// Unit tests for the codex adapter's per-line fold logic.
//
// Pins the codex-specific sum rule (input_tokens only — NOT input+cached —
// for `in`; output + reasoning_output for `out`) and the sticky model
// cursor that turn_context lines maintain across event_msg lines.
// Surrounding adoption/scheduling logic is integration-tested by
// `metrics_tokens_codex_integration_test.go`.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { TokenSnapshot } from '../../src/agentTokens/shared';
import { foldCodexLine } from '../../src/agentTokens/codex';

function emptyTokens(): Record<string, TokenSnapshot> { return {}; }
function modelRef(initial = '') { return { value: initial }; }

const MODEL = 'gpt-5';

function turnContext(model: string, ts = '2026-05-26T12:00:00Z'): string {
  return JSON.stringify({ type: 'turn_context', timestamp: ts, payload: { model } });
}

function tokenCountLine(ts: string, last: Record<string, number>): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts,
    payload: { type: 'token_count', info: { last_token_usage: last } },
  });
}

describe('foldCodexLine — sum rules', () => {
  it('`in` = input_tokens ONLY; cached_input_tokens is a subset and must NOT be added', () => {
    const t = emptyTokens();
    const ref = modelRef();
    foldCodexLine(turnContext(MODEL), t, ref, undefined);
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', {
        input_tokens: 100,
        cached_input_tokens: 60, // verified: input already includes cached
        output_tokens: 30,
        reasoning_output_tokens: 0,
      }),
      t,
      ref,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 100, out: 30 } });
  });

  it('`out` = output_tokens + reasoning_output_tokens', () => {
    const t = emptyTokens();
    const ref = modelRef();
    foldCodexLine(turnContext(MODEL), t, ref, undefined);
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', {
        input_tokens: 10,
        output_tokens: 50,
        reasoning_output_tokens: 30,
      }),
      t,
      ref,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 10, out: 80 } });
  });

  it('accumulates across multiple token_count lines', () => {
    const t = emptyTokens();
    const ref = modelRef();
    foldCodexLine(turnContext(MODEL), t, ref, undefined);
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', { input_tokens: 10, output_tokens: 5 }),
      t,
      ref,
      undefined,
    );
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:02Z', { input_tokens: 20, output_tokens: 7 }),
      t,
      ref,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 30, out: 12 } });
  });
});

describe('foldCodexLine — sticky model cursor', () => {
  it('turn_context updates modelRef; subsequent token_counts credit that model', () => {
    const t = emptyTokens();
    const ref = modelRef();
    foldCodexLine(turnContext('gpt-5'), t, ref, undefined);
    assert.equal(ref.value, 'gpt-5');
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', { input_tokens: 10, output_tokens: 5 }),
      t,
      ref,
      undefined,
    );
    foldCodexLine(turnContext('gpt-5.1'), t, ref, undefined);
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:02Z', { input_tokens: 20, output_tokens: 7 }),
      t,
      ref,
      undefined,
    );
    assert.deepEqual(t, {
      'gpt-5':   { in: 10, out: 5 },
      'gpt-5.1': { in: 20, out: 7 },
    });
  });

  it('token_count BEFORE any turn_context is dropped (no model to credit)', () => {
    const t = emptyTokens();
    const ref = modelRef();
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', { input_tokens: 10, output_tokens: 5 }),
      t,
      ref,
      undefined,
    );
    assert.deepEqual(t, {});
  });

  it('turn_context with empty payload.model leaves the prior cursor intact', () => {
    const t = emptyTokens();
    const ref = modelRef('gpt-5');
    foldCodexLine(turnContext(''), t, ref, undefined);
    assert.equal(ref.value, 'gpt-5');
  });
});

describe('foldCodexLine — minTs gate', () => {
  it('drops token_count lines whose timestamp is strictly before minTs', () => {
    const t = emptyTokens();
    const ref = modelRef(MODEL);
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldCodexLine(
      tokenCountLine('2026-05-26T11:59:59Z', { input_tokens: 100, output_tokens: 10 }),
      t,
      ref,
      minTs,
    );
    assert.deepEqual(t, {});
  });

  it('NEVER drops turn_context — model state must stay consistent across the replay boundary', () => {
    const t = emptyTokens();
    const ref = modelRef();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    // pre-minTs turn_context: still updates the cursor so post-minTs token_counts
    // know which model to credit.
    foldCodexLine(turnContext('gpt-5', '2026-05-26T11:59:00Z'), t, ref, minTs);
    assert.equal(ref.value, 'gpt-5');
    foldCodexLine(
      tokenCountLine('2026-05-26T12:00:01Z', { input_tokens: 1, output_tokens: 1 }),
      t,
      ref,
      minTs,
    );
    assert.deepEqual(t, { 'gpt-5': { in: 1, out: 1 } });
  });
});
