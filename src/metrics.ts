// Session metrics: append-only NDJSON event log for the abox metrics pipeline.
//
// Each closed session emits one `closed` line; long-lived sessions also emit
// periodic `tick` lines (driven by a shared timer in server.ts). A host-side
// collector reads the log forward from a cursor and folds it into rollups.
//
// Writes go through a 200ms / 64KB buffered appender so a burst of very short
// sessions (e.g. `abox-cli pwd`) costs a handful of fsyncs, not one per event.
// Metrics must never crash wsh: every fs operation is wrapped and failures are
// dropped silently.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const METRICS_DIR = path.join(os.homedir(), '.wsh', 'metrics');
// Box-user opt-out: presence of ~/.wsh/metrics.off makes recordTick/recordClosed
// no-ops, so no events ever enter the on-disk segment. Toggle by touch/rm; the
// next event reflects the change without restarting wsh. Undocumented for now
// (we'd rather users keep metrics on); operators should not flip this remotely.
const METRICS_OFF_FILE = path.join(os.homedir(), '.wsh', 'metrics.off');
const SEGMENT_MAX_BYTES = 100 * 1024 * 1024; // rotate at 100 MB
const SEGMENTS_KEPT = 2;                     // current + 1 previous
const FLUSH_BYTES = 64 * 1024;               // flush early when buffer hits 64 KB
const FLUSH_INTERVAL_MS = 200;
const SEGMENT_RE = /^events-(\d{6})\.ndjson$/;

/** Minimal session shape the recorder needs — server.ts's Session satisfies it structurally. */
export interface MetricsSession {
  app: string;
  binary: string;
  appType: 'pty' | 'web' | 'job';
  createdBy: string;
  createdAt: number; // ms epoch
  bytesIn: number;
  bytesOut: number;
}

let currentSeq = 0;
let buffer: string[] = [];
let bufferBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

function segmentName(seq: number): string {
  return `events-${String(seq).padStart(6, '0')}.ndjson`;
}

function segmentPath(seq: number): string {
  return path.join(METRICS_DIR, segmentName(seq));
}

