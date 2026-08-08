// Tests for the shared Ollama reachability/model-list/validation logic
// (src/local/core/ollama.js), plus a regression check that both consumers —
// src/indexer/preflight.js and src/admin/system/ollama.js — actually import
// from this shared module instead of re-implementing their own fetch calls.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isOllamaReachable, listOllamaModels, validateOllamaModels, generateStream, getModelContextLength,
  embeddingDimensionFromShow, getOllamaEmbeddingDimension, getRunningModel,
} from '../../../src/local/core/ollama.js';
import { checkOllamaPreflight } from '../../../src/shared/indexer/preflight.js';
import { checkOllama } from '../../../src/local/admin/system/ollama.js';
import { createOllamaDiscoveryCapability } from '../../../src/local/core/ollama-capability.js';

// preflight.js has no module-scope capability of its own at all (Phase 8B
// Step 3 — checkOllamaPreflight()/ensureOllamaPreflight() take their
// capability as a real function argument, no apply*Capability() setter
// exists to call here anymore). This test file's whole point is proving
// checkOllamaPreflight() delegates to the REAL shared local/core/ollama.js
// logic (via local/core/ollama-capability.js's real factory, exercised end
// to end with a stubbed globalThis.fetch) — so every checkOllamaPreflight()
// call below passes a real OllamaDiscoveryCapability explicitly, mirroring
// what indexer/run.js's own per-call ctx.ollamaDiscovery supplies in
// production (buildRunContext() — no module-scope snapshot, see run.js's
// own header comment).

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

describe('getModelContextLength', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('requests /api/show against the given baseUrl, not the module-level default', async () => {
    // Regression: showModel() always used the module-level OLLAMA_URL,
    // ignoring any baseUrl a caller passed — a GenerationProvider
    // constructed with a non-default baseUrl had its /api/show call
    // (and therefore its numCtx) silently resolved against the wrong
    // Ollama instance (code review finding, confirmed live).
    let requestedUrl;
    globalThis.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ model_info: { 'x.context_length': 8192 } }) };
    };
    await getModelContextLength('gemma3:4b', 4096, 'http://custom-host:11500');
    assert.equal(requestedUrl, 'http://custom-host:11500/api/show');
  });

  it('caches by baseUrl + model, not model alone — two different baseUrls never collide', async () => {
    const responses = {
      'http://host-a:11434': { model_info: { 'x.context_length': 4096 } },
      'http://host-b:11434': { model_info: { 'x.context_length': 32768 } },
    };
    globalThis.fetch = async (url) => {
      const base = url.replace(/\/api\/show$/, '');
      return { ok: true, json: async () => responses[base] };
    };
    const a = await getModelContextLength('gemma3:4b', 4096, 'http://host-a:11434');
    const b = await getModelContextLength('gemma3:4b', 4096, 'http://host-b:11434');
    assert.equal(a, 4096);
    assert.equal(b, 32768);
  });

  it('falls back to the given default when /api/show is unreachable', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await getModelContextLength('gemma3:4b', 2048, 'http://unreachable:11434');
    assert.equal(result, 2048);
  });
});

describe('Ollama embedding dimension', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reads the architecture embedding length only for embedding-capable models', () => {
    assert.equal(embeddingDimensionFromShow({
      capabilities: ['embedding'],
      model_info: {
        'general.architecture': 'bert',
        'bert.embedding_length': 768,
        'bert.vision.embedding_length': 1152,
      },
    }), 768);
    assert.equal(embeddingDimensionFromShow({
      capabilities: ['completion'],
      model_info: { 'general.architecture': 'llama', 'llama.embedding_length': 4096 },
    }), null);
  });

  it('falls back to one /api/embed probe when /api/show metadata is incomplete', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/api/show')) {
        return { ok: true, json: async () => ({ capabilities: ['embedding'], model_info: {} }) };
      }
      if (url.endsWith('/api/embed')) {
        return { ok: true, json: async () => ({ embeddings: [Array(384).fill(0)] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const dimension = await getOllamaEmbeddingDimension(
      'probe-model',
      'http://dimension-probe:11434'
    );
    assert.equal(dimension, 384);
    assert.deepEqual(calls, [
      'http://dimension-probe:11434/api/show',
      'http://dimension-probe:11434/api/embed',
    ]);
  });
});

