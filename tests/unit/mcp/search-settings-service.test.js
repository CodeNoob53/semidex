// mcp/tools/search.js — settingsService wiring (Global Settings phase).
// search.js's handle() requires a live embed/Qdrant call to exercise
// end-to-end (no existing test harness stubs those — confirmed, this
// module has never had a handle()-level unit test), so this file verifies
// the specific extraction contract directly on the small resolver
// functions handle() calls: setSettingsService() actually changes what
// they resolve to, and falls back to the original env reads when unset.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setSettingsService, getRerankEnabled, getRerankCeEnabled, getRerankPrefetchMult } from '../../../src/mcp/tools/search.js';

describe('mcp/tools/search.js — settingsService extraction (consumed, not copied)', () => {
  test.afterEach(() => { setSettingsService(null); }); // reset module-level state between tests

  test('with no settingsService set, resolvers fall back to direct env reads unchanged', () => {
    const originalEnabled = process.env.RERANK_ENABLED;
    const originalCe = process.env.RERANK_CE_ENABLED;
    try {
      delete process.env.RERANK_ENABLED;
      delete process.env.RERANK_CE_ENABLED;
      assert.equal(getRerankEnabled(), false);
      assert.equal(getRerankCeEnabled(), false);
      assert.equal(getRerankPrefetchMult(), 4);

      process.env.RERANK_ENABLED = '1';
      assert.equal(getRerankEnabled(), true);
    } finally {
      if (originalEnabled === undefined) delete process.env.RERANK_ENABLED; else process.env.RERANK_ENABLED = originalEnabled;
      if (originalCe === undefined) delete process.env.RERANK_CE_ENABLED; else process.env.RERANK_CE_ENABLED = originalCe;
    }
  });

  test('setSettingsService() makes resolvers read from the service instead of process.env', () => {
    const fakeService = {
      getActiveValue: (key) => ({ RERANK_ENABLED: true, RERANK_CE_ENABLED: false, RERANK_PREFETCH_MULT: 7 }[key]),
      refreshIfChanged: () => {},
    };
    setSettingsService(fakeService);
    assert.equal(getRerankEnabled(), true);
    assert.equal(getRerankCeEnabled(), false);
    assert.equal(getRerankPrefetchMult(), 7);
  });

  test('setSettingsService(null) resets to env-fallback state', () => {
    setSettingsService({ getActiveValue: () => true, refreshIfChanged: () => {} });
    assert.equal(getRerankEnabled(), true);
    setSettingsService(null);
    assert.equal(getRerankEnabled(), process.env.RERANK_ENABLED === '1');
  });
});
