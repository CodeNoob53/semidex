import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIndexBatches } from './run-scifact.mjs';

function prepared(entries) {
  return new Map(entries.map(([id, truncated]) => [id, { truncated }]));
}

describe('BEIR indexing batch policy', () => {
  test('keeps the normal batch size outside local-native', () => {
    const docIds = Array.from({ length: 25 }, (_, i) => `d${i}`);
    const batches = buildIndexBatches({
      docIds,
      preparedDocuments: prepared(docIds.map((id) => [id, true])),
      profileKind: 'cloud',
      regime: 'native',
    });

    assert.deepEqual(batches.map((batch) => batch.length), [24, 1]);
  });

  test('uses batches of four for long local-native documents', () => {
    const entries = [
      ['s1', false], ['l1', true], ['s2', false], ['l2', true],
      ['l3', true], ['l4', true], ['l5', true],
    ];
    const batches = buildIndexBatches({
      docIds: entries.map(([id]) => id),
      preparedDocuments: prepared(entries),
      profileKind: 'local',
      regime: 'native',
    });

    assert.deepEqual(batches, [['s1', 's2'], ['l1', 'l2', 'l3', 'l4'], ['l5']]);
    assert.deepEqual(batches.flat().sort(), entries.map(([id]) => id).sort());
  });
});