/** Scan the metrics dir, pick the highest existing segment as current (or create #1). */
function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    let max = 0;
    for (const name of fs.readdirSync(METRICS_DIR)) {
      const m = name.match(SEGMENT_RE);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    currentSeq = max || 1;
    if (!fs.existsSync(segmentPath(currentSeq))) {
      fs.writeFileSync(segmentPath(currentSeq), '');
    }
  } catch {
    // Leave currentSeq at 0; append() will no-op on failure.
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
  // Don't let a pending metrics flush hold the process open.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Flush the in-memory buffer to disk synchronously. Safe to call any time. */
export function flush(): void {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  if (buffer.length === 0) return;
  const data = buffer.join('');
  buffer = [];
  bufferBytes = 0;
  if (currentSeq === 0) return; // init failed earlier — drop
  try {
    fs.appendFileSync(segmentPath(currentSeq), data);
    maybeRotate();
  } catch {
    // disk full / permissions — drop, never throw into a session handler
  }
}

function maybeRotate(): void {
  try {
    const size = fs.statSync(segmentPath(currentSeq)).size;
    if (size < SEGMENT_MAX_BYTES) return;
    currentSeq += 1;
    fs.writeFileSync(segmentPath(currentSeq), '');
    // Drop segments older than the kept window.
    for (let seq = currentSeq - SEGMENTS_KEPT; seq >= 1; seq--) {
      const p = segmentPath(seq);
      if (!fs.existsSync(p)) break;
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch {
    // ignore — next flush retries
  }
}

function append(obj: Record<string, unknown>): void {
  // One stat per event is cheap (the file lives in the same dir we just wrote
  // to, so it's hot in the page cache). Checking here covers every caller.
  if (fs.existsSync(METRICS_OFF_FILE)) return;
  init();
  let line: string;
  try {
    line = JSON.stringify(obj) + '\n';
  } catch {
    return;
  }
  buffer.push(line);
  bufferBytes += line.length;
  if (bufferBytes >= FLUSH_BYTES) flush();
  else scheduleFlush();
}

/** Record a session that has just ended. Captures final cumulative byte
 *  totals plus, when the session's binary is a known agent, a per-model
 *  cumulative token map collected at close time. */
export function recordClosed(
  sid: string,
  s: MetricsSession,
  tokens?: Record<string, { in: number; out: number }>,
): void {
  const evt: Record<string, unknown> = {
    t: 'closed',
    sid,
    app: s.app,
    binary: s.binary,
    appType: s.appType,
    user: s.createdBy || '',
    openedAt: Math.floor(s.createdAt / 1000),
    closedAt: Math.floor(Date.now() / 1000),
    bytesIn: s.bytesIn,
    bytesOut: s.bytesOut,
  };
  if (tokens && Object.keys(tokens).length > 0) evt.tokens = tokens;
  append(evt);
}

/** Record a periodic checkpoint for a still-running session. Tokens, when
 *  present, are cumulative per model since session start; the host collector
 *  turns them into per-(sid, model) deltas the same way it does for bytes. */
export function recordTick(
  sid: string,
  s: MetricsSession,
  tokens?: Record<string, { in: number; out: number }>,
): void {
  const evt: Record<string, unknown> = {
    t: 'tick',
    sid,
    app: s.app,
    binary: s.binary,
    appType: s.appType,
    user: s.createdBy || '',
    openedAt: Math.floor(s.createdAt / 1000),
    ts: Math.floor(Date.now() / 1000),
    bytesIn: s.bytesIn,
    bytesOut: s.bytesOut,
  };
  if (tokens && Object.keys(tokens).length > 0) evt.tokens = tokens;
  append(evt);
}

/** One event line plus the cursor to resume *after* it. */
export interface MetricsReadEvent {
  line: string;   // raw NDJSON line, no trailing newline
  cursor: string; // pass as `since` to read everything strictly after this line
}

/**
 * Read events forward from `cursor`. Returns each complete line tagged with
 * its own resume cursor, so a consumer can stop at any line and persist a
 * cursor that exactly resumes after it. Cursor format is "<seq>:<offset>";
 * "" starts from the oldest retained segment.
 *
 * A single call stays within one segment. When the cursor's segment is fully
 * consumed and a newer one exists, `nextCursor` rolls to "<seq+1>:0" so the
 * next call continues cleanly across the rotation boundary.
 */
export function readEvents(cursor: string, maxBytes = 1 << 20): { events: MetricsReadEvent[]; nextCursor: string } {
  init();
  flush(); // make sure on-disk state is current before the host reads
  if (currentSeq === 0) return { events: [], nextCursor: cursor || '1:0' };

  let seq: number, offset: number;
  const parts = (cursor || '').split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    seq = parseInt(parts[0], 10);
    offset = parseInt(parts[1], 10);
  } else {
    seq = Math.max(1, currentSeq - SEGMENTS_KEPT + 1);
    offset = 0;
  }
  // A cursor pointing into a rotated-away segment: jump to the oldest kept one.
  if (seq < currentSeq - SEGMENTS_KEPT + 1) { seq = Math.max(1, currentSeq - SEGMENTS_KEPT + 1); offset = 0; }
  if (seq > currentSeq) return { events: [], nextCursor: `${seq}:${offset}` };

  let chunk = '';
  try {
    const fd = fs.openSync(segmentPath(seq), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (offset < size) {
        const want = Math.min(maxBytes, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, offset);
        chunk = buf.subarray(0, read).toString('utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], nextCursor: `${seq}:${offset}` };
  }

  const events: MetricsReadEvent[] = [];
  let pos = offset;
  let idx = 0;
  for (;;) {
    const nl = chunk.indexOf('\n', idx);
    if (nl === -1) break; // trailing partial line — leave it for the next read
    const line = chunk.slice(idx, nl);
    pos += Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
    if (line.trim().length > 0) events.push({ line, cursor: `${seq}:${pos}` });
    idx = nl + 1;
  }

  let nextCursor = `${seq}:${pos}`;
  if (seq < currentSeq) {
    // If this (rotated) segment is fully consumed, roll to the next one.
    try {
      if (pos >= fs.statSync(segmentPath(seq)).size) nextCursor = `${seq + 1}:0`;
    } catch { /* ignore */ }
  }
  return { events, nextCursor };
}

// Last-ditch flush so buffered events aren't lost on a clean shutdown.
process.on('exit', () => { try { flush(); } catch { /* ignore */ } });
