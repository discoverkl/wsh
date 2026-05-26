/*
 * traecli adapter — captures cumulative per-model {in,out} tokens from
 * trae-agent / coco's on-disk session log.
 *
 * Source: ~/.cache/coco/sessions/<uuid>/
 *           ├── session.json     {id, created_at, metadata:{cwd,model_name,...}}
 *           ├── events.jsonl     user/assistant message stream — tokens live here
 *           ├── traces.jsonl     OpenTelemetry-ish span log — NOT used (see below)
 *           └── session.log
 *
 * Why events.jsonl and not traces.jsonl: traces.jsonl is buffered and only
 * flushed at coco process exit — often AFTER the pid is reaped from /proc.
 * `enumerateTraeSessions` stats its target file before opening it, so for
 * short-lived jobs (e.g. `traecli -p "..."`) traces.jsonl is missing
 * throughout the agent's lifetime, no session is adopted, and the close
 * handler emits the `closed` event with no `tokens` field. events.jsonl is
 * appended line-by-line as each LLM response completes, ~3-10s before agent
 * exit, so prewarm reliably catches it. Single source — falling back to
 * traces.jsonl would re-open the close race.
 *
 * Each assistant turn writes one event of shape
 *   { created_at, message: { message: { role: "assistant", response_meta: { usage },
 *                                       extra: { _source_model } } } }
 * Filter: `e.message.message.role === 'assistant'`. This both selects the
 * per-turn usage and drops the `agent_end.output.response_meta.usage`
 * mirror that coco emits once at session close — counting that instead
 * would under-count multi-turn loops (agent_end carries only the final turn).
 *
 * Attribution mirrors the claude adapter's signal stack but with one
 * extra step: the session dir name is a random UUID independent of cwd,
 * so we enumerate recently-touched session dirs and pair them to traecli
 * PIDs via the cwd recorded in session.json plus a created_at ↔
 * PID-start proximity match (with inode tiebreak for concurrent same-
 * cwd sessions).
 *
 * Sum rule: tokens_in  = prompt_tokens + (prompt_token_details.cached_tokens ?? 0);
 *           tokens_out = completion_tokens + (completion_token_details.reasoning_tokens ?? 0).
 *
 * Older coco builds without events.jsonl produce no token attribution
 * (un-adopted, same outcome as a missing file today); no fallback to
 * traces.jsonl.
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

const TRAECLI_BINARIES = new Set(['coco', 'traecli', 'trae-agent', 'ta']);
const COCO_SESSIONS_ROOT = path.join(os.homedir(), '.cache', 'coco', 'sessions');
// Don't bother reading session.json for dirs whose events.jsonl hasn't been
// touched in this long — the directory is dormant and can't be the answer.
const TRAECLI_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TraeSession {
  id: string;
  cwd: string;
  createdAtMs: number;
  eventsPath: string;
  eventsMtimeMs: number;
  eventsSize: number;
  inode: number;
}

const traecliState = new Map<string, AdapterState>();
registerAdapterState(traecliState);

async function enumerateTraeSessions(sinceMs: number): Promise<TraeSession[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(COCO_SESSIONS_ROOT);
  } catch {
    return [];
  }
  const out: TraeSession[] = [];
  for (const id of entries) {
    const dir = path.join(COCO_SESSIONS_ROOT, id);
    const eventsPath = path.join(dir, 'events.jsonl');
    let eventsSt: fs.Stats;
    try {
      eventsSt = await fs.promises.stat(eventsPath);
    } catch {
      continue;
    }
    if (eventsSt.mtimeMs < sinceMs) continue;
    let meta: any;
    try {
      const txt = await fs.promises.readFile(path.join(dir, 'session.json'), 'utf8');
      meta = JSON.parse(txt);
    } catch {
      continue;
    }
    const cwd = typeof meta?.metadata?.cwd === 'string' ? meta.metadata.cwd : '';
    const createdAtMs = typeof meta?.created_at === 'string' ? Date.parse(meta.created_at) : NaN;
    if (!cwd || !Number.isFinite(createdAtMs)) continue;
    // Canonicalize cwd via realpath so it can be string-compared against
    // /proc/<pid>/cwd (which the kernel already resolves through symlinks).
    let canonCwd = cwd;
    try { canonCwd = await fs.promises.realpath(cwd); } catch { /* keep original */ }
    out.push({
      id,
      cwd: canonCwd,
      createdAtMs,
      eventsPath,
      eventsMtimeMs: eventsSt.mtimeMs,
      eventsSize: eventsSt.size,
      inode: Number(eventsSt.ino),
    });
  }
  return out;
}

// foldTraeEvent folds a single events.jsonl line into `tokens`. Only events
// whose `message.message.role === 'assistant'` contribute — that filter both
// selects per-turn usage and drops the `agent_end.output` mirror that fires
// once at session close. When `minTs` is set, events whose `created_at` is
// before it are skipped (resume catch-up). Missing `_source_model` → drop
// (matches the no-`model.name` drop the span parser did, and avoids polluting
// per-model rollups with an "unknown" bucket).
// Exported for `xterm/test-unit/agentTokens/traecli.test.ts`.
export function foldTraeEvent(
  line: string,
  tokens: Record<string, TokenSnapshot>,
  minTs: number | undefined,
): void {
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  const m = e?.message?.message;
  if (!m || m.role !== 'assistant') return;
  const usage = m.response_meta?.usage;
  if (!usage) return;
  const modelName = typeof m.extra?._source_model === 'string' ? m.extra._source_model : '';
  if (!modelName) return;
  if (minTs != null) {
    const tMs = typeof e.created_at === 'string' ? Date.parse(e.created_at) : NaN;
    if (!Number.isFinite(tMs) || tMs < minTs) return;
  }
  const inTok = toInt(usage.prompt_tokens) + toInt(usage.prompt_token_details?.cached_tokens);
  const outTok = toInt(usage.completion_tokens) + toInt(usage.completion_token_details?.reasoning_tokens);
  if (inTok === 0 && outTok === 0) return;
  const cur = tokens[modelName] || { in: 0, out: 0 };
  cur.in += inTok;
  cur.out += outTok;
  tokens[modelName] = cur;
}

