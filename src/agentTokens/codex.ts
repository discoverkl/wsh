/*
 * codex adapter — captures cumulative per-model {in,out} tokens from
 * Codex CLI's on-disk rollout files.
 *
 * Source: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl
 *         (one flat file per session, date-partitioned by start day).
 *
 *   - First line: `session_meta` with payload.{id, timestamp (ISO), cwd}
 *     — like traecli's session.json but inline at the top of the file.
 *   - `turn_context` lines: payload.model (per-turn; a session can switch
 *     models mid-conversation, mirroring claude).
 *   - `event_msg` lines with payload.type == "token_count": carry
 *     payload.info.last_token_usage.{input_tokens, cached_input_tokens,
 *     output_tokens, reasoning_output_tokens}.
 *
 * Sum rules (important — DIFFERENT from claude):
 *   tokens_in  = input_tokens
 *     Codex's `input_tokens` ALREADY INCLUDES the cached portion (verified:
 *     `input + output == total`; `cached_input_tokens` is a subset/
 *     diagnostic). Adding cached would double-count. Opposite of claude,
 *     where the three input fields are disjoint and ARE summed.
 *   tokens_out = output_tokens + reasoning_output_tokens
 *     Parallels the traecli adapter; captures all generated tokens even
 *     though codex's own `total_tokens` excludes reasoning.
 *
 * Attribution mirrors the traecli signal stack but the per-session
 * metadata lives inline (first line of the rollout) rather than a
 * sibling JSON. `codex resume <uuid>` empirically APPENDS to the
 * original rollout file (every UUID under ~/.codex/sessions/** appears
 * in exactly one file), so the mtime-based resume rule catches it
 * cleanly without any new logic.
 *
 * Per-file currentModel cursor (the only codex-specific state). A
 * `turn_context` line read in tick N must still be the "current model"
 * when a `token_count` arrives in tick N+1. The cursor is held in
 * state.ext.currentModel: Map<path, string> and survives across ticks.
 * The minTs filter never gates `turn_context` updates — model state
 * must stay consistent across the replay boundary — only token credit.
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
  readFirstLine,
  registerAdapterState,
  streamNewLines,
  toInt,
  withSessionLock,
} from './shared';

const CODEX_BINARIES = new Set(['codex']);
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
// Bound the YYYY/MM/DD walk so we don't stat every rollout ever written.
// Covers casual `codex resume`s up to a couple of weeks old plus any
// timezone-edge slop; resuming a months-old session won't be attributed.
const CODEX_WALK_WINDOW_DAYS = 14;

interface CodexSession {
  id: string;          // session uuid from session_meta.payload.id
  cwd: string;
  createdAtMs: number; // session_meta.payload.timestamp parsed
  rolloutPath: string;
  mtimeMs: number;
  sizeBytes: number;
  inode: number;
}

interface CodexExt {
  currentModel: Map<string, string>; // path → most recent turn_context.model
}

const codexState = new Map<string, AdapterState<CodexExt>>();
registerAdapterState(codexState as Map<string, AdapterState<any>>);

// ---- session enumeration -------------------------------------------------

// listDateDirs returns absolute paths of `YYYY/MM/DD/` directories under
// CODEX_SESSIONS_ROOT whose date is within the last `windowDays` (plus one
// day of slop for timezone edges). All three levels are gated by a strict
// `^\d+$` shape and bounds-checked, so a stray directory accidentally named
// like a number ("2e3", "2026.0") can't slip through.
const YEAR_RE  = /^\d{4}$/;
const MONTH_RE = /^\d{1,2}$/;
const DAY_RE   = /^\d{1,2}$/;

async function listDateDirs(windowDays: number): Promise<string[]> {
  // Single cutoff with the day-level slop baked in — applied uniformly at
  // every walk level so a directory whose month is one less than cutoff's
  // can't be skipped before its day is considered.
  const cutoffMs = Date.now() - (windowDays + 1) * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);
  const cutoffYM = cutoff.getUTCFullYear() * 100 + (cutoff.getUTCMonth() + 1);
  const out: string[] = [];
  let years: string[];
  try {
    years = await fs.promises.readdir(CODEX_SESSIONS_ROOT);
  } catch {
    return out;
  }
  for (const y of years) {
    if (!YEAR_RE.test(y)) continue;
    const yn = Number(y);
    if (yn < cutoff.getUTCFullYear()) continue;
    let months: string[];
    try { months = await fs.promises.readdir(path.join(CODEX_SESSIONS_ROOT, y)); }
    catch { continue; }
    for (const m of months) {
      if (!MONTH_RE.test(m)) continue;
      const mn = Number(m);
      if (mn < 1 || mn > 12) continue;
      if (yn * 100 + mn < cutoffYM) continue;
      let days: string[];
      try { days = await fs.promises.readdir(path.join(CODEX_SESSIONS_ROOT, y, m)); }
      catch { continue; }
      for (const d of days) {
        if (!DAY_RE.test(d)) continue;
        const dn = Number(d);
        if (dn < 1 || dn > 31) continue;
        if (Date.UTC(yn, mn - 1, dn) < cutoffMs) continue;
        out.push(path.join(CODEX_SESSIONS_ROOT, y, m, d));
      }
    }
  }
  return out;
}

// readSessionMeta reads the first line of a rollout (up to META_MAX_BYTES)
// and returns its session_meta payload, or null if absent/malformed.
//
// Codex 0.132+ session_meta lines are 15–22 KB (the base_instructions blob
// alone exceeds 10 KB), so the bounded-but-generous cap matters: any cap
// shorter than the actual first line silently drops every codex session
// because JSON.parse fails on the truncated head.
const META_MAX_BYTES = 256 * 1024;

async function readSessionMeta(file: string): Promise<{ id: string; cwd: string; createdAtMs: number } | null> {
  const first = await readFirstLine(file, META_MAX_BYTES);
  if (!first) return null;
  let obj: any;
  try { obj = JSON.parse(first); } catch { return null; }
  if (!obj || obj.type !== 'session_meta') return null;
  const p = obj.payload || {};
  const id = typeof p.id === 'string' ? p.id : '';
  const cwd = typeof p.cwd === 'string' ? p.cwd : '';
  const createdAtMs = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
  if (!id || !cwd || !Number.isFinite(createdAtMs)) return null;
  // Canonicalize the recorded cwd so it can be string-compared against
  // /proc/<pid>/cwd (which the kernel already resolves through symlinks).
  // Falls back to the original on realpath failure (cwd no longer exists).
  let canonCwd = cwd;
  try { canonCwd = await fs.promises.realpath(cwd); } catch { /* keep original */ }
  return { id, cwd: canonCwd, createdAtMs };
}

