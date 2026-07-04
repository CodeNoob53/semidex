// Tests for the shared Ollama reachability/model-list/validation logic
// (src/core/ollama.js), plus a regression check that both consumers —
// src/indexer/preflight.js and src/admin/system/ollama.js — actually import
// from this shared module instead of re-implementing their own fetch calls.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isOllamaReachable, listOllamaModels, validateOllamaModels,
} from '../../../src/core/ollama.js';
import { checkOllamaPreflight } from '../../../src/indexer/preflight.js';
import { checkOllama } from '../../../src/admin/system/ollama.js';

describe('validateOllamaModels', () => {
  it('returns null when every required model is available', () => {
    assert.equal(validateOllamaModels(['a', 'b'], ['a', 'b', 'c']), null);
  });

  it('returns the deduped list of missing models', () => {
    assert.deepEqual(validateOllamaModels(['a', 'b', 'a'], ['a']), ['b']);
  });

  it('is an exact-match check, not a prefix/substring match', () => {
    assert.deepEqual(validateOllamaModels(['gemma3:4b'], ['gemma3:4b-it-qat']), ['gemma3:4b']);
  });
});

describe('isOllamaReachable', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns true when /api/version responds ok', async () => {
    globalThis.fetch = async (url) => { assert.match(url, /\/api\/version$/); return { ok: true }; };
    assert.equal(await isOllamaReachable('http://localhost:11434'), true);
  });

  it('returns false on a non-ok response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await isOllamaReachable('http://localhost:11434'), false);
  });

  it('returns false on a network error (never throws)', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await isOllamaReachable('http://localhost:11434'), false);
  });
});

describe('listOllamaModels', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns model names from /api/tags', async () => {
    globalThis.fetch = async (url) => {
      assert.match(url, /\/api\/tags$/);
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }, { name: 'qwen3:4b' }] }) };
    };
    assert.deepEqual(await listOllamaModels('http://localhost:11434'), ['gemma3:4b', 'qwen3:4b']);
  });

  it('throws on a non-ok response (callers should check isOllamaReachable first)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(() => listOllamaModels('http://localhost:11434'));
  });
});

// ── Both consumers reuse this module, instead of duplicating fetch calls ────

describe('shared Ollama logic — no duplication between indexer and admin', () => {
  it('src/indexer/preflight.js imports isOllamaReachable/listOllamaModels from core/ollama.js', async () => {
    const src = await readFile(new URL('../../../src/indexer/preflight.js', import.meta.url), 'utf-8');
    assert.match(src, /from ['"]\.\.\/core\/ollama\.js['"]/);
    assert.match(src, /isOllamaReachable/);
    assert.match(src, /listOllamaModels/);
    assert.ok(!/fetch\(.*\/api\/version/.test(src), 'preflight.js must not re-implement its own /api/version fetch');
    assert.ok(!/fetch\(.*\/api\/tags/.test(src), 'preflight.js must not re-implement its own /api/tags fetch');
  });

  it('src/admin/system/ollama.js imports isOllamaReachable/listOllamaModels from core/ollama.js', async () => {
    const src = await readFile(new URL('../../../src/admin/system/ollama.js', import.meta.url), 'utf-8');
    assert.match(src, /from ['"]\.\.\/\.\.\/core\/ollama\.js['"]/);
    assert.match(src, /isOllamaReachable/);
    assert.match(src, /listOllamaModels/);
    assert.ok(!/fetch\(.*\/api\/version/.test(src), 'admin ollama.js must not re-implement its own /api/version fetch');
    assert.ok(!/fetch\(.*\/api\/tags/.test(src), 'admin ollama.js must not re-implement its own /api/tags fetch');
  });

  it('preflight (indexer) and checkOllama (admin) agree on model validation for the same inputs', async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        if (url.endsWith('/api/version')) return { ok: true };
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'other-model' }] }) };
        throw new Error(`unexpected fetch ${url}`);
      };

      const adminResult = await checkOllama({ baseUrl: 'http://localhost:11434', requiredModel: 'gemma3:4b' });
      assert.equal(adminResult.status, 'model_missing');

      await assert.rejects(
        () => checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'gemma3:4b'),
        /Required Ollama model\(s\) not pulled/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('preflight (indexer) and checkOllama (admin) agree when Ollama is unreachable', async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

      const adminResult = await checkOllama({ baseUrl: 'http://localhost:11434' });
      assert.equal(adminResult.status, 'missing');

      await assert.rejects(
        () => checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'gemma3:4b'),
        /Ollama unreachable/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
