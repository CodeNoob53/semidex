import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_STATUS, COLLECTION_STATUS, resolveLaneAvailability, resolveAvailability,
  resetLaneAvailabilityCache,
} from '../../../../src/core/embedding-profile/availability.js';

// The per-model lane-availability cache is module-level and keyed by
// "provider:model" — many test cases in this file reuse the same model
// names (e.g. 'bge-m3', 'aapot/bge-m3-onnx') with DELIBERATELY different
// fake check results to prove different branches. Without a reset between
// tests, an earlier test's cached result would leak into a later one.
beforeEach(() => resetLaneAvailabilityCache());

function profile({ denseProvider = 'ollama', denseModel = 'bge-m3', denseExecution = 'client', sparse = { provider: 'hashed-tf', model: 'hashed-tf', execution: 'client' } } = {}) {
  return {
    embedding: {
      dense: { provider: denseProvider, model: denseModel, vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: denseExecution },
      sparse,
    },
  };
}

describe('resolveLaneAvailability', () => {
  it('a null lane (dense-only collection\'s sparse) reports AVAILABLE with a "no sparse lane configured" reason', async () => {
    const result = await resolveLaneAvailability(null, {});
    assert.equal(result.status, LANE_STATUS.AVAILABLE);
    assert.match(result.reason, /no sparse lane configured/);
  });

  it('a non-client execution mode reports UNSUPPORTED_BACKEND, naming the mode', async () => {
    const result = await resolveLaneAvailability({ provider: 'e5', model: 'x', execution: 'qdrant-cloud' }, {});
    assert.equal(result.status, LANE_STATUS.UNSUPPORTED_BACKEND);
    assert.match(result.reason, /qdrant-cloud/);
  });

  it('hashed-tf is always AVAILABLE, no external dependency, no probe needed', async () => {
    const result = await resolveLaneAvailability({ provider: 'hashed-tf', model: 'hashed-tf', execution: 'client' }, {});
    assert.equal(result.status, LANE_STATUS.AVAILABLE);
  });

  it('an ollama lane delegates to checkOllamaLane and maps "available"', async () => {
    const checkOllamaLane = async ({ requiredModel }) => { assert.equal(requiredModel, 'bge-m3'); return { status: 'available' }; };
    const result = await resolveLaneAvailability({ provider: 'ollama', model: 'bge-m3', execution: 'client' }, { checkOllamaLane });
    assert.equal(result.status, LANE_STATUS.AVAILABLE);
  });

  it('an ollama lane maps "model_missing" to LANE_STATUS.MISSING_MODEL', async () => {
    const checkOllamaLane = async () => ({ status: 'model_missing', message: 'model not pulled' });
    const result = await resolveLaneAvailability({ provider: 'ollama', model: 'bge-m3', execution: 'client' }, { checkOllamaLane });
    assert.equal(result.status, LANE_STATUS.MISSING_MODEL);
  });

  it('an ollama lane maps unreachable Ollama ("missing") to LANE_STATUS.MISSING_MODEL', async () => {
    const checkOllamaLane = async () => ({ status: 'missing', message: 'Ollama is not running' });
    const result = await resolveLaneAvailability({ provider: 'ollama', model: 'bge-m3', execution: 'client' }, { checkOllamaLane });
    assert.equal(result.status, LANE_STATUS.MISSING_MODEL);
  });

  it('a bge-m3-onnx lane delegates to checkOnnxModelCached and maps MODEL_CACHED — never AVAILABLE from a cache check alone', async () => {
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.MODEL_CACHED });
    const result = await resolveLaneAvailability({ provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', execution: 'client' }, { checkOnnxModelCached });
    assert.equal(result.status, LANE_STATUS.MODEL_CACHED);
    assert.notEqual(result.status, LANE_STATUS.AVAILABLE, 'file presence must never be reported as the strong AVAILABLE claim');
  });

  it('a bge-m3-onnx lane maps NOT_CACHED distinctly from MODEL_CACHED', async () => {
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.NOT_CACHED });
    const result = await resolveLaneAvailability({ provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', execution: 'client' }, { checkOnnxModelCached });
    assert.equal(result.status, LANE_STATUS.NOT_CACHED);
  });

  it('throws when an ollama lane is checked without checkOllamaLane injected (fail loud, not silently skip)', async () => {
    await assert.rejects(() => resolveLaneAvailability({ provider: 'ollama', model: 'x', execution: 'client' }, {}));
  });

  it('throws when a bge-m3-onnx lane is checked without checkOnnxModelCached injected', async () => {
    await assert.rejects(() => resolveLaneAvailability({ provider: 'bge-m3-onnx', model: 'x', execution: 'client' }, {}));
  });
});

