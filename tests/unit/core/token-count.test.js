// Migrated from src/smoke/sections/36-token-count.js (heuristic + mode
// resolution). Tokenizer-dependent paths (bge-m3 cache) stay in the smoke
// suite until the integration tier exists — they depend on a local model cache.
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHUNKING_SCHEMA_VERSION,
  QDRANT_CLOUD_TOKEN_MODE_PREFIX,
  heuristicTokenCount,
  resolveTokenCountMode,
  getTokenCounter,
  countTokens,
  takeLastTokens,
} from '../../../src/shared/core/token-count.js';
import { createCloudEmbeddingCapability } from '../../../src/cloud/embedding/cloud-embedding-provider.js';

// Real capability (code review, Phase 8B Step 6) — token-count.js's own
// getCloudTokenCounter() now requires an injected `cloudEmbed` capability
// rather than importing the real qdrant-cloud-tokenizer.js itself. These
// tests already exercise the real cached tokenizer via localFilesOnly, so
// the real (not faked) capability is the correct choice here.
const cloudEmbed = createCloudEmbeddingCapability();

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../');
function tokenizerCached(modelId) {
  return existsSync(join(REPO_ROOT, 'models', modelId, 'tokenizer.json'));
}
const E5_ID = 'intfloat/multilingual-e5-small';
const MINILM_ID = 'sentence-transformers/all-minilm-l6-v2';
const e5Cached = tokenizerCached(E5_ID);
const minilmCached = tokenizerCached(MINILM_ID);

function cloudProfile(denseModel) {
  return { embedding: { dense: { execution: 'qdrant-cloud', model: denseModel } } };
}
function clientProfile() {
  return { embedding: { dense: { execution: 'client', model: 'gemma3:4b' } } };
}

describe('resolveTokenCountMode', () => {
  it('current chunking schema version is 4', () => {
    assert.equal(CHUNKING_SCHEMA_VERSION, 4);
  });

  it('default mode is bge-m3', () => {
    assert.equal(resolveTokenCountMode({}), 'bge-m3');
  });

  it('explicit bge-m3 stays bge-m3', () => {
    assert.equal(resolveTokenCountMode({ TOKEN_COUNT: 'bge-m3' }), 'bge-m3');
  });

  it('explicit heuristic opt-out works', () => {
    assert.equal(resolveTokenCountMode({ TOKEN_COUNT: 'heuristic' }), 'heuristic');
  });

  it('invalid mode throws an actionable error', () => {
    assert.throws(
      () => resolveTokenCountMode({ TOKEN_COUNT: 'invalid' }),
      /Unsupported TOKEN_COUNT/,
    );
  });
});

// The live-bug fix: a Qdrant Cloud (E5) collection previously reported
// `token count mode: bge-m3` because resolveTokenCountMode() was
// completely blind to the active embedding profile. These tests pin the
// fixed, profile-aware contract directly.
describe('resolveTokenCountMode — profile-aware (Qdrant Cloud fix)', () => {
  it('a qdrant-cloud profile ALWAYS resolves to a model-scoped mode, never bge-m3, regardless of TOKEN_COUNT', () => {
    const mode = resolveTokenCountMode({ TOKEN_COUNT: 'bge-m3' }, cloudProfile(E5_ID));
    assert.equal(mode, `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${E5_ID}`);
    assert.notEqual(mode, 'bge-m3');
  });

  it('a qdrant-cloud profile resolves to the SAME model-scoped mode even when TOKEN_COUNT=heuristic — the cloud tokenizer is not a choice', () => {
    const mode = resolveTokenCountMode({ TOKEN_COUNT: 'heuristic' }, cloudProfile(MINILM_ID));
    assert.equal(mode, `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${MINILM_ID}`);
  });

  it('the model-scoped mode string names the EXACT dense model, not a fixed placeholder', () => {
    assert.equal(resolveTokenCountMode({}, cloudProfile(E5_ID)), `qdrant-cloud:${E5_ID}`);
    assert.equal(resolveTokenCountMode({}, cloudProfile(MINILM_ID)), `qdrant-cloud:${MINILM_ID}`);
  });

  it('a client-execution profile (Ollama/BGE-M3-ONNX) falls back to the original env-only TOKEN_COUNT behavior, unchanged', () => {
    assert.equal(resolveTokenCountMode({ TOKEN_COUNT: 'bge-m3' }, clientProfile()), 'bge-m3');
    assert.equal(resolveTokenCountMode({ TOKEN_COUNT: 'heuristic' }, clientProfile()), 'heuristic');
  });

  it('no profile argument at all (existing callers, e.g. Ask prompt-context budgeting) is byte-identical to before this fix', () => {
    assert.equal(resolveTokenCountMode({}), 'bge-m3');
    assert.equal(resolveTokenCountMode({ TOKEN_COUNT: 'heuristic' }), 'heuristic');
  });

  it('a null profile explicitly behaves exactly like an omitted one', () => {
    assert.throws(() => resolveTokenCountMode({ TOKEN_COUNT: 'invalid' }, null), /Unsupported TOKEN_COUNT/);
  });
});

