/*
 * Claude adapter — captures cumulative per-model {in,out} tokens from
 * Claude Code's on-disk JSONL transcripts.
 *
 * Source: ~/.claude/projects/<encoded-cwd>/*.jsonl, one file per session.
 *   <encoded-cwd> is `cwd.replace(/\//g, '-')` — e.g. `/root/code/abox`
 *   becomes `-root-code-abox`. Each line is a JSON object; assistant
 *   turns carry `usage.{input_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens, output_tokens}` and `message.model`.
 *
 * Attribution. Claude does not keep its transcript fd open between writes,
 * so /proc/<pid>/fd is useless. Instead we walk descendants of the wsh
 * PTY child, filter by /proc/<pid>/comm ∈ {claude, cco, ccr}, and read
 * each one's /proc/<pid>/cwd (kernel-persistent) to find the project dir.
 *
 * Pairing PIDs to .jsonl files (see adoptFiles):
 *   1. Fresh: the lowest-inode unclaimed file whose first timestamped
 *      line lands within ±FRESH_SLACK_MS of the PID's start. Inode order
 *      makes concurrent claudes in the same cwd attribute correctly even
 *      when their write order interleaves — claude creates one file
 *      before the other.
 *   2. Resume: the most recently mtime-bumped file whose mtime is newer
 *      than PID start. Replayed from offset 0 with a per-line timestamp
 *      filter, so turns written between PID start and our first scan
 *      still count, while older history doesn't double-count. Fixes the
 *      `claude --resume` race.
 *
 * Sum rule for tokens_in. Claude reports three disjoint input variants
 * (raw, cache_creation, cache_read) — they are ADDED. tokens_out is just
 * `output_tokens`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AdapterState,
  AgentPid,
  DISCOVER_THROTTLE_MS,
  FRESH_SLACK_MS,
  SessionContext,
  TokenAdapter,
  TokenSnapshot,
  fileLease,
  gatherAgentPids,
  registerAdapterState,
  streamNewLines,
  toInt,
  withSessionLock,
} from './shared';

const CLAUDE_BINARIES = new Set(['claude', 'cco', 'ccr']);

interface CandidateFile {
  path: string;
  firstTs: number | null; // ms epoch from the first timestamped JSONL line
  mtimeMs: number;
  sizeBytes: number;
  inode: number;
}

const claudeState = new Map<string, AdapterState>();
registerAdapterState(claudeState);

function cwdToProjectDir(cwd: string): string {
  // Observed encoding: `/root/code/abox` → `-root-code-abox`. Just `/` → `-`;
  // other characters preserved verbatim.
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
}

// readFirstTs peeks at the head of a transcript and returns the first
// timestamped line's `timestamp` field as ms-epoch, or null if none is
// found within the first HEAD_SCAN_BYTES. Claude prepends untimestamped
// header lines (e.g. `{"type":"permission-mode",...}`) so we scan forward
// until we hit a real turn. The cap is generous because individual claude
// header blocks can exceed 8 KB on long permission policies / env dumps —
// silently returning null here excludes the file from the fresh-match path.
const HEAD_SCAN_BYTES = 64 * 1024;

async function readFirstTs(file: string): Promise<number | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(HEAD_SCAN_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lastNL = text.lastIndexOf('\n');
    const scannable = lastNL >= 0 ? text.slice(0, lastNL) : '';
    for (const line of scannable.split('\n')) {
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const ts = obj && typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

async function enumerateCandidates(projectDir: string): Promise<CandidateFile[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(projectDir);
  } catch {
    return [];
  }
  const out: CandidateFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(full);
    } catch {
      continue;
    }
    const firstTs = await readFirstTs(full);
    out.push({
      path: full,
      firstTs,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      inode: Number(st.ino),
    });
  }
  return out;
}

// foldClaudeLine extracts token usage from a single transcript line into
// `tokens`. Assistant lines only; lines whose own timestamp is < minTs
// (when set) are skipped — used by the resume catch-up replay.
// Exported for `xterm/test-unit/agentTokens/claude.test.ts`.
export function foldClaudeLine(
  line: string,
  tokens: Record<string, TokenSnapshot>,
  minTs: number | undefined,
): void {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || obj.type !== 'assistant') return;
  if (minTs != null) {
    // Only drop when we can prove the line is older than minTs; a missing
    // or unparseable timestamp falls through (consistent with the no-minTs
    // tick path, which has no gate at all).
    const lineTs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(lineTs) && lineTs < minTs) return;
  }
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return;
  const model = typeof msg.model === 'string' ? msg.model.trim() : '';
  if (!model) return;
  const u = msg.usage || {};
  const inTok =
    toInt(u.input_tokens) +
    toInt(u.cache_creation_input_tokens) +
    toInt(u.cache_read_input_tokens);
  const outTok = toInt(u.output_tokens);
  if (inTok === 0 && outTok === 0) return;
  const cur = tokens[model] || { in: 0, out: 0 };
  cur.in += inTok;
  cur.out += outTok;
  tokens[model] = cur;
}

// adoptFiles pairs the session's claude PIDs to transcript files and
// mutates `state.files` in place. Fresh match first (offset 0); resume
// fallback replays from offset 0 with a timestamp filter and persists
// the post-replay offset.
async function adoptFiles(
  pids: AgentPid[],
  s: SessionContext,
  state: AdapterState,
): Promise<void> {
  const byCwd = new Map<string, AgentPid[]>();
  for (const p of pids) {
    const list = byCwd.get(p.cwd) ?? [];
    list.push(p);
    byCwd.set(p.cwd, list);
  }
  for (const [cwd, group] of byCwd) {
    const candidates = await enumerateCandidates(cwdToProjectDir(cwd));
    if (candidates.length === 0) continue;
    const taken = new Set<string>();
    for (const c of candidates) {
      if (state.files.has(c.path)) { taken.add(c.path); continue; }
      const owner = fileLease.get(c.path);
      // Skip files leased to a different sid. Also skip a SELF-owned lease
      // when state.files no longer has the path — that combo means a prior
      // adoption left a stale lease; treat it as not-ours-to-re-adopt so a
      // future state.files invalidation path can't trigger double-counting.
      if (owner && owner !== s.sid) taken.add(c.path);
      else if (owner === s.sid) taken.add(c.path);
    }
    const sortedPids = [...group].sort((a, b) => a.startMs - b.startMs);
    const sortedByInode = [...candidates].sort((a, b) => a.inode - b.inode);
    for (const p of sortedPids) {
      // Fresh: lowest-inode file whose firstTs is within ±slack of this PID.
      let freshHit: CandidateFile | null = null;
      for (const c of sortedByInode) {
        if (taken.has(c.path)) continue;
        if (c.firstTs == null) continue;
        if (Math.abs(c.firstTs - p.startMs) > FRESH_SLACK_MS) continue;
        freshHit = c;
        break;
      }
      if (freshHit) {
        taken.add(freshHit.path);
        fileLease.set(freshHit.path, s.sid);
        state.files.set(freshHit.path, 0);
        continue;
      }
      // Resume: most-recently-mtime'd file. Replay from 0 with the timestamp
      // filter, then continue from the post-replay offset.
      let resumeHit: CandidateFile | null = null;
      let bestMtime = -Infinity;
      for (const c of candidates) {
        if (taken.has(c.path)) continue;
        if (c.mtimeMs <= p.startMs - FRESH_SLACK_MS) continue;
        if (c.mtimeMs > bestMtime) {
          resumeHit = c;
          bestMtime = c.mtimeMs;
        }
      }
      if (resumeHit) {
        // Close the TOCTOU window: claim the lease + state.files entry
        // BEFORE awaiting streamNewLines, so a concurrent session's
        // adoptFiles (per-sid lock is not cross-sid) can't observe the
        // path as unleased and double-credit the same history.
        taken.add(resumeHit.path);
        fileLease.set(resumeHit.path, s.sid);
        state.files.set(resumeHit.path, 0); // updated after the read
        const minTs = p.startMs - FRESH_SLACK_MS;
        const next = await streamNewLines(resumeHit.path, 0, line => {
          foldClaudeLine(line, state.tokens, minTs);
        });
        if (next === -1) {
          // File rotated mid-adoption — undo the claim, retry on next discovery.
          state.files.delete(resumeHit.path);
          if (fileLease.get(resumeHit.path) === s.sid) fileLease.delete(resumeHit.path);
          continue;
        }
        state.files.set(resumeHit.path, next);
      }
    }
  }
}

async function tokensForLockedClaude(s: SessionContext): Promise<Record<string, TokenSnapshot>> {
  let st = claudeState.get(s.sid);
  if (!st) {
    st = { files: new Map(), tokens: {}, lastDiscover: 0, ext: {} };
    claudeState.set(s.sid, st);
  }
  const now = Date.now();
  // Throttle is skipped while we haven't adopted anything yet — server.ts
  // pings us once per second during a young session so we can adopt as
  // soon as the claude process is observable.
  const shouldDiscover =
    s.pid != null && (st.files.size === 0 || now - st.lastDiscover >= DISCOVER_THROTTLE_MS);
  if (shouldDiscover) {
    st.lastDiscover = now;
    const pids = await gatherAgentPids(s.pid as number, CLAUDE_BINARIES);
    if (pids.length > 0) await adoptFiles(pids, s, st);
  }
  for (const [file, offset] of Array.from(st.files.entries())) {
    const next = await streamNewLines(file, offset, line => {
      foldClaudeLine(line, st!.tokens, undefined);
    });
    if (next === -1) {
      // File shrunk/rotated — drop tracking so the next discovery can re-adopt.
      st.files.delete(file);
      if (fileLease.get(file) === s.sid) fileLease.delete(file);
      continue;
    }
    if (next !== offset) st.files.set(file, next);
  }
  // Defensive copy so callers can't mutate our cache.
  const out: Record<string, TokenSnapshot> = {};
  for (const [m, t] of Object.entries(st.tokens)) out[m] = { in: t.in, out: t.out };
  return out;
}

export const claudeAdapter: TokenAdapter = {
  tokensFor(s) {
    return withSessionLock(s.sid, () => tokensForLockedClaude(s));
  },
};
