// core/run-suite.mjs — offline. runIndexer/queryOne/adapter are ALL
// dependency-injected here with fakes/throw-on-call stubs — this is what
// makes "this test never touches the network" a structural property of
// what's passed in (Finding R2-6), never a property inferred from
// grepping source text. Every test uses a fresh, unique suiteId so
// checkpoint files never collide across test runs.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { checkpointPathFor } from './core/checkpoint.mjs';
import { COLLECTION_PREFIX } from './core/profiles.mjs';
import { materializedDir } from './core/isolated-config.mjs';

function throwingAdapter() {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined; // avoid being awaited-as-thenable in async contexts
      return () => { throw new Error(`offline test attempted a real adapter call: ${String(prop)}`); };
    },
  });
}

function throwingRunIndexer() {
  return async () => { throw new Error('offline test attempted to spawn the real indexer'); };
}

function throwingQueryOne() {
  return async () => { throw new Error('offline test attempted a real query'); };
}

function tinyDataset({ docCount = 3, queryCount = 2 } = {}) {
  const corpus = new Map();
  for (let i = 0; i < docCount; i++) corpus.set(`doc-${i}`, { title: `T${i}`, text: `Body ${i}` });
  const queries = new Map();
  const qrels = new Map();
  for (let i = 0; i < queryCount; i++) {
    queries.set(`q-${i}`, `query text ${i}`);
    qrels.set(`q-${i}`, new Map([[`doc-${i}`, 1]]));
  }
  return { corpus, queries, qrels };
}

const cleanupTargets = [];
afterEach(() => {
  for (const path of cleanupTargets.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function cleanupSuite(suiteId) {
  cleanupTargets.push(checkpointPathFor(suiteId, { smoke: true }));
  cleanupTargets.push(checkpointPathFor(suiteId, { smoke: false }));
}

describe('runSuiteAcrossProfiles() — required DI, never internal construction', () => {
  it('throws if adapter/runIndexer/queryOne are omitted — never silently defaults to a real implementation', async () => {
    const suiteId = `unit-test-di-${Date.now()}`;
    cleanupSuite(suiteId);
    await assert.rejects(() => runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'x', ...tinyDataset(), toMarkdown: (d) => d.text, smoke: true,
    }), /adapter, runIndexer, and queryOne are all required/);
  });
});

describe('runSuiteAcrossProfiles() — production path actually invoked (spy)', () => {
  it('calls runIndexer with the real materialized directory as its target, and calls queryOne once per query per profile', async () => {
    const suiteId = `unit-test-invoked-${Date.now()}`;
    cleanupSuite(suiteId);
    const indexerCalls = [];
    const queryCalls = [];
    const runIndexer = async (env, targetPath) => {
      indexerCalls.push({ env, targetPath });
      return { stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: 1000, ms: 5 };
    };
    const queryOne = async ({ collection, query }) => {
      queryCalls.push({ collection, query });
      return { ok: true, hits: [], ms: 1, error: null };
    };
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };

    const { state } = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp1', ...tinyDataset({ docCount: 2, queryCount: 2 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });

    assert.equal(indexerCalls.length, 2, 'expected one indexer spawn per profile (local + cloud)');
    assert.equal(queryCalls.length, 4, 'expected 2 queries x 2 profiles = 4 query calls');
    for (const call of indexerCalls) {
      assert.ok(call.targetPath.includes('materialized'), 'indexer must be spawned against the real materialized directory, never a hand-built point payload');
      assert.equal(call.env.COLLECTION, indexerCalls.find((c) => c.env === call.env).env.COLLECTION);
    }
    for (const profileId of ['local', 'cloud']) {
      assert.ok(state.profiles[profileId]);
      assert.ok(state.profiles[profileId].collection.startsWith(COLLECTION_PREFIX));
    }
  });
});

describe('runSuiteAcrossProfiles() — cleanup always runs, even when an injected step throws', () => {
  it('cleanupCollection (via adapter.deleteCollection) is still called when queryOne throws mid-profile', async () => {
    const suiteId = `unit-test-cleanup-throw-${Date.now()}`;
    cleanupSuite(suiteId);
    const deleteCalls = [];
    const adapter = {
      deleteCollection: async (name) => { deleteCalls.push(name); },
      listCollections: async () => [],
    };
    const runIndexer = async () => ({ stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 });
    const queryOne = async () => { throw new Error('simulated query crash'); };

    const { state } = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp2', ...tinyDataset({ docCount: 1, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });

    assert.equal(deleteCalls.length, 2, 'cleanup must be attempted for BOTH profiles despite the query step throwing in each');
    for (const profileId of ['local', 'cloud']) {
      assert.equal(state.profiles[profileId].cleanup.deleted, true);
      assert.ok(state.profiles[profileId].errors.length > 0, 'the simulated crash must be recorded as an error');
    }
  });
});

