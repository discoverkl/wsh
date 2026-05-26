/*
 * Shared scaffolding for per-binary agent token adapters.
 *
 * Each adapter is best-effort. Everything here is wrapped so a failure
 * degrades to "no tokens captured" — metrics must never crash wsh.
 *
 * Linux attribution stack (shared by every adapter):
 *   1. walk /proc/<pty-pid> descendants (readChildren, descendantsOf)
 *   2. filter by /proc/<pid>/comm ∈ the adapter's binary set (readComm)
 *   3. read each agent process's /proc/<pid>/cwd (readCwd) and start
 *      time from /proc/<pid> ctime (readPidStartMs) — both kernel-
 *      persistent, so the adapter doesn't depend on the agent keeping
 *      its transcript fd open.
 *
 * Cross-cutting state lives here so all adapters share one instance:
 *   - sessionLock     per-sid serialization (prewarm vs tick vs close)
 *   - fileLease       cross-session file ownership (concurrent --resume)
 *   - state registry  lets dropSession() walk every adapter's per-sid
 *                     state map without shared.ts importing the adapters.
 */

import * as fs from 'fs';

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

export interface AgentPid {
  pid: number;
  cwd: string;
  startMs: number;
}

/** Per-adapter session state. Generic `E` is for adapter-specific extensions
 *  (codex uses it to keep a sticky per-file `currentModel` cursor across
 *  ticks). Claude and traecli use the default empty extension. */
export interface AdapterState<E = Record<string, never>> {
  files: Map<string, number>;            // path → byte offset already folded
  tokens: Record<string, TokenSnapshot>; // cumulative {model → {in,out}}
  lastDiscover: number;                  // ms epoch of last /proc scan
  ext: E;
}

export const DISCOVER_THROTTLE_MS = 5_000;
export const FRESH_SLACK_MS = 5_000;

// ---- module-scope concurrency --------------------------------------------

// Per-sid serialization. tokensFor can be called concurrently for the same
// session — prewarm (1 s), tick (60 s) and close can overlap — and two
// concurrent reads of the same (file, offset) would double-count every
// turn. Each call queues behind the previous so state mutations are
// serialized.
const sessionLock = new Map<string, Promise<unknown>>();

// First wsh session to adopt a transcript path owns it; later sessions
// skip it. Prevents both from counting the same new turns when two
// sessions `--resume <same-id>` concurrently. Released by dropSession.
export const fileLease = new Map<string, string>(); // path → owner sid

export async function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLock.get(sid) ?? Promise.resolve();
  // `.then(fn, fn)` runs fn whether or not the previous attempt rejected;
  // a prior failure must not poison the queue for this session.
  const next = prev.then(fn, fn);
  sessionLock.set(sid, next);
  return next;
}

// ---- state registry (used by dropSession) --------------------------------

const stateRegistry: Array<Map<string, AdapterState<any>>> = [];

/** Each adapter registers its per-sid state map at module load. dropSession
 *  iterates the registry instead of importing adapters (avoids circular
 *  imports between shared.ts and the adapter modules). */
export function registerAdapterState(m: Map<string, AdapterState<any>>): void {
  stateRegistry.push(m);
}

/** Release per-session state for whichever adapter held it, plus any file
 *  leases owned by this sid. Called from the close hook so module-scope
 *  state doesn't grow forever. */
export function dropSession(sid: string): void {
  for (const m of stateRegistry) {
    const st = m.get(sid);
    if (!st) continue;
    for (const file of st.files.keys()) {
      if (fileLease.get(file) === sid) fileLease.delete(file);
    }
    m.delete(sid);
  }
  sessionLock.delete(sid);
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

// readPidStartMs returns process creation time (ms epoch) via the ctime of
// /proc/<pid> — set at process creation on Linux, not perturbed by reads.
// Reliable enough to disambiguate concurrent agents started fractions of
// a second apart.
async function readPidStartMs(pid: number): Promise<number | null> {
  try {
    const st = await fs.promises.stat(`/proc/${pid}`);
    return st.ctime.getTime();
  } catch {
    return null;
  }
}

/** Walk descendants of `rootPid` and return every process whose
 *  `/proc/<pid>/comm` is in `comms`, with its cwd and start time. */
export async function gatherAgentPids(rootPid: number, comms: Set<string>): Promise<AgentPid[]> {
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

// ---- generic file streaming ---------------------------------------------

// Cap per-call read size so a multi-MB resume catch-up doesn't allocate the
// whole file at once or stall the event loop. The remainder is read on the
// next tick — adoption sets state.files[path] to the returned offset, so the
// session's ongoing tick loop naturally drains the backlog one chunk at a
// time. JSONL transcripts never have a single line larger than this, so the
// "no complete line in the chunk" path is unreachable in practice.
const MAX_READ_PER_CALL = 4 * 1024 * 1024;

/** Stream new bytes from `offset` to current EOF (capped at MAX_READ_PER_CALL),
 *  splitting on '\n' and invoking `onLine` for each complete line. Returns
 *  the offset to commit: only complete \n-terminated lines are consumed, so
 *  a half-flushed trailing line is re-read on the next call.
 *
 *  Owns the stat / open / Buffer.alloc / read / lastIndexOf('\n') /
 *  Buffer.byteLength / finally-close arithmetic so each adapter's per-line
 *  parser stays focused on its own schema.
 *
 *  File shrinkage: if `st.size < offset` (rotation, truncation), the caller's
 *  offset is stale — there's nothing to do here besides report it. The caller
 *  can detect this via the returned value: when shrinkage occurred we return
 *  `-1` so the adapter can decide whether to re-adopt from 0 or drop the
 *  file. The original `offset` is returned for the normal up-to-date case. */
export async function streamNewLines(
  file: string,
  offset: number,
  onLine: (line: string) => void,
): Promise<number> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    const st = await fs.promises.stat(file);
    if (st.size < offset) return -1; // shrunk/rotated — caller resets
    if (st.size === offset) return offset; // nothing new
    fd = await fs.promises.open(file, 'r');
    const want = Math.min(st.size - offset, MAX_READ_PER_CALL);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fd.read(buf, 0, want, offset);
    if (bytesRead <= 0) return offset;
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lastNL = text.lastIndexOf('\n');
    if (lastNL < 0) return offset; // no complete line yet
    const complete = text.slice(0, lastNL);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      onLine(line);
    }
    return offset + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the consumed \n
  } catch {
    return offset;
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

/** Read the first '\n'-terminated line of `file`, growing the read window
 *  incrementally up to `maxBytes`. Returns null if the file is unreadable,
 *  empty, or contains no newline within the cap.
 *
 *  Replaces the old fixed-8KB read used by codex's session_meta and claude's
 *  readFirstTs — codex 0.132+ session_meta lines are 15–22 KB (base_instructions
 *  blob alone is multi-KB), and future agents may push further. */
export async function readFirstLine(file: string, maxBytes: number): Promise<string | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const chunks: Buffer[] = [];
    let pos = 0;
    const CHUNK = 8192;
    while (pos < maxBytes) {
      const want = Math.min(CHUNK, maxBytes - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fd.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const slice = buf.slice(0, bytesRead);
      const nl = slice.indexOf(0x0a); // '\n'
      if (nl >= 0) {
        chunks.push(slice.slice(0, nl));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(slice);
      pos += bytesRead;
      if (bytesRead < want) break; // EOF before we found a newline
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

// ---- helpers -------------------------------------------------------------

export function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