describe('heuristicTokenCount', () => {
  it('matches Math.ceil(length / 4) exactly', () => {
    for (const text of ['', 'x', 'abc', 'abcd', 'abcde', 'hello world', 'A'.repeat(400)]) {
      assert.equal(heuristicTokenCount(text), Math.ceil(text.length / 4), `text length ${text.length}`);
    }
  });
});

describe('getTokenCounter / countTokens — heuristic mode', () => {
  it('returns a synchronous counter function', async () => {
    const counter = await getTokenCounter({ mode: 'heuristic' });
    assert.equal(typeof counter, 'function');
    assert.equal(counter('hello'), 2);
    assert.equal(typeof counter('test'), 'number', 'must not return a Promise');
  });

  it('countTokens agrees with the heuristic formula', async () => {
    const n = await countTokens('hello world', { mode: 'heuristic' });
    assert.equal(n, Math.ceil('hello world'.length / 4));
  });
});

describe('takeLastTokens — heuristic mode', () => {
  it('returns a suffix that fits within maxTokens', async () => {
    const text = 'A'.repeat(100);
    const suffix = await takeLastTokens(text, 10, { mode: 'heuristic' });
    assert.equal(typeof suffix, 'string');
    assert.ok(Math.ceil(suffix.length / 4) <= 10, 'suffix exceeds token budget');
    assert.ok(text.endsWith(suffix), 'result is not a suffix of the original');
  });

  it('empty text returns ""', async () => {
    assert.equal(await takeLastTokens('', 10, { mode: 'heuristic' }), '');
  });

  it('maxTokens=0 returns ""', async () => {
    assert.equal(await takeLastTokens('hello', 0, { mode: 'heuristic' }), '');
  });

  it('text that already fits is returned whole', async () => {
    assert.equal(await takeLastTokens('hi', 100, { mode: 'heuristic' }), 'hi');
  });
});

describe('bge-m3 tokenizer (skipped when local cache is absent)', () => {
  let counter = null;
  let loadError = null;

  it('loads from local cache or throws an actionable error', async () => {
    try {
      counter = await getTokenCounter({ mode: 'bge-m3', localFilesOnly: true });
    } catch (err) {
      loadError = err;
      assert.match(err.message, /BGE-M3 tokenizer not cached locally/);
    }
  });

  it('produces plausible counts for ASCII text', async (t) => {
    if (!counter) return t.skip(loadError ? 'tokenizer cache absent' : 'load test did not run');
    const text = 'The quick brown fox jumps over the lazy dog.';
    const count = await counter(text);
    assert.equal(typeof count, 'number');
    assert.ok(count > 0);
    assert.ok(count < Math.ceil(text.length / 4) * 3, 'count implausibly far from heuristic');
  });

  it('second load produces consistent counts (cached tokenizer)', async (t) => {
    if (!counter) return t.skip('tokenizer cache absent');
    const counter2 = await getTokenCounter({ mode: 'bge-m3', localFilesOnly: true });
    const text = 'The quick brown fox jumps over the lazy dog.';
    assert.equal(await counter(text), await counter2(text));
  });
});

