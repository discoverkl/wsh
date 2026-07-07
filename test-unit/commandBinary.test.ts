// Unit tests for commandBinary — the `binary` metrics dimension derivation.
//
// Pins the two things the naive `basename(split(/\s+/)[0])` got wrong: shell
// quoting (abox-cli exec single-quotes every argv element) and leading
// `NAME=value` env-assignments. The gateway-side sanitizer (Go
// Test_SanitizeBinary) is the backstop for whatever still slips through.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { commandBinary, tokenizeCommand } from '../src/commandBinary';

describe('commandBinary', () => {
  it('returns the bare program name for a plain command', () => {
    assert.equal(commandBinary('claude'), 'claude');
    assert.equal(commandBinary('python3 -m http.server'), 'python3');
    assert.equal(commandBinary('/usr/bin/node server.js'), 'node');
    assert.equal(commandBinary('  jupyter lab --port=8888  '), 'jupyter');
  });

  it('strips the shell quoting abox-cli exec applies to every argv element', () => {
    // `abox-cli exec claude foo` ships `'claude' 'foo'`.
    assert.equal(commandBinary("'claude' 'foo'"), 'claude');
    assert.equal(commandBinary("'./run.sh' '--flag'"), 'run.sh');
    assert.equal(commandBinary('"python3" "-u"'), 'python3');
  });

  it('skips leading NAME=value env-assignments like a shell does', () => {
    assert.equal(commandBinary('FOO=bar ./run.sh'), 'run.sh');
    assert.equal(commandBinary("'FILE_B64=cGFja2FnZQ==' './deploy.sh'"), 'deploy.sh');
    assert.equal(commandBinary('A=1 B=2 node app.js'), 'node');
  });

  it('preserves documented blind spots (wrapper / compound / first-token)', () => {
    assert.equal(commandBinary('cco --resume'), 'cco'); // wrapper reported as-is
    assert.equal(commandBinary('cd x && claude'), 'cd'); // compound → first token
  });

  it('yields the first real token even when it is a flag (sanitizer is the backstop)', () => {
    // A producer that emits flags before the program (observed: metrics args
    // built from a randomly-ordered map). commandBinary can only report the
    // first real token; the gateway rejects the ones that are not program names.
    assert.equal(commandBinary("'--cmd' 'x' '--target' 'y'"), '--cmd');
  });

  it('returns empty for an empty or all-assignment command', () => {
    assert.equal(commandBinary(''), '');
    assert.equal(commandBinary('   '), '');
    assert.equal(commandBinary('FOO=bar'), '');
  });
});

describe('tokenizeCommand', () => {
  it('splits on unquoted whitespace and unquotes one level', () => {
    assert.deepEqual(tokenizeCommand("a 'b c' \"d e\""), ['a', 'b c', 'd e']);
    assert.deepEqual(tokenizeCommand('  x   y '), ['x', 'y']);
    assert.deepEqual(tokenizeCommand("it\\ s one"), ['it s', 'one']);
  });
});
