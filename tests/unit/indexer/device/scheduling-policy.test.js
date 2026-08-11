import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndexSchedulingPolicy } from '../../../../src/shared/indexer/device/scheduling-policy.js';

function id(overrides) {
  return { kind: 'unknown', backend: 'x', deviceId: null, verified: false, source: null, ...overrides };
}

const cpuV = (extra = {}) => id({ kind: 'cpu', verified: true, source: 'ollama-api', ...extra });
const gpuV = (extra = {}) => id({ kind: 'gpu', verified: true, source: 'ollama-api', ...extra });
const cpuU = (extra = {}) => id({ kind: 'cpu', verified: false, source: 'manual', ...extra });
const gpuU = (extra = {}) => id({ kind: 'gpu', verified: false, source: 'manual', ...extra });
// A resolved GENERATION_DEVICE_OVERRIDE -- verified:true (explicit
// operator assertion) but source stays 'manual' forever, per
// resolveGenerationResourceIdentity()'s deliberate exception.
const cpuManualV = (extra = {}) => id({ kind: 'cpu', verified: true, source: 'manual', ...extra });
const gpuManualV = (extra = {}) => id({ kind: 'gpu', verified: true, source: 'manual', ...extra });
const mixedV = (extra = {}) => id({ kind: 'mixed', verified: true, source: 'ollama-api', ...extra });
const unknownId = (extra = {}) => id({ kind: 'unknown', verified: false, source: null, ...extra });
const taggingActive = () => id({ kind: 'cpu', verified: true, source: 'structural' });
const taggingInactive = () => id({ kind: 'unknown', verified: false, source: null });