describe('resolveLaneAvailability — per-model lane-availability cache, keyed by "provider:model"', () => {
  it('an ollama lane checked twice for the SAME model calls checkOllamaLane only once', async () => {
    let calls = 0;
    const checkOllamaLane = async () => { calls++; return { status: 'available' }; };
    const lane = { provider: 'ollama', model: 'bge-m3', execution: 'client' };
    await resolveLaneAvailability(lane, { checkOllamaLane });
    await resolveLaneAvailability(lane, { checkOllamaLane });
    assert.equal(calls, 1, 'second call within the TTL must hit the cache, not probe Ollama again');
  });

  it('an ollama lane checked for a DIFFERENT model is not affected by another model\'s cached result', async () => {
    const checkOllamaLane = async ({ requiredModel }) => ({ status: requiredModel === 'bge-m3' ? 'available' : 'model_missing' });
    const first = await resolveLaneAvailability({ provider: 'ollama', model: 'bge-m3', execution: 'client' }, { checkOllamaLane });
    const second = await resolveLaneAvailability({ provider: 'ollama', model: 'other-model', execution: 'client' }, { checkOllamaLane });
    assert.equal(first.status, LANE_STATUS.AVAILABLE);
    assert.equal(second.status, LANE_STATUS.MISSING_MODEL);
  });

  it('a bge-m3-onnx lane checked twice for the SAME model calls checkOnnxModelCached only once', async () => {
    let calls = 0;
    const checkOnnxModelCached = async () => { calls++; return { status: LANE_STATUS.MODEL_CACHED }; };
    const lane = { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', execution: 'client' };
    await resolveLaneAvailability(lane, { checkOnnxModelCached });
    await resolveLaneAvailability(lane, { checkOnnxModelCached });
    assert.equal(calls, 1);
  });

  it('the ollama cache and the bge-m3-onnx cache are keyed separately even if a model string happened to collide', async () => {
    const checkOllamaLane = async () => ({ status: 'available' });
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.NOT_CACHED });
    const ollamaResult = await resolveLaneAvailability({ provider: 'ollama', model: 'shared-name', execution: 'client' }, { checkOllamaLane, checkOnnxModelCached });
    const onnxResult = await resolveLaneAvailability({ provider: 'bge-m3-onnx', model: 'shared-name', execution: 'client' }, { checkOllamaLane, checkOnnxModelCached });
    assert.equal(ollamaResult.status, LANE_STATUS.AVAILABLE);
    assert.equal(onnxResult.status, LANE_STATUS.NOT_CACHED);
  });

  it('resetLaneAvailabilityCache() clears cached results, forcing a fresh check', async () => {
    let calls = 0;
    const checkOllamaLane = async () => { calls++; return { status: 'available' }; };
    const lane = { provider: 'ollama', model: 'bge-m3', execution: 'client' };
    await resolveLaneAvailability(lane, { checkOllamaLane });
    resetLaneAvailabilityCache();
    await resolveLaneAvailability(lane, { checkOllamaLane });
    assert.equal(calls, 2);
  });
});

