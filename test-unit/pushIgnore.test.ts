// Unit tests for pushIgnore — the target box's deny rules for inbound
// `abox-cli push`.
//
// Two things are worth pinning beyond plain glob behaviour, because both are
// what the rules exist for rather than incidental:
//   - a rule hides a path from the DELETE side too, not just the upload side;
//   - matching is order-independent, since the manifest is an untrusted flat
//     list that may name a child without its parent.
// The delete-side half is enforced in server.ts (it filters both sides of the
// diff); here we pin the matcher property it rests on.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePushIgnore, pushIgnored } from '../src/pushIgnore';

const rules = (text: string) => compilePushIgnore(text, 'test.conf');
const hit = (text: string, p: string, isDir = false) =>
  pushIgnored(rules(text), p, isDir) !== null;

describe('pushIgnore — the shipped rules', () => {
  const shipped = rules(`
    /.abox/active-tokens.json
    /.trae/traecli.yaml
    /.trae/traecli.toml
    /.claude-code-router/config.json
  `);
  const denied = (p: string) => pushIgnored(shipped, p, false) !== null;

  it('hides exactly the env-bound config, and nothing adjacent', () => {
    assert.ok(denied('.trae/traecli.yaml'));
    assert.ok(denied('.trae/traecli.toml'));
    assert.ok(denied('.claude-code-router/config.json'));
    assert.ok(denied('.abox/active-tokens.json'));

    // The rest of those directories is user data and must travel.
    assert.ok(!denied('.trae/sessions/abc.json'));
    assert.ok(!denied('.claude-code-router/plugins/foo.js'));
    assert.ok(!denied('.abox/setup.sh'));
  });

  it('does not match the same basename deeper in the tree', () => {
    // Anchored rules only. A checked-in copy in a project is the user's file.
    assert.ok(!denied('workspace/abox/img/shared/traecli/traecli.yaml'));
    assert.ok(!denied('workspace/notes/.trae/traecli.yaml'));
  });
});

describe('pushIgnore — anchoring', () => {
  it('anchors a pattern containing a slash', () => {
    assert.ok(hit('/.trae/traecli.yaml', '.trae/traecli.yaml'));
    assert.ok(!hit('/.trae/traecli.yaml', 'sub/.trae/traecli.yaml'));
    // Leading slash is optional when the pattern already has an inner slash.
    assert.ok(hit('.trae/traecli.yaml', '.trae/traecli.yaml'));
    assert.ok(!hit('.trae/traecli.yaml', 'sub/.trae/traecli.yaml'));
  });

  it('matches a bare name at any depth — the gitignore default, not docker\'s', () => {
    assert.ok(hit('traecli.yaml', 'traecli.yaml'));
    assert.ok(hit('traecli.yaml', 'a/b/c/traecli.yaml'));
    assert.ok(!hit('traecli.yaml', 'a/traecli.yaml.bak'));
  });
});

describe('pushIgnore — directories', () => {
  it('hides everything beneath a matched directory', () => {
    assert.ok(hit('/node_modules', 'node_modules', true));
    assert.ok(hit('/node_modules', 'node_modules/pkg/index.js'));
    assert.ok(!hit('/node_modules', 'src/node_modules/pkg/index.js'));
  });

  it('honours a trailing slash as directories-only', () => {
    assert.ok(hit('cache/', 'a/cache', true));
    assert.ok(hit('cache/', 'a/cache/blob'));
    // A regular file named `cache` is not a directory, so the rule misses it.
    assert.ok(!hit('cache/', 'a/cache', false));
  });

  it('is order-independent — a child matches without its parent being seen', () => {
    // The incoming manifest is a flat list from a client we do not control; it
    // may list a child first, or omit the parent entirely.
    const r = rules('/.trae/');
    assert.ok(pushIgnored(r, '.trae/traecli.yaml', false));
    assert.ok(pushIgnored(r, '.trae/deep/nested/file.txt', false));
  });
});

describe('pushIgnore — wildcards', () => {
  it('keeps * inside one segment', () => {
    assert.ok(hit('*.pyc', 'a/b/mod.pyc'));
    assert.ok(!hit('/build/*.log', 'build/sub/x.log'));
    assert.ok(hit('/build/*.log', 'build/x.log'));
  });

  it('crosses segments with **', () => {
    assert.ok(hit('/src/**/test', 'src/test', true));
    assert.ok(hit('/src/**/test', 'src/a/b/test', true));
    assert.ok(hit('**/tmp', 'a/b/tmp'));
    assert.ok(hit('/logs/**', 'logs/2026/07/a.txt'));
  });

  it('treats ? as a single non-slash character', () => {
    assert.ok(hit('/a?c', 'abc'));
    assert.ok(!hit('/a?c', 'a/c'));
  });
});