describe('getRunningModel', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns {size, size_vram} for a model present in /api/ps (matched by "name")', async () => {
    globalThis.fetch = async (url) => {
      assert.match(url, /\/api\/ps$/);
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 1000, size_vram: 1000 }] }) };
    };
    assert.deepEqual(await getRunningModel('gemma3:4b', 'http://localhost:11434'), { size: 1000, size_vram: 1000 });
  });

  it('matches by "model" field too (defensive, in case /api/ps ever uses that key instead of "name")', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ model: 'gemma3:4b', size: 500, size_vram: 0 }] }) });
    assert.deepEqual(await getRunningModel('gemma3:4b'), { size: 500, size_vram: 0 });
  });

  it('returns null when the model is not present in the response (not currently loaded)', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'other-model', size: 1000, size_vram: 1000 }] }) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null when models is an empty array', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null on a non-OK HTTP status', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null on malformed JSON / missing models array, never throws', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null on a network error (never throws)', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null on a timeout (never throws)', async () => {
    globalThis.fetch = async () => { throw new Error('The operation was aborted'); };
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null for a malformed entry: non-finite size', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 'not-a-number', size_vram: 100 }] }) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null for a malformed entry: negative size_vram', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 1000, size_vram: -1 }] }) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('returns null for a malformed entry: size <= 0', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 0, size_vram: 0 }] }) });
    assert.equal(await getRunningModel('gemma3:4b'), null);
  });

  it('never caches — two consecutive calls always re-fetch (unlike showModel())', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 1000, size_vram: callCount === 1 ? 0 : 1000 }] }) };
    };
    const first = await getRunningModel('gemma3:4b');
    const second = await getRunningModel('gemma3:4b');
    assert.equal(callCount, 2);
    assert.equal(first.size_vram, 0);
    assert.equal(second.size_vram, 1000);
  });

  it('strips a trailing slash from baseUrl before building the request URL', async () => {
    let requestedUrl;
    globalThis.fetch = async (url) => { requestedUrl = url; return { ok: true, json: async () => ({ models: [] }) }; };
    await getRunningModel('gemma3:4b', 'http://custom-host:11500/');
    assert.equal(requestedUrl, 'http://custom-host:11500/api/ps');
  });
});

// ── generateStream ────────────────────────────────────────────────────────
// A real fetch() Response.body is a web ReadableStream yielding Uint8Array
// chunks (NOT Node Buffers) — string-concatenating a Uint8Array directly
// calls its default toString(), producing a comma-separated byte list, not
// UTF-8 text. This is exactly the bug the manual live-Ollama check caught
// (2026-07-15): every stub in ollama-provider.test.js replaces
// generateStreamFn wholesale, so nothing exercised the real NDJSON-over-
// bytes parsing loop below until a live run against real Ollama returned
// zero tokens and an empty answer. fakeStreamResponse() reproduces the
// exact chunk shape (Uint8Array, not Buffer, not string) so this class of
// bug is caught by the unit suite going forward, without a live server.
function fakeStreamResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: {
      [Symbol.asyncIterator]: async function* () {
        for (const line of lines) yield encoder.encode(line);
      },
    },
  };
}

