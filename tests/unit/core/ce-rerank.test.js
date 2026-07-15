// core/ce-rerank.js — applyCeRerankSettings() (code review fix). Proves
// RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are genuinely
// consumed from a SettingsService (next_restart: read once, before the
// first model load), not left permanently reading raw env as an earlier,
// incorrect reading of "next_restart" had it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCeRerankSettings } from '../../../src/core/ce-rerank.js';
import * as ceRerankModule from '../../../src/core/ce-rerank.js';

function fakeSettingsService(values) {
  return { getActiveValue: (key) => values[key] };
}

describe('applyCeRerankSettings — settingsService extraction for next_restart fields', () => {
  test('overwrites RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR exports', () => {
    const originalModel = ceRerankModule.RERANK_CE_MODEL;
    const originalDevice = ceRerankModule.RERANK_CE_DEVICE;
    const originalCacheDir = ceRerankModule.RERANK_CE_CACHE_DIR;
    try {
      applyCeRerankSettings(fakeSettingsService({
        RERANK_CE_MODEL: 'custom/model-name', RERANK_CE_DEVICE: 'dml', RERANK_CE_CACHE_DIR: '/custom/cache',
      }));
      assert.equal(ceRerankModule.RERANK_CE_MODEL, 'custom/model-name');
      assert.equal(ceRerankModule.RERANK_CE_DEVICE, 'dml');
      assert.equal(ceRerankModule.RERANK_CE_CACHE_DIR, '/custom/cache');
    } finally {
      // Restore for any test that runs after this one in the same process.
      applyCeRerankSettings(fakeSettingsService({
        RERANK_CE_MODEL: originalModel, RERANK_CE_DEVICE: originalDevice, RERANK_CE_CACHE_DIR: originalCacheDir,
      }));
    }
  });
});
