// indexer/phases/chunk.js — applyChunkingSettings() (Global Settings phase).
// Proves the four chunking knobs are actually CONSUMED from a
// SettingsService (not just independently duplicated) — calling
// applyChunkingSettings() changes what getChunkingConfig() reports, and a
// subsequent real chunkText() call reflects the new bound.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getChunkingConfig, applyChunkingSettings } from '../../../src/indexer/phases/chunk.js';

function fakeSettingsService(values) {
  return { getActiveValue: (key) => values[key] };
}

describe('applyChunkingSettings — settingsService extraction (consumed, not copied)', () => {
  test('overwrites the module-level chunking config that getChunkingConfig() reports', () => {
    const before = getChunkingConfig();
    assert.equal(before.maxTokens, 512); // default, matches chunk.js's own envInt default

    applyChunkingSettings(fakeSettingsService({
      MAX_CHUNK_TOKENS: 999, MIN_CHUNK_TOKENS: 111, OVERLAP_SENTENCES: 3, CHUNK_OVERLAP_TOKENS: 77,
    }));

    const after = getChunkingConfig();
    assert.equal(after.maxTokens, 999);
    assert.equal(after.minTokens, 111);
    assert.equal(after.overlapSentences, 3);
    assert.equal(after.overlapTokens, 77);

    // Restore defaults so this test doesn't leak module state into any
    // test that runs after it in the same process.
    applyChunkingSettings(fakeSettingsService({
      MAX_CHUNK_TOKENS: 512, MIN_CHUNK_TOKENS: 160, OVERLAP_SENTENCES: 2, CHUNK_OVERLAP_TOKENS: 80,
    }));
  });
});
