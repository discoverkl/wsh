// Unit tests for the binary→agent classifier in dispatch.ts.
//
// The Go-side counterpart (`internal/gateway/metrics_agent.go:binaryToAgent`)
// MUST stay aligned with this map per the contract comment at the top of
// dispatch.ts. If you add a binary here, mirror it there — otherwise the
// dashboard's agent dimension will diverge from wsh's token-adapter dispatch.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { agentOf } from '../../src/agentTokens/dispatch';

describe('agentOf — known binaries', () => {
  const cases: Array<[string, string]> = [
    ['claude',     'claude-code'],
    ['cco',        'claude-code'],
    ['ccr',        'claude-code'],
    ['ccrc',       'claude-code'],
    ['codex',      'codex'],
    ['coco',       'traecli'],
    ['traecli',    'traecli'],
    ['trae-agent', 'traecli'],
    ['ta',         'traecli'],
  ];
  for (const [binary, agent] of cases) {
    it(`${binary} → ${agent}`, () => {
      assert.equal(agentOf(binary), agent);
    });
  }
});

describe('agentOf — unknown binaries', () => {
  for (const binary of ['bash', 'node', 'python', 'sh', '', 'fakebinary']) {
    it(`${binary || '<empty>'} → "" (not an agent)`, () => {
      assert.equal(agentOf(binary), '');
    });
  }
});
