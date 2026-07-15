// src/core/env-bootstrap.js — shared env-snapshot/load helpers (relocated
// from src/admin/bootstrap.js during the Global Settings phase so every
// real process entry point — admin, MCP, indexer child process, sync,
// doctor, backfill scripts — can bootstrap env the same provenance-correct
// way). These tests exercise the pure/side-effect-controlled pieces
// directly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv,
} from '../../../src/core/env-bootstrap.js';

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
  test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'semidex-env-bootstrap-test-')); });
  test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('parses a real .env-shaped file without touching process.env', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'OLLAMA_URL=http://from-file:11434\nASK_MODEL=file-model\n');
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
  test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'semidex-env-bootstrap-test-')); });
  test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns both raw snapshots and only gap-fills the target env — proves OS env wins without diffing an already-mutated process.env', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'OLLAMA_URL=http://dotenv-host:11434\nCONTEXT_MODEL=dotenv-model\n');
    const target = { OLLAMA_URL: 'http://os-host:11434' }; // OS already set this one
    const { osEnv, dotenvValues } = bootstrapEnv({ envPath, env: target });

    assert.deepEqual(osEnv, { OLLAMA_URL: 'http://os-host:11434' });
    assert.deepEqual(dotenvValues, { OLLAMA_URL: 'http://dotenv-host:11434', CONTEXT_MODEL: 'dotenv-model' });

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

  // Code review fix (P2): a spawned child process (e.g. the indexer job
  // registry spawns) must be handed the PARENT's `osEnv` snapshot as its
  // own env base — never the parent's already-gap-filled process.env —
  // or the child's own bootstrapEnv() call cannot tell "the OS really set
  // this" apart from "my parent's dotenv gap-fill put this here", and
  // misclassifies a genuine .env-only value as os_env. Since os_env
  // outranks config_json in SettingsService's precedence, that
  // misclassification would let a stale/inherited .env value permanently
  // shadow a settings.json override in the child, and the child would
  // never re-read a live edit to .env either (it would just inherit
  // whatever string value leaked through, rather than parsing the real
  // file itself). This test proves the fix at the exact mechanism level:
  // building a "child env" from bare osEnv (not gap-filled process.env)
  // lets the child's own bootstrapEnv() correctly classify a .env-only
  // value as dotenv.
  test('simulated parent-to-child handoff: using bare osEnv (not gap-filled process.env) as the child\'s base env preserves correct os_env vs. dotenv classification', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'MAX_CHUNK_TOKENS=777\n');

    // Parent process bootstraps once.
    const parentProcessEnv = {};
    const { osEnv: parentOsEnv } = bootstrapEnv({ envPath, env: parentProcessEnv });
    assert.equal('MAX_CHUNK_TOKENS' in parentOsEnv, false, 'sanity: MAX_CHUNK_TOKENS was never real OS env for the parent');
    assert.equal(parentProcessEnv.MAX_CHUNK_TOKENS, '777', 'sanity: parent process.env WAS gap-filled by its own bootstrap');

    // BUGGY handoff: child inherits the parent's gap-filled process.env.
    const buggyChildEnv = { ...parentProcessEnv };
    const { osEnv: buggyChildOsEnv } = bootstrapEnv({ envPath, env: buggyChildEnv });
    assert.equal('MAX_CHUNK_TOKENS' in buggyChildOsEnv, true, 'demonstrates the bug: the child wrongly classifies the inherited .env value as its own os_env');

    // FIXED handoff: child inherits only the parent's bare osEnv snapshot.
    const fixedChildEnv = { ...parentOsEnv };
    const { osEnv: fixedChildOsEnv, dotenvValues: fixedChildDotenv } = bootstrapEnv({ envPath, env: fixedChildEnv });
    assert.equal('MAX_CHUNK_TOKENS' in fixedChildOsEnv, false, 'the fix: the child does not see MAX_CHUNK_TOKENS as os_env');
    assert.equal(fixedChildDotenv.MAX_CHUNK_TOKENS, '777', 'the fix: the child correctly (re-)classifies it as dotenv, from its own fresh read of the real .env file');
  });
});