async function enumerateCodexSessions(sinceMs: number, skip: Set<string>): Promise<CodexSession[]> {
  const out: CodexSession[] = [];
  for (const dir of await listDateDirs(CODEX_WALK_WINDOW_DAYS)) {
    let entries: string[];
    try { entries = await fs.promises.readdir(dir); }
    catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      if (skip.has(full)) continue; // already adopted by this sid or leased to another
      let st: fs.Stats;
      try { st = await fs.promises.stat(full); }
      catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      const meta = await readSessionMeta(full);
      if (!meta) continue;
      out.push({
        id: meta.id,
        cwd: meta.cwd,
        createdAtMs: meta.createdAtMs,
        rolloutPath: full,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        inode: Number(st.ino),
      });
    }
  }
  return out;
}

// ---- per-line fold -------------------------------------------------------

// foldCodexLine handles two line types:
//   - turn_context: updates the sticky per-file currentModel cursor.
//                   ALWAYS applied, regardless of minTs — model state
//                   must stay consistent across the replay boundary.
//   - event_msg/token_count: credits last_token_usage with the sum rules
//                            documented at the top. Gated by minTs.
// Exported for `xterm/test-unit/agentTokens/codex.test.ts`.
export function foldCodexLine(
  line: string,
  tokens: Record<string, TokenSnapshot>,
  modelRef: { value: string },
  minTs: number | undefined,
): void {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'turn_context') {
    const m = obj.payload && typeof obj.payload.model === 'string' ? obj.payload.model.trim() : '';
    if (m) modelRef.value = m;
    return;
  }
  if (obj.type !== 'event_msg') return;
  const payload = obj.payload;
  if (!payload || payload.type !== 'token_count') return;

  if (minTs != null) {
    // Only drop when we can prove the line is older than minTs; a missing or
    // unparseable timestamp falls through and gets credited (consistent with
    // the no-minTs tick path, which has no gate at all). Treating NaN as
    // "older" would make the same line credit in tick but drop in replay.
    const lineTs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(lineTs) && lineTs < minTs) return;
  }
  const last = payload.info && payload.info.last_token_usage;
  if (!last || typeof last !== 'object') return;
  // tokens_in: input_tokens only — already includes cached on codex.
  const inTok = toInt(last.input_tokens);
  // tokens_out: output + reasoning — codex's own total ignores reasoning,
  // but we capture all generated tokens (parallels traecli's sum).
  const outTok = toInt(last.output_tokens) + toInt(last.reasoning_output_tokens);
  if (inTok === 0 && outTok === 0) return;
  const model = modelRef.value || '';
  if (!model) return; // shouldn't happen: turn_context always precedes
  const cur = tokens[model] || { in: 0, out: 0 };
  cur.in += inTok;
  cur.out += outTok;
  tokens[model] = cur;
}

// ---- adoption ------------------------------------------------------------