describe('generateStream', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('decodes real Uint8Array chunks (not Buffers) into UTF-8 text, not a byte-value list', async () => {
    globalThis.fetch = async () => fakeStreamResponse([
      '{"response":"Hel","done":false}\n',
      '{"response":"lo","done":false}\n',
      '{"response":"","done":true,"prompt_eval_count":12,"eval_count":2}\n',
    ]);
    const tokens = [];
    const result = await generateStream('gemma3:4b', 'hi', { onToken: (t) => tokens.push(t) });
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(result.text, 'Hello');
    assert.equal(result.tokensIn, 12);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.aborted, false);
  });

  it('sends the native top-level "system" body field when a system instruction is supplied', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return fakeStreamResponse(['{"response":"ok","done":false}\n', '{"response":"","done":true}\n']);
    };
    await generateStream('gemma3:4b', 'Evidence:\n...\n\nQuestion: q', { system: 'Answer using only the evidence.' });
    assert.equal(capturedBody.system, 'Answer using only the evidence.');
    assert.equal(capturedBody.model, 'gemma3:4b');
    assert.equal(capturedBody.prompt, 'Evidence:\n...\n\nQuestion: q');
    assert.equal(capturedBody.stream, true);
    assert.ok(!capturedBody.prompt.includes('Answer using only the evidence.'), 'the system instruction must never be prepended to prompt');
  });

  it('omits "system" from the request body entirely when no system instruction is supplied (never sent as an empty string)', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return fakeStreamResponse(['{"response":"","done":true}\n']);
    };
    await generateStream('gemma3:4b', 'hi');
    assert.equal('system' in capturedBody, false, 'the request body must not carry a "system" key at all when none was supplied');
  });

  it('handles a UTF-8 multi-byte character split across two chunk boundaries', async () => {
    // "привіт" (Cyrillic) — encode as one JSON line, then split the raw
    // bytes mid-character to exercise TextDecoder's stream:true carry-over.
    const encoder = new TextEncoder();
    const line = JSON.stringify({ response: 'привіт', done: false }) + '\n'
      + JSON.stringify({ response: '', done: true }) + '\n';
    const bytes = encoder.encode(line);
    const splitAt = Math.floor(bytes.length / 2);
    globalThis.fetch = async () => ({
      ok: true,
      body: {
        [Symbol.asyncIterator]: async function* () {
          yield bytes.slice(0, splitAt);
          yield bytes.slice(splitAt);
        },
      },
    });
    const result = await generateStream('gemma3:4b', 'hi');
    assert.equal(result.text, 'привіт');
  });

  it('handles a JSON line split across two chunks (partial line buffered until newline)', async () => {
    globalThis.fetch = async () => fakeStreamResponse([
      '{"resp',
      'onse":"ok","done":false}\n{"response":"","done":true}\n',
    ]);
    const result = await generateStream('gemma3:4b', 'hi');
    assert.equal(result.text, 'ok');
  });

  it('an aborted signal mid-stream returns partial text and aborted: true, not a throw', async () => {
    const controller = new AbortController();
    globalThis.fetch = async () => ({
      ok: true,
      body: {
        [Symbol.asyncIterator]: async function* () {
          yield new TextEncoder().encode('{"response":"partial","done":false}\n');
          controller.abort();
          throw new Error('simulated abort during read');
        },
      },
    });
    const result = await generateStream('gemma3:4b', 'hi', { signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.text, 'partial');
  });

  it('targets the given baseUrl, not the module-level OLLAMA_URL default, when one is passed', async () => {
    // Regression: ollama-provider.js's generate() passed baseUrl through to
    // generateStream(), but generateStream() itself ignored it and always
    // built the request URL from the module-level OLLAMA_URL constant — a
    // provider constructed with a non-default baseUrl silently generated
    // against the wrong Ollama instance (code review finding, confirmed
    // live: baseUrl=http://example.invalid:9999 actually hit
    // localhost:11434).
    let requestedUrl;
    globalThis.fetch = async (url) => { requestedUrl = url; return fakeStreamResponse(['{"response":"","done":true}\n']); };
    await generateStream('gemma3:4b', 'hi', { baseUrl: 'http://custom-host:11500' });
    assert.equal(requestedUrl, 'http://custom-host:11500/api/generate');
  });

  it('strips a trailing slash from baseUrl before building the request URL', async () => {
    let requestedUrl;
    globalThis.fetch = async (url) => { requestedUrl = url; return fakeStreamResponse(['{"response":"","done":true}\n']); };
    await generateStream('gemma3:4b', 'hi', { baseUrl: 'http://custom-host:11500/' });
    assert.equal(requestedUrl, 'http://custom-host:11500/api/generate');
  });

  it('awaits onToken before reading the next frame (real backpressure, not fire-and-forget)', async () => {
    const order = [];
    let resolveSlowToken;
    globalThis.fetch = async () => fakeStreamResponse([
      '{"response":"a","done":false}\n',
      '{"response":"b","done":false}\n',
      '{"response":"","done":true}\n',
    ]);
    const onToken = async (t) => {
      order.push(`onToken-start:${t}`);
      if (t === 'a') {
        await new Promise((resolve) => { resolveSlowToken = resolve; });
      }
      order.push(`onToken-end:${t}`);
    };
    // Resolve the slow first onToken shortly after the call starts —if
    // generateStream() did NOT await onToken, it would already have moved
    // on to processing "b" before "onToken-end:a" is recorded.
    setTimeout(() => resolveSlowToken?.(), 5);
    const result = await generateStream('gemma3:4b', 'hi', { onToken });
    assert.deepEqual(order, ['onToken-start:a', 'onToken-end:a', 'onToken-start:b', 'onToken-end:b']);
    assert.equal(result.text, 'ab');
  });
});

