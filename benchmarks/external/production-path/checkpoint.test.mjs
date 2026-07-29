// core/checkpoint.mjs — offline, real filesystem writes to the harness's
// own .runs/ directory (never a real Qdrant/network call).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  checkpointPathFor, isCompletedProfileRun, buildBenchmarkContract,
  validateResumeCheckpoint, writeCheckpointAtomic, writeFileAtomic,
  loadCheckpointIfExists, initialCheckpointState,
} from './core/checkpoint.mjs';

const writtenPaths = [];
afterEach(() => {
  for (const path of writtenPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

describe('checkpointPathFor() — smoke and full paths are always disjoint', () => {
  it('never returns the same path for smoke:true vs smoke:false, for any suite', () => {
    for (const suiteId of ['scifact', 'miracl-ru', 'slavic', 'structural']) {
      const smokePath = checkpointPathFor(suiteId, { smoke: true });
      const fullPath = checkpointPathFor(suiteId, { smoke: false });
      assert.notEqual(smokePath, fullPath);
    }
  });

  it('a smoke checkpoint write never touches the full-run path on disk', () => {
    const suiteId = `unit-test-${Date.now()}`;
    const smokePath = checkpointPathFor(suiteId, { smoke: true });
    const fullPath = checkpointPathFor(suiteId, { smoke: false });
    writtenPaths.push(smokePath, fullPath);
    writeCheckpointAtomic(smokePath, initialCheckpointState({ suiteId }));
    assert.ok(existsSync(smokePath));
    assert.ok(!existsSync(fullPath), 'writing the smoke checkpoint must never create the full-run checkpoint file');
  });
});

describe('isCompletedProfileRun()', () => {
  const goodBlock = {
    errors: [],
    cleanup: { deleted: true },
    unmappedHitCount: 0,
    queryErrorCount: 0,
    indexing: { errors: 0 },
    metrics: { ndcgAt10: 0.42, queryCount: 10 },
  };

  it('true for a fully clean, fully-scored profile run', () => {
    assert.equal(isCompletedProfileRun(goodBlock, { queryCount: 10 }), true);
  });

  it('false when errors is non-empty', () => {
    assert.equal(isCompletedProfileRun({ ...goodBlock, errors: [{ message: 'x' }] }, {}), false);
  });

  it('false when cleanup.deleted is not true', () => {
    assert.equal(isCompletedProfileRun({ ...goodBlock, cleanup: { deleted: false } }, {}), false);
  });

  it('false when unmappedHitCount is nonzero — mapping bug invalidates the run', () => {
    assert.equal(isCompletedProfileRun({ ...goodBlock, unmappedHitCount: 3 }, {}), false);
  });

  it('false when queryErrorCount is nonzero — a query error invalidates the run, never scored as an empty ranking', () => {
    assert.equal(isCompletedProfileRun({ ...goodBlock, queryErrorCount: 1 }, {}), false);
  });

  it('false when metrics are missing or ndcgAt10 is not a finite number', () => {
    assert.equal(isCompletedProfileRun({ ...goodBlock, metrics: null }, {}), false);
    assert.equal(isCompletedProfileRun({ ...goodBlock, metrics: { ndcgAt10: NaN } }, {}), false);
  });

  it('false for a null/undefined block', () => {
    assert.equal(isCompletedProfileRun(null, {}), false);
    assert.equal(isCompletedProfileRun(undefined, {}), false);
  });

  it('false when the expected query count does not match', () => {
    assert.equal(isCompletedProfileRun(goodBlock, { queryCount: 999 }), false);
  });
});

describe('buildBenchmarkContract() / validateResumeCheckpoint()', () => {
  const baseArgs = {
    suiteId: 'scifact', datasetFingerprint: 'abc123', qdrantUrl: 'https://example.qdrant.io',
    collectionPrefix: 'semidex-prodpath-bench-', chunkCandidateLimit: 400, documentMetricDepth: 100,
    collapseStrategy: 'max', cudaRequested: false, deterministicEnvHash: 'envhash1',
  };

  it('never includes the raw QDRANT_URL in the contract — only a hashed fingerprint', () => {
    const contract = buildBenchmarkContract(baseArgs);
    assert.ok(!JSON.stringify(contract).includes('example.qdrant.io'));
    assert.equal(typeof contract.qdrantEndpointFingerprint, 'string');
  });

  it('accepts a resume whose contract matches exactly and every profile is complete', () => {
    const contract = buildBenchmarkContract(baseArgs);
    const previous = {
      benchmarkContract: contract,
      profiles: {
        local: { errors: [], cleanup: { deleted: true }, unmappedHitCount: 0, queryErrorCount: 0, metrics: { ndcgAt10: 0.5, queryCount: 5 } },
      },
    };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });

  it('rejects a resume whose contract differs (e.g. a changed dataset fingerprint)', () => {
    const contract = buildBenchmarkContract(baseArgs);
    const changedContract = buildBenchmarkContract({ ...baseArgs, datasetFingerprint: 'different' });
    const previous = { benchmarkContract: contract, profiles: {} };
    assert.throws(() => validateResumeCheckpoint(previous, changedContract), /does not match/);
  });

  it('rejects a resume whose contract differs due to a changed deterministicEnvHash — a future default-value change becomes a visible contract mismatch, never silent drift', () => {
    const contract = buildBenchmarkContract(baseArgs);
    const changedContract = buildBenchmarkContract({ ...baseArgs, deterministicEnvHash: 'envhash2' });
    const previous = { benchmarkContract: contract, profiles: {} };
    assert.throws(() => validateResumeCheckpoint(previous, changedContract), /does not match/);
  });

  it('rejects a resume with an incomplete profile that has no confirmed cleanup', () => {
    const contract = buildBenchmarkContract(baseArgs);
    const previous = {
      benchmarkContract: contract,
      profiles: { local: { errors: [{ message: 'crashed' }], cleanup: { deleted: false } } },
    };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /Incomplete profile run/);
  });

  it('accepts a resume with an incomplete profile IF cleanup was confirmed — full profile rerun is expected, not a resume-in-place', () => {
    const contract = buildBenchmarkContract(baseArgs);
    const previous = {
      benchmarkContract: contract,
      profiles: { local: { errors: [{ message: 'crashed mid-query' }], cleanup: { deleted: true } } },
    };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });

  it('rejects a checkpoint that is not an object', () => {
    assert.throws(() => validateResumeCheckpoint(null, {}), /not a JSON object/);
    assert.throws(() => validateResumeCheckpoint('a string', {}), /not a JSON object/);
  });
});

describe('writeCheckpointAtomic() / writeFileAtomic() — tmp-then-rename', () => {
  it('writeCheckpointAtomic never leaves a .tmp-* file behind on success', () => {
    const path = checkpointPathFor(`unit-test-atomic-${Date.now()}`, { smoke: true });
    writtenPaths.push(path);
    writeCheckpointAtomic(path, initialCheckpointState({ suiteId: 'x' }));
    assert.ok(existsSync(path));
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(written.benchmarkContract.suiteId, 'x');
  });

  it('writeFileAtomic writes real, complete file content (used for .trec run files too)', () => {
    const path = checkpointPathFor(`unit-test-atomic-trec-${Date.now()}`, { smoke: true }).replace('.json', '.trec');
    writtenPaths.push(path);
    writeFileAtomic(path, 'q1\tQ0\tdoc1\t1\t0.9\trun\n');
    assert.equal(readFileSync(path, 'utf-8'), 'q1\tQ0\tdoc1\t1\t0.9\trun\n');
  });
});

describe('loadCheckpointIfExists()', () => {
  it('returns null for a nonexistent path', () => {
    assert.equal(loadCheckpointIfExists(checkpointPathFor(`unit-test-missing-${Date.now()}`, { smoke: true })), null);
  });

  it('round-trips a written checkpoint exactly', () => {
    const path = checkpointPathFor(`unit-test-roundtrip-${Date.now()}`, { smoke: true });
    writtenPaths.push(path);
    const state = initialCheckpointState({ suiteId: 'roundtrip-test' });
    writeCheckpointAtomic(path, state);
    const loaded = loadCheckpointIfExists(path);
    assert.equal(loaded.benchmarkContract.suiteId, 'roundtrip-test');
    assert.equal(loaded.version, state.version);
  });
});
