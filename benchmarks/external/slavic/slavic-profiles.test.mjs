import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGUAGES, LANGUAGE_CODES, RESERVED_FOR_LATER_EXPANSION, CONFIRMED_UNAVAILABLE,
  languageByCode, parseLanguagesFlag, collectionName, COLLECTION_PREFIX,
  PROVIDER, RRF_K,
} from './slavic-profiles.mjs';

describe('LANGUAGES: exact matrix', () => {
  test('is exactly the 7 user-decided languages, in order', () => {
    assert.deepEqual(LANGUAGE_CODES, ['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn']);
  });

  test('exactly 3 Cyrillic, 3 Latin (incl. English control)', () => {
    const cyrillic = LANGUAGES.filter((l) => l.script === 'Cyrillic');
    const latin = LANGUAGES.filter((l) => l.script === 'Latin');
    assert.equal(cyrillic.length, 3);
    assert.equal(latin.length, 4); // pol, ces, slk, eng — eng is the control but still Latin script
  });

  test('eng_Latn is present as the control', () => {
    assert.ok(LANGUAGE_CODES.includes('eng_Latn'));
  });

  test('bel_Cyrl and srp_Latn are NOT in LANGUAGES — confirmed unavailable, never silently substituted', () => {
    assert.equal(LANGUAGE_CODES.includes('bel_Cyrl'), false);
    assert.equal(LANGUAGE_CODES.includes('srp_Latn'), false);
  });

  test('CONFIRMED_UNAVAILABLE documents exactly bel_Cyrl and srp_Latn with a reason each', () => {
    const codes = CONFIRMED_UNAVAILABLE.map((l) => l.code);
    assert.deepEqual(codes.sort(), ['bel_Cyrl', 'srp_Latn']);
    for (const entry of CONFIRMED_UNAVAILABLE) {
      assert.ok(entry.reason && entry.reason.length > 0);
    }
  });

  test('RESERVED_FOR_LATER_EXPANSION lists mkd_Cyrl/srp_Cyrl/hrv_Latn/slv_Latn and is disjoint from LANGUAGES', () => {
    const reservedCodes = RESERVED_FOR_LATER_EXPANSION.map((l) => l.code);
    assert.deepEqual(reservedCodes.sort(), ['hrv_Latn', 'mkd_Cyrl', 'slv_Latn', 'srp_Cyrl']);
    for (const code of reservedCodes) assert.equal(LANGUAGE_CODES.includes(code), false);
  });

  test('languageByCode resolves every code in LANGUAGES', () => {
    for (const code of LANGUAGE_CODES) {
      assert.equal(languageByCode(code).code, code);
    }
  });

  test('languageByCode throws on an unknown code', () => {
    assert.throws(() => languageByCode('xyz_Notreal'), /unknown language code/);
  });
});

describe('parseLanguagesFlag: monolingual language-config selection', () => {
  test('null (flag never passed) defaults to all 7 languages in canonical order', () => {
    assert.deepEqual(parseLanguagesFlag(null).map((l) => l.code), LANGUAGE_CODES);
  });

  test('reorders requested languages to canonical order regardless of CLI order', () => {
    const result = parseLanguagesFlag('bul_Cyrl,ukr_Cyrl');
    assert.deepEqual(result.map((l) => l.code), ['ukr_Cyrl', 'bul_Cyrl']);
  });

  test('rejects an unknown language code', () => {
    assert.throws(() => parseLanguagesFlag('not-a-lang'), /unknown language code/);
  });

  test('rejects a code from RESERVED_FOR_LATER_EXPANSION (not part of this run\'s scope)', () => {
    assert.throws(() => parseLanguagesFlag('hrv_Latn'), /unknown language code/);
  });

  // ── P2-equivalent regression: explicit empty --languages= must not
  // silently default to running all 7 (mirrors rrf-sweep-config.mjs's
  // parseScopesFlag() fix, applied here from the start). ─────────────────
  test('empty string (explicit --languages= with nothing after it) throws, does NOT default to all', () => {
    assert.throws(() => parseLanguagesFlag(''), /no language codes/);
  });

  test('whitespace/comma-only value throws the same way', () => {
    assert.throws(() => parseLanguagesFlag(' , ,'), /no language codes/);
  });

  test('a valid single-language value works normally', () => {
    assert.deepEqual(parseLanguagesFlag('ukr_Cyrl').map((l) => l.code), ['ukr_Cyrl']);
  });
});

describe('collectionName / COLLECTION_PREFIX', () => {
  test('collectionName always starts with the owned prefix', () => {
    assert.ok(collectionName('ukr_Cyrl', 'abc123').startsWith(COLLECTION_PREFIX));
  });

  test('COLLECTION_PREFIX is distinct from every other benchmark harness\'s prefix', () => {
    assert.notEqual(COLLECTION_PREFIX, 'semidex-beir-scifact-');
    assert.notEqual(COLLECTION_PREFIX, 'semidex-miracl-ru-');
    assert.notEqual(COLLECTION_PREFIX, 'semidex-rrf-sweep-');
  });
});

describe('PROVIDER: locked to BGE-M3 ONNX only', () => {
  test('provider kind is local (no Qdrant Cloud E5/BM25 in this benchmark)', () => {
    assert.equal(PROVIDER.kind, 'local');
  });

  test('dense size is 1024 (BGE-M3\'s real output dimension)', () => {
    assert.equal(PROVIDER.denseSize, 1024);
  });
});

describe('RRF_K: single fixed equal mode, no sweep', () => {
  test('is exactly 60 (Semidex production default)', () => {
    assert.equal(RRF_K, 60);
  });
});
