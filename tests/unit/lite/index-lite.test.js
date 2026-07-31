// index-lite.js — the semidex-lite `index` CLI command. spawnFn is a fake
// (EventEmitter-shaped) child process, matching this repo's own
// admin/jobs/registry.js test convention — never spawns a real indexer
// process. Uses a real createSettingsService against a temp settings.json
// so the env-provenance sequence itself is exercised, not mocked away.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndex } from '../../../packages/lite/lite-src/index-lite.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function withTempSettingsPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-index-test-'));
  const settingsPath = join(dir, 'settings.json');
  return fn(settingsPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('runIndex() — COLLECTION required', () => {
  it('returns 1 and never spawns when COLLECTION is unset', async () => {
    const savedCollection = process.env.COLLECTION;
    delete process.env.COLLECTION;
    let spawnCalled = false;
    try {
      const code = await withTempSettingsPath((settingsPath) => runIndex('./docs', {
        settingsPath,
        spawnFn: () => { spawnCalled = true; return makeFakeChild(); },
      }));
      assert.equal(code, 1);
      assert.equal(spawnCalled, false);
    } finally {
      if (savedCollection !== undefined) process.env.COLLECTION = savedCollection;
    }
  });
});

describe('runIndex() — spawn + exit handling', () => {
  it('resolves 0 when the (fake) indexer child exits 0', async () => {
    process.env.COLLECTION = 'test-collection';
    const calls = [];
    const code = await withTempSettingsPath((settingsPath) => runIndex('./docs', {
      settingsPath,
      pollIntervalMs: 5,
      spawnFn: (command, args, opts) => {
        calls.push({ command, args, opts });
        const child = makeFakeChild();
        setTimeout(() => child.emit('exit', 0, null), 10);
        return child;
      },
    }));
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.env.COLLECTION, 'test-collection');
  });

  it('resolves 1 when the (fake) indexer child exits non-zero', async () => {
    process.env.COLLECTION = 'test-collection';
    const code = await withTempSettingsPath((settingsPath) => runIndex('./docs', {
      settingsPath,
      pollIntervalMs: 5,
      spawnFn: () => {
        const child = makeFakeChild();
        setTimeout(() => child.emit('exit', 1, null), 10);
        return child;
      },
    }));
    assert.equal(code, 1);
  });

  it('passes PRUNE_STALE=1 only when --prune-stale is present in argv', async () => {
    process.env.COLLECTION = 'test-collection';
    const calls = [];
    await withTempSettingsPath((settingsPath) => runIndex('./docs', {
      settingsPath,
      pollIntervalMs: 5,
      argv: ['node', 'semidex-lite', 'index', './docs', '--prune-stale'],
      spawnFn: (command, args, opts) => {
        calls.push(opts.env);
        const child = makeFakeChild();
        setTimeout(() => child.emit('exit', 0, null), 10);
        return child;
      },
    }));
    assert.equal(calls[0].PRUNE_STALE, '1');
  });

  it('omits PRUNE_STALE when --prune-stale is absent', async () => {
    process.env.COLLECTION = 'test-collection';
    const calls = [];
    await withTempSettingsPath((settingsPath) => runIndex('./docs', {
      settingsPath,
      pollIntervalMs: 5,
      argv: ['node', 'semidex-lite', 'index', './docs'],
      spawnFn: (command, args, opts) => {
        calls.push(opts.env);
        const child = makeFakeChild();
        setTimeout(() => child.emit('exit', 0, null), 10);
        return child;
      },
    }));
    assert.equal(calls[0].PRUNE_STALE, undefined);
  });

  it('never sets ONNX_EMBED=1/TAG_GEN=1 — no local job option is ever exposed as a CLI flag', async () => {
    process.env.COLLECTION = 'test-collection';
    const calls = [];
    await withTempSettingsPath((settingsPath) => runIndex('./docs', {
      settingsPath,
      pollIntervalMs: 5,
      spawnFn: (command, args, opts) => {
        calls.push(opts.env);
        const child = makeFakeChild();
        setTimeout(() => child.emit('exit', 0, null), 10);
        return child;
      },
    }));
    assert.equal(calls[0].ONNX_EMBED, '0');
    assert.equal(calls[0].TAG_GEN, undefined);
  });
});
