// Tests for src/admin/system/folder-picker.js, src/admin/system/ollama.js,
// and the POST /api/system/pick-folder + GET /api/system/ollama-status
// routes. No real powershell.exe/dialog and no real Ollama instance is ever
// spawned/queried — spawnFn/fetch-touching functions are always stubbed.
//
// checkOllama() is read-only by design (no auto-spawn of `ollama serve`) —
// these tests assert both its status logic AND that no child_process spawn
// ever happens as a side effect of checking status.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickFolder } from '../../../src/admin/system/folder-picker.js';
import { checkOllama } from '../../../src/admin/system/ollama.js';
import { createApp } from '../../../src/admin/server.js';

function makeStubAdapter() {
  return {
    name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true, detail: '' }),
    listCollections: async () => [], getCollection: async () => null, createCollection: async () => {},
    deleteCollection: async () => {}, ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [], getChunk: async () => [], searchHybrid: async () => [],
    getSkeletonRoot: async () => null, getSkeletonNode: async () => null, getSkeletonChildren: async () => [],
    getStructuralNode: async () => null, getSectionAnchor: async () => null,
  };
}

async function withApp(opts, fn) {
  const app = createApp({ adapter: makeStubAdapter(), ...opts });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  return child;
}

// ── pickFolder ──────────────────────────────────────────────────────────────

describe('pickFolder', () => {
  it('rejects with UNSUPPORTED_PLATFORM on a non-Windows platform', async () => {
    await assert.rejects(
      () => pickFolder({ platform: 'linux' }),
      (err) => err.code === 'UNSUPPORTED_PLATFORM',
    );
  });

  it('resolves { path, cancelled: false } when the dialog returns a path on stdout', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('C:\\Users\\demo\\Documents'));
        child.emit('exit', 0);
      }, 5);
      return child;
    };
    const result = await pickFolder({ spawnFn, platform: 'win32' });
    assert.deepEqual(result, { path: 'C:\\Users\\demo\\Documents', cancelled: false });
  });

  it('resolves { path: null, cancelled: true } when the dialog is cancelled (empty stdout)', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('exit', 0), 5);
      return child;
    };
    const result = await pickFolder({ spawnFn, platform: 'win32' });
    assert.deepEqual(result, { path: null, cancelled: true });
  });

  it('rejects with PICKER_UNAVAILABLE when powershell.exe cannot be spawned', async () => {
    const spawnFn = () => { throw new Error('ENOENT'); };
    await assert.rejects(
      () => pickFolder({ spawnFn, platform: 'win32' }),
      (err) => err.code === 'PICKER_UNAVAILABLE',
    );
  });

  it('rejects with PICKER_UNAVAILABLE when the child emits an error event', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 5);
      return child;
    };
    await assert.rejects(
      () => pickFolder({ spawnFn, platform: 'win32' }),
      (err) => err.code === 'PICKER_UNAVAILABLE',
    );
  });

  it('rejects with PICKER_FAILED on a non-zero exit code', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('some PowerShell error'));
        child.emit('exit', 1);
      }, 5);
      return child;
    };
    await assert.rejects(
      () => pickFolder({ spawnFn, platform: 'win32' }),
      (err) => err.code === 'PICKER_FAILED',
    );
  });

  it('rejects with PICKER_TIMEOUT if the dialog never resolves within timeoutMs', async () => {
    const spawnFn = () => makeFakeChild(); // never emits exit/error
    await assert.rejects(
      () => pickFolder({ spawnFn, platform: 'win32', timeoutMs: 20 }),
      (err) => err.code === 'PICKER_TIMEOUT',
    );
  });
});

// ── checkOllama ───────────────────────────────────────────────────────────────
// Read-only: no child_process import in ollama.js at all anymore, so there is
// no spawnFn to inject here — these tests only stub fetch.

