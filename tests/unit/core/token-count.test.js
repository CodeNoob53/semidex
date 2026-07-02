// Migrated from src/smoke/sections/36-token-count.js (heuristic + mode
// resolution). Tokenizer-dependent paths (bge-m3 cache) stay in the smoke
// suite until the integration tier exists — they depend on a local model cache.
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNKING_SCHEMA_VERSION,
  heuristicTokenCount,
  resolveTokenCountMode,
  getTokenCounter,
  countTokens,
  takeLastTokens,
} from '../../../src/core/token-count.js';

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
