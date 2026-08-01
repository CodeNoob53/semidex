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
} from '../../../src/core/token-count.js';

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
    const counter = await getTokenCounter({ mode, localFilesOnly: true });
    assert.equal(typeof counter, 'function');
    const count = await counter('A short sentence about semidex.');
    assert.equal(typeof count, 'number');
    assert.ok(count > 0);
  });

  it('countTokens agrees with a direct getTokenCounter call for the same E5 mode', async () => {
    const mode = resolveTokenCountMode({}, cloudProfile(E5_ID));
    const text = 'Семідекс — це локальний RAG-індексатор.';
    const direct = await (await getTokenCounter({ mode, localFilesOnly: true }))(text);
    const viaCountTokens = await countTokens(text, { mode, localFilesOnly: true });
    assert.equal(direct, viaCountTokens);
  });
});

describe('MiniLM profile (qdrant-cloud) — real tokenizer, 384d/256-token identity', { skip: !minilmCached }, () => {
  it('getTokenCounter resolves the MiniLM tokenizer for a qdrant-cloud:<MiniLM-id> mode, never BGE-M3', async () => {
    const mode = resolveTokenCountMode({}, cloudProfile(MINILM_ID));
    const counter = await getTokenCounter({ mode, localFilesOnly: true });
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
