// Proves the generic resolver+scheduler stack (resolvePipelineResourceIdentities
// + resolveIndexSchedulingPolicy + runBoundedFilePipeline) works for
// non-Ollama/non-ONNX scenarios using ONLY fake capability objects — never
// touching real stageB/Ollama/ONNX integration. This is the direct proof
// that adding a new provider means adding a capability, never a scheduler
// change: every fake below uses the exact same uniform
// { getResourceIdentity({env}) } shape a real capability would.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePipelineResourceIdentities } from '../../../../src/shared/indexer/device/resource-identity.js';
import { resolveIndexSchedulingPolicy } from '../../../../src/shared/indexer/device/scheduling-policy.js';
import { runBoundedFilePipeline } from '../../../../src/shared/indexer/pipeline/bounded-file-pipeline.js';

function fakeCapability(resourceIdentity) {
  if (typeof resourceIdentity === 'function') return { getResourceIdentity: resourceIdentity };
  return { getResourceIdentity: async () => resourceIdentity };
}

const UNKNOWN = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };

async function policyFor({ generation, embedding, tagging = UNKNOWN }) {
  const identities = await resolvePipelineResourceIdentities({
    generationCapability: fakeCapability(generation),
    embeddingCapability: fakeCapability(embedding),
    taggingCapability: fakeCapability(tagging),
    env: {},
  });
  return resolveIndexSchedulingPolicy(identities);
}

