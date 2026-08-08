import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEmbeddingResourceIdentity,
  resolveGenerationResourceIdentity,
  resolveTagOnnxResourceIdentity,
  resolveActiveGenerationModels,
  buildResourceIdentityInputs,
} from '../../../../src/shared/indexer/device/resource-identity.js';

// Realistic byte-scale fixture helper — VRAM_TOLERANCE_BYTES (64MB) is
// meaningful only against real model sizes (hundreds of MB to a few GB),
// never toy values like `size: 1000`.
const GB = 1024 * 1024 * 1024;

describe('resolveEmbeddingResourceIdentity', () => {
  it('onnxProviderState effective=cpu -> verified cpu, source onnx-runtime', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: { requested: 'cpu', effective: 'cpu', fellBackToCpu: false } });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' });
  });

  it('onnxProviderState effective=dml -> verified gpu, deviceId null (honest, not fabricated)', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: { requested: 'dml', effective: 'dml', fellBackToCpu: false } });
    assert.deepEqual(r, { kind: 'gpu', backend: 'onnx-dml', deviceId: null, verified: true, source: 'onnx-runtime' });
  });

  it('onnxProviderState effective=cuda -> verified gpu, deviceId cuda:0', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: { requested: 'cuda', effective: 'cuda', fellBackToCpu: false } });
    assert.deepEqual(r, { kind: 'gpu', backend: 'onnx-cuda', deviceId: 'cuda:0', verified: true, source: 'onnx-runtime' });
  });

  it('onnxProviderState null, ONNX_EXECUTION_PROVIDER unset -> unverified cpu fallback', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: null, onnxExecutionProvider: undefined });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' });
  });

  it('onnxProviderState null, ONNX_EXECUTION_PROVIDER=cpu -> unverified cpu', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: null, onnxExecutionProvider: 'cpu' });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' });
  });

  it('onnxProviderState null, ONNX_EXECUTION_PROVIDER=dml -> unverified gpu', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: null, onnxExecutionProvider: 'dml' });
    assert.deepEqual(r, { kind: 'gpu', backend: 'onnx-dml', deviceId: null, verified: false, source: 'manual' });
  });

  it('onnxProviderState null, ONNX_EXECUTION_PROVIDER=cuda -> unverified gpu', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: null, onnxExecutionProvider: 'cuda' });
    assert.deepEqual(r, { kind: 'gpu', backend: 'onnx-cuda', deviceId: null, verified: false, source: 'manual' });
  });

  it('onnxProviderState null, ONNX_EXECUTION_PROVIDER=garbage -> unverified cpu default', () => {
    const r = resolveEmbeddingResourceIdentity({ onnxProviderState: null, onnxExecutionProvider: 'garbage' });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' });
  });

  it('called with no args at all -> unverified cpu default (defensive)', () => {
    const r = resolveEmbeddingResourceIdentity();
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' });
  });

  it('denseExecution=qdrant-cloud -> verified remote, regardless of onnxProviderState/onnxExecutionProvider', () => {
    const r = resolveEmbeddingResourceIdentity({
      denseExecution: 'qdrant-cloud',
      onnxProviderState: { requested: 'cpu', effective: 'cpu', fellBackToCpu: false },
      onnxExecutionProvider: 'dml',
    });
    assert.deepEqual(r, { kind: 'remote', backend: 'qdrant-cloud', deviceId: null, verified: true, source: 'manual' });
  });

  it('denseExecution=qdrant-cluster -> verified remote', () => {
    const r = resolveEmbeddingResourceIdentity({ denseExecution: 'qdrant-cluster' });
    assert.deepEqual(r, { kind: 'remote', backend: 'qdrant-cluster', deviceId: null, verified: true, source: 'manual' });
  });

  it('denseExecution=client (or unset) does NOT force remote -- falls through to the ONNX-shaped logic', () => {
    const r = resolveEmbeddingResourceIdentity({ denseExecution: 'client', onnxProviderState: { requested: 'cpu', effective: 'cpu', fellBackToCpu: false } });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' });
  });

  it('denseProvider=ollama (client execution) -> unknown, never silently reused as an ONNX classification', () => {
    const r = resolveEmbeddingResourceIdentity({
      denseExecution: 'client',
      denseProvider: 'ollama',
      onnxProviderState: { requested: 'cpu', effective: 'cpu', fellBackToCpu: false },
    });
    assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });
});

