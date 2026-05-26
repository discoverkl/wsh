// Unit tests for the traecli adapter's per-event fold logic.
//
// Pins the traecli-specific sum rule (prompt + cached for `in`,
// completion + reasoning for `out`) and the
// `message.message.role === 'assistant'`-only filter that drops user/tool
// events AND the `agent_end.output` mirror event coco emits at session
// close — counting `agent_end` instead would under-count multi-turn loops.
// Surrounding adoption/scheduling is integration-tested by
// `metrics_tokens_traecli_integration_test.go`.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { TokenSnapshot } from '../../src/agentTokens/shared';
import { foldTraeEvent } from '../../src/agentTokens/traecli';

function emptyTokens(): Record<string, TokenSnapshot> { return {}; }

const MODEL = 'kimi-k2.5';
const DEFAULT_CREATED_AT = '2026-05-26T12:00:00Z';

// Build an events.jsonl line matching coco's per-turn shape:
//   { created_at, message: { message: { role, response_meta:{usage}, extra:{_source_model} } } }
function event(args: {
  role?: string;
  model?: string;
  prompt?: number;
  cached?: number;
  completion?: number;
  reasoning?: number;
  createdAt?: string;
}): string {
  const usage: any = {};
  if (args.prompt !== undefined) usage.prompt_tokens = args.prompt;
  if (args.cached !== undefined) usage.prompt_token_details = { cached_tokens: args.cached };
  if (args.completion !== undefined) usage.completion_tokens = args.completion;
  if (args.reasoning !== undefined) usage.completion_token_details = { reasoning_tokens: args.reasoning };
  const inner: any = {
    role: args.role ?? 'assistant',
    response_meta: { usage },
  };
  if (args.model !== undefined) inner.extra = { _source_model: args.model };
  return JSON.stringify({
    created_at: args.createdAt ?? DEFAULT_CREATED_AT,
    message: { message: inner },
  });
}

describe('foldTraeEvent — sum rules', () => {
  it('`in` = prompt + cached; `out` = completion + reasoning', () => {
    const t = emptyTokens();
    foldTraeEvent(
      event({ model: MODEL, prompt: 100, cached: 50, completion: 30, reasoning: 20 }),
      t,
      undefined,
    );
    assert.deepEqual(t, { [MODEL]: { in: 150, out: 50 } });
  });

  it('accumulates across multiple assistant events', () => {
    const t = emptyTokens();
    foldTraeEvent(event({ model: MODEL, prompt: 10, completion: 5 }), t, undefined);
    foldTraeEvent(event({ model: MODEL, prompt: 20, completion: 7 }), t, undefined);
    assert.deepEqual(t, { [MODEL]: { in: 30, out: 12 } });
  });

  it('keeps per-model totals separate', () => {
    const t = emptyTokens();
    foldTraeEvent(event({ model: 'kimi', prompt: 100, completion: 10 }), t, undefined);
    foldTraeEvent(event({ model: 'glm',  prompt: 50,  completion: 5 }),  t, undefined);
    assert.deepEqual(t, {
      kimi: { in: 100, out: 10 },
      glm:  { in: 50,  out: 5 },
    });
  });
});

describe('foldTraeEvent — role filter', () => {
  it('drops user/tool/system roles', () => {
    const t = emptyTokens();
    for (const role of ['user', 'tool', 'system', '']) {
      foldTraeEvent(event({ role, model: MODEL, prompt: 1, completion: 1 }), t, undefined);
    }
    assert.deepEqual(t, {});
  });

  it('drops the agent_end mirror (no `message.message` payload)', () => {
    // coco emits this once at session close with the FINAL turn's usage;
    // counting it as a source would under-count multi-turn loops.
    const t = emptyTokens();
    const line = JSON.stringify({
      created_at: DEFAULT_CREATED_AT,
      agent_end: {
        output: {
          role: 'assistant',
          response_meta: { usage: { prompt_tokens: 100, completion_tokens: 10 } },
          extra: { _source_model: MODEL },
        },
      },
    });
    foldTraeEvent(line, t, undefined);
    assert.deepEqual(t, {});
  });

  it('drops assistant event with no `_source_model` (cannot attribute)', () => {
    const t = emptyTokens();
    foldTraeEvent(event({ prompt: 100, completion: 10 }), t, undefined);
    assert.deepEqual(t, {});
  });

  it('drops assistant event with zero in AND zero out', () => {
    const t = emptyTokens();
    foldTraeEvent(event({ model: MODEL, prompt: 0, completion: 0 }), t, undefined);
    assert.deepEqual(t, {});
  });

  it('survives malformed JSON without throwing', () => {
    const t = emptyTokens();
    foldTraeEvent('{not json', t, undefined);
    foldTraeEvent('', t, undefined);
    assert.deepEqual(t, {});
  });
});

describe('foldTraeEvent — minTs gate', () => {
  it('drops events whose created_at is strictly before minTs', () => {
    const t = emptyTokens();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldTraeEvent(
      event({
        model: MODEL, prompt: 100, completion: 10,
        createdAt: new Date(minTs - 1).toISOString(),
      }),
      t,
      minTs,
    );
    assert.deepEqual(t, {});
  });

  it('keeps events whose created_at is >= minTs', () => {
    const t = emptyTokens();
    const minTs = Date.parse('2026-05-26T12:00:00Z');
    foldTraeEvent(
      event({
        model: MODEL, prompt: 100, completion: 10,
        createdAt: new Date(minTs).toISOString(),
      }),
      t,
      minTs,
    );
    assert.deepEqual(t, { [MODEL]: { in: 100, out: 10 } });
  });
});