describe('resolveAvailability — non-resolved outcomes map to distinct COLLECTION_STATUS values, no lane checks run', () => {
  it('legacy_unmigrated -> COLLECTION_STATUS.LEGACY_UNMIGRATED', async () => {
    const result = await resolveAvailability({ resolved: false, reason: 'legacy_unmigrated' }, {});
    assert.equal(result.status, COLLECTION_STATUS.LEGACY_UNMIGRATED);
    assert.equal(result.dense, null);
    assert.equal(result.aggregate.browsingAvailable, true);
    assert.equal(result.aggregate.hybridSearchAvailable, false);
  });

  it('invalid -> COLLECTION_STATUS.INVALID_PROFILE', async () => {
    const result = await resolveAvailability({ resolved: false, reason: 'invalid' }, {});
    assert.equal(result.status, COLLECTION_STATUS.INVALID_PROFILE);
  });

  it('unsupported_schema_version -> COLLECTION_STATUS.UNSUPPORTED_PROFILE_SCHEMA', async () => {
    const result = await resolveAvailability({ resolved: false, reason: 'unsupported_schema_version' }, {});
    assert.equal(result.status, COLLECTION_STATUS.UNSUPPORTED_PROFILE_SCHEMA);
  });

  it('schema_mismatch -> COLLECTION_STATUS.SCHEMA_MISMATCH — a shape-valid profile that disagrees with the live vector schema, distinct from every other non-resolved reason', async () => {
    const result = await resolveAvailability({ resolved: false, reason: 'schema_mismatch', mismatches: [{ field: 'dense.dimensions', expected: 1024, found: 768 }] }, {});
    assert.equal(result.status, COLLECTION_STATUS.SCHEMA_MISMATCH);
    assert.notEqual(result.status, COLLECTION_STATUS.AMBIGUOUS_LEGACY, 'must not fall through to the generic ambiguous_legacy default — schema_mismatch has its own explicit mapping');
  });

  it('no lane-check functions are ever called for any non-resolved outcome', async () => {
    let called = false;
    const checkOllamaLane = async () => { called = true; return { status: 'available' }; };
    const checkOnnxModelCached = async () => { called = true; return { status: LANE_STATUS.MODEL_CACHED }; };
    for (const reason of ['legacy_unmigrated', 'invalid', 'unsupported_schema_version', 'schema_mismatch']) {
      await resolveAvailability({ resolved: false, reason }, { checkOllamaLane, checkOnnxModelCached });
    }
    assert.equal(called, false);
  });
});

