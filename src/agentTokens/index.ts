// Public surface — server.ts imports from './agentTokens' (this barrel).
export { agentOf, captureTokens } from './dispatch';
export { dropSession } from './shared';
export type { TokenSnapshot, SessionContext, TokenAdapter } from './shared';
