/*
 * Binary → adapter dispatch.
 *
 * BINARY_TO_AGENT is the wsh-side classifier and a SUBSET of the Go side
 * (internal/gateway/metrics_agent.go) — every entry here MUST also be in
 * metrics_agent.go with the same agent value. The Go map may include
 * extras (e.g. a binary whose token capture isn't implemented yet);
 * those sessions still classify correctly for bytes/sessions/active —
 * they just don't carry tokens_in/tokens_out.
 *
 * captureTokens is the single entry point the metrics hooks call. Pure
 * best-effort: any error → empty map → no `tokens` field on the event.
 */

import type { SessionContext, TokenAdapter, TokenSnapshot } from './shared';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { traecliAdapter } from './traecli';

// Returns "" for non-agent binaries; the dispatcher skips them entirely.
const BINARY_TO_AGENT: Record<string, string> = {
  claude:       'claude-code',
  cco:          'claude-code',
  ccr:          'claude-code',
  ccrc:         'claude-code',
  codex:        'codex',
  coco:         'traecli',
  traecli:      'traecli',
  'trae-agent': 'traecli',
  ta:           'traecli',
};

export function agentOf(binary: string): string {
  return BINARY_TO_AGENT[binary] || '';
}

const ADAPTERS: Record<string, TokenAdapter> = {
  claude:       claudeAdapter,
  cco:          claudeAdapter,
  ccr:          claudeAdapter,
  ccrc:         claudeAdapter,
  codex:        codexAdapter,
  coco:         traecliAdapter,
  traecli:      traecliAdapter,
  'trae-agent': traecliAdapter,
  ta:           traecliAdapter,
};

function adapterFor(binary: string): TokenAdapter | null {
  return ADAPTERS[binary] || null;
}

export async function captureTokens(
  s: SessionContext,
): Promise<Record<string, TokenSnapshot>> {
  const a = adapterFor(s.binary);
  if (!a) return {};
  try {
    return await a.tokensFor(s);
  } catch {
    return {};
  }
}