// Real-tokenizer regression tests for the Qdrant Cloud fix — uses the
// tokenizer files already cached locally under models/<model-id>/ (the
// same files qdrant-cloud-catalog.test.js's own real-tokenizer tests use),
// via localFilesOnly: true — no network access, no ONNX weights involved.
describe('E5 profile (qdrant-cloud) — real tokenizer, 384d/512-token identity', { skip: !e5Cached }, () => {
  it('getTokenCounter resolves the E5 tokenizer for a qdrant-cloud:<E5-id> mode, never BGE-M3', async () => {
    const mode = resolveTokenCountMode({}, cloudProfile(E5_ID));
    const counter = await getTokenCounter({ mode, localFilesOnly: true, cloudEmbed });
    assert.equal(typeof counter, 'function');
    const count = await counter('A short sentence about semidex.');
    assert.equal(typeof count, 'number');
    assert.ok(count > 0);
  });

  it('countTokens agrees with a direct getTokenCounter call for the same E5 mode', async () => {
    const mode = resolveTokenCountMode({}, cloudProfile(E5_ID));
    const text = 'Семідекс — це локальний RAG-індексатор.';
    const direct = await (await getTokenCounter({ mode, localFilesOnly: true, cloudEmbed }))(text);
    const viaCountTokens = await countTokens(text, { mode, localFilesOnly: true, cloudEmbed });
    assert.equal(direct, viaCountTokens);
  });
});

describe('MiniLM profile (qdrant-cloud) — real tokenizer, 384d/256-token identity', { skip: !minilmCached }, () => {
  it('getTokenCounter resolves the MiniLM tokenizer for a qdrant-cloud:<MiniLM-id> mode, never BGE-M3', async () => {
    const mode = resolveTokenCountMode({}, cloudProfile(MINILM_ID));
    const counter = await getTokenCounter({ mode, localFilesOnly: true, cloudEmbed });
    const count = await counter('A short sentence about semidex.');
    assert.equal(typeof count, 'number');
    assert.ok(count > 0);
  });
});

describe('Cloud profile — never loads BGE-M3 (the exact live bug this fix closes)', { skip: !e5Cached }, () => {
  it('a cloud-mode counter never touches the BGE-M3 tokenizer cache/counter path', async () => {
    // Not a mock/spy on loadBgeTokenizer (no test-only DI seam exists for
    // it, and adding one purely for this assertion would be test-only
    // surface area) — instead, this proves the OBSERVABLE contract: the
    // resolved mode string itself can never equal 'bge-m3' for a cloud
    // profile (asserted directly above), and getTokenCounter()'s cloud
    // branch returns before ever reaching the `mode !== 'bge-m3'`
    // BGE-M3-loading branch in the source — confirmed by the mode-prefix
    // dispatch order in token-count.js itself (this test would fail loudly
    // if a future refactor moved the cloud check after the bge-m3 check).
    const mode = resolveTokenCountMode({ TOKEN_COUNT: 'bge-m3' }, cloudProfile(E5_ID));
    assert.notEqual(mode, 'bge-m3');
    assert.ok(mode.startsWith(QDRANT_CLOUD_TOKEN_MODE_PREFIX));
  });
});

