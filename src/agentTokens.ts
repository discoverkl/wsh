/*
 * Per-binary agent token capture. Each adapter walks its agent's on-disk
 * transcript and returns cumulative `{model → {in, out}}` token counts since
 * the wsh session started. The collector turns those cumulative numbers into
 * per-(sid, model) deltas, parallel to how cumulative byte counters are
 * folded into per-(sid) deltas.
 *
 * Capture is best-effort: every fs call is wrapped, failures degrade to an
 * empty map (no `tokens` field on the metric event), and nothing here ever
 * throws into the caller. Metrics must never crash wsh.
 *
 * Attribution on Linux. Claude does not keep its transcript fd open between
 * writes, so /proc/<pid>/fd is useless. Instead we walk descendants of the
 * wsh PTY child, identify claude/cco/ccr processes by /proc/<pid>/comm,
 * read each one's /proc/<pid>/cwd (kernel-persistent), and enumerate
 * `~/.claude/projects/<encoded-cwd>/*.jsonl`. PIDs and candidate files are
 * paired by:
 *   1) PID-start ↔ file-first-timestamp proximity (fresh transcript), with
 *      inode order as a tiebreaker so concurrent claudes in the same cwd
 *      attribute correctly even if their write order interleaves.
 *   2) file-mtime > PID-start (resumed transcript) when no fresh match.
 *      A resumed file is replayed from offset 0 with a timestamp filter, so
 *      turns that landed between PID start and our first discovery still
 *      count toward this session — solving the "user types and claude
 *      writes before we get there" race for `claude --resume`.
 *
 * Discovery throttle is 5 s, but skipped entirely while state.files is
 * empty so a young session keeps re-trying every tick (server.ts schedules
 * a 1 s prewarm loop for sessions in their first 30 s) instead of waiting
 * for the 60 s tick.
 *
 * Ships the `claude` adapter only. `codex` and `coco/traecli` slots are
 * commented out for future activation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TokenSnapshot {
  in: number;
  out: number;
}

export interface SessionContext {
  sid: string;
  binary: string;
  createdAt: number; // ms epoch (matches session.createdAt in server.ts)
  pid: number | null; // PTY/child pid; null skips /proc discovery this tick
}

export interface TokenAdapter {
  tokensFor(s: SessionContext): Promise<Record<string, TokenSnapshot>>;
}

// agentOf mirrors internal/gateway/metrics_agent.go's binary→agent mapping
// but is a SUBSET: this map only lists binaries we ship a token adapter for.
// Every entry here MUST also be in metrics_agent.go (with the same agent
// value); the Go side is the authoritative classifier and may list extras
// (e.g. codex) that lack a token adapter today.
// Returns "" for non-agent binaries; the dispatcher skips them entirely.
const BINARY_TO_AGENT: Record<string, string> = {
  claude: 'claude-code',
  cco: 'claude-code',
  ccr: 'claude-code',
  ccrc: 'claude-code',
  coco: 'traecli',
  traecli: 'traecli',
  'trae-agent': 'traecli',
  ta: 'traecli',
  // codex: 'codex',   // classified by Go side, no on-disk usage source confirmed yet
};

export function agentOf(binary: string): string {
  return BINARY_TO_AGENT[binary] || '';
}

// ---- claude adapter ------------------------------------------------------

const CLAUDE_BINARIES = new Set(['claude', 'cco', 'ccr']);
const DISCOVER_THROTTLE_MS = 5_000;
const FRESH_SLACK_MS = 5_000;

interface ClaudeState {
  files: Map<string, number>; // path → byte offset already folded
  tokens: Record<string, TokenSnapshot>;
  lastDiscover: number;
}

const claudeState = new Map<string, ClaudeState>();

// Per-sid lock. tokensFor can be called concurrently for the same session —
// the 1 s prewarm interval can overlap a 60 s tick or the close hook — and
// two concurrent reads of the same `(file, offset)` would double-count
// every turn. Each call queues behind the previous so reads/writes to
// `state.files` and `state.tokens` are serialized.
const sessionLock = new Map<string, Promise<unknown>>();

// Cross-session lease. First wsh session to adopt a transcript path owns it;
// later sessions skip it, preventing both from counting the same new turns
// when two wsh sessions `claude --resume <same-id>` concurrently. Released
// by dropSession at session close.
const fileLease = new Map<string, string>(); // path → owner sid


interface CandidateFile {
  path: string;
  firstTs: number | null; // ms epoch from the first timestamped JSONL line
  mtimeMs: number;
  sizeBytes: number;
  inode: number;
}

// ---- /proc walkers -------------------------------------------------------

async function readChildren(pid: number): Promise<number[]> {
  let tids: string[];
  try {
    tids = await fs.promises.readdir(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const tid of tids) {
    let txt: string;
    try {
      txt = await fs.promises.readFile(`/proc/${pid}/task/${tid}/children`, 'utf8');
    } catch {
      continue;
    }
    for (const tok of txt.trim().split(/\s+/)) {
      if (!tok) continue;
      const n = Number(tok);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return out;
}

async function descendantsOf(root: number): Promise<number[]> {
  const seen = new Set<number>([root]);
  const queue: number[] = [root];
  const out: number[] = [];
  while (queue.length) {
    const p = queue.shift()!;
    for (const k of await readChildren(p)) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      queue.push(k);
    }
  }
  return out;
}

async function readComm(pid: number): Promise<string> {
  try {
    return (await fs.promises.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function readCwd(pid: number): Promise<string> {
  try {
    return await fs.promises.readlink(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

// readPidStartMs returns when the process was created (ms epoch), via the
// ctime of /proc/<pid> — set at process creation on Linux and not updated
// by reads. Reliable enough to disambiguate concurrent claudes started even
// fractions of a second apart.
async function readPidStartMs(pid: number): Promise<number | null> {
  try {
    const st = await fs.promises.stat(`/proc/${pid}`);
    return st.ctime.getTime();
  } catch {
    return null;
  }
}

interface AgentPid { pid: number; cwd: string; startMs: number; }

async function gatherAgentPids(rootPid: number, comms: Set<string>): Promise<AgentPid[]> {
  const pids = [rootPid, ...(await descendantsOf(rootPid))];
  const out: AgentPid[] = [];
  for (const pid of pids) {
    if (!comms.has(await readComm(pid))) continue;
    const cwd = await readCwd(pid);
    if (!cwd) continue;
    const startMs = await readPidStartMs(pid);
    if (startMs == null) continue;
    out.push({ pid, cwd, startMs });
  }
  return out;
}


function cwdToProjectDir(cwd: string): string {
  // Observed encoding: `/Users/dev/code/project` → `-Users-dev-code-project`.
  // Just `/` → `-`; other characters preserved verbatim.
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
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

// readFirstTs peeks at the head of a JSONL transcript and returns the first
// line's `timestamp` field as ms-epoch, or null if none is found. Claude
// prepends header lines (e.g. `{"type":"permission-mode",...}`) with no
// timestamp, so we scan forward until we hit a timestamped line.
async function readFirstTs(file: string): Promise<number | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(8192);
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

// readTokensSince streams new bytes from `offset` and folds every assistant
// line's usage into `tokens` (mutating). When `minTs` is provided, only
// assistant lines whose own `timestamp` is ≥ minTs contribute — used by
// the resume catch-up path so a long historical transcript doesn't get
// re-counted but its post-resume turns do. Returns the offset to commit
// (only advances past complete \n-terminated lines, so a half-flushed
// final line is re-read next tick).
async function readTokensSince(
  file: string,
  offset: number,
  tokens: Record<string, TokenSnapshot>,
  minTs?: number,
): Promise<number> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    const st = await fs.promises.stat(file);
    if (st.size <= offset) return offset;
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(st.size - offset);
    await fd.read(buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const lastNL = text.lastIndexOf('\n');
    if (lastNL < 0) return offset; // no complete line yet
    const complete = text.slice(0, lastNL);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || obj.type !== 'assistant') continue;
      if (minTs != null) {
        const lineTs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
        if (!Number.isFinite(lineTs) || lineTs < minTs) continue;
      }
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') continue;
      const model = typeof msg.model === 'string' ? msg.model.trim() : '';
      if (!model) continue;
      const u = msg.usage || {};
      const inTok =
        toInt(u.input_tokens) +
        toInt(u.cache_creation_input_tokens) +
        toInt(u.cache_read_input_tokens);
      const outTok = toInt(u.output_tokens);
      if (inTok === 0 && outTok === 0) continue;
      const cur = tokens[model] || { in: 0, out: 0 };
      cur.in += inTok;
      cur.out += outTok;
      tokens[model] = cur;
    }
    return offset + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the consumed \n
  } catch {
    return offset;
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// adoptFiles pairs the session's claude PIDs to transcript files and mutates
// `state.files` in place. Each PID tries a fresh match first (file whose
// first timestamped line lands within ±FRESH_SLACK_MS of the PID's start —
// adopted at offset 0). The fresh search walks files in inode order so
// concurrent claudes in the same cwd attribute by file-creation order (an
// older claude takes the older-inode file). If no fresh match exists, a
// recently-modified file (mtime > PID start − slack) is adopted as a resume
// transcript: we replay from offset 0 with a timestamp filter so any turns
// written before this very first discovery are still counted, and persist
// the post-replay offset for ongoing incremental folds.
async function adoptFiles(
  pids: AgentPid[],
  s: SessionContext,
  state: ClaudeState,
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
      if (state.files.has(c.path)) taken.add(c.path);
      const owner = fileLease.get(c.path);
      if (owner && owner !== s.sid) taken.add(c.path);
    }
    const sortedPids = [...group].sort((a, b) => a.startMs - b.startMs);
    const sortedByInode = [...candidates].sort((a, b) => a.inode - b.inode);
    for (const p of sortedPids) {
      // Fresh match: lowest-inode file whose firstTs is within ±slack of this PID.
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
      // Resume match: recently-modified file. Replay from 0 with ts filter
      // (catches turns landed between PID start and now), then continue
      // from the post-replay offset.
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
        const next = await readTokensSince(
          resumeHit.path,
          0,
          state.tokens,
          p.startMs - FRESH_SLACK_MS,
        );
        taken.add(resumeHit.path);
        fileLease.set(resumeHit.path, s.sid);
        state.files.set(resumeHit.path, next);
      }
    }
  }
}

async function tokensForLocked(s: SessionContext): Promise<Record<string, TokenSnapshot>> {
  let st = claudeState.get(s.sid);
  if (!st) {
    st = { files: new Map(), tokens: {}, lastDiscover: 0 };
    claudeState.set(s.sid, st);
  }
  const now = Date.now();
  // Throttle is skipped while we haven't adopted anything yet — server.ts
  // pings us once per second during a young session so we can adopt as soon
  // as the claude process is observable.
  const shouldDiscover =
    s.pid != null && (st.files.size === 0 || now - st.lastDiscover >= DISCOVER_THROTTLE_MS);
  if (shouldDiscover) {
    st.lastDiscover = now;
    const pids = await gatherAgentPids(s.pid as number, CLAUDE_BINARIES);
    if (pids.length > 0) await adoptFiles(pids, s, st);
  }
  for (const [file, offset] of Array.from(st.files.entries())) {
    const next = await readTokensSince(file, offset, st.tokens);
    if (next !== offset) st.files.set(file, next);
  }
  // Defensive copy so callers can't mutate our cache.
  const out: Record<string, TokenSnapshot> = {};
  for (const [m, t] of Object.entries(st.tokens)) out[m] = { in: t.in, out: t.out };
  return out;
}

export const claudeAdapter: TokenAdapter = {
  async tokensFor(s) {
    const prev = sessionLock.get(s.sid) ?? Promise.resolve();
    const next = prev.then(() => tokensForLocked(s), () => tokensForLocked(s));
    sessionLock.set(s.sid, next);
    return next as Promise<Record<string, TokenSnapshot>>;
  },
};

// ---- traecli adapter -----------------------------------------------------
//
// traecli (alias: coco, trae-agent, ta) stores session history under
//   ~/.cache/coco/sessions/<uuid>/
//     ├── session.json     // {id, created_at, metadata: {cwd, model_name, ...}}
//     ├── events.jsonl     // user/assistant message stream
//     ├── traces.jsonl     // open-telemetry-ish span log — token usage lives here
//     └── session.log
//
// Tokens come from `traces.jsonl`. Each model call is wrapped in two spans
// with identical token tags — a `model.stream.eino` outer streaming span and
// a `model.real_call` inner span that represents the actual upstream HTTP
// request. We count only `model.real_call` so retries (which spawn new
// real_call spans) are reflected and the outer wrapper doesn't double-count.
//
// Process attribution mirrors the claude adapter's signal stack but with one
// extra step: the session dir name is a random UUID independent of cwd, so
// we enumerate recently-touched session dirs and pair them to traecli PIDs
// via the cwd recorded in session.json plus a created_at ↔ PID-start
// proximity match (with a traces.jsonl-mtime fallback for `--resume`).

const TRAECLI_BINARIES = new Set(['coco', 'traecli', 'trae-agent', 'ta']);
const COCO_SESSIONS_ROOT = path.join(os.homedir(), '.cache', 'coco', 'sessions');
// Don't bother reading session.json for dirs whose traces.jsonl hasn't been
// touched in this long — the directory is dormant and can't be the answer.
const TRAECLI_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TraeSession {
  id: string;
  cwd: string;
  createdAtMs: number;
  tracesPath: string;
  tracesMtimeMs: number;
  tracesSize: number;
  inode: number;
}

const traecliState = new Map<string, ClaudeState>();

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
    const tracesPath = path.join(dir, 'traces.jsonl');
    let tracesSt: fs.Stats;
    try {
      tracesSt = await fs.promises.stat(tracesPath);
    } catch {
      continue;
    }
    if (tracesSt.mtimeMs < sinceMs) continue;
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
    out.push({
      id,
      cwd,
      createdAtMs,
      tracesPath,
      tracesMtimeMs: tracesSt.mtimeMs,
      tracesSize: tracesSt.size,
      inode: Number(tracesSt.ino),
    });
  }
  return out;
}

// readTokensSinceTraces folds new spans from traces.jsonl. Only `model.real_call`
// spans contribute. When `minTs` is set, spans whose `startTime` (microseconds
// since epoch in the trace format) is before `minTs` are skipped — used for
// resume catch-up so older spans of a resumed conversation don't get re-counted.
async function readTokensSinceTraces(
  file: string,
  offset: number,
  tokens: Record<string, TokenSnapshot>,
  minTs?: number,
): Promise<number> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    const st = await fs.promises.stat(file);
    if (st.size <= offset) return offset;
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(st.size - offset);
    await fd.read(buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const lastNL = text.lastIndexOf('\n');
    if (lastNL < 0) return offset;
    const complete = text.slice(0, lastNL);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let span: any;
      try { span = JSON.parse(line); } catch { continue; }
      const tags: Array<{ key?: string; value?: any }> = Array.isArray(span?.tags) ? span.tags : [];
      let category = '', modelName = '', input = 0, cacheRead = 0, output = 0, reasoning = 0;
      for (const t of tags) {
        if (!t || typeof t.key !== 'string') continue;
        switch (t.key) {
          case 'span.category':           category = String(t.value ?? ''); break;
          case 'model.name':              modelName = String(t.value ?? ''); break;
          case 'usage.input_tokens':      input = toInt(t.value); break;
          case 'usage.cache_read_tokens': cacheRead = toInt(t.value); break;
          case 'usage.output_tokens':     output = toInt(t.value); break;
          case 'usage.reasoning_tokens':  reasoning = toInt(t.value); break;
        }
      }
      if (category !== 'model.real_call') continue;
      if (!modelName) continue;
      if (minTs != null) {
        const startMs = typeof span.startTime === 'number' ? span.startTime / 1000 : NaN;
        if (!Number.isFinite(startMs) || startMs < minTs) continue;
      }
      const inTok = input + cacheRead;
      const outTok = output + reasoning;
      if (inTok === 0 && outTok === 0) continue;
      const cur = tokens[modelName] || { in: 0, out: 0 };
      cur.in += inTok;
      cur.out += outTok;
      tokens[modelName] = cur;
    }
    return offset + Buffer.byteLength(complete, 'utf8') + 1;
  } catch {
    return offset;
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

async function adoptTraeSessions(
  pids: AgentPid[],
  s: SessionContext,
  state: ClaudeState,
): Promise<void> {
  if (pids.length === 0) return;
  const oldestPidStart = pids.reduce((m, p) => Math.min(m, p.startMs), Infinity);
  const sinceMs = Math.min(oldestPidStart, Date.now() - TRAECLI_RECENCY_WINDOW_MS) - FRESH_SLACK_MS;
  const sessions = await enumerateTraeSessions(sinceMs);
  if (sessions.length === 0) return;
  const taken = new Set<string>();
  for (const sess of sessions) {
    if (state.files.has(sess.tracesPath)) taken.add(sess.tracesPath);
    const owner = fileLease.get(sess.tracesPath);
    if (owner && owner !== s.sid) taken.add(sess.tracesPath);
  }
  const sortedPids = [...pids].sort((a, b) => a.startMs - b.startMs);
  for (const p of sortedPids) {
    const candidates = sessions.filter(c => c.cwd === p.cwd && !taken.has(c.tracesPath));
    // Fresh match: session.created_at within ±slack of PID start; tie-break
    // on inode (which monotonically increases with creation order on ext4).
    let freshHit: TraeSession | null = null;
    for (const c of candidates.slice().sort((a, b) => a.inode - b.inode)) {
      if (Math.abs(c.createdAtMs - p.startMs) <= FRESH_SLACK_MS) {
        freshHit = c;
        break;
      }
    }
    if (freshHit) {
      taken.add(freshHit.tracesPath);
      fileLease.set(freshHit.tracesPath, s.sid);
      state.files.set(freshHit.tracesPath, 0);
      continue;
    }
    // Resume: traces.jsonl recently modified after PID start. Replay from
    // offset 0 with a startTime filter so only post-resume spans count.
    let resumeHit: TraeSession | null = null;
    let bestMtime = -Infinity;
    for (const c of candidates) {
      if (c.tracesMtimeMs <= p.startMs - FRESH_SLACK_MS) continue;
      if (c.tracesMtimeMs > bestMtime) {
        resumeHit = c;
        bestMtime = c.tracesMtimeMs;
      }
    }
    if (resumeHit) {
      const next = await readTokensSinceTraces(
        resumeHit.tracesPath,
        0,
        state.tokens,
        p.startMs - FRESH_SLACK_MS,
      );
      taken.add(resumeHit.tracesPath);
      fileLease.set(resumeHit.tracesPath, s.sid);
      state.files.set(resumeHit.tracesPath, next);
    }
  }
}

async function tokensForLockedTraecli(s: SessionContext): Promise<Record<string, TokenSnapshot>> {
  let st = traecliState.get(s.sid);
  if (!st) {
    st = { files: new Map(), tokens: {}, lastDiscover: 0 };
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
    const next = await readTokensSinceTraces(file, offset, st.tokens);
    if (next !== offset) st.files.set(file, next);
  }
  const out: Record<string, TokenSnapshot> = {};
  for (const [m, t] of Object.entries(st.tokens)) out[m] = { in: t.in, out: t.out };
  return out;
}

export const traecliAdapter: TokenAdapter = {
  async tokensFor(s) {
    const prev = sessionLock.get(s.sid) ?? Promise.resolve();
    const next = prev.then(() => tokensForLockedTraecli(s), () => tokensForLockedTraecli(s));
    sessionLock.set(s.sid, next);
    return next as Promise<Record<string, TokenSnapshot>>;
  },
};

// dropSession releases the per-session cache for whichever adapter held it.
// Called from the close hook so the in-memory state doesn't grow forever.
export function dropSession(sid: string): void {
  for (const map of [claudeState, traecliState]) {
    const st = map.get(sid);
    if (st) {
      for (const file of st.files.keys()) {
        if (fileLease.get(file) === sid) fileLease.delete(file);
      }
      map.delete(sid);
    }
  }
  sessionLock.delete(sid);
}

// ---- registry + dispatch -------------------------------------------------

const ADAPTERS: Record<string, TokenAdapter> = {
  claude: claudeAdapter,
  cco: claudeAdapter,
  ccr: claudeAdapter,
  ccrc: claudeAdapter,
  coco: traecliAdapter,
  traecli: traecliAdapter,
  'trae-agent': traecliAdapter,
  ta: traecliAdapter,
};

// adapterFor returns the registered adapter for a binary, or null when the
// session isn't an agent we instrument. Used by the metrics hook to skip the
// adapter call entirely for shells, editors, etc.
export function adapterFor(binary: string): TokenAdapter | null {
  return ADAPTERS[binary] || null;
}

// captureTokens is the single entry point the metrics hooks call. Pure
// best-effort: any error → empty map → no `tokens` field on the event.
export async function captureTokens(
  s: SessionContext,
): Promise<Record<string, TokenSnapshot>> {
  const a = adapterFor(s.binary);
  if (!a) return {};
  try {
    return await a.tokensFor(s);
  } catch {
    return {};
  }
}
