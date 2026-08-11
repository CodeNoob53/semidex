// device/resource-identity.js — now fully provider-agnostic. Every
// provider-specific resolver that used to be tested here (Ollama VRAM
// classification, ONNX provider-state mapping, active-model selection) has
// relocated into the capability that owns that knowledge — see
// tests/unit/local/core/ollama-resource-identity.test.js and
// tests/unit/local/core/onnx-embed-resource-identity.test.js. This file
// tests only the one generic function this module still exports:
// resolvePipelineResourceIdentities().
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePipelineResourceIdentities } from '../../../../src/shared/indexer/device/resource-identity.js';

function fakeCapability(resourceIdentity) {
  return { getResourceIdentity: mock.fn(async () => resourceIdentity) };
}

const GPU_A = { kind: 'gpu', backend: 'test-gpu', deviceId: 'gpu-a', verified: true, source: 'test' };
const CPU = { kind: 'cpu', backend: 'test-cpu', deviceId: null, verified: true, source: 'test' };
const UNKNOWN = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };

describe('resolvePipelineResourceIdentities', () => {
  it('composes generation/embedding/tagging from three normal capabilities', async () => {
    const result = await resolvePipelineResourceIdentities({
      generationCapability: fakeCapability(GPU_A),
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(result, { generation: GPU_A, embedding: CPU, tagging: CPU });
  });

  it('a capability whose getResourceIdentity throws SYNCHRONOUSLY -> that slot becomes unknown, others unaffected, no throw propagates', async () => {
    function syncThrow() { throw new Error('sync throw before any Promise'); }
    const result = await resolvePipelineResourceIdentities({
      generationCapability: { getResourceIdentity: syncThrow },
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(GPU_A),
      env: {},
    });
    assert.deepEqual(result.generation, UNKNOWN);
    assert.deepEqual(result.embedding, CPU);
    assert.deepEqual(result.tagging, GPU_A);
  });

  it('a capability whose getResourceIdentity returns a rejected Promise -> that slot becomes unknown, others unaffected', async () => {
    const result = await resolvePipelineResourceIdentities({
      generationCapability: fakeCapability(GPU_A),
      embeddingCapability: { getResourceIdentity: async () => { throw new Error('async rejection'); } },
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(result.generation, GPU_A);
    assert.deepEqual(result.embedding, UNKNOWN);
    assert.deepEqual(result.tagging, CPU);
  });

  it('a capability that returns a malformed/non-ResourceIdentity-shaped value -> normalized to unknown', async () => {
    const malformed = [
      { getResourceIdentity: async () => null },
      { getResourceIdentity: async () => 'not an object' },
      { getResourceIdentity: async () => ({ kind: 'not-a-real-kind', backend: 'x', deviceId: null, verified: true }) },
      { getResourceIdentity: async () => ({ kind: 'cpu', backend: 123, deviceId: null, verified: true }) }, // backend not a string
      { getResourceIdentity: async () => ({ kind: 'cpu', backend: 'x', deviceId: 42, verified: true }) }, // deviceId not string/null
      { getResourceIdentity: async () => ({ kind: 'cpu', backend: 'x', deviceId: null, verified: 'yes' }) }, // verified not boolean
    ];
    for (const cap of malformed) {
      const result = await resolvePipelineResourceIdentities({
        generationCapability: cap,
        embeddingCapability: fakeCapability(CPU),
        taggingCapability: fakeCapability(CPU),
        env: {},
      });
      assert.deepEqual(result.generation, UNKNOWN, `expected malformed result to normalize to unknown: ${JSON.stringify(cap)}`);
    }
  });

  it('a null/missing capability slot -> unknown for that slot, no crash', async () => {
    const result = await resolvePipelineResourceIdentities({
      generationCapability: null,
      embeddingCapability: undefined,
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(result.generation, UNKNOWN);
    assert.deepEqual(result.embedding, UNKNOWN);
    assert.deepEqual(result.tagging, CPU);
  });

  it('a capability object missing getResourceIdentity entirely -> unknown for that slot, no crash', async () => {
    const result = await resolvePipelineResourceIdentities({
      generationCapability: {},
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(result.generation, UNKNOWN);
  });

  it('context (env) is passed through unmodified to each capability\'s getResourceIdentity call', async () => {
    const env = { SOME_VAR: 'value' };
    const genCap = fakeCapability(GPU_A);
    const embedCap = fakeCapability(CPU);
    const tagCap = fakeCapability(CPU);
    await resolvePipelineResourceIdentities({
      generationCapability: genCap,
      embeddingCapability: embedCap,
      taggingCapability: tagCap,
      env,
    });
    assert.deepEqual(genCap.getResourceIdentity.mock.calls[0].arguments[0], { env });
    assert.deepEqual(embedCap.getResourceIdentity.mock.calls[0].arguments[0], { env });
    assert.deepEqual(tagCap.getResourceIdentity.mock.calls[0].arguments[0], { env });
  });

  it('two calls with two different fake capability instances never leak state between them', async () => {
    const genCapA = fakeCapability(GPU_A);
    const genCapB = fakeCapability(CPU);
    const resultA = await resolvePipelineResourceIdentities({
      generationCapability: genCapA,
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    const resultB = await resolvePipelineResourceIdentities({
      generationCapability: genCapB,
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(resultA.generation, GPU_A);
    assert.deepEqual(resultB.generation, CPU);
    assert.equal(genCapA.getResourceIdentity.mock.callCount(), 1);
    assert.equal(genCapB.getResourceIdentity.mock.callCount(), 1);
  });

  it('never imports, names, or requires provider-specific fields — an arbitrary, never-before-seen backend/source string passes through untouched', async () => {
    const exotic = { kind: 'gpu', backend: 'my-hypothetical-provider-v2', deviceId: 'exotic-device-7', verified: true, source: 'exotic-source-token' };
    const result = await resolvePipelineResourceIdentities({
      generationCapability: fakeCapability(exotic),
      embeddingCapability: fakeCapability(CPU),
      taggingCapability: fakeCapability(CPU),
      env: {},
    });
    assert.deepEqual(result.generation, exotic);
  });
});