describe('pushIgnore — parsing', () => {
  it('skips comments and blank lines', () => {
    const r = rules('# a comment\n\n   \n/real.txt\n');
    assert.equal(r.length, 1);
    assert.equal(r[0].pattern, '/real.txt');
  });

  it('has no negation — a ! line is a literal name, not a re-include', () => {
    // Dropping `!` is what lets a matched directory be pruned during a walk.
    // Pin it so nobody "fixes" it into a half-working negation.
    const r = rules('/a\n!/a/keep.txt');
    assert.ok(pushIgnored(r, 'a/keep.txt', false), 'the ! line must not re-include');
    assert.equal(r.length, 2);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    assert.ok(hit('/a+b.txt', 'a+b.txt'));
    assert.ok(!hit('/a+b.txt', 'aab.txt'));
    assert.ok(hit('/x[1].log', 'x[1].log'));
  });

  it('reports which file and line matched', () => {
    const r = compilePushIgnore('/.trae/traecli.yaml\n', '20-traecli.conf');
    const m = pushIgnored(r, '.trae/traecli.yaml', false);
    assert.equal(m?.source, '20-traecli.conf');
    assert.equal(m?.pattern, '/.trae/traecli.yaml');
  });

  it('matches nothing when there are no rules', () => {
    assert.equal(pushIgnored([], 'anything/at/all', false), null);
  });
});

// The frame conversion, pinned directly. Deny rules are written against $HOME
// but manifest paths arrive relative to the pushed directory, and getting that
// join wrong fails open — the rule just doesn't fire. Both historical bugs were
// in this one expression, so it gets its own test rather than only being covered
// through the handlers.
describe('pushHomePrefix', () => {
  // Mirrors server.ts. Kept here because the rule it encodes ('.' means the
  // frames coincide) is what the two bugs got wrong.
  const pushHomePrefix = (rel: string) => (rel === '.' ? '' : rel + '/');

  it('prefixes a subdirectory push', () => {
    assert.equal(pushHomePrefix('workspace/101') + 'src/main.go', 'workspace/101/src/main.go');
    assert.equal(pushHomePrefix('.trae') + 'traecli.yaml', '.trae/traecli.yaml');
  });

  it('is empty for a whole-box push, where the two frames coincide', () => {
    // `${rel}/${p}` here would yield './.trae/traecli.yaml', which matches no
    // anchored rule — silently disarming deny on the one shape it exists for.
    assert.equal(pushHomePrefix('.'), '');
    assert.equal(pushHomePrefix('.') + '.trae/traecli.yaml', '.trae/traecli.yaml');
  });

  it('produces paths an anchored rule actually matches, in both shapes', () => {
    const r = rules('/.trae/traecli.yaml');
    for (const [rel, local] of [['.trae', 'traecli.yaml'], ['.', '.trae/traecli.yaml']] as const) {
      assert.ok(
        pushIgnored(r, pushHomePrefix(rel) + local, false),
        `rel=${rel} local=${local} should match the $HOME-anchored rule`,
      );
    }
  });
});

// --- Shared conformance vectors ---
//
// The same file cmd/abox-cli/pushignore_test.go reads. The grammar has two
// implementations and they must agree exactly: the client ships its skip
// patterns to the box, which re-parses them here. A pattern one side matches and
// the other doesn't leaves the path out of the manifest but present on the box,
// and the diff resolves that by deleting it — so drift is silent data loss.
//
// Skipped when the abox repo isn't a sibling checkout (a standalone xterm clone,
// or a CI job that only fetches this repo). The Go side always runs them, so at
// least one implementation is pinned unconditionally; both are pinned in the
// side-by-side layout this pair is actually developed in.
describe('pushIgnore — shared vectors', () => {
  interface Vector {
    pattern: string;
    path: string;
    isDir: boolean;
    want: boolean;
    why: string;
  }

  const load = (): Vector[] | null => {
    for (const rel of ['../abox/cmd/abox-cli/testdata/ignore_vectors.json',
                       '../../abox/cmd/abox-cli/testdata/ignore_vectors.json']) {
      try {
        return JSON.parse(readFileSync(rel, 'utf8')).cases as Vector[];
      } catch { /* try the next layout */ }
    }
    return null;
  };

  const vectors = load();

  it('agrees with the Go implementation on every shared case', { skip: vectors ? false : 'abox repo not a sibling checkout' }, () => {
    assert.ok(vectors && vectors.length >= 20, 'expected a meaningful vector set');
    for (const v of vectors!) {
      const got = pushIgnored(rules(v.pattern), v.path, v.isDir) !== null;
      assert.equal(got, v.want,
        `pattern ${JSON.stringify(v.pattern)} vs ${JSON.stringify(v.path)} (dir=${v.isDir}) — ${v.why}`);
    }
  });
});
