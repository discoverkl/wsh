// Post-push hook — hand control to an image-owned script once a push has
// finished writing.
//
// Some of what a push leaves behind needs repairing: config files whose
// endpoints are bound to the build flavor of the image, a migration to re-run,
// a service to restart. Encoding that here would mean growing a config grammar
// in wsh to chase each new case, in a repo with its own release cadence. A
// script ships with the image instead, so a new repair is an image change and
// wsh's involvement stays at "run this if it's executable".
//
// The script lives outside /root, which is the property that makes this safe:
// push can only write under $HOME, so a pushed box cannot replace the hook on
// the box it is pushed to.
//
// Failure never fails the push. By the time the hook runs the files have
// landed and there is nothing to roll back, so a non-zero exit is reported and
// nothing more. Same for a hang: the hook is killed at the timeout and the push
// still returns success.

import { spawn } from 'child_process';
import fs from 'fs';

export const PUSH_POSTFIX_HOOK = '/opt/abox/bin/abox-push-postfix';

const HOOK_TIMEOUT_MS = 60_000;
const HOOK_OUTPUT_CAP = 8 * 1024;
/** Exit code reported for a hook killed at the timeout, per GNU timeout(1). */
export const HOOK_TIMEOUT_CODE = 124;

export interface PushPostfixResult {
  code: number;
  /** stdout and stderr interleaved, capped. One line per repair, by convention. */
  output: string;
}

export interface PushPostfixInput {
  hook: string;
  rel: string;
  target: string;
  added: number;
  updated: number;
  deleted: number;
}

/**
 * Run the hook, or return null if there isn't an executable one — an older
 * image, or a host that isn't a box, simply has nothing to run.
 */
export function runPushPostfix(input: PushPostfixInput): Promise<PushPostfixResult | null> {
  try {
    fs.accessSync(input.hook, fs.constants.X_OK);
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<PushPostfixResult | null>((resolve) => {
    let child;
    try {
      child = spawn(input.hook, [], {
        // No stdin. Handing the hook the list of written paths was a false
        // economy: its repairs are idempotent, so filtering by "did this push
        // touch it?" only ever skipped work that was already a no-op — and it
        // made a box that missed a repair once stay wrong, since an unchanged
        // source file is never re-sent. The hook checks what it cares about.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ABOX_PUSH_REL: input.rel,
          ABOX_PUSH_TARGET: input.target,
          ABOX_PUSH_ADDED: String(input.added),
          ABOX_PUSH_UPDATED: String(input.updated),
          ABOX_PUSH_DELETED: String(input.deleted),
        },
      });
    } catch (err) {
      resolve({ code: -1, output: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length < HOOK_OUTPUT_CAP) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: output.slice(0, HOOK_OUTPUT_CAP).trimEnd() });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(HOOK_TIMEOUT_CODE);
    }, HOOK_TIMEOUT_MS);
    timer.unref?.();

    child.on('error', () => {
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}