async function adoptCodexSessions(
  pids: AgentPid[],
  s: SessionContext,
  state: AdapterState<CodexExt>,
): Promise<void> {
  if (pids.length === 0) return;
  const oldestPidStart = pids.reduce((m, p) => Math.min(m, p.startMs), Infinity);
  const sinceMs = Math.min(oldestPidStart, Date.now() - 24 * 60 * 60 * 1000) - FRESH_SLACK_MS;
  // Skip rollouts already tracked by this sid (consistent with state.files)
  // OR leased to another sid. Skipping at enumeration time saves the
  // readSessionMeta read for paths we'd otherwise filter out — a real I/O
  // win when many codex sessions accumulate in the 14-day window.
  const skip = new Set<string>();
  for (const path of state.files.keys()) skip.add(path);
  for (const [path, owner] of fileLease.entries()) {
    if (owner !== s.sid) skip.add(path);
  }
  const sessions = await enumerateCodexSessions(sinceMs, skip);
  if (sessions.length === 0) return;
  const taken = new Set<string>();
  const sortedPids = [...pids].sort((a, b) => a.startMs - b.startMs);
  for (const p of sortedPids) {
    const candidates = sessions.filter(c => c.cwd === p.cwd && !taken.has(c.rolloutPath));
    // Fresh: session_meta.timestamp within ±slack of PID start; tie-break
    // on inode (monotonic in creation order on ext4).
    let freshHit: CodexSession | null = null;
    for (const c of candidates.slice().sort((a, b) => a.inode - b.inode)) {
      if (Math.abs(c.createdAtMs - p.startMs) <= FRESH_SLACK_MS) {
        freshHit = c;
        break;
      }
    }
    if (freshHit) {
      taken.add(freshHit.rolloutPath);
      fileLease.set(freshHit.rolloutPath, s.sid);
      state.files.set(freshHit.rolloutPath, 0);
      state.ext.currentModel.set(freshHit.rolloutPath, '');
      continue;
    }
    // Resume: rollout mtime > PID start (codex appends to the original
    // file on `codex resume`). Replay from offset 0 with a per-line
    // timestamp filter so only post-resume turns count for tokens —
    // turn_context lines from earlier still flow through to seed the
    // model cursor.
    let resumeHit: CodexSession | null = null;
    let bestMtime = -Infinity;
    for (const c of candidates) {
      if (c.mtimeMs <= p.startMs - FRESH_SLACK_MS) continue;
      if (c.mtimeMs > bestMtime) {
        resumeHit = c;
        bestMtime = c.mtimeMs;
      }
    }
    if (resumeHit) {
      // Close the TOCTOU window: claim the lease + state.files entry
      // BEFORE awaiting streamNewLines, so a concurrent session running
      // adoptCodexSessions in parallel (per-sid lock is not cross-sid)
      // can't observe the same path as unleased and double-credit it.
      taken.add(resumeHit.rolloutPath);
      fileLease.set(resumeHit.rolloutPath, s.sid);
      state.files.set(resumeHit.rolloutPath, 0); // updated after the read
      const modelRef = { value: '' };
      const minTs = p.startMs - FRESH_SLACK_MS;
      const next = await streamNewLines(resumeHit.rolloutPath, 0, line => {
        foldCodexLine(line, state.tokens, modelRef, minTs);
      });
      if (next === -1) {
        // File rotated mid-adoption — undo the claim, let next discovery retry.
        state.files.delete(resumeHit.rolloutPath);
        if (fileLease.get(resumeHit.rolloutPath) === s.sid) {
          fileLease.delete(resumeHit.rolloutPath);
        }
        continue;
      }
      state.files.set(resumeHit.rolloutPath, next);
      state.ext.currentModel.set(resumeHit.rolloutPath, modelRef.value);
    }
  }
}

// ---- tick ---------------------------------------------------------------

async function tokensForLockedCodex(s: SessionContext): Promise<Record<string, TokenSnapshot>> {
  let st = codexState.get(s.sid);
  if (!st) {
    st = { files: new Map(), tokens: {}, lastDiscover: 0, ext: { currentModel: new Map() } };
    codexState.set(s.sid, st);
  }
  const now = Date.now();
  const shouldDiscover =
    s.pid != null && (st.files.size === 0 || now - st.lastDiscover >= DISCOVER_THROTTLE_MS);
  if (shouldDiscover) {
    st.lastDiscover = now;
    const pids = await gatherAgentPids(s.pid as number, CODEX_BINARIES);
    if (pids.length > 0) await adoptCodexSessions(pids, s, st);
  }
  for (const [file, offset] of Array.from(st.files.entries())) {
    // Sticky cursor: wrap the per-file currentModel in a ref the fold
    // callback mutates; write it back so the next tick continues from
    // wherever the last turn_context line left it.
    const modelRef = { value: st.ext.currentModel.get(file) || '' };
    const next = await streamNewLines(file, offset, line => {
      foldCodexLine(line, st!.tokens, modelRef, undefined);
    });
    if (next === -1) {
      // File shrunk/rotated — drop tracking so the next discovery can re-adopt.
      // state.tokens (cumulative for the wsh session) is preserved.
      st.files.delete(file);
      st.ext.currentModel.delete(file);
      if (fileLease.get(file) === s.sid) fileLease.delete(file);
      continue;
    }
    if (next !== offset) st.files.set(file, next);
    st.ext.currentModel.set(file, modelRef.value);
  }
  const out: Record<string, TokenSnapshot> = {};
  for (const [m, t] of Object.entries(st.tokens)) out[m] = { in: t.in, out: t.out };
  return out;
}

export const codexAdapter: TokenAdapter = {
  tokensFor(s) {
    return withSessionLock(s.sid, () => tokensForLockedCodex(s));
  },
};
