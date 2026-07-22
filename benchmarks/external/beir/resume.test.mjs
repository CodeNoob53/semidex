import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isCompletedRunCheckpoint,
  validateResumeCheckpoint,
} from './run-scifact.mjs';

const runCfg = Object.freeze({
  runId: 'local-common-512',
  profileId: 'local',
  regime: 'common-512',
  rrfKs: [60],
});

const contract = Object.freeze({
  version: 1,
  datasetMd5: 'fixture',
  documentCount: 3,
  queryCount: 2,
  preparedCache: 'fixture.json',
  runs: [runCfg],
});

function completedRun() {
  const metric = { queryCount: 2, ndcgAt10: 0.5 };
  return {
    ...runCfg,
    indexing: { documentsIndexed: 3, errors: 0 },
    queryStats: { total: 2, ran: 2, errors: 0 },
    errors: [],
    cleanup: { attempted: true, deleted: true },
    metrics: { dense: metric, sparse: metric, hybrid_k60: metric },
  };
}

describe('BEIR checkpoint completion', () => {
  test('accepts only a fully measured, zero-error, cleaned run', () => {
    assert.equal(isCompletedRunCheckpoint(completedRun(), runCfg, contract), true);
  });

  test('does not skip a partial run', () => {
    const partial = completedRun();
    partial.queryStats.ran = 1;
    assert.equal(isCompletedRunCheckpoint(partial, runCfg, contract), false);
  });
});

describe('BEIR resume validation', () => {
  test('accepts a matching contract and completed run', () => {
    const report = { benchmarkContract: contract, runs: { [runCfg.runId]: completedRun() } };
    assert.equal(validateResumeCheckpoint(report, contract, [runCfg]), true);
  });

  test('accepts the validated legacy checkpoint shape', () => {
    const report = {
      environment: { datasetStats: { corpusSize: 3, queryCount: 2 } },
      runs: { [runCfg.runId]: completedRun() },
    };
    assert.equal(validateResumeCheckpoint(report, contract, [runCfg]), true);
  });

  test('rejects a changed benchmark contract', () => {
    const report = {
      benchmarkContract: { ...contract, preparedCache: 'other.json' },
      runs: { [runCfg.runId]: completedRun() },
    };
    assert.throws(
      () => validateResumeCheckpoint(report, contract, [runCfg]),
      /does not match/,
    );
  });

  test('rejects an incomplete run without confirmed cleanup', () => {
    const partial = completedRun();
    partial.queryStats.ran = 1;
    partial.cleanup.deleted = false;
    const report = { benchmarkContract: contract, runs: { [runCfg.runId]: partial } };
    assert.throws(
      () => validateResumeCheckpoint(report, contract, [runCfg]),
      /does not have confirmed cleanup/,
    );
  });
});
