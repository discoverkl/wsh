import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What the two sides last agreed on — the box half of abox's sync record.
 *
 * Designed in abox's sync.md. In one paragraph: each side keeps ONE hash of
 * what it looked like when the two last agreed, the box holds both of them
 * (it is the point every machine has in common), and no transfer happens until
 * both know who moved since. No history, no merge, no per-file bookkeeping.
 *
 * The record is an optimization, never a safety mechanism. Its only job is to
 * prove the receiver is where the last sync left it, which is what lets a push
 * skip the confirmation prompt. Every degraded case — no record, a filter never
 * seen before, a push that died mid-chunk — simply has no record, and the
 * client's answer to that is to stop and ask.
 *
 * Records live in $HOME so they self-invalidate: rebuild a box and they go with
 * the home directory they describe. They are denied in push-ignore.d for the
 * same reason ~/.abox/locked is — a mirror must not claim agreements it never
 * made, and deny rules are two-way invisible, so a whole-box push can neither
 * carry them in nor delete them as leftovers.
 */

const SYNC_HOME = os.homedir();

/** One line per synced root, keyed by the replica that synced it. */
export const SYNC_STATE_DIR = path.join(SYNC_HOME, '.wsh', 'push-state');

/**
 * Cap on the lines one replica's file may hold, oldest dropped first.
 *
 * A record is keyed by (rel, skip_fp), and a filter is anything the user typed
 * --exclude for, so the key space is open-ended. Nothing here is load-bearing:
 * dropping a record costs one confirmation prompt, which is exactly what having
 * no record has always meant.
 */
const SYNC_MAX_RECORDS = 500;

/** Resolution mtimes are hashed at — one second, matching PUSH_MTIME_TOL_NS. */
const SYNC_MTIME_QUANTUM_MS = 1000;

/** The states the check can report. Answers who moved, and nothing else. */
export type SyncStateName = 'in_sync' | 'local_moved' | 'box_moved' | 'both_moved' | 'no_record';

export interface SyncRecord {
  /** Destination path relative to $HOME; '.' for the whole box. */
  rel: string;
  /** The client's fingerprint of the filter this record describes a view under. */
  fp: string;
  /** Hash of the client's tree when the two last agreed. Opaque here. */
  lh: string;
  /** Hash of this box's tree at the same moment, taken after the repair hook. */
  bh: string;
  /** Whether the push that wrote this was removing what the box held and the client did not. */
  del: boolean;
  /** Unix seconds. */
  at: number;
}

/**
 * A replica id names a file, so it is validated exactly as the client writes
 * it: 32 lowercase hex digits. Strictness here is what keeps a path separator
 * out of a filename built from request input.
 */
export function syncValidReplica(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
}

/** Where one replica's records live. Null when the id is not one we wrote. */
function syncRecordPath(replica: string): string | null {
  if (!syncValidReplica(replica)) return null;
  return path.join(SYNC_STATE_DIR, replica);
}

/**
 * NDJSON, one record per line — not the columns the design sketch showed.
 * A `rel` is a filesystem path and may hold spaces or tabs, so any delimiter
 * cheap enough to write is one a filename can contain.
 *
 * A malformed line is dropped rather than reported. The file is a cache of
 * agreements; the cost of losing one is a prompt, and the cost of failing a
 * push over a byte someone appended by hand is a box nobody can sync to.
 */
function syncReadAll(replica: string): SyncRecord[] {
  const p = syncRecordPath(replica);
  if (!p) return [];
  let text: string;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out: SyncRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SyncRecord;
      if (typeof r?.rel === 'string' && typeof r.fp === 'string' && typeof r.lh === 'string' && typeof r.bh === 'string') {
        out.push({ rel: r.rel, fp: r.fp, lh: r.lh, bh: r.bh, del: r.del === true, at: Number(r.at) || 0 });
      }
    } catch { /* a line we cannot read is a record we do not have */ }
  }
  return out;
}

/** The record for one (rel, skip_fp), or null. */
export function syncFind(replica: string, rel: string, fp: string): SyncRecord | null {
  return syncReadAll(replica).find(r => r.rel === rel && r.fp === fp) ?? null;
}

/**
 * Write one record, replacing any previous agreement about the same view.
 *
 * Rewrites the whole file through a temp and a rename: the file is a few
 * hundred short lines at most, and appending would need a compaction pass
 * anyway to keep a re-synced root from accumulating one line per push.
 *
 * Best-effort. A record that fails to land means the next push asks a question
 * it could have skipped, which is the safe direction and not worth failing an
 * apply that has already written the user's files.
 */
