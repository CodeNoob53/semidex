// src/admin/bootstrap.js — env-snapshot/load helpers (Phase 4A.5a). Tests
// the pure/side-effect-controlled pieces directly; the isMainModule
// self-start block is exercised live (npm run admin), not here — importing
// bootstrap.js in a test must never itself start a server or touch a real
// .env file on disk, since import.meta.url !== the test runner's entry
// script, so the guard already prevents that. These tests confirm the
// guard actually holds and that the exported helpers behave correctly in
// isolation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv,
} from '../../../src/admin/bootstrap.js';

describe('snapshotOsEnv', () => {
  test('returns a plain-object copy, not a live reference to the input', () => {
    const env = { FOO: 'bar' };
    const snapshot = snapshotOsEnv(env);
    env.FOO = 'mutated';
    env.NEW_KEY = 'added-after-snapshot';
    assert.equal(snapshot.FOO, 'bar');
    assert.equal(snapshot.NEW_KEY, undefined);
  });

  test('defaults to the real process.env when no argument is given', () => {
    const originalMarker = process.env.SEMIDEX_BOOTSTRAP_TEST_MARKER;
    process.env.SEMIDEX_BOOTSTRAP_TEST_MARKER = 'present';
    try {
      const snapshot = snapshotOsEnv();
      assert.equal(snapshot.SEMIDEX_BOOTSTRAP_TEST_MARKER, 'present');
    } finally {
      if (originalMarker === undefined) delete process.env.SEMIDEX_BOOTSTRAP_TEST_MARKER;
      else process.env.SEMIDEX_BOOTSTRAP_TEST_MARKER = originalMarker;
    }
  });
});

describe('loadDotenvValues', () => {
  let tmpDir;
  test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'semidex-bootstrap-test-')); });
  test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('parses a real .env-shaped file without touching process.env', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'OLLAMA_URL=http://from-file:11434\nASK_MODEL=file-model\n');
    // process.env is a special host object — comparing it directly against
    // a plain-object snapshot via deepEqual fails on internal
    // representation differences even with identical content, so compare
    // two plain snapshots instead (this is what actually proves no key was
    // added/changed).
    const before = { ...process.env };
    const values = loadDotenvValues(envPath);
    const after = { ...process.env };
    assert.deepEqual(values, { OLLAMA_URL: 'http://from-file:11434', ASK_MODEL: 'file-model' });
    assert.deepEqual(after, before, 'loadDotenvValues must not mutate process.env');
  });

  test('returns an empty object when the file does not exist, never throws', () => {
    const values = loadDotenvValues(join(tmpDir, 'nonexistent.env'));
    assert.deepEqual(values, {});
  });

  test('handles quoted and commented values the same way dotenv.parse does', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, '# a comment\nQUOTED="value with spaces"\nBARE=plain\n');
    const values = loadDotenvValues(envPath);
    assert.equal(values.QUOTED, 'value with spaces');
    assert.equal(values.BARE, 'plain');
  });
});

describe('applyDotenvValues', () => {
  test('fills a gap in the target env object', () => {
    const env = {};
    applyDotenvValues({ OLLAMA_URL: 'http://dotenv:11434' }, env);
    assert.equal(env.OLLAMA_URL, 'http://dotenv:11434');
  });

  test('never overrides a key already present in the target env object', () => {
    const env = { OLLAMA_URL: 'http://os-set:11434' };
    applyDotenvValues({ OLLAMA_URL: 'http://dotenv:11434' }, env);
    assert.equal(env.OLLAMA_URL, 'http://os-set:11434', 'OS env value must survive dotenv application');
  });
});

describe('bootstrapEnv', () => {
  let tmpDir;
  test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'semidex-bootstrap-test-')); });
  test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns both raw snapshots and only gap-fills the target env — proves OS env wins without diffing an already-mutated process.env', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'OLLAMA_URL=http://dotenv-host:11434\nCONTEXT_MODEL=dotenv-model\n');
    const target = { OLLAMA_URL: 'http://os-host:11434' }; // OS already set this one
    const { osEnv, dotenvValues } = bootstrapEnv({ envPath, env: target });

    // osEnv is the snapshot BEFORE dotenv was applied — since target only
    // had OLLAMA_URL to start, that's exactly what the snapshot reflects.
    assert.deepEqual(osEnv, { OLLAMA_URL: 'http://os-host:11434' });
    assert.deepEqual(dotenvValues, { OLLAMA_URL: 'http://dotenv-host:11434', CONTEXT_MODEL: 'dotenv-model' });

    // target (acting as process.env) keeps its own OLLAMA_URL and gains the
    // dotenv-only CONTEXT_MODEL — this is what lets later
    // `import 'dotenv/config'` calls elsewhere in the import graph become
    // safe no-ops.
    assert.equal(target.OLLAMA_URL, 'http://os-host:11434');
    assert.equal(target.CONTEXT_MODEL, 'dotenv-model');
  });

  test('a missing .env file still returns a valid (empty dotenvValues) result, never throws', () => {
    const target = { OLLAMA_URL: 'http://os-host:11434' };
    assert.doesNotThrow(() => {
      const { dotenvValues } = bootstrapEnv({ envPath: join(tmpDir, 'missing.env'), env: target });
      assert.deepEqual(dotenvValues, {});
    });
  });
});

describe('bootstrap.js — import safety', () => {
  test('importing this module does not start a server or bind a port (isMainModule guard holds under the test runner)', async () => {
    // If the guard were broken, importing this file from the test runner
    // (whose process.argv[1] is the test runner's own entry, not
    // bootstrap.js) would attempt server.listen() and this import would
    // either throw (port already bound by another test) or leave a
    // dangling listener. A clean, silent import is the proof.
    await import('../../../src/admin/bootstrap.js');
    // No assertion needed beyond "did not throw and did not hang" — a
    // hidden server.listen() call would manifest as an unclosed handle
    // that the test runner would flag separately.
  });
});
