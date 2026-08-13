// Unit tests for syncState — the box's half of abox's agreed-state record.
//
// Two properties carry the whole design and neither is obvious from the code:
//
//   - the fold must be order-independent, because this box's walk and the
//     pushing client's walk visit a tree in genuinely different orders;
//   - the tuple must cover exactly what pushCompare consults. More, and the
//     guard reports "moved" on changes push would never act on. Less, and a
//     match becomes a promise the comparison does not keep.
//
// The record file itself is a cache of agreements, so the tests below also pin
// that damaging it costs a prompt rather than a working box.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SyncHash, syncClassify, syncValidReplica, type SyncRecord } from '../src/syncState';

const entry = (o: Partial<{ path: string; type: string; size: number; mtime_ns: number; target: string }>) => ({
  path: 'a.txt', type: 'file', size: 5, mtime_ns: 1_700_000_000_000_000_000, ...o,
});

const fold = (es: ReturnType<typeof entry>[]): string => {
  const h = new SyncHash();
  for (const e of es) h.add(e);
  return h.digest();
};

describe('SyncHash — the fold', () => {
  it('does not depend on the order entries are visited in', () => {
    // This box emits every entry of a directory before descending into any of
    // them; the client's WalkDir yields a directory's children lexically,
    // depth-first. An order-sensitive fold would need both sides to sort
    // identically, which means matching JS UTF-16 order against Go's byte-wise
    // order — and those disagree on any filename outside the BMP.
    const es = [
      entry({ path: 'a.txt' }),
      entry({ path: 'sub', type: 'dir' }),
      entry({ path: 'sub/c.txt', size: 9 }),
      entry({ path: 'link', type: 'symlink', target: '../elsewhere' }),
    ];
    assert.equal(fold(es), fold([es[2], es[0], es[3], es[1]]));
  });

  it('counts entries, so a cancelling pair is not the empty tree', () => {
    const one = entry({});
    assert.notEqual(fold([one, one]), fold([]));
  });

  it('moves on every field pushCompare consults', () => {
    const base = fold([entry({})]);
    assert.notEqual(fold([entry({ path: 'b.txt' })]), base, 'path');
    assert.notEqual(fold([entry({ type: 'dir' })]), base, 'type');
    assert.notEqual(fold([entry({ size: 6 })]), base, 'size');
    assert.notEqual(fold([entry({ mtime_ns: 1_700_000_002_000_000_000 })]), base, 'mtime across a bucket');
    assert.notEqual(fold([entry({ type: 'symlink', target: 'elsewhere' })]), base, 'symlink target');
  });

  it('ignores sub-second mtime drift, as pushCompare does', () => {
    // pushCompare tolerates a whole second (PUSH_MTIME_TOL_NS), so a hash with
    // finer resolution would report movement the diff would never act on.
    assert.equal(fold([entry({ mtime_ns: 1_700_000_000_400_000_000 })]), fold([entry({})]));
  });

  it('reports how many entries it folded', () => {
    const h = new SyncHash();
    assert.equal(h.entries, 0);
    h.add(entry({}));
    h.add(entry({ path: 'b.txt' }));
    assert.equal(h.entries, 2);
  });
});

describe('syncClassify — who moved', () => {
  const rec: SyncRecord = { rel: 'workspace/101', fp: 'f', lh: 'L', bh: 'B', del: true, at: 1 };

  it('names each of the four states', () => {
    assert.equal(syncClassify(rec, 'L', 'B'), 'in_sync');
    assert.equal(syncClassify(rec, 'X', 'B'), 'local_moved');
    assert.equal(syncClassify(rec, 'L', 'X'), 'box_moved');
    assert.equal(syncClassify(rec, 'X', 'Y'), 'both_moved');
  });

  it('has no opinion without a record', () => {
    // Which is not the same as "unchanged": the client reads no_record as the
    // case that stops and asks.
    assert.equal(syncClassify(null, 'L', 'B'), 'no_record');
  });
});

describe('syncValidReplica', () => {
  it('accepts exactly what the client writes', () => {
    assert.ok(syncValidReplica('0123456789abcdef0123456789abcdef'));
  });

  it('rejects anything that could name a file we did not mean', () => {
    // The id becomes a filename, so a lax reader here is how a path separator
    // gets into one.
    for (const bad of ['', '../../etc/passwd', 'ABCDEF0123456789abcdef0123456789', 'short', 'g'.repeat(32), 42, null]) {
      assert.ok(!syncValidReplica(bad), String(bad));
    }
  });
});
