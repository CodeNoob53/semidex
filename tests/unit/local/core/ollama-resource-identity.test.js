// Tests for createOllamaResourceIdentityCapability() — the relocated
// generation/embedding VRAM-classification and active-model-selection
// logic (formerly resolveGenerationResourceIdentity()/
// resolveActiveGenerationModels() in the now fully-provider-agnostic
// device/resource-identity.js), plus the request-scoped /api/ps in-flight
// dedup this factory owns.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaResourceIdentityCapability } from '../../../../src/local/core/ollama-capability.js';

const GB = 1024 * 1024 * 1024;

function fetchRespondingWith(modelsByName) {
  return async (url) => {
    const match = /\/api\/ps$/.test(url);
    if (!match) return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () => ({
        models: Object.entries(modelsByName).map(([name, { size, size_vram }]) => ({ name, size, size_vram })),
      }),
    };
  };
}

describe('createOllamaResourceIdentityCapability — getResourceIdentity (generation)', () => {
  let originalFetch;
  let originalEnv;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('single active model, verified cpu placement', async () => {
    globalThis.fetch = fetchRespondingWith({ 'gemma3:4b': { size: 4 * GB, size_vram: 0 } });
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('single active model, verified gpu placement', async () => {
    globalThis.fetch = fetchRespondingWith({ 'gemma3:4b': { size: 4 * GB, size_vram: 4 * GB } });
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('two active models (CONTEXT_MODEL + TAG_MODEL), one gpu one cpu -> mixed', async () => {
    globalThis.fetch = fetchRespondingWith({
      'ctx-model': { size: 4 * GB, size_vram: 4 * GB },
      'tag-model': { size: 2 * GB, size_vram: 0 },
    });
    process.env.CONTEXT_MODEL = 'ctx-model';
    process.env.TAG_MODEL = 'tag-model';
    process.env.TAG_GEN = '1';
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('no active models this run (CONTEXT_MODE=deterministic, TAG_GEN off) -> unknown, override not consulted', async () => {
    globalThis.fetch = fetchRespondingWith({});
    process.env.CONTEXT_MODE = 'deterministic';
    delete process.env.TAG_GEN;
    process.env.GENERATION_DEVICE_OVERRIDE = 'gpu';
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('model unresolved (not loaded), GENERATION_DEVICE_OVERRIDE=gpu -> verified:true, source:manual (deliberate exception)', async () => {
    globalThis.fetch = fetchRespondingWith({}); // target model never appears in /api/ps
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    process.env.GENERATION_DEVICE_OVERRIDE = 'gpu';
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'manual' });
  });

  it('a real /api/ps read always takes priority over GENERATION_DEVICE_OVERRIDE, even when it contradicts', async () => {
    globalThis.fetch = fetchRespondingWith({ 'gemma3:4b': { size: 4 * GB, size_vram: 0 } }); // real signal: cpu
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    process.env.GENERATION_DEVICE_OVERRIDE = 'gpu'; // contradicting manual claim
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('getRunningModel that throws/rejects never propagates -- treated as unresolved', async () => {
    globalThis.fetch = async () => { throw new Error('network error'); };
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('env falls back to process.env when omitted', async () => {
    globalThis.fetch = fetchRespondingWith({ 'gemma3:4b': { size: 4 * GB, size_vram: 4 * GB } });
    process.env.CONTEXT_MODEL = 'gemma3:4b';
    delete process.env.TAG_GEN;
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity();
    assert.deepEqual(result, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  // Code review finding (P1): CONTEXT_MODE=deterministic + COMBINED_LLM=1
  // + TAG_GEN=1 + TAG_PROVIDER=ollama — stageB's own CONTEXT_MODE=
  // deterministic branch explicitly ignores COMBINED_LLM=1 (warns and
  // falls through to its own plain per-file Ollama tag call using
  // TAG_MODEL), so the scheduler must probe TAG_MODEL, never CONTEXT_MODEL,
  // for this combination. An earlier version of resolveActiveGenerationModels()
  // checked COMBINED_LLM=1 first and reported only CONTEXT_MODEL here —
  // silently checking a model stageB never calls while never checking the
  // one it actually does.
  it('CONTEXT_MODE=deterministic + COMBINED_LLM=1 + TAG_GEN=1 + TAG_PROVIDER=ollama -> probes TAG_MODEL, not CONTEXT_MODEL (matches stageB, which ignores combined mode under deterministic context)', async () => {
    globalThis.fetch = fetchRespondingWith({
      'context-model': { size: 4 * GB, size_vram: 4 * GB }, // gpu, if wrongly probed
      'tag-model': { size: 2 * GB, size_vram: 0 },           // cpu, the real signal
    });
    process.env.CONTEXT_MODE = 'deterministic';
    process.env.COMBINED_LLM = '1';
    process.env.TAG_GEN = '1';
    process.env.TAG_PROVIDER = 'ollama';
    process.env.CONTEXT_MODEL = 'context-model';
    process.env.TAG_MODEL = 'tag-model';
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' },
      'expected the real tag-model signal (cpu), not the never-called context-model signal (gpu)');
  });

  it('CONTEXT_MODE=deterministic + COMBINED_LLM=1 + TAG_GEN=0 -> no active models at all (deterministic context never calls Ollama, tags disabled)', async () => {
    globalThis.fetch = fetchRespondingWith({ 'context-model': { size: 4 * GB, size_vram: 4 * GB } });
    process.env.CONTEXT_MODE = 'deterministic';
    process.env.COMBINED_LLM = '1';
    delete process.env.TAG_GEN;
    process.env.CONTEXT_MODEL = 'context-model';
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getResourceIdentity({ env: process.env });
    assert.deepEqual(result, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  // Code review finding (P2), documented as a known, deliberate
  // conservative limitation rather than "fixed" — see
  // resolveActiveGenerationModels()'s own extended header comment. A
  // pure-skeleton (Markdown-only) collection with ONNX tags and no nav
  // summaries makes ZERO Ollama calls for context, but this env-only
  // function cannot distinguish that from a mixed skeleton+legacy
  // collection where CONTEXT_MODEL genuinely IS called by the legacy
  // files' own stageB branch — so it conservatively keeps probing
  // CONTEXT_MODEL. This test pins the accepted, bounded consequence: the
  // probe legitimately reports the never-loaded model as unresolved, and
  // (with it as the ONLY entry in the active-model list) that resolves to
  // unknown/unverified by default -- never a crash, never a wrong overlap
  // decision in the dangerous direction, and GENERATION_DEVICE_OVERRIDE
  // remains available to unlock overlap for an operator who knows their
  // deployment is purely skeleton files.
  it('P2: pure-skeleton-shaped env (TAG_PROVIDER=onnx, TAG_GEN=1, SKELETON_SUMMARY unset, CONTEXT_MODEL never loaded) -> conservatively unknown, not a crash; GENERATION_DEVICE_OVERRIDE still unlocks it', async () => {
    globalThis.fetch = fetchRespondingWith({}); // CONTEXT_MODEL never appears -- it was never actually called
    process.env.TAG_PROVIDER = 'onnx';
    process.env.TAG_GEN = '1';
    delete process.env.SKELETON_SUMMARY;
    delete process.env.CONTEXT_MODE;
    process.env.CONTEXT_MODEL = 'context-model';

    const capDefault = createOllamaResourceIdentityCapability();
    const withoutOverride = await capDefault.getResourceIdentity({ env: process.env });
    assert.deepEqual(withoutOverride, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });

    process.env.GENERATION_DEVICE_OVERRIDE = 'cpu';
    const capOverridden = createOllamaResourceIdentityCapability();
    const withOverride = await capOverridden.getResourceIdentity({ env: process.env });
    assert.deepEqual(withOverride, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'manual' });
  });
});

describe('createOllamaResourceIdentityCapability — getEmbeddingResourceIdentity (embedding)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('named embedding model, verified cpu placement', async () => {
    globalThis.fetch = fetchRespondingWith({ 'bge-m3': { size: 2 * GB, size_vram: 0 } });
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getEmbeddingResourceIdentity({ env: {}, model: 'bge-m3' });
    assert.deepEqual(result, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('no model name supplied -> unknown', async () => {
    globalThis.fetch = fetchRespondingWith({});
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getEmbeddingResourceIdentity({ env: {}, model: undefined });
    assert.deepEqual(result, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('embedding never consults GENERATION_DEVICE_OVERRIDE, even when set and the model is unresolved', async () => {
    globalThis.fetch = fetchRespondingWith({}); // model never appears
    const cap = createOllamaResourceIdentityCapability();
    const result = await cap.getEmbeddingResourceIdentity({ env: { GENERATION_DEVICE_OVERRIDE: 'gpu' }, model: 'bge-m3' });
    assert.deepEqual(result, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });
});

describe('createOllamaResourceIdentityCapability — request-scoped /api/ps dedup', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('two concurrent calls on the SAME instance needing the same model+baseUrl issue exactly one real fetch call', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      if (!/\/api\/ps$/.test(url)) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 4 * GB, size_vram: 4 * GB }] }) };
    };
    const cap = createOllamaResourceIdentityCapability();
    const env = { CONTEXT_MODEL: 'gemma3:4b' };
    // Fire both concurrently (no await between them) so they're genuinely in flight together.
    const [r1, r2] = await Promise.all([
      cap.getResourceIdentity({ env }),
      cap.getResourceIdentity({ env }),
    ]);
    assert.deepEqual(r1, r2);
    assert.equal(fetchCallCount, 1, 'expected exactly one real fetch call for two concurrent identical requests');
  });

  it('two SEQUENTIAL calls (first settles before the second starts) each issue their own fresh fetch call -- no stale caching', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      if (!/\/api\/ps$/.test(url)) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 4 * GB, size_vram: 4 * GB }] }) };
    };
    const cap = createOllamaResourceIdentityCapability();
    const env = { CONTEXT_MODEL: 'gemma3:4b' };
    await cap.getResourceIdentity({ env });
    await cap.getResourceIdentity({ env });
    assert.equal(fetchCallCount, 2, 'expected two independent fetch calls -- the in-flight cache must not survive past settlement');
  });

  it('two DIFFERENT capability instances never share dedup state', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      if (!/\/api\/ps$/.test(url)) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 4 * GB, size_vram: 4 * GB }] }) };
    };
    const capA = createOllamaResourceIdentityCapability();
    const capB = createOllamaResourceIdentityCapability();
    const env = { CONTEXT_MODEL: 'gemma3:4b' };
    await Promise.all([capA.getResourceIdentity({ env }), capB.getResourceIdentity({ env })]);
    assert.equal(fetchCallCount, 2, 'two independent instances must each issue their own real fetch call');
  });

  it('a rejected in-flight call does not poison the dedup cache for the next call', async () => {
    let callNum = 0;
    globalThis.fetch = async (url) => {
      callNum += 1;
      if (!/\/api\/ps$/.test(url)) return { ok: false, status: 404 };
      if (callNum === 1) throw new Error('transient network error');
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', size: 4 * GB, size_vram: 0 }] }) };
    };
    const cap = createOllamaResourceIdentityCapability();
    const env = { CONTEXT_MODEL: 'gemma3:4b' };
    const first = await cap.getResourceIdentity({ env });
    assert.deepEqual(first, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
    const second = await cap.getResourceIdentity({ env });
    assert.deepEqual(second, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });
});