describe('resolveIndexSchedulingPolicy', () => {
  it('1. verified cpu + verified cpu -> false (both CPU)', () => {
    const p = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: cpuV(), tagging: taggingInactive() });
    assert.equal(p.canOverlapGenerationAndEmbedding, false);
    assert.match(p.pairReasons.generationEmbedding, /both sides verified on CPU/i);
  });

  it('2. verified gpu + verified gpu, same/no deviceId -> false', () => {
    const p1 = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: gpuV(), tagging: taggingInactive() });
    assert.equal(p1.canOverlapGenerationAndEmbedding, false);
    assert.match(p1.pairReasons.generationEmbedding, /same GPU/i);

    const p2 = resolveIndexSchedulingPolicy({ generation: gpuV({ deviceId: 'gpu-0' }), embedding: gpuV({ deviceId: 'gpu-0' }), tagging: taggingInactive() });
    assert.equal(p2.canOverlapGenerationAndEmbedding, false);
    assert.match(p2.pairReasons.generationEmbedding, /same GPU/i);
  });

  it('3. verified gpu(A) + verified gpu(B), distinct deviceId -> true', () => {
    const p = resolveIndexSchedulingPolicy({
      generation: gpuV({ deviceId: 'gpu-A' }),
      embedding: gpuV({ deviceId: 'gpu-B' }),
      tagging: taggingInactive(),
    });
    assert.equal(p.canOverlapGenerationAndEmbedding, true);
    assert.match(p.pairReasons.generationEmbedding, /distinct GPU/i);
  });

  it('4. verified cpu + verified gpu (either order) -> true', () => {
    const p1 = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: gpuV(), tagging: taggingInactive() });
    assert.equal(p1.canOverlapGenerationAndEmbedding, true);
    const p2 = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: cpuV(), tagging: taggingInactive() });
    assert.equal(p2.canOverlapGenerationAndEmbedding, true);
  });

  it('4b. manually-confirmed (verified:true, source:manual) generation cpu + verified gpu embedding -> true, reason notes manual confirmation', () => {
    const p = resolveIndexSchedulingPolicy({ generation: cpuManualV(), embedding: gpuV(), tagging: taggingInactive() });
    assert.equal(p.canOverlapGenerationAndEmbedding, true);
    assert.match(p.pairReasons.generationEmbedding, /manually confirmed/i);
    // Generic wording now — this file has zero provider-specific
    // vocabulary; the reason names "an explicit operator override," never
    // a specific env var name (that specificity now lives entirely inside
    // whichever capability actually offers such an override).
    assert.match(p.pairReasons.generationEmbedding, /explicit operator override/);
  });

  it('4c. manually-confirmed generation gpu + verified cpu embedding -> true, reason notes manual confirmation', () => {
    const p = resolveIndexSchedulingPolicy({ generation: gpuManualV(), embedding: cpuV(), tagging: taggingInactive() });
    assert.equal(p.canOverlapGenerationAndEmbedding, true);
    assert.match(p.pairReasons.generationEmbedding, /manually confirmed/i);
  });

  it('4d. two verified (non-manual) sides never mention "manually confirmed" in the reason', () => {
    const p = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: gpuV(), tagging: taggingInactive() });
    assert.doesNotMatch(p.pairReasons.generationEmbedding, /manually confirmed/i);
  });

  it('5. unknown (either side) -> false', () => {
    const p1 = resolveIndexSchedulingPolicy({ generation: unknownId(), embedding: cpuV(), tagging: taggingInactive() });
    assert.equal(p1.canOverlapGenerationAndEmbedding, false);
    assert.match(p1.pairReasons.generationEmbedding, /unknown/i);

    const p2 = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: unknownId(), tagging: taggingInactive() });
    assert.equal(p2.canOverlapGenerationAndEmbedding, false);
    assert.match(p2.pairReasons.generationEmbedding, /unknown/i);
  });

  it('6. mixed (either side) -> false', () => {
    const p1 = resolveIndexSchedulingPolicy({ generation: mixedV(), embedding: cpuV(), tagging: taggingInactive() });
    assert.equal(p1.canOverlapGenerationAndEmbedding, false);
    assert.match(p1.pairReasons.generationEmbedding, /mixed/i);

    const p2 = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: mixedV(), tagging: taggingInactive() });
    assert.equal(p2.canOverlapGenerationAndEmbedding, false);
    assert.match(p2.pairReasons.generationEmbedding, /mixed/i);
  });

  it('7. unverified cpu + unverified gpu (either order) -> false ("not independently verified")', () => {
    const p1 = resolveIndexSchedulingPolicy({ generation: cpuU(), embedding: gpuU(), tagging: taggingInactive() });
    assert.equal(p1.canOverlapGenerationAndEmbedding, false);
    assert.match(p1.pairReasons.generationEmbedding, /not independently verified/i);

    const p2 = resolveIndexSchedulingPolicy({ generation: gpuU(), embedding: cpuU(), tagging: taggingInactive() });
    assert.equal(p2.canOverlapGenerationAndEmbedding, false);
    assert.match(p2.pairReasons.generationEmbedding, /not independently verified/i);
  });

  it('8. unverified gpu + verified gpu, distinct deviceId -> still false (verified-gating blocks it too)', () => {
    const p = resolveIndexSchedulingPolicy({
      generation: gpuU({ deviceId: 'gpu-A' }),
      embedding: gpuV({ deviceId: 'gpu-B' }),
      tagging: taggingInactive(),
    });
    assert.equal(p.canOverlapGenerationAndEmbedding, false);
    assert.match(p.pairReasons.generationEmbedding, /not independently verified/i);
  });

  describe('9. tagging-lane pairwise cases', () => {
    it('generation: verified-gpu, tagging: active -> canOverlapGenerationAndTagging: true', () => {
      const p = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: cpuV(), tagging: taggingActive() });
      assert.equal(p.canOverlapGenerationAndTagging, true);
    });

    it('generation: verified-cpu, tagging: active -> canOverlapGenerationAndTagging: false', () => {
      const p = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: gpuV(), tagging: taggingActive() });
      assert.equal(p.canOverlapGenerationAndTagging, false);
    });

    it('embedding: verified-cpu, tagging: active -> canOverlapTaggingAndEmbedding: false (dangerous scenario)', () => {
      const p = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: cpuV(), tagging: taggingActive() });
      assert.equal(p.canOverlapTaggingAndEmbedding, false);
    });

    it('embedding: verified-gpu (dml), tagging: active -> canOverlapTaggingAndEmbedding: true', () => {
      const p = resolveIndexSchedulingPolicy({ generation: cpuV(), embedding: gpuV(), tagging: taggingActive() });
      assert.equal(p.canOverlapTaggingAndEmbedding, true);
    });

    it('tagging: inactive -> both tagging-pair booleans false', () => {
      const p = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: cpuV(), tagging: taggingInactive() });
      assert.equal(p.canOverlapGenerationAndTagging, false);
      assert.equal(p.canOverlapTaggingAndEmbedding, false);
    });
  });

  it('10. serializedLaneGroups composition matches the 3 pairwise booleans', () => {
    const p = resolveIndexSchedulingPolicy({ generation: gpuV(), embedding: cpuV(), tagging: taggingActive() });
    // generation vs embedding: gpu+cpu, both verified -> overlap true -> not serialized
    // generation vs tagging: gpu+cpu, both verified -> overlap true -> not serialized
    // tagging vs embedding: cpu+cpu, both verified -> overlap false -> serialized
    assert.deepEqual(p.serializedLaneGroups, [['tagging', 'embedding']]);
    assert.equal(p.canOverlapGenerationAndEmbedding, true);
    assert.equal(p.canOverlapGenerationAndTagging, true);
    assert.equal(p.canOverlapTaggingAndEmbedding, false);
  });

  it('reason and pairReasons are always non-empty strings', () => {
    const p = resolveIndexSchedulingPolicy({ generation: unknownId(), embedding: unknownId(), tagging: taggingInactive() });
    assert.ok(p.reason.length > 0);
    assert.ok(p.pairReasons.generationEmbedding.length > 0);
    assert.ok(p.pairReasons.generationTagging.length > 0);
    assert.ok(p.pairReasons.taggingEmbedding.length > 0);
  });
});