describe('checkOllama', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns "available" when Ollama is reachable and no specific model is required', async () => {
    globalThis.fetch = async (url) => {
      assert.match(url, /\/api\/version$/);
      return { ok: true };
    };
    const result = await checkOllama({ baseUrl: 'http://localhost:11434' });
    assert.equal(result.status, 'available');
  });

  it('returns "available" when the required model is present in /api/tags', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }] }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await checkOllama({ baseUrl: 'http://localhost:11434', requiredModel: 'gemma3:4b' });
    assert.equal(result.status, 'available');
  });

  it('returns "model_missing" when the required model is not in /api/tags', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'other-model' }] }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await checkOllama({ baseUrl: 'http://localhost:11434', requiredModel: 'gemma3:4b' });
    assert.equal(result.status, 'model_missing');
    assert.equal(result.missingModel, 'gemma3:4b');
    assert.match(result.message, /ollama pull gemma3:4b/);
  });

  it('returns "missing" (not "starting") when Ollama is unreachable — never attempts to spawn anything', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await checkOllama({ baseUrl: 'http://localhost:11434' });
    assert.equal(result.status, 'missing');
    assert.match(result.message, /Start Ollama and retry/);
    assert.match(result.message, /ollama serve/);
  });

  it('does not import node:child_process — checking status can never spawn a process', async () => {
    const src = await (await import('node:fs/promises')).readFile(
      new URL('../../../src/admin/system/ollama.js', import.meta.url), 'utf-8',
    );
    assert.ok(!/child_process/.test(src), 'ollama.js must not import node:child_process at all');
  });

  it('never calls a pull/download endpoint when a required model is missing — only reports it', async () => {
    const calledUrls = [];
    globalThis.fetch = async (url) => {
      calledUrls.push(url);
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await checkOllama({ baseUrl: 'http://localhost:11434', requiredModel: 'gemma3:4b' });
    assert.equal(result.status, 'model_missing');
    assert.ok(!calledUrls.some((u) => /pull|download/.test(u)), 'must never call a pull/download endpoint automatically');
    assert.match(result.message, /ollama pull gemma3:4b/, 'must tell the user the command to run themselves, not run it for them');
  });
});

// ── POST /api/system/pick-folder ────────────────────────────────────────────

describe('POST /api/system/pick-folder', () => {
  it('returns a domain-shaped { path, cancelled } response on success', async () => {
    const pickFolderFn = async () => ({ path: 'C:\\Users\\demo\\Docs', cancelled: false });
    await withApp({ pickFolderFn }, async (base) => {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { path: 'C:\\Users\\demo\\Docs', cancelled: false });
    });
  });

  it('returns { path: null, cancelled: true } when the user cancels the dialog', async () => {
    const pickFolderFn = async () => ({ path: null, cancelled: true });
    await withApp({ pickFolderFn }, async (base) => {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { path: null, cancelled: true });
    });
  });

  it('returns a clear error status when the picker is unavailable (not a raw 500 crash)', async () => {
    const pickFolderFn = async () => { const err = new Error('Native folder picker is only available on Windows.'); err.code = 'UNSUPPORTED_PLATFORM'; throw err; };
    await withApp({ pickFolderFn }, async (base) => {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 501);
      const body = await res.json();
      assert.equal(body.error.code, 'UNSUPPORTED_PLATFORM');
      assert.match(body.error.message, /only available on Windows/);
    });
  });

  it('returns a clear error status when the picker times out', async () => {
    const pickFolderFn = async () => { const err = new Error('Folder picker timed out.'); err.code = 'PICKER_TIMEOUT'; throw err; };
    await withApp({ pickFolderFn }, async (base) => {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 504);
    });
  });
});

// ── GET /api/system/ollama-status ───────────────────────────────────────────

describe('GET /api/system/ollama-status', () => {
  it('returns the domain-shaped status from checkOllamaFn', async () => {
    const checkOllamaFn = async () => ({ status: 'available', message: 'Ollama is running.' });
    await withApp({ checkOllamaFn }, async (base) => {
      const res = await fetch(base + '/api/system/ollama-status');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'available', message: 'Ollama is running.' });
    });
  });

  it('surfaces "missing" status with an actionable message', async () => {
    const checkOllamaFn = async () => ({ status: 'missing', message: 'Ollama is not installed or not on PATH. Install it from https://ollama.com, then try again.' });
    await withApp({ checkOllamaFn }, async (base) => {
      const res = await fetch(base + '/api/system/ollama-status');
      const body = await res.json();
      assert.equal(body.status, 'missing');
      assert.match(body.message, /ollama\.com/);
    });
  });
});
