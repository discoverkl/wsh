import path from 'path';

// Deriving the `binary` metrics dimension — the program name behind a session.
//
// A session's command is a shell command line: job/ad-hoc sessions run it via
// `/bin/sh -c <command>`, and `abox-cli exec` POSIX-single-quotes every argv
// element before shipping it. So the naive `basename(command.split(/\s+/)[0])`
// broke two ways: it kept the shell quoting (`'claude'` instead of `claude`)
// and, when the command led with a `NAME=value` env-assignment or the caller
// emitted args before the program, it returned that token instead of the
// program name. This module recovers the program name the way a shell would
// read it — enough of a shell to find argv[0], not a full parser.

/**
 * Minimal POSIX-ish word splitter: splits `command` on unquoted whitespace and
 * removes one level of single/double quoting and backslash escaping. It is NOT
 * a full shell parser — no expansion, no operators (`&&`, `|`), no here-docs —
 * only enough to recover the leading program name from a command line. In
 * particular it undoes the single-quoting `abox-cli exec` applies to each argv
 * element.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false; // started a token? distinguishes an empty "" token from none
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      // Single quotes are fully literal — only another quote ends them.
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      // Inside double quotes a backslash escapes only a few metacharacters.
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) cur += command[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) { tokens.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

// A leading `NAME=value` shell env-assignment (the shell consumes these before
// the program name in `FOO=bar prog args`). Matches the shell's own name rule.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Program name spawned for a session: the basename of the command's first
 * "real" token. It shell-tokenizes `command` (undoing quoting) and skips any
 * leading `NAME=value` env-assignments — so `FOO=bar ./run.sh` yields `run.sh`
 * and `'claude' '--foo'` yields `claude`, not `'claude'`.
 *
 * Best-effort by design and unchanged from the documented `binary` blind spots:
 * it does not resolve wrappers (`cco` stays `cco`), follow `cd x && prog`
 * (returns `cd`), or expand variables. A command whose first real token is
 * itself a flag — a caller that emits args before the program — yields that
 * flag; the gateway's dimension sanitizer is the backstop that keeps such
 * garbage out of the metrics store.
 */
export function commandBinary(command: string): string {
  for (const tok of tokenizeCommand(command)) {
    if (ENV_ASSIGN.test(tok)) continue;
    return path.basename(tok);
  }
  return '';
}
