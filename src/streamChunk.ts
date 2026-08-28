// Chunk-boundary rules for the SSE job stream.
//
// The job stream is resumable: a client that loses the connection reconnects,
// and wsh replays the log from the start. For that to work the decoded text has
// to be a pure function of the log — the same bytes in, the same bytes out,
// no matter where the reads happened to be cut. Both functions here exist to
// make that true, and they fail in the same way when they are missing: a
// boundary lands inside something that must not be split, the two sides are
// processed independently, and the result differs from processing the whole.
//
// utf8SafeEnd covers codepoints (a split one decodes to U+FFFD). escSafeEnd
// covers escape sequences (a split one matches no strip pattern and survives).
// Chunk boundaries come from tick timing and the read cap, so they differ
// between a live stream and a replay — which is exactly when a client resuming
// by byte count would misalign, silently eating real output or reprinting old
// output.

// Strip ephemeral terminal queries/responses from scrollback data.
// These should not be replayed — replaying stale queries causes xterm.js to
// generate responses that flow back to PTY stdin as garbage (the originating
// program is long gone, so bash echoes the responses as visible text).
//
// Every query xterm.js responds to is listed here, plus responses that were
// already echoed as garbage and baked into the scrollback.
//
// Queries:
//   CSI c  / CSI > c / CSI = c    — DA1/DA2/DA3 (device attributes)
//   CSI 5 n / CSI 6 n / CSI ? 6 n — DSR (device status / cursor position)
//   CSI ? Ps $ p / CSI Ps $ p     — DECRQM (request mode)
//   CSI 14 t / 16 t / 18 t        — window/cell size queries
//   DCS $ q ... ST                — DECRQSS (request status string)
//   OSC 4;N;? / 10;? / 11;? / 12;? — color queries
// Responses:
//   CSI row ; col R / CSI ? row ; col R — CPR
//   CSI ? ... c                         — DA response
//   CSI Ps ; Ps $ y / CSI ? Ps ; Ps $ y — DECRPM (mode report)
//   CSI 8 ; rows ; cols t               — text area size response
//   DCS 0/1 $ r ... ST                  — DECRQSS response
export const ephemeralRe = new RegExp([
  '\\x1b\\[\\??[>= ]?[\\d;]*c',           // DA query + response
  '\\x1b\\[\\??\\d*n',                     // DSR query (5n, 6n, ?6n)
  '\\x1b\\[\\??\\d+;\\d+R',               // CPR response (row;colR, ?row;colR)
  '\\x1b\\[\\??\\d+\\$p',                 // DECRQM query (?Ps$p, Ps$p)
  '\\x1b\\[\\??\\d+;\\d+\\$y',            // DECRPM response (?Ps;Ps$y, Ps;Ps$y)
  '\\x1b\\[(?:14|16|18)t',                // window/cell size queries
  '\\x1b\\[8;\\d+;\\d+t',                 // text area size response
  '\\x1bP\\$q[^\\x1b]*\\x1b\\\\',         // DECRQSS query (DCS$q...ST)
  '\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\',     // DECRQSS response (DCS 0/1 $r...ST)
  '\\x1b\\](?:1[012]|4;\\d+);\\?(?:\\x07|\\x1b\\\\)', // OSC color queries
].join('|'), 'g');

export function stripEphemeralSequences(buf: Buffer): Buffer {
  // Byte-level pre-check: skip the UTF-8 decode entirely when there are no
  // escape characters. indexOf is C++-implemented; toString allocates a string
  // the size of the buffer, which dominates for large logs without escapes.
  if (buf.indexOf(0x1b) === -1) return buf;
  const str = buf.toString('utf8');
  const stripped = str.replace(ephemeralRe, '');
  return stripped.length === str.length ? buf : Buffer.from(stripped, 'utf8');
}

// Returns the index of the first byte of any trailing incomplete UTF-8
// codepoint, or buf.length if the buffer ends on a complete codepoint.
// Used to defer split codepoints to the next chunk so toString('utf8')
// doesn't emit U+FFFD across read boundaries.
export function utf8SafeEnd(buf: Buffer): number {
  // A 4-byte codepoint can have at most 3 trailing continuation bytes pending.
  for (let back = 1; back <= 3 && buf.length - back >= 0; back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue;        // continuation byte; keep walking
    if ((b & 0x80) === 0x00) return buf.length; // ASCII; whole buffer is safe
    const need =
      (b & 0xe0) === 0xc0 ? 2 :
      (b & 0xf0) === 0xe0 ? 3 :
      (b & 0xf8) === 0xf0 ? 4 : 0;
    if (need === 0) return buf.length;        // invalid lead; let toString replace
    return back === need ? buf.length : buf.length - back;
  }
  return buf.length;
}

// An unterminated escape sequence is held back at most this far. Every sequence
// ephemeralRe recognises is far shorter; the cap exists so a stray 0x1b in
// output that is not really an escape cannot stall the tail of a stream.
export const ESC_MAX_PENDING = 256;

// sequenceEnd returns the index just past the escape sequence beginning at
// `start`, or -1 when the buffer ends before the sequence terminates.
function sequenceEnd(buf: Buffer, start: number): number {
  const kind = buf[start + 1];
  if (kind === undefined) return -1;      // a bare ESC at the very end
  if (kind === 0x5b) {                    // CSI: ends on a final byte 0x40..0x7e
    for (let i = start + 2; i < buf.length; i++) {
      if (buf[i] >= 0x40 && buf[i] <= 0x7e) return i + 1;
    }
    return -1;
  }
  if (kind === 0x5d || kind === 0x50) {   // OSC / DCS: ends on BEL or on ST
    for (let i = start + 2; i < buf.length; i++) {
      if (buf[i] === 0x07) return i + 1;
      if (buf[i] === 0x1b) {
        if (i + 1 >= buf.length) return -1;       // an ST split across the cut
        if (buf[i + 1] === 0x5c) return i + 2;
      }
    }
    return -1;
  }
  return start + 2;                       // a two-byte escape, ESC \ included
}

// Returns the index at which a trailing, still-incomplete escape sequence
// begins, or buf.length when the buffer does not end inside one.
//
// Scanned forward, skipping each complete sequence, rather than from the last
// ESC backwards. An OSC or DCS is terminated by ST, which is ITSELF an ESC —
// so the last ESC in `…OSC 11;? ESC \` is the terminator, not the start, and
// searching backwards would report the sequence as complete-and-safe while the
// real sequence was still open one cut earlier. The result was a partial OSC
// emitted to the client, which is precisely the non-determinism this exists to
// prevent.
export function escSafeEnd(buf: Buffer): number {
  let i = buf.indexOf(0x1b);
  while (i !== -1) {
    const end = sequenceEnd(buf, i);
    if (end === -1) {
      // Incomplete from i to the end. Hold it back — unless it has grown past
      // anything we would ever strip, in which case it is not a sequence and
      // holding it would stall the stream.
      return buf.length - i > ESC_MAX_PENDING ? buf.length : i;
    }
    i = buf.indexOf(0x1b, end);
  }
  return buf.length;
}

// chunkSafeEnd is how far into `buf` it is safe to decode and strip right now.
// One number for both hazards, so the caller keeps a single pending buffer and
// its end-of-stream flush drains whichever kind of tail is left over.
export function chunkSafeEnd(buf: Buffer): number {
  return Math.min(utf8SafeEnd(buf), escSafeEnd(buf));
}
