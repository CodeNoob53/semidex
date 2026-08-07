// src/indexer/run.js's exported pure helpers. run.js's main() itself talks
// directly to Qdrant and is not independently testable without a real/mocked
// storage backend — these are the small, pure conditions extracted out of it
// specifically so they can be pinned without that dependency.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipCollectionNavRollup, collectionNavRollupNeeded } from '../../../src/shared/indexer/run.js';

describe('shouldSkipCollectionNavRollup', () => {
  test('true for an empty fileNodes array — nothing to roll up', () => {
    assert.equal(shouldSkipCollectionNavRollup([]), true);
  });

  test('false when at least one file nav node exists', () => {
    assert.equal(shouldSkipCollectionNavRollup([{ source_file: 'a.md', summary: '' }]), false);
  });

  test('false for multiple file nav nodes', () => {
    assert.equal(shouldSkipCollectionNavRollup([
      { source_file: 'a.md', summary: '' },
      { source_file: 'b.md', summary: '' },
    ]), false);
  });
});

describe('collectionNavRollupNeeded', () => {
  test('false when nothing was indexed and nothing was pruned', () => {
    assert.equal(collectionNavRollupNeeded(0, 0), false);
  });

  test('true when files were indexed, regardless of pruning', () => {
    assert.equal(collectionNavRollupNeeded(3, 0), true);
  });

  // The exact regression this guards: an empty-root run with
  // PRUNE_STALE=1 that removes every previously-indexed file. indexed
  // stays 0, but the rollup must still run so stale directory/collection
  // nav points get cleared (shouldSkipCollectionNavRollup then reports
  // true for the now-empty fileNodes, triggering cleanup instead of skip).
  test('true when nothing was indexed but files were pruned (empty-root PRUNE_STALE scenario)', () => {
    assert.equal(collectionNavRollupNeeded(0, 5), true);
  });

  // Partial prune with no new files indexed: the rollup must still run so
  // it rebuilds from whatever file nav nodes remain after the prune.
  test('true for a partial prune with zero new files indexed', () => {
    assert.equal(collectionNavRollupNeeded(0, 1), true);
  });

  test('true when both indexed and pruned counts are nonzero', () => {
    assert.equal(collectionNavRollupNeeded(2, 3), true);
  });
});