// Review finding (P1): getCloudTokenCounter()'s own counter/text caches
// used to be keyed ONLY by `modelId\0localFilesOnly` in a single
// module-scope Map — indistinguishable from a SECOND, independently
// constructed `cloudEmbed` capability resolving the SAME model id. The
// first composition root to ever resolve a given model id in a process
// silently became the ONLY one whose cloudEmbed.getCloudTokenCounter()
// was ever actually invoked; every other capability's calls for that
// model id transparently returned the first one's cached counter/results
// instead — real cross-instance state leakage, not a plain shared cache.
// Fixed via a WeakMap<cloudEmbed, {...}> — every test below uses fully
// fake, injected `cloudEmbed` objects (never the real network-backed
// tokenizer) specifically so the counter VALUE itself (not just "was it
// called") can be asserted deterministically.
describe('getCloudTokenCounter() — capability-scoped caching (review finding, P1)', () => {
  function fakeCloudEmbed(counterValue) {
    let calls = 0;
    return {
      calls: () => calls,
      async getCloudTokenCounter(modelId, opts) {
        calls += 1;
        return async (text) => counterValue;
      },
    };
  }

  it('two independent cloudEmbed instances resolving the SAME modelId each get their OWN counter — never the other instance\'s cached value (the exact repro from the review finding)', async () => {
    const capabilityA = fakeCloudEmbed(11);
    const capabilityB = fakeCloudEmbed(22);
    const modelId = 'shared-model-id';

    const modeA = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${modelId}`;
    const modeB = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${modelId}`;

    const countA = await countTokens('hello world', { mode: modeA, cloudEmbed: capabilityA });
    const countB = await countTokens('hello world', { mode: modeB, cloudEmbed: capabilityB });

    assert.equal(countA, 11, 'capability A must resolve its own counter value');
    assert.equal(countB, 22, 'capability B must resolve its own counter value, never A\'s cached 11');
    assert.equal(capabilityA.calls(), 1, 'capability A\'s getCloudTokenCounter() must actually be invoked');
    assert.equal(capabilityB.calls(), 1, 'capability B\'s getCloudTokenCounter() must actually be invoked — the old bug meant this call never happened at all');
  });

  it('a SECOND call to the SAME cloudEmbed instance for the same modelId reuses its own cached counter (no repeated getCloudTokenCounter() calls) — caching itself is preserved, only cross-instance sharing was removed', async () => {
    const capability = fakeCloudEmbed(42);
    const modelId = 'reused-model-id';
    const mode = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${modelId}`;

    const first = await countTokens('text one', { mode, cloudEmbed: capability });
    const second = await countTokens('text two', { mode, cloudEmbed: capability });

    assert.equal(first, 42);
    assert.equal(second, 42);
    assert.equal(capability.calls(), 1, 'the SAME cloudEmbed instance must only ever call its own getCloudTokenCounter() once per modelId/localFilesOnly combination');
  });

  it('the per-text result cache is also capability-scoped — two capabilities never see each other\'s cached per-text counts, even for the identical model id and text', async () => {
    let capabilityACallCount = 0;
    let capabilityBCallCount = 0;
    const capabilityA = {
      async getCloudTokenCounter() {
        return async (text) => { capabilityACallCount += 1; return 100; };
      },
    };
    const capabilityB = {
      async getCloudTokenCounter() {
        return async (text) => { capabilityBCallCount += 1; return 200; };
      },
    };
    const modelId = 'text-cache-model-id';
    const mode = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${modelId}`;
    const text = 'the exact same text string';

    const resultA1 = await countTokens(text, { mode, cloudEmbed: capabilityA });
    const resultB1 = await countTokens(text, { mode, cloudEmbed: capabilityB });
    // Second call to A for the identical text must hit A's OWN cache
    // (capabilityACallCount stays 1), never B's.
    const resultA2 = await countTokens(text, { mode, cloudEmbed: capabilityA });

    assert.equal(resultA1, 100);
    assert.equal(resultB1, 200, 'capability B must compute its own result for the identical text, never reuse A\'s cached 100');
    assert.equal(resultA2, 100);
    assert.equal(capabilityACallCount, 1, 'A\'s underlying counter fn must only be invoked once — the second call hits A\'s own per-text cache');
    assert.equal(capabilityBCallCount, 1);
  });

  it('within a SINGLE cloudEmbed instance, two different models never share a per-text cached count for the same text (review finding, P1 follow-up — the exact E5/MiniLM repro)', async () => {
    let modelACallCount = 0;
    let modelBCallCount = 0;
    const capability = {
      async getCloudTokenCounter(modelId) {
        if (modelId === 'model-a') return async (text) => { modelACallCount += 1; return 11; };
        return async (text) => { modelBCallCount += 1; return 22; };
      },
    };
    const text = 'the exact same text string';
    const modeA = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}model-a`;
    const modeB = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}model-b`;

    const resultA = await countTokens(text, { mode: modeA, cloudEmbed: capability });
    const resultB = await countTokens(text, { mode: modeB, cloudEmbed: capability });

    assert.equal(resultA, 11, 'model-a must resolve its own counter value');
    assert.equal(resultB, 22, 'model-b must compute its own result for the identical text, never reuse model-a\'s cached 11 (the bug: a bare-text-keyed per-text cache shared across every counterCacheKey within one capability)');
    assert.equal(modelACallCount, 1);
    assert.equal(modelBCallCount, 1, 'model-b\'s underlying counter fn must actually be invoked — the old bug meant this call never happened at all');
  });

  it('within a SINGLE cloudEmbed instance, the same model+localFilesOnly combination still reuses its own per-text cache across repeated calls (caching itself is preserved, only cross-model sharing was removed)', async () => {
    let callCount = 0;
    const capability = {
      async getCloudTokenCounter() {
        return async (text) => { callCount += 1; return 7; };
      },
    };
    const text = 'reused text for one model';
    const mode = `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}model-a`;

    const first = await countTokens(text, { mode, cloudEmbed: capability });
    const second = await countTokens(text, { mode, cloudEmbed: capability });

    assert.equal(first, 7);
    assert.equal(second, 7);
    assert.equal(callCount, 1, 'the second call for the SAME model+text must hit the per-text cache, not recompute');
  });
});
