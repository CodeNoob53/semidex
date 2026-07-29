// core/run-suite.mjs's CUDA preflight — offline, using the injectable
// probeOnnxProviderFn DI parameter (never the real ONNX runtime probe).
// Confirms: a fallback-to-CPU result aborts the local profile BEFORE
// indexing is ever attempted, never silently continuing on CPU and
// mislabeling the run as GPU-accelerated.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { checkpointPathFor } from './core/checkpoint.mjs';

function tinyDataset() {
  const corpus = new Map([['doc-0', { title: 'T', text: 'Body' }]]);
  const queries = new Map([['q-0', 'query text']]);
  const qrels = new Map([['q-0', new Map([['doc-0', 1]])]]);
  return { corpus, queries, qrels };
}

const cleanupTargets = [];
afterEach(() => {
  for (const path of cleanupTargets.splice(0)) rmSync(path, { recursive: true, force: true });
});

function cleanupSuite(suiteId) {
  cleanupTargets.push(checkpointPathFor(suiteId, { smoke: true }));
  cleanupTargets.push(checkpointPathFor(suiteId, { smoke: false }));
}

describe('CUDA preflight — cuda:true, fellBackToCpu:true aborts before indexing', () => {
  it('local profile never calls runIndexer when the CUDA probe reports a CPU fallback', async () => {
    const suiteId = `unit-test-cuda-fallback-${Date.now()}`;
    cleanupSuite(suiteId);
    const indexerCalls = [];
    const runIndexer = async (env, targetPath) => {
      indexerCalls.push({ profile: env.DENSE_PROVIDER, targetPath });
      return { stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 };
    };
    const queryOne = async () => ({ ok: true, hits: [], ms: 1, error: null });
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const probeOnnxProviderFn = async () => ({ ok: true, effectiveProvider: 'cpu', fellBackToCpu: true, message: 'CUDA runtime not found' });

    const { state } = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp-cuda', ...tinyDataset(), toMarkdown: (d) => d.text,
      smoke: true, cudaRequested: true, adapter, runIndexer, queryOne, probeOnnxProviderFn,
    });

    assert.equal(indexerCalls.some((c) => c.profile === 'bge-m3-onnx'), false, 'local profile\'s indexer must never be invoked after a CUDA fallback');
    assert.ok(state.profiles.local.errors.some((e) => e.message?.includes('CUDA requested but unavailable')));
    // Cloud profile is entirely unaffected by the local-only CUDA gate.
    assert.equal(indexerCalls.some((c) => c.profile === 'qdrant-cloud'), true, 'the cloud profile must still run normally — CUDA preflight is local-only');
  });

  it('local profile proceeds to indexing normally when the CUDA probe succeeds', async () => {
    const suiteId = `unit-test-cuda-ok-${Date.now()}`;
    cleanupSuite(suiteId);
    const indexerCalls = [];
    const runIndexer = async (env) => { indexerCalls.push(env.DENSE_PROVIDER); return { stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 }; };
    const queryOne = async () => ({ ok: true, hits: [], ms: 1, error: null });
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const probeOnnxProviderFn = async () => ({ ok: true, effectiveProvider: 'cuda', fellBackToCpu: false });

    await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp-cuda-ok', ...tinyDataset(), toMarkdown: (d) => d.text,
      smoke: true, cudaRequested: true, adapter, runIndexer, queryOne, probeOnnxProviderFn,
    });

    assert.equal(indexerCalls.includes('bge-m3-onnx'), true, 'local profile must still be indexed when the CUDA probe succeeds');
  });

  it('the probe is never called at all when cudaRequested is false — no unnecessary preflight overhead', async () => {
    const suiteId = `unit-test-cuda-not-requested-${Date.now()}`;
    cleanupSuite(suiteId);
    let probeCalled = false;
    const probeOnnxProviderFn = async () => { probeCalled = true; return { ok: true, fellBackToCpu: false }; };
    const runIndexer = async () => ({ stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 });
    const queryOne = async () => ({ ok: true, hits: [], ms: 1, error: null });
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };

    await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp-cuda-not-req', ...tinyDataset(), toMarkdown: (d) => d.text,
      smoke: true, cudaRequested: false, adapter, runIndexer, queryOne, probeOnnxProviderFn,
    });

    assert.equal(probeCalled, false);
  });
});