// ── Both consumers reuse this module, instead of duplicating fetch calls ────

describe('shared Ollama logic — no duplication between indexer and admin', () => {
  it('src/shared/indexer/preflight.js delegates to shared Ollama logic through its own capability function argument, never re-implementing the fetches', async () => {
    const src = await readFile(new URL('../../../src/shared/indexer/preflight.js', import.meta.url), 'utf-8');
    // preflight.js has no module-scope capability binding at all (Phase 8B
    // Step 3 — it depends only on the narrow OllamaDiscoveryCapability
    // contract, passed as a real function argument by its caller:
    // indexer/run.js's own per-call ctx.ollamaDiscovery in production, or
    // this test file itself above). The no-duplication invariant this test
    // protects is unchanged: preflight still calls through to
    // isOllamaReachable/listOllamaModels (via its own capability
    // parameter), never re-implementing either fetch itself.
    assert.match(src, /capability\.isOllamaReachable/);
    assert.match(src, /capability\.listOllamaModels/);
    assert.ok(!/fetch\(.*\/api\/version/.test(src), 'preflight.js must not re-implement its own /api/version fetch');
    assert.ok(!/fetch\(.*\/api\/tags/.test(src), 'preflight.js must not re-implement its own /api/tags fetch');
  });

  it('local/core/ollama-capability.js re-exports the shared Ollama logic from local/core/ollama.js (so preflight\'s delegation is transitive, not a fork)', async () => {
    const src = await readFile(new URL('../../../src/local/core/ollama-capability.js', import.meta.url), 'utf-8');
    // The capability factory must import the real local/core/ollama.js
    // functions and forward to them — never re-implement the fetches. This
    // is what makes preflight's injected OllamaDiscoveryCapability
    // equivalent, for the no-duplication invariant, to calling
    // local/core/ollama.js directly.
    assert.match(src, /from ['"]\.\/ollama\.js['"]/);
    assert.ok(!/fetch\(.*\/api\/version/.test(src), 'ollama-capability.js must not re-implement its own /api/version fetch');
    assert.ok(!/fetch\(.*\/api\/tags/.test(src), 'ollama-capability.js must not re-implement its own /api/tags fetch');
  });

  it('src/local/admin/system/ollama.js imports isOllamaReachable/listOllamaModels from local/core/ollama.js', async () => {
    const src = await readFile(new URL('../../../src/local/admin/system/ollama.js', import.meta.url), 'utf-8');
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
        () => checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'gemma3:4b', createOllamaDiscoveryCapability()),
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
        () => checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'gemma3:4b', createOllamaDiscoveryCapability()),
        /Ollama unreachable/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