describe('runSuiteAcrossProfiles() — resume/checkpoint correctness', () => {
  it('a resumed run skips a profile whose checkpoint is already complete, and only reruns the incomplete one', async () => {
    const suiteId = `unit-test-resume-${Date.now()}`;
    cleanupSuite(suiteId);
    const indexerCalls = [];
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const runIndexer = async (env, targetPath) => {
      indexerCalls.push(targetPath);
      return { stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 };
    };
    const queryOne = async () => ({ ok: true, hits: [], ms: 1, error: null });

    const first = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp3', ...tinyDataset({ docCount: 1, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });
    assert.equal(indexerCalls.length, 2);
    assert.equal(first.state.verdict, 'COMPLETE');

    // Resuming a fully-complete run should skip BOTH profiles (nothing left to do).
    indexerCalls.length = 0;
    const second = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp3', ...tinyDataset({ docCount: 1, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, resume: true, adapter, runIndexer, queryOne,
    });
    assert.equal(indexerCalls.length, 0, 'a resume of an already-complete run must not re-invoke the indexer for either profile');
    assert.equal(second.state.verdict, 'COMPLETE');
  });
});

describe('runSuiteAcrossProfiles() — end-to-end unmapped-hit tracking with REAL Chunk-shaped hits', () => {
  it('zero unmappedHitCount when queryOne returns real Chunk-shaped hits (sourceFile top-level, not payload.source_file) matching the materialized filenames — REGRESSION for the payload-vs-flat-shape bug caught by a live smoke run', async () => {
    const suiteId = `unit-test-real-shape-${Date.now()}`;
    cleanupSuite(suiteId);
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const runIndexer = async () => ({ stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 });
    // Real runHybridSearch() hits are flat Chunk objects (toChunk() shape)
    // — sourceFile directly on the hit, never nested under .payload.
    const queryOne = async () => ({
      ok: true,
      hits: [
        { sourceFile: 'doc-doc-0.md', score: 0.9, text: 'chunk text' },
        { sourceFile: 'doc-doc-1.md', score: 0.8, text: 'chunk text' },
      ],
      ms: 1,
      error: null,
    });

    const { state } = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp-realshape', ...tinyDataset({ docCount: 2, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });

    for (const profileId of ['local', 'cloud']) {
      assert.equal(state.profiles[profileId].unmappedHitCount, 0, `${profileId} profile: real Chunk-shaped hits matching materialized filenames must never be counted as unmapped`);
    }
  });

  it('a raw-Qdrant-point-shaped hit ({payload:{source_file}}) — the WRONG shape a real Chunk never has — is correctly counted as unmapped, proving the gate actually catches the shape mismatch rather than passing vacuously', async () => {
    const suiteId = `unit-test-wrong-shape-${Date.now()}`;
    cleanupSuite(suiteId);
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const runIndexer = async () => ({ stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 });
    const queryOne = async () => ({
      ok: true,
      hits: [{ payload: { source_file: 'doc-doc-0.md' }, score: 0.9 }],
      ms: 1,
      error: null,
    });

    const { state } = await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp-wrongshape', ...tinyDataset({ docCount: 1, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });

    for (const profileId of ['local', 'cloud']) {
      assert.equal(state.profiles[profileId].unmappedHitCount, 1, `${profileId} profile: a payload-shaped hit has no top-level sourceFile and must be counted as unmapped`);
    }
  });
});

describe('runSuiteAcrossProfiles() — identical corpus/query membership across profiles', () => {
  it('both profiles materialize the exact same set of document IDs from the same input dataset', async () => {
    const suiteId = `unit-test-membership-${Date.now()}`;
    cleanupSuite(suiteId);
    const materializedTargets = [];
    const adapter = { deleteCollection: async () => {}, listCollections: async () => [] };
    const runIndexer = async (env, targetPath) => {
      materializedTargets.push({ targetPath, sourceRoot: env.SOURCE_ROOT });
      return { stdout: '', stderr: '', exitCode: 0, peakChildRssBytes: null, ms: 1 };
    };
    const queryOne = async () => ({ ok: true, hits: [], ms: 1, error: null });

    await runSuiteAcrossProfiles({
      suiteId, datasetFingerprint: 'fp4', ...tinyDataset({ docCount: 3, queryCount: 1 }),
      toMarkdown: (d) => d.text, smoke: true, adapter, runIndexer, queryOne,
    });

    assert.equal(materializedTargets.length, 2);
    const localDir = materializedTargets.find((t) => t.targetPath.includes('local'))?.targetPath;
    const cloudDir = materializedTargets.find((t) => t.targetPath.includes('cloud'))?.targetPath;
    assert.ok(localDir && cloudDir);
    const localFiles = readdirSync(localDir).sort();
    const cloudFiles = readdirSync(cloudDir).sort();
    assert.deepEqual(localFiles, cloudFiles, 'both profiles must materialize the exact same document filenames from the same input corpus');
    for (const f of [localDir, cloudDir]) cleanupTargets.push(f);
  });
});