describe('resolveTagOnnxResourceIdentity', () => {
  it('active:true -> verified cpu, source structural', () => {
    const r = resolveTagOnnxResourceIdentity({ active: true });
    assert.deepEqual(r, { kind: 'cpu', backend: 'onnx-unknown', deviceId: null, verified: true, source: 'structural' });
  });

  it('active:false -> unknown, unverified, source null', () => {
    const r = resolveTagOnnxResourceIdentity({ active: false });
    assert.deepEqual(r, { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null });
  });
});

describe('resolveGenerationResourceIdentity', () => {
  it('single model, size_vram <= tolerance -> verified cpu', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: 4 * GB, size_vram: 0 }] });
    assert.deepEqual(r, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('single model, size_vram >= size - tolerance -> verified gpu, deviceId null', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: 4 * GB, size_vram: 4 * GB }] });
    assert.deepEqual(r, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('single model, genuinely partial offload -> verified mixed', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: 4 * GB, size_vram: 2 * GB }] });
    assert.deepEqual(r, { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('two models, one gpu one cpu -> verified mixed (P1 fix #2 scenario)', () => {
    const r = resolveGenerationResourceIdentity({
      runningModels: [
        { model: 'a', size: 4 * GB, size_vram: 4 * GB },
        { model: 'b', size: 2 * GB, size_vram: 0 },
      ],
    });
    assert.deepEqual(r, { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('two models, both gpu -> collapse to single verified gpu, not mixed', () => {
    const r = resolveGenerationResourceIdentity({
      runningModels: [
        { model: 'a', size: 4 * GB, size_vram: 4 * GB },
        { model: 'b', size: 3 * GB, size_vram: 3 * GB },
      ],
    });
    assert.deepEqual(r, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('a real /api/ps read ALWAYS takes priority over GENERATION_DEVICE_OVERRIDE, even when the override is set and contradicts it', () => {
    const r = resolveGenerationResourceIdentity({
      runningModels: [{ model: 'a', size: 4 * GB, size_vram: 0 }], // real signal: cpu
      generationDeviceOverride: 'gpu', // contradicting manual claim -- must be ignored
    });
    assert.deepEqual(r, { kind: 'cpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('one model gpu, one unresolved -> verified mixed (unresolved never silently dropped)', () => {
    const r = resolveGenerationResourceIdentity({
      runningModels: [
        { model: 'a', size: 4 * GB, size_vram: 4 * GB },
        { model: 'b', runningModel: null },
      ],
    });
    assert.deepEqual(r, { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('empty array -> unknown, unverified, source null, override NOT consulted', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [], generationDeviceOverride: 'gpu' });
    assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  for (const override of [null, 'gpu', 'cpu', 'garbage', undefined]) {
    it(`all models unresolved, override=${JSON.stringify(override)} -> falls through to override branch`, () => {
      const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', runningModel: null }], generationDeviceOverride: override });
      if (override === 'cpu' || override === 'gpu') {
        // A deliberate exception to the "unverified never unlocks
        // overlap" rule: an explicit operator assertion IS verified:true
        // (real, informed claim about their own topology), but stays
        // source:'manual' forever -- never conflated with a real
        // 'ollama-api' runtime read in diagnostics/logs.
        assert.deepEqual(r, { kind: override, backend: 'ollama', deviceId: null, verified: true, source: 'manual' });
      } else {
        assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
      }
    });
  }

  it('malformed entry (non-finite size) treated as unresolved for that model', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: NaN, size_vram: 100 }] });
    assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('malformed entry (negative size_vram) treated as unresolved for that model', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: 1000, size_vram: -5 }] });
    assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('malformed entry (size_vram > size) treated as unresolved for that model', () => {
    const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', size: 1000, size_vram: 5000 }] });
    assert.deepEqual(r, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('invariant: a resolved cpu/gpu override always carries source:manual, never source:ollama-api (never conflated with a real read)', () => {
    for (const override of ['gpu', 'cpu']) {
      const r = resolveGenerationResourceIdentity({ runningModels: [{ model: 'a', runningModel: null }], generationDeviceOverride: override });
      assert.equal(r.verified, true, `override=${override} should produce verified:true (explicit operator assertion)`);
      assert.equal(r.source, 'manual', `override=${override} must always carry source:'manual', never 'ollama-api'`);
    }
  });
});

describe('resolveActiveGenerationModels', () => {
  it('COMBINED_LLM=1 -> only CONTEXT_MODEL, TAG_MODEL ignored', () => {
    const models = resolveActiveGenerationModels({ COMBINED_LLM: '1', CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model' });
    assert.deepEqual(models, ['ctx-model']);
  });

  it('CONTEXT_MODE=deterministic + TAG_GEN=1 (ollama tags) -> only the tag model', () => {
    const models = resolveActiveGenerationModels({ CONTEXT_MODE: 'deterministic', TAG_GEN: '1', CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model' });
    assert.deepEqual(models, ['tag-model']);
  });

  it('CONTEXT_MODE=deterministic + TAG_GEN=0 -> empty (zero Ollama calls)', () => {
    const models = resolveActiveGenerationModels({ CONTEXT_MODE: 'deterministic', TAG_GEN: '0', CONTEXT_MODEL: 'ctx-model' });
    assert.deepEqual(models, []);
  });

  it('CONTEXT_MODE=deterministic + TAG_GEN=1 + TAG_PROVIDER=onnx -> empty (tags go to ONNX, not Ollama)', () => {
    const models = resolveActiveGenerationModels({ CONTEXT_MODE: 'deterministic', TAG_GEN: '1', TAG_PROVIDER: 'onnx', CONTEXT_MODEL: 'ctx-model' });
    assert.deepEqual(models, []);
  });

  it('TAG_PROVIDER=onnx + TAG_GEN=1 (not deterministic, not combined) -> only CONTEXT_MODEL', () => {
    const models = resolveActiveGenerationModels({ TAG_PROVIDER: 'onnx', TAG_GEN: '1', CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model' });
    assert.deepEqual(models, ['ctx-model']);
  });

  it('plain default, TAG_MODEL distinct from CONTEXT_MODEL -> both, de-duplicated when equal', () => {
    const models = resolveActiveGenerationModels({ TAG_GEN: '1', CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model' });
    assert.deepEqual(models, ['ctx-model', 'tag-model']);
  });

  it('plain default, TAG_MODEL unset (falls back to CONTEXT_MODEL) -> single deduplicated entry', () => {
    const models = resolveActiveGenerationModels({ TAG_GEN: '1', CONTEXT_MODEL: 'ctx-model' });
    assert.deepEqual(models, ['ctx-model']);
  });

  it('plain default, TAG_GEN off -> only CONTEXT_MODEL', () => {
    const models = resolveActiveGenerationModels({ CONTEXT_MODEL: 'ctx-model' });
    assert.deepEqual(models, ['ctx-model']);
  });

  it('SKELETON_SUMMARY=llm adds CONTEXT_MODEL even for an otherwise-empty deterministic+tags-off run', () => {
    const models = resolveActiveGenerationModels({ CONTEXT_MODE: 'deterministic', TAG_GEN: '0', SKELETON_SUMMARY: 'llm', CONTEXT_MODEL: 'ctx-model' });
    assert.deepEqual(models, ['ctx-model']);
  });

  it('no CONTEXT_MODEL/TAG_MODEL set -> defaults to gemma3:4b', () => {
    const models = resolveActiveGenerationModels({ TAG_GEN: '1' });
    assert.deepEqual(models, ['gemma3:4b']);
  });
});

describe('buildResourceIdentityInputs', () => {
  it('composes generation/embedding/tagging from fakes', async () => {
    const getRunningModel = mock.fn(async (model) => (model === 'ctx-model' ? { size: 4 * GB, size_vram: 4 * GB } : null));
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model', TAG_GEN: '0' },
      onnxProviderState: { requested: 'cpu', effective: 'cpu', fellBackToCpu: false },
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.deepEqual(result.generation, { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
    assert.deepEqual(result.embedding, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' });
    assert.deepEqual(result.tagging, { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null });
  });

  it('activeModels.length === 0 skips every getRunningModel call', async () => {
    const getRunningModel = mock.fn(async () => ({ size: 1, size_vram: 1 }));
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODE: 'deterministic', TAG_GEN: '0' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.equal(getRunningModel.mock.callCount(), 0);
    assert.deepEqual(result.generation, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('ollamaDiscovery: null skips every getRunningModel call even when models are active', async () => {
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: null,
    });
    assert.deepEqual(result.generation, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('calls getRunningModel exactly once per distinct active model, with correct model-name arguments', async () => {
    const calls = [];
    const getRunningModel = mock.fn(async (model) => {
      calls.push(model);
      return model === 'ctx-model' ? { size: 1000, size_vram: 1000 } : { size: 1000, size_vram: 0 };
    });
    await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model', TAG_GEN: '1' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.equal(getRunningModel.mock.callCount(), 2);
    assert.deepEqual(new Set(calls), new Set(['ctx-model', 'tag-model']));
  });

  it('CONTEXT_MODEL and TAG_MODEL both unset (same default) -> exactly one call, not two', async () => {
    const getRunningModel = mock.fn(async () => ({ size: 1000, size_vram: 0 }));
    await buildResourceIdentityInputs({
      env: { TAG_GEN: '1' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.equal(getRunningModel.mock.callCount(), 1);
    assert.equal(getRunningModel.mock.calls[0].arguments[0], 'gemma3:4b');
  });

  it('passes OLLAMA_URL through as baseUrl, defaulting when unset', async () => {
    const getRunningModel = mock.fn(async () => ({ size: 1000, size_vram: 0 }));
    await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model', OLLAMA_URL: 'http://example:1234' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.equal(getRunningModel.mock.calls[0].arguments[1], 'http://example:1234');
  });

  it('a getRunningModel() that REJECTS (violates its own documented never-throw contract, e.g. Lite\'s unavailableOllamaCapability) never propagates -- treated as unresolved, never crashes the caller', async () => {
    const getRunningModel = mock.fn(async () => { throw new Error('OllamaNotAvailableInLiteIndexerError: getRunningModel'); });
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model', SKELETON_SUMMARY: 'llm' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.deepEqual(result.generation, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('a getRunningModel() that throws SYNCHRONOUSLY (before ever returning a Promise -- a plain non-async function, or any capability that throws before its own async boundary) never propagates either -- .catch() alone cannot see this, so the call must be wrapped in an already-settled Promise first', async () => {
    // Deliberately NOT `async` -- calling this throws immediately,
    // synchronously, with no Promise object ever created for a
    // `.catch()` to attach to. This is exactly the shape that broke
    // `ollamaDiscovery.getRunningModel(...).catch(...)` (the call
    // expression itself throws before `.catch` can even be read off its
    // result) and is fixed by routing through
    // `Promise.resolve().then(() => ollamaDiscovery.getRunningModel(...))`
    // instead.
    function getRunningModel() {
      throw new Error('synchronous throw, no Promise ever created');
    }
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.deepEqual(result.generation, { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null });
  });

  it('mixed resolved/rejecting getRunningModel calls -- the rejecting one is treated as unresolved, not silently dropped from the union', async () => {
    const getRunningModel = mock.fn(async (model) => {
      if (model === 'ctx-model') return { size: 4 * GB, size_vram: 4 * GB };
      throw new Error('network error');
    });
    const result = await buildResourceIdentityInputs({
      env: { CONTEXT_MODEL: 'ctx-model', TAG_MODEL: 'tag-model', TAG_GEN: '1' },
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: { getRunningModel },
    });
    assert.deepEqual(result.generation, { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' });
  });

  it('denseExecution/denseProvider are threaded through into the composed embedding identity', async () => {
    const result = await buildResourceIdentityInputs({
      env: {},
      onnxProviderState: null,
      taggingActive: false,
      ollamaDiscovery: null,
      denseExecution: 'qdrant-cloud',
      denseProvider: 'qdrant-cloud',
    });
    assert.deepEqual(result.embedding, { kind: 'remote', backend: 'qdrant-cloud', deviceId: null, verified: true, source: 'manual' });
  });
});
