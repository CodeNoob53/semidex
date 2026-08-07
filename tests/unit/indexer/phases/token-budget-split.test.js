// src/indexer/phases/token-budget-split.js — neutral, format-agnostic
// token-budget splitting primitives shared by entity-split.js and
// chunk.js. Moved verbatim from entity-split.js (splitOversizedUnitIntoPieces)
// plus a new canonicalWhitespace helper — direct coverage of both from
// their neutral location, independent of either caller.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitOversizedUnitIntoPieces, canonicalWhitespace } from '../../../../src/shared/indexer/phases/token-budget-split.js';

function makeBudget(maxInputTokens) {
  return { maxInputTokens, countTokens: (text) => Math.ceil(text.length / 4) };
}

describe('splitOversizedUnitIntoPieces', () => {
  test('splits an oversized string into pieces that each fit the budget', async () => {
    const text = 'a'.repeat(1000);
    const budget = makeBudget(40);
    const pieces = await splitOversizedUnitIntoPieces(text, (p) => p, budget);
    assert.ok(pieces.length > 1);
    for (const piece of pieces) {
      assert.ok((await budget.countTokens(piece)) <= budget.maxInputTokens);
    }
  });

  test('concatenating pieces reproduces the original text exactly (byte-for-byte)', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(30);
    const budget = makeBudget(20);
    const pieces = await splitOversizedUnitIntoPieces(text, (p) => p, budget);
    assert.equal(pieces.join(''), text);
  });

  test('a text that already fits whole is returned as a single piece', async () => {
    const text = 'short text';
    const budget = makeBudget(512);
    const pieces = await splitOversizedUnitIntoPieces(text, (p) => p, budget);
    assert.deepEqual(pieces, [text]);
  });

  test('renderPiece is applied when measuring — a wrapper that adds tokens shrinks the piece size', async () => {
    const text = 'x'.repeat(200);
    const budget = makeBudget(20);
    const bare = await splitOversizedUnitIntoPieces(text, (p) => p, budget);
    const wrapped = await splitOversizedUnitIntoPieces(text, (p) => `[[${p}]]`, budget);
    assert.ok(wrapped.length >= bare.length, 'wrapping every piece with extra characters should never produce fewer, larger pieces');
    assert.equal(wrapped.join(''), text, 'concatenation must still reproduce the raw text — renderPiece only affects measurement, not assembly');
  });

  test('pathological floor guard: a budget too small for even one rendered character still terminates, taking one character anyway', async () => {
    const text = 'abc';
    // renderPiece adds a prefix that always exceeds any budget — even a
    // single source character can never "fit" once rendered.
    const budget = makeBudget(1);
    const pieces = await splitOversizedUnitIntoPieces(text, (p) => `PREFIX-THAT-IS-WAY-TOO-LONG-${p}`, budget);
    assert.equal(pieces.join(''), text, 'must still make forward progress and reproduce the text exactly');
    assert.equal(pieces.length, text.length, 'each character taken as its own piece when nothing fits');
  });

  test('empty text returns an empty pieces array', async () => {
    const budget = makeBudget(10);
    const pieces = await splitOversizedUnitIntoPieces('', (p) => p, budget);
    assert.deepEqual(pieces, []);
  });
});

describe('canonicalWhitespace', () => {
  test('normalizes CRLF/CR to LF before collapsing whitespace', () => {
    assert.equal(canonicalWhitespace('a\r\nb\rc\nd'), 'a b c d');
  });

  test('collapses repeated whitespace runs (including newlines) to a single space, and trims', () => {
    assert.equal(canonicalWhitespace('  a   b\n\n\nc\t\td  '), 'a b c d');
  });

  test('strips page markers only when stripPageMarkers is true', () => {
    const text = 'before -- 3 of 10 -- after';
    assert.equal(canonicalWhitespace(text), 'before -- 3 of 10 -- after');
    assert.equal(canonicalWhitespace(text, { stripPageMarkers: true }), 'before after');
  });

  test('two differently-whitespaced strings with the same content canonicalize identically', () => {
    const a = 'Hello\n\nWorld';
    const b = 'Hello   World';
    assert.equal(canonicalWhitespace(a), canonicalWhitespace(b));
  });
});
