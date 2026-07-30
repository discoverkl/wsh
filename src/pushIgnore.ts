// Push ignore rules — the target box's authority over what an inbound
// `abox-cli push` is not allowed to touch.
//
// Motivating case: pushing a whole box across envs (an `office` box onto an
// `sg` box). Nearly all of /root should travel, but a few config files are
// bound to the env the image was built for — abox's build.sh rewrites their
// hostnames for prod — so copying one box's over another's points the target
// at the wrong endpoints. The rule files live in the image at
// /etc/abox/push-ignore.d/; see abox/img/push-ignore.d/README.md.
//
// Two properties carry the whole design, and both are easy to lose:
//
//   1. A matched path is invisible in BOTH directions. It is filtered out of
//      the incoming manifest (never overwritten) *and* out of the target's own
//      walk (never deleted for being absent upstream). Skipping only the
//      upload leaves the delete pass to do exactly the damage the rule exists
//      to prevent.
//   2. The rules are read here, on the target — not supplied by the client.
//      An office box does not get to decide which of an sg box's config files
//      survive contact with it.
//
// The syntax is a gitignore subset with no `!` negation. Dropping negation is
// what lets a matched directory be pruned outright during a walk (which
// matters on a 100GB box) and keeps this small enough to mirror in Go without
// the two implementations drifting.

import fs from 'fs';
import path from 'path';

export interface PushIgnoreRule {
  /** The line as written, for diagnostics. */
  pattern: string;
  /** File the rule came from, e.g. "20-traecli.conf". */
  source: string;
  /** Pattern ended in `/` — matches directories only. */
  dirOnly: boolean;
  /** Matches a slash-separated path relative to the push root. */
  re: RegExp;
}

export const PUSH_IGNORE_DIR = '/etc/abox/push-ignore.d';

/** Escape a literal character for use inside a regex. */
function escapeLiteral(c: string): string {
  return /[.+^${}()|[\]\\*?]/.test(c) ? '\\' + c : c;
}

/**
 * Translate one gitignore-subset pattern into a regex source matching a
 * slash-separated relative path. `[...]` character classes are deliberately
 * unsupported — `[` is a literal — so that the Go side can stay a direct
 * transliteration of this function.
 */
function translate(pat: string): string {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        const atSegStart = i === 0 || pat[i - 1] === '/';
        // `**/` — zero or more leading directories.
        if (atSegStart && pat[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; continue; }
        // Trailing `**`, or a `**` that isn't its own segment: cross segments.
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*';
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '/') { re += '/'; continue; }
    re += escapeLiteral(c);
  }
  return re;
}

/** Compile the contents of one rule file. Blank lines and `#` comments skipped. */
export function compilePushIgnore(text: string, source: string): PushIgnoreRule[] {
  const out: PushIgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let pat = line;
    const dirOnly = pat.endsWith('/');
    if (dirOnly) pat = pat.slice(0, -1);
    // gitignore rule: a `/` anywhere but the end anchors the pattern to the
    // root; a bare name matches at any depth. Root-anchoring everything (the
    // dockerignore model) would be wrong here — the root is a whole home
    // directory, and "never sync this name, wherever it is" is the common case.
    let anchored = pat.includes('/');
    if (pat.startsWith('/')) { anchored = true; pat = pat.slice(1); }
    if (!pat) continue;
    const body = translate(pat);
    out.push({
      pattern: line,
      source,
      dirOnly,
      re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    });
  }
  return out;
}

/**
 * Load every `*.conf` in `dir`, merged in filename order. A missing directory
 * yields no rules — an older image, or a host that isn't a box, simply has
 * nothing to protect. Non-`.conf` files are skipped so a README can live there.
 *
 * Order is cosmetic (it only affects which rule gets reported for a path);
 * with no negation in the syntax it cannot change *whether* a path matches.
 */
export function loadPushIgnoreDir(dir: string = PUSH_IGNORE_DIR): PushIgnoreRule[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.conf')).sort();
  } catch {
    return [];
  }
  const rules: PushIgnoreRule[] = [];
  for (const name of names) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    rules.push(...compilePushIgnore(text, name));
  }
  return rules;
}

/**
 * Return the rule that hides `relPath`, or null. Matching a directory hides
 * everything beneath it.
 *
 * Every ancestor prefix is tested rather than relying on a parent having been
 * pruned first: the incoming manifest is a flat list from a client we do not
 * control, so it may name `.trae/traecli.yaml` without `.trae`, or in any
 * order. Testing ancestors makes the filter order-independent, which is what
 * makes it a guarantee instead of an artifact of traversal order. Paths are a
 * handful of segments and rule counts are tiny, so the nested loop is free.
 */
export function pushIgnored(
  rules: PushIgnoreRule[],
  relPath: string,
  isDir: boolean,
): PushIgnoreRule | null {
  if (rules.length === 0 || !relPath) return null;
  const segs = relPath.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const prefix = i === segs.length ? relPath : segs.slice(0, i).join('/');
    // Every proper ancestor is a directory by construction; the leaf's own
    // type is whatever the caller says it is.
    const prefixIsDir = i < segs.length || isDir;
    for (const r of rules) {
      if (r.dirOnly && !prefixIsDir) continue;
      if (r.re.test(prefix)) return r;
    }
  }
  return null;
}