describe('provider-agnostic scheduling — end-to-end via fake capabilities', () => {
  it('1. Ollama-shaped generation GPU + ONNX-shaped embedding CPU -> overlap (regression, unchanged behavior through the new resolver)', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('2. ONNX-generation GPU + ONNX-embedding CPU -> overlap, no Ollama involved at all', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'onnx-generation-cuda', deviceId: 'cuda:0', verified: true, source: 'onnx-runtime' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('3. cloud-generation remote + local-embedding cpu -> overlap', async () => {
    const policy = await policyFor({
      generation: { kind: 'remote', backend: 'my-cloud-llm-provider', deviceId: null, verified: true, source: 'cloud-api' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('4. local-generation gpu + Qdrant-Cloud-embedding remote -> overlap', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' },
      embedding: { kind: 'remote', backend: 'qdrant-cloud', deviceId: null, verified: true, source: 'manual' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('5. cloud generation + cloud embedding -> overlap, no local device-lane conflict', async () => {
    const policy = await policyFor({
      generation: { kind: 'remote', backend: 'gemini', deviceId: null, verified: true, source: 'cloud-api' },
      embedding: { kind: 'remote', backend: 'qdrant-cloud', deviceId: null, verified: true, source: 'manual' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('6. generation and embedding on the SAME GPU deviceId -> sequential', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'onnx-generation-cuda', deviceId: 'gpu-0', verified: true, source: 'onnx-runtime' },
      embedding: { kind: 'gpu', backend: 'onnx-cuda', deviceId: 'gpu-0', verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, false);
  });

  it('7. two DIFFERENT verified GPU deviceIds -> overlap', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'onnx-generation-cuda', deviceId: 'gpu-0', verified: true, source: 'onnx-runtime' },
      embedding: { kind: 'gpu', backend: 'onnx-cuda', deviceId: 'gpu-1', verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true);
  });

  it('8a. unknown identity -> sequential', async () => {
    const policy = await policyFor({
      generation: UNKNOWN,
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, false);
  });

  it('8b. mixed identity -> sequential', async () => {
    const policy = await policyFor({
      generation: { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, false);
  });

  it('9. a capability that throws SYNCHRONOUSLY -> unknown, and the real bounded pipeline does not crash — files still get processed', async () => {
    function syncThrowingCapability() {
      return { getResourceIdentity: () => { throw new Error('sync throw from a fake provider capability'); } };
    }
    const events = [];
    const recomputePolicy = async () => {
      const identities = await resolvePipelineResourceIdentities({
        generationCapability: syncThrowingCapability(),
        embeddingCapability: fakeCapability({ kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' }),
        taggingCapability: fakeCapability(UNKNOWN),
        env: {},
      });
      return resolveIndexSchedulingPolicy(identities);
    };
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => { events.push(`${prepared.file}:B`); return prepared; };
    const runStageC = async (prepared) => { events.push(`${prepared.file}:C`); return prepared; };
    const runStageD = async (prepared) => { events.push(`${prepared.file}:D`); };

    const { results } = await runBoundedFilePipeline({
      files: ['a', 'b'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
    });
    assert.deepEqual(results, ['indexed', 'indexed']);
    assert.deepEqual(events.sort(), ['a:B', 'a:C', 'a:D', 'b:B', 'b:C', 'b:D']);
  });

  it('10. a capability that returns a rejected Promise -> unknown, and the real bounded pipeline does not crash', async () => {
    function rejectingCapability() {
      return { getResourceIdentity: async () => { throw new Error('async rejection from a fake provider capability'); } };
    }
    const events = [];
    const recomputePolicy = async () => {
      const identities = await resolvePipelineResourceIdentities({
        generationCapability: fakeCapability({ kind: 'gpu', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' }),
        embeddingCapability: rejectingCapability(),
        taggingCapability: fakeCapability(UNKNOWN),
        env: {},
      });
      return resolveIndexSchedulingPolicy(identities);
    };
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => { events.push(`${prepared.file}:B`); return prepared; };
    const runStageC = async (prepared) => { events.push(`${prepared.file}:C`); return prepared; };
    const runStageD = async (prepared) => { events.push(`${prepared.file}:D`); };

    const { results } = await runBoundedFilePipeline({
      files: ['a'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
    });
    assert.deepEqual(results, ['indexed']);
    assert.deepEqual(events, ['a:B', 'a:C', 'a:D']);
  });

  it('11. generation capability can be an arbitrary ONNX-shaped backend string with zero scheduler code change', async () => {
    const policy = await policyFor({
      generation: { kind: 'gpu', backend: 'onnx-generation-directml', deviceId: null, verified: true, source: 'onnx-runtime' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true, 'overlap must be decided purely from kind/verified/deviceId, never from backend string content');
  });

  it('12. a provider with a completely new, never-before-seen name works through identity without adding scheduler conditions', async () => {
    const policy = await policyFor({
      generation: { kind: 'cpu', backend: 'openrouter-llama-70b-cpu-inference', deviceId: null, verified: true, source: 'openrouter-api-v3' },
      embedding: { kind: 'gpu', backend: 'some-future-embedding-accelerator', deviceId: 'accel-0', verified: true, source: 'future-provider-source' },
    });
    assert.equal(policy.canOverlapGenerationAndEmbedding, true, 'a genuinely novel provider name/source must never require a scheduler change to produce correct overlap decisions');
  });

  it('proves actual stage-event ORDERING for a real overlap scenario driven through the full stack (not just the policy booleans)', async () => {
    const events = [];
    let resolveAEmbed;
    const gateAEmbed = new Promise((r) => { resolveAEmbed = r; });

    const recomputePolicy = async () => policyFor({
      generation: { kind: 'gpu', backend: 'my-hypothetical-provider', deviceId: null, verified: true, source: 'onnx-runtime' },
      embedding: { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' },
    });

    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      if (prepared.file === 'A') await gateAEmbed;
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    const run = runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
    });

    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    // B's own summarizing should have started and finished while A's
    // embedding is still gated open — genuine cross-file overlap, proven
    // by actual event ordering, not just the policy's boolean output.
    assert.ok(events.includes('B:summarizing:start'));
    assert.ok(events.includes('B:summarizing:end'));
    assert.ok(!events.includes('A:embedding:end'), 'A:embedding:end should not have fired yet -- gateAEmbed is still held');

    resolveAEmbed();
    await run;
  });
});
