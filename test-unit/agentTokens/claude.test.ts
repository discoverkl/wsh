// Unit tests for the claude adapter's per-line fold logic.
//
// Pins the canonical sum rule (input + cache_creation + cache_read for `in`,
// output for `out`) and the minTs gate. The surrounding adoption/scheduling
// logic is integration-tested by `metrics_tokens_claude_integration_test.go`.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { TokenSnapshot } from '../../src/agentTokens/shared';
import { foldClaudeLine } from '../../src/agentTokens/claude';

function emptyTokens(): Record<string, TokenSnapshot> { return {}; }

const MODEL = 'claude-opus-4-7';

function assistantLine(ts: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { model: MODEL, usage },
  });
}

describe('foldClaudeLine — sum rules', () => {
  it('adds input + cache_creation + cache_read into `in`; output_tokens → `out`', () => {
    const t = emptyTokens();
    foldClaudeLine(
      assistantLine('2026-05-26T12:00:00Z', {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 50,
      }),
      t,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 600, out: 50 } });
  });

  it('accumulates across lines for the same model', () => {
    const t = emptyTokens();
    foldClaudeLine(
      assistantLine('2026-05-26T12:00:00Z', { input_tokens: 10, output_tokens: 5 }),
      t,
      undefined,
    );
    foldClaudeLine(
      assistantLine('2026-05-26T12:01:00Z', { input_tokens: 20, output_tokens: 7 }),
      t,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 30, out: 12 } });
  });

  it('keeps per-model totals separate when model changes mid-session', () => {
    const t = emptyTokens();
    foldClaudeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-26T12:00:00Z',
        message: { model: 'opus', usage: { input_tokens: 100, output_tokens: 10 } },
      }),
      t,
      undefined,
    );
    foldClaudeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-26T12:01:00Z',
        message: { model: 'sonnet', usage: { input_tokens: 50, output_tokens: 5 } },
      }),
      t,
      undefined,
    );
    assert.deepEqual(t, {
      opus: { in: 100, out: 10 },
      sonnet: { in: 50, out: 5 },
    });
  });
});

describe('foldClaudeLine — line filters', () => {
  it('ignores non-assistant lines (user, system, permission-mode, etc.)', () => {
    const t = emptyTokens();
    foldClaudeLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }), t, undefined);
    foldClaudeLine(JSON.stringify({ type: 'system', message: {} }), t, undefined);
    foldClaudeLine(JSON.stringify({ type: 'permission-mode', mode: 'default' }), t, undefined);
    assert.deepEqual(t, {});
  });

  it('ignores lines with no model name', () => {
    const t = emptyTokens();
    foldClaudeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-26T12:00:00Z',
        message: { usage: { input_tokens: 10, output_tokens: 5 } }, // no model
      }),
      t,
      undefined,
    );
    assert.deepEqual(t, {});
  });

  it('ignores lines with zero in AND zero out', () => {
    const t = emptyTokens();
    foldClaudeLine(
      assistantLine('2026-05-26T12:00:00Z', { input_tokens: 0, output_tokens: 0 }),
      t,
      undefined,
    );
    assert.deepEqual(t, {});
  });

  it('survives malformed JSON without throwing', () => {
    const t = emptyTokens();
    foldClaudeLine('{not json', t, undefined);
    foldClaudeLine('', t, undefined);
    assert.deepEqual(t, {});
  });
});

describe('foldClaudeLine — minTs gate (resume catch-up)', () => {
  it('drops lines whose timestamp is strictly before minTs', () => {
    const t = emptyTokens();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldClaudeLine(
      assistantLine('2026-05-26T11:59:59Z', { input_tokens: 100, output_tokens: 10 }),
      t,
      minTs,
    );
    assert.deepEqual(t, {});
  });

  it('keeps lines whose timestamp is >= minTs', () => {
    const t = emptyTokens();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldClaudeLine(
      assistantLine('2026-05-26T12:00:00Z', { input_tokens: 100, output_tokens: 10 }),
      t,
      minTs,
    );
    assert.deepEqual(t, { [MODEL]: { in: 100, out: 10 } });
  });

  it('falls through (credits) when timestamp is missing/unparseable — consistent with the no-minTs path', () => {
    const t = emptyTokens();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldClaudeLine(
      JSON.stringify({
        type: 'assistant',
        // no timestamp field
        message: { model: MODEL, usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      t,
      minTs,
    );
    assert.deepEqual(t, { [MODEL]: { in: 1, out: 1 } });
  });
});
