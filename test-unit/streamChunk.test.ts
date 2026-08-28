// Unit tests for streamChunk — the chunk-boundary rules the job stream's
// resumability rests on.
//
// The property under test is the whole point: decoding and stripping a log must
// give the same bytes regardless of where the reads were cut. A live stream is
// cut by tick timing and the 1 MiB read cap; a replay after a reconnect reads
// the same log in completely different pieces. If those two disagree, a client
// resuming by byte count misaligns against its own earlier output — silently
// eating what follows, or reprinting what came before.
//
// utf8SafeEnd already held codepoints back. escSafeEnd is the missing half:
// stripEphemeralSequences matches on whatever chunk it is handed, so a sequence
// split across two reads matches in NEITHER half and survives, while the same
// bytes read whole are stripped.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { chunkSafeEnd, escSafeEnd, stripEphemeralSequences, utf8SafeEnd, ESC_MAX_PENDING } from '../src/streamChunk';

const ESC = '\x1b';

// feed replays `log` through the same pending-buffer discipline the stream
// handler uses, cut at the given boundaries, and returns what a client would
// have seen in total.
function feed(log: Buffer, cuts: number[]): string {
  let pending = Buffer.alloc(0);
  let out = '';
  let at = 0;
  for (const cut of [...cuts, log.length]) {
    if (cut <= at) continue;
    const chunk = log.subarray(at, cut);
    at = cut;
    const pend = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const safeEnd = chunkSafeEnd(pend);
    pending = pend.subarray(safeEnd);
    const decodable = pend.subarray(0, safeEnd);
    if (decodable.length) out += stripEphemeralSequences(decodable).toString('utf8');
  }
  // End of job: whatever is still pending is genuinely trailing.
  if (pending.length) out += stripEphemeralSequences(pending).toString('utf8');
  return out;
}

describe('escSafeEnd — where a chunk may end', () => {
  it('holds back a bare trailing ESC', () => {
    const b = Buffer.from(`hi${ESC}`);
    assert.equal(escSafeEnd(b), 2);
  });

  it('holds back an unterminated CSI', () => {
    const b = Buffer.from(`hi${ESC}[6`);
    assert.equal(escSafeEnd(b), 2);
  });

  it('releases a terminated CSI', () => {
    const b = Buffer.from(`hi${ESC}[6n`);
    assert.equal(escSafeEnd(b), b.length);
  });

  it('holds back an unterminated OSC', () => {
    const b = Buffer.from(`hi${ESC}]4;1;?`);
    assert.equal(escSafeEnd(b), 2);
  });

  it('releases an OSC terminated by BEL', () => {
    const b = Buffer.from(`hi${ESC}]4;1;?\x07`);
    assert.equal(escSafeEnd(b), b.length);
  });

  it('releases an OSC terminated by ST', () => {
    const b = Buffer.from(`hi${ESC}]11;?${ESC}\\`);
    assert.equal(escSafeEnd(b), b.length);
  });

  it('holds back an unterminated DCS', () => {
    const b = Buffer.from(`hi${ESC}P$q m`);
    assert.equal(escSafeEnd(b), 2);
  });

  it('releases a two-byte escape', () => {
    const b = Buffer.from(`hi${ESC}c`);
    assert.equal(escSafeEnd(b), b.length);
  });

  it('does not stall on a stray ESC in ordinary output', () => {
    // A lone 0x1b followed by a lot of non-terminating bytes must eventually be
    // released, or the tail of a stream could be held forever.
    const b = Buffer.concat([Buffer.from(`hi${ESC}[`), Buffer.alloc(ESC_MAX_PENDING, 0x31)]);
    assert.equal(escSafeEnd(b), b.length);
  });

  it('leaves an escape-free buffer alone', () => {
    const b = Buffer.from('plain output\n');
    assert.equal(escSafeEnd(b), b.length);
  });
});

describe('chunk-independence — the property resumability needs', () => {
  // A DSR cursor query is the common case: TUIs and progress bars emit them,
  // and they are stripped, so splitting one changes the output length.
  const log = Buffer.from(`before${ESC}[6nafter\n`);

  it('a split escape sequence strips the same as a whole one', () => {
    const whole = feed(log, []);
    assert.equal(whole, 'beforeafter\n');
    for (let cut = 1; cut < log.length; cut++) {
      assert.equal(feed(log, [cut]), whole, `cut at ${cut} changed the output`);
    }
  });

  it('holds across every pair of cuts too', () => {
    const whole = feed(log, []);
    for (let a = 1; a < log.length; a++) {
      for (let b = a + 1; b < log.length; b++) {
        assert.equal(feed(log, [a, b]), whole, `cuts at ${a},${b} changed the output`);
      }
    }
  });

  it('holds for multi-byte UTF-8 as well', () => {
    const utf8 = Buffer.from(`héllo ${ESC}[6n wörld 🎉\n`);
    const whole = feed(utf8, []);
    assert.equal(whole, 'héllo  wörld 🎉\n');
    for (let cut = 1; cut < utf8.length; cut++) {
      assert.equal(feed(utf8, [cut]), whole, `cut at ${cut} changed the output`);
    }
  });

  it('holds for an OSC colour query, which is the longest shape we strip', () => {
    const osc = Buffer.from(`a${ESC}]11;?${ESC}\\b\n`);
    const whole = feed(osc, []);
    assert.equal(whole, 'ab\n');
    for (let cut = 1; cut < osc.length; cut++) {
      assert.equal(feed(osc, [cut]), whole, `cut at ${cut} changed the output`);
    }
  });

  it('preserves escapes it does not strip, wherever the cut falls', () => {
    // A colour SGR is not ephemeral; it must survive intact and identically.
    const sgr = Buffer.from(`red ${ESC}[31mtext${ESC}[0m done\n`);
    const whole = feed(sgr, []);
    assert.equal(whole, sgr.toString('utf8'));
    for (let cut = 1; cut < sgr.length; cut++) {
      assert.equal(feed(sgr, [cut]), whole, `cut at ${cut} changed the output`);
    }
  });
});

describe('utf8SafeEnd is still doing its own job', () => {
  it('holds back a split codepoint', () => {
    const b = Buffer.from('a🎉', 'utf8').subarray(0, 3); // 'a' + 2 of 4 bytes
    assert.equal(utf8SafeEnd(b), 1);
  });

  it('releases a complete one', () => {
    const b = Buffer.from('a🎉', 'utf8');
    assert.equal(utf8SafeEnd(b), b.length);
  });
});