async function adoptTraeSessions(
  pids: AgentPid[],
  s: SessionContext,
  state: AdapterState,
): Promise<void> {
  if (pids.length === 0) return;
  const oldestPidStart = pids.reduce((m, p) => Math.min(m, p.startMs), Infinity);
  const sinceMs = Math.min(oldestPidStart, Date.now() - TRAECLI_RECENCY_WINDOW_MS) - FRESH_SLACK_MS;
  const sessions = await enumerateTraeSessions(sinceMs);
  if (sessions.length === 0) return;
  const taken = new Set<string>();
  for (const sess of sessions) {
    if (state.files.has(sess.eventsPath)) { taken.add(sess.eventsPath); continue; }
    const owner = fileLease.get(sess.eventsPath);
    // Skip files leased to a different sid. Also skip a SELF-owned lease
    // when state.files no longer has the path — stale-lease defense.
    if (owner && owner !== s.sid) taken.add(sess.eventsPath);
    else if (owner === s.sid) taken.add(sess.eventsPath);
  }
  const sortedPids = [...pids].sort((a, b) => a.startMs - b.startMs);
  for (const p of sortedPids) {
    const candidates = sessions.filter(c => c.cwd === p.cwd && !taken.has(c.eventsPath));
    // Fresh: session.created_at within ±slack of PID start; tie-break on
    // inode (which monotonically increases with creation order on ext4).
    let freshHit: TraeSession | null = null;
    for (const c of candidates.slice().sort((a, b) => a.inode - b.inode)) {
      if (Math.abs(c.createdAtMs - p.startMs) <= FRESH_SLACK_MS) {
        freshHit = c;
        break;
      }
    }
    if (freshHit) {
      taken.add(freshHit.eventsPath);
      fileLease.set(freshHit.eventsPath, s.sid);
      state.files.set(freshHit.eventsPath, 0);
      continue;
    }
    // Resume: events.jsonl recently modified after PID start. Replay from
    // offset 0 with a created_at filter so only post-resume events count.
    let resumeHit: TraeSession | null = null;
    let bestMtime = -Infinity;
    for (const c of candidates) {
      if (c.eventsMtimeMs <= p.startMs - FRESH_SLACK_MS) continue;
      if (c.eventsMtimeMs > bestMtime) {
        resumeHit = c;
        bestMtime = c.eventsMtimeMs;
      }
    }
    if (resumeHit) {
      // Close the TOCTOU window: claim BEFORE the await.
      taken.add(resumeHit.eventsPath);
      fileLease.set(resumeHit.eventsPath, s.sid);
      state.files.set(resumeHit.eventsPath, 0); // updated after the read
      const minTs = p.startMs - FRESH_SLACK_MS;
      const next = await streamNewLines(resumeHit.eventsPath, 0, line => {
        foldTraeEvent(line, state.tokens, minTs);
      });
      if (next === -1) {
        state.files.delete(resumeHit.eventsPath);
        if (fileLease.get(resumeHit.eventsPath) === s.sid) fileLease.delete(resumeHit.eventsPath);
        continue;
      }
      state.files.set(resumeHit.eventsPath, next);
    }
  }
}

async function tokensForLockedTraecli(s: SessionContext): Promise<Record<string, TokenSnapshot>> {
  let st = traecliState.get(s.sid);
  if (!st) {
    st = { files: new Map(), tokens: {}, lastDiscover: 0, ext: {} };
    traecliState.set(s.sid, st);
  }
  const now = Date.now();
  const shouldDiscover =
    s.pid != null && (st.files.size === 0 || now - st.lastDiscover >= DISCOVER_THROTTLE_MS);
  if (shouldDiscover) {
    st.lastDiscover = now;
    const pids = await gatherAgentPids(s.pid as number, TRAECLI_BINARIES);
    if (pids.length > 0) await adoptTraeSessions(pids, s, st);
  }
  for (const [file, offset] of Array.from(st.files.entries())) {
    const next = await streamNewLines(file, offset, line => {
      foldTraeEvent(line, st!.tokens, undefined);
    });
    if (next === -1) {
      // File shrunk/rotated — drop tracking so the next discovery can re-adopt.
      st.files.delete(file);
      if (fileLease.get(file) === s.sid) fileLease.delete(file);
      continue;
    }
    if (next !== offset) st.files.set(file, next);
  }
  const out: Record<string, TokenSnapshot> = {};
  for (const [m, t] of Object.entries(st.tokens)) out[m] = { in: t.in, out: t.out };
  return out;
}

export const traecliAdapter: TokenAdapter = {
  tokensFor(s) {
    return withSessionLock(s.sid, () => tokensForLockedTraecli(s));
  },
};