export function syncWrite(replica: string, rec: SyncRecord): void {
  const p = syncRecordPath(replica);
  if (!p) return;
  try {
    const kept = syncReadAll(replica).filter(r => !(r.rel === rec.rel && r.fp === rec.fp));
    kept.push(rec);
    // Oldest first, so slicing from the end keeps the most recently agreed.
    kept.sort((a, b) => a.at - b.at);
    const lines = kept.slice(-SYNC_MAX_RECORDS).map(r => JSON.stringify(r)).join('\n');
    fs.mkdirSync(SYNC_STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, lines + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error(`[sync] could not record ${rec.rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- The hash ---

/**
 * Folds a tree into one value, one entry at a time.
 *
 * Order-independent by construction: each entry is hashed alone and the digests
 * are XOR-accumulated, with the entry count folded in at the end so a tree
 * cannot collide with a permutation of itself plus a cancelling pair.
 *
 * That is not a micro-optimization. This walk emits every entry of a directory
 * before descending into any of them, while the pushing client's walk yields a
 * directory's children lexically depth-first — so an order-sensitive fold would
 * need the two sides to sort identically, which means matching JavaScript's
 * UTF-16 code-unit ordering against Go's byte-wise one. They disagree on any
 * filename outside the BMP.
 *
 * Only this box's hashes are ever compared against this box's records, so
 * nothing here has to agree with the Go implementation for correctness. It is
 * kept identical anyway (see syncAppendTuple in cmd/abox-cli/sync.go) so the
 * two can be held up side by side.
 */
export class SyncHash {
  private acc = Buffer.alloc(32);
  private count = 0;

  /**
   * Fold one entry in.
   *
   * The tuple is only the fields pushCompare consults, at the precision it
   * consults them. Everything it ignores is left out, because a hash covering
   * more than the comparison does would report "moved" on changes push would
   * never act on: permission bits (pushCompare ignores mode outright, so a
   * chmod -R would look like a moved tree) and content (this walk computes no
   * sha256, which is why pushCompare's shaDiff can never fire here).
   */
  add(e: { path: string; type: string; size?: number; mtime_ns?: number; target?: string }): void {
    const parts = [e.path, e.type];
    if (e.type === 'file') {
      parts.push(String(e.size ?? 0));
      // Down through ms rather than dividing the ns value by 1e9. A unix time
      // in nanoseconds is past 2^53, so mtime_ns is already a double quantised
      // to a few hundred ns — harmless at one-second resolution, and both box
      // hashes come from the same pushWalk either way, so the two are compared
      // on equal footing. Math.floor, not truncation, to match the client's
      // floor-toward-negative-infinity on a pre-1970 mtime.
      parts.push(String(Math.floor((e.mtime_ns ?? 0) / 1e6 / SYNC_MTIME_QUANTUM_MS)));
    } else {
      parts.push('0', '0');
    }
    parts.push(e.type === 'symlink' ? (e.target ?? '') : '');
    const sum = crypto.createHash('sha256').update(parts.join('\n') + '\n').digest();
    for (let i = 0; i < 32; i++) this.acc[i] ^= sum[i];
    this.count += 1;
  }

  get entries(): number { return this.count; }

  digest(): string {
    const tail = Buffer.alloc(8);
    tail.writeBigUInt64LE(BigInt(this.count));
    return crypto.createHash('sha256').update(Buffer.concat([this.acc, tail])).digest('hex');
  }
}

/**
 * Compare a live pair of hashes against what was agreed.
 *
 * A match is conclusive; a mismatch is advisory. The mtime quantum has no
 * tolerance while pushCompare has a one-second one, so two states it would call
 * identical can hash differently at a bucket boundary — which costs a live diff
 * and never a wrong answer. The reverse cannot happen: the tuple is a superset
 * of what pushCompare consults, so two states it calls different never hash the
 * same.
 */
export function syncClassify(rec: SyncRecord | null, localHash: string, boxHash: string): SyncStateName {
  if (!rec) return 'no_record';
  const localMoved = rec.lh !== localHash;
  const boxMoved = rec.bh !== boxHash;
  if (localMoved && boxMoved) return 'both_moved';
  if (localMoved) return 'local_moved';
  if (boxMoved) return 'box_moved';
  return 'in_sync';
}
