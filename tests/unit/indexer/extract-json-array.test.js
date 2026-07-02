// Migrated from src/smoke/sections/16-extract-json-array.js
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonArray } from '../../../src/indexer/phases/tag.js';

describe('extractJsonArray — accepted shapes', () => {
  it('flat array is returned as-is', () => {
    assert.deepEqual(extractJsonArray('[["a","b"],["c","d"]]', 2), [['a', 'b'], ['c', 'd']]);
  });

  it('object wrapper with array values is flattened', () => {
    assert.deepEqual(
      extractJsonArray('{"tags":[["a","b"]],"tags2":[["c","d"]]}', 2),
      [['a', 'b'], ['c', 'd']],
    );
  });

  it('flat strings per chunk key are flattened', () => {
    assert.deepEqual(
      extractJsonArray('{"c0":["a","b"],"c1":["c","d"]}', 2),
      [['a', 'b'], ['c', 'd']],
    );
  });

  it('markdown-fenced JSON is parsed', () => {
    assert.deepEqual(extractJsonArray('```json\n[["a"],["b"]]\n```', 2), [['a'], ['b']]);
  });

  it('numbered keys with an empty tag group are preserved positionally', () => {
    assert.deepEqual(extractJsonArray('{"tags_0":[],"tags_1":["a","b"]}', 2), [[], ['a', 'b']]);
    assert.deepEqual(extractJsonArray('{"tags0":["a"],"tags1":[],"tags2":["c"]}', 3), [['a'], [], ['c']]);
  });
});

describe('extractJsonArray — rejected shapes return null', () => {
  it('wrong length', () => {
    assert.equal(extractJsonArray('[["a"],["b"],["c"]]', 2), null);
  });

  it('empty object', () => {
    assert.equal(extractJsonArray('{}', 2), null);
  });

  it('arrays containing objects', () => {
    assert.equal(extractJsonArray('{"tags0":[{"bad":true}],"tags1":["a"]}', 2), null);
  });

  it('arrays containing numbers', () => {
    assert.equal(extractJsonArray('{"tags0":[1,2],"tags1":["a"]}', 2), null);
  });
});
