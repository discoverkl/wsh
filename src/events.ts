import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface WshEvent {
  type: string;
  ts: number;
  data?: Record<string, any>;
}

export const LOG_FILE = path.join(os.homedir(), '.wsh', 'events.log');
export const CURSOR_DIR = path.join(os.homedir(), '.wsh', 'events', 'cursors');
const MAX_LINES = 10000;

const bus = new EventEmitter();
bus.setMaxListeners(0);

let lastTs = 0;
let emitCount = 0;
function nextTs(): number {
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return lastTs;
}

// --- Validation ---

const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;

export function isValidEventType(type: string): boolean {
  return EVENT_TYPE_RE.test(type);
}

// --- Emit ---

export function emit(type: string, data?: Record<string, any>): WshEvent {
  const event: WshEvent = { type, ts: nextTs(), ...(data !== undefined && { data }) };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');
  bus.emit('*', event);
  if (++emitCount % 100 === 0) rotate();
  return event;
}

// --- Subscribe (in-process) ---

export function on(fn: (e: WshEvent) => void): () => void {
  bus.on('*', fn);
  return () => { bus.off('*', fn); };
}

// --- Replay from disk ---

export function readSince(sinceTs: number): WshEvent[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const events: WshEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.ts > sinceTs) events.push(e);
    } catch {}
  }
  return events;
}

// --- Named cursors ---

export function getCursor(name: string): number {
  try {
    return parseInt(fs.readFileSync(path.join(CURSOR_DIR, name), 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function setCursor(name: string, ts: number): void {
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  fs.writeFileSync(path.join(CURSOR_DIR, name), String(ts));
}

// --- Trim / GC ---

export function trim(keep?: { count?: number; sinceTs?: number }): number {
  if (!fs.existsSync(LOG_FILE)) return 0;
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  let kept: string[];
  if (keep?.sinceTs !== undefined) {
    kept = lines.filter(line => {
      try { return JSON.parse(line).ts > keep.sinceTs!; } catch { return false; }
    });
  } else {
    const max = keep?.count ?? MAX_LINES;
    kept = lines.slice(-max);
  }
  const removed = lines.length - kept.length;
  if (removed > 0) {
    fs.writeFileSync(LOG_FILE + '.tmp', kept.length ? kept.join('\n') + '\n' : '');
    fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
  }
  return removed;
}

/** Alias for trim() with defaults — keeps last MAX_LINES. */
export function rotate(): void {
  trim();
}