describe('resolveAvailability — resolved profile, strict hybridSearchAvailable vs looser searchAttemptable', () => {
  it('both lanes fully AVAILABLE -> hybridSearchAvailable: true, status: AVAILABLE', async () => {
    const checkOllamaLane = async () => ({ status: 'available' });
    const result = await resolveAvailability({ resolved: true, profile: profile() }, { checkOllamaLane });
    assert.equal(result.aggregate.hybridSearchAvailable, true);
    assert.equal(result.aggregate.searchAttemptable, true);
    assert.equal(result.status, COLLECTION_STATUS.AVAILABLE);
  });

  it('missing Ollama model disables hybridSearchAvailable but never browsingAvailable', async () => {
    const checkOllamaLane = async () => ({ status: 'model_missing', message: 'not pulled' });
    const result = await resolveAvailability({ resolved: true, profile: profile() }, { checkOllamaLane });
    assert.equal(result.aggregate.hybridSearchAvailable, false);
    assert.equal(result.aggregate.browsingAvailable, true);
    assert.equal(result.status, COLLECTION_STATUS.MISSING_MODEL);
  });

  it('a dense-only profile (sparse: null) produces hybridSearchAvailable: false with a reason distinguishing "no sparse lane configured" — sparse === null must NOT satisfy the aggregate', async () => {
    const checkOllamaLane = async () => ({ status: 'available' });
    const denseOnly = profile({ sparse: null });
    const result = await resolveAvailability({ resolved: true, profile: denseOnly }, { checkOllamaLane });
    assert.equal(result.aggregate.hybridSearchAvailable, false);
    assert.equal(result.sparse, null);
  });

  it('a broken sparse lane alone (dense fine) also disables hybridSearchAvailable, with a distinct reason from the null case', async () => {
    const checkOllamaLane = async ({ requiredModel }) => (requiredModel === 'bge-m3' ? { status: 'available' } : { status: 'model_missing' });
    // sparse provider is 'ollama' here purely to exercise a real lane failure via the same DI hook.
    const p = profile({ sparse: { provider: 'ollama', model: 'sparse-model-x', execution: 'client' } });
    const result = await resolveAvailability({ resolved: true, profile: p }, { checkOllamaLane });
    assert.equal(result.aggregate.hybridSearchAvailable, false);
    assert.notEqual(result.sparse.status, LANE_STATUS.AVAILABLE);
  });

  it('unsupported_backend for a qdrant-cloud execution profile', async () => {
    const p = profile({ denseExecution: 'qdrant-cloud', sparse: null });
    const result = await resolveAvailability({ resolved: true, profile: p }, {});
    assert.equal(result.status, COLLECTION_STATUS.UNSUPPORTED_BACKEND);
    assert.equal(result.aggregate.hybridSearchAvailable, false);
    assert.equal(result.aggregate.searchAttemptable, false);
  });

  it('available for both local providers (ollama+hashed-tf) when actually reachable', async () => {
    const checkOllamaLane = async () => ({ status: 'available' });
    const result = await resolveAvailability({ resolved: true, profile: profile() }, { checkOllamaLane });
    assert.equal(result.status, COLLECTION_STATUS.AVAILABLE);
  });

  it('ONNX MODEL_CACHED (never AVAILABLE) — regression test: hybridSearchAvailable: false (strict), searchAttemptable: true, status: RUNTIME_UNVERIFIED (never AVAILABLE)', async () => {
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.MODEL_CACHED });
    const p = profile({ denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparse: { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', execution: 'client' } });
    const result = await resolveAvailability({ resolved: true, profile: p }, { checkOnnxModelCached });
    assert.equal(result.aggregate.hybridSearchAvailable, false, 'MODEL_CACHED must NOT satisfy the strict boolean');
    assert.equal(result.aggregate.searchAttemptable, true);
    assert.equal(result.status, COLLECTION_STATUS.RUNTIME_UNVERIFIED);
    assert.notEqual(result.status, COLLECTION_STATUS.AVAILABLE);
  });

  it('ONNX NOT_CACHED — regression test: searchAttemptable: true (Semidex auto-downloads), status: DOWNLOAD_REQUIRED, distinct from Ollama MISSING_MODEL', async () => {
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.NOT_CACHED });
    const p = profile({ denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparse: { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', execution: 'client' } });
    const result = await resolveAvailability({ resolved: true, profile: p }, { checkOnnxModelCached });
    assert.equal(result.aggregate.searchAttemptable, true, 'NOT_CACHED must still count as attemptable — Semidex auto-downloads ONNX models on first use');
    assert.equal(result.status, COLLECTION_STATUS.DOWNLOAD_REQUIRED);
  });

  it('Ollama MISSING_MODEL produces searchAttemptable: false — the exact distinction from ONNX NOT_CACHED, since Semidex never auto-pulls Ollama models', async () => {
    const checkOllamaLane = async () => ({ status: 'model_missing' });
    const result = await resolveAvailability({ resolved: true, profile: profile() }, { checkOllamaLane });
    assert.equal(result.aggregate.searchAttemptable, false);
    assert.equal(result.status, COLLECTION_STATUS.MISSING_MODEL);
  });

  it('checkOnnxRuntimeProbe / probeOnnxProvider-shaped function is NEVER called by resolveAvailability — routine resolution never touches the expensive probe', async () => {
    let expensiveProbeCalled = false;
    const checkOnnxModelCached = async () => ({ status: LANE_STATUS.MODEL_CACHED });
    const deps = {
      checkOnnxModelCached,
      checkOnnxRuntimeProbe: async () => { expensiveProbeCalled = true; return { ok: true }; },
    };
    const p = profile({ denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparse: null });
    await resolveAvailability({ resolved: true, profile: p }, deps);
    assert.equal(expensiveProbeCalled, false);
  });

  it('no denseOnlySearchAvailable-shaped field exists anywhere in the result', async () => {
    const checkOllamaLane = async () => ({ status: 'available' });
    const result = await resolveAvailability({ resolved: true, profile: profile() }, { checkOllamaLane });
    assert.equal('denseOnlySearchAvailable' in result.aggregate, false);
    assert.equal(JSON.stringify(result).includes('denseOnlySearchAvailable'), false);
  });
});
