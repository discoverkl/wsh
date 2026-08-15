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
/**
 * Rules wsh enforces itself, whatever the image says.
 *
 * Everything else in this file is the *image's* policy, and it is right that it
 * is: the box owner decides what their env-bound config is. These are not
 * policy. They are wsh's own bookkeeping about the sync protocol — the record
 * of what each machine last agreed with this box, and the copies of whatever a
 * push replaced — and both are false the instant they land on a different box.
 *
 * `push-state` is the record store's old name. It stays listed beside the
 * current one because a box that synced before the rename still has the
 * directory, and a name that stops being denied is a directory that becomes
 * pushable.
 *
 * The last two are the *client's* half of the same pair, under ~/.abox, and
 * they are denied here because a deny rule filters the client's manifest as
 * well as this box's walk — so one list closes both directions at once.
 *
 *   ~/.abox/replica names the machine every record is keyed by. Carry it and
 *   the destination becomes a second machine claiming the first one's identity
 *   — and a box is a client too. A pushes to C; B, holding A's id, pushes to C;
 *   A's next check reads B's record as its own and answers in_sync. That is the
 *   silent skip the record exists to prevent, reached from the other end.
 *
 *   ~/.abox/trash is the client's undo, and it is the wrong box's undo the
 *   moment it lands — the same argument as /.wsh/trash/, in the other
 *   direction. Without the rule a `pull ~ --delete` also names both local-only
 *   and removes them, since the box does not have them.
 *
 * The record is the dangerous one, and it is dangerous in the unsafe direction:
 * a mirrored record says "when we last agreed, my copy hashed to X" about a
 * tree that was never party to the agreement, so the target would read its own
 * freshly-overwritten files as matching and conclude nobody had changed it.
 * That is precisely the conclusion the whole design exists to make a box earn.
 *
 * Relying on `/etc/abox/push-ignore.d/` for that would make a safety property
 * of wsh depend on a file shipped by a different repo on its own release
 * cadence — so a box running last month's image would silently lose the
 * guarantee, with no symptom until someone lost work. wsh creates these
 * directories; wsh protects them.
 */
const PUSH_BUILTIN_DENY = `
/.wsh/sync-state/
/.wsh/push-state/
/.wsh/trash/
/.abox/replica
/.abox/trash/
`;

export function loadPushIgnoreDir(dir: string = PUSH_IGNORE_DIR): PushIgnoreRule[] {
  // Built-ins first, so they apply even when the directory is missing entirely
  // — an older image, or a host that isn't a box.
  const rules: PushIgnoreRule[] = compilePushIgnore(PUSH_BUILTIN_DENY, 'wsh built-in');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.conf')).sort();
  } catch {
    return rules;
  }
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
