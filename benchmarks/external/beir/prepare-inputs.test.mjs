import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';

import {
  boundedBatchTokenCounts,
  commonCandidateWordCount,
  formatForLanes,
  largestFittingWordPrefix,
  prepareInputs,
  validatePrepared,
} from './prepare-inputs.mjs';

describe('provider lane formatting', () => {
  test('Cloud E5 gets asymmetric prefixes while BM25 gets raw text', () => {
    const document = formatForLanes({ body: 'alpha beta', profileKind: 'cloud', role: 'document' });
    assert.equal(document.denseText, 'passage: alpha beta');
    assert.equal(document.sparseText, 'alpha beta');

    const query = formatForLanes({ body: 'alpha', profileKind: 'cloud', role: 'query' });
    assert.equal(query.denseText, 'query: alpha');
    assert.equal(query.sparseText, 'alpha');
    assert.equal(query.sparseText.includes('query:'), false);
  });

  test('local dense and sparse lanes receive the same provider-neutral body', () => {
    const local = formatForLanes({ body: 'same body', profileKind: 'local', role: 'document' });
    assert.deepEqual(local, { denseText: 'same body', sparseText: 'same body' });
  });
});

test('bounded batch counting uses budget + 1 as the overflow sentinel', async () => {
  const calls = [];
  const tokenizer = async (texts, options) => {
    calls.push({ texts, options });
    const lengths = texts.map((text) => Math.min(text.split(' ').length, options.max_length));
    const columns = Math.max(...lengths);
    const mask = [];
    for (const length of lengths) {
      for (let index = 0; index < columns; index++) mask.push(index < length ? 1n : 0n);
    }
    return {
      attention_mask: { dims: [texts.length, columns], data: mask },
    };
  };
  const texts = ['one two', 'one two three four five six'];
  const counts = await boundedBatchTokenCounts(tokenizer, texts, { budget: 4, batchSize: 2 });
  assert.deepEqual(counts, [2, 5]);
  assert.equal(calls[0].options.max_length, 5);
  assert.equal(calls[0].options.truncation, true);
});

test('common truncation stops on a word boundary', async () => {
  const result = await largestFittingWordPrefix({
    title: 'Title',
    body: 'alpha beta gamma delta',
    fits: async (candidate) => {
      const bodyWords = candidate.split('\n\n')[1]?.split(' ').filter(Boolean).length ?? 0;
      return { ok: bodyWords <= 2, bgeCount: bodyWords + 2, e5Count: bodyWords + 3 };
    },
  });
  assert.equal(result.commonBody, 'Title\n\nalpha beta');
  assert.equal(result.commonBody.endsWith('bet'), false);
});

test('a tokenizer that already fits does not collapse the shared candidate', () => {
  assert.equal(commonCandidateWordCount({
    totalWords: 300,
    headerWords: 10,
    prefixWords: 1,
    bgeDecodedWords: 280,
    e5DecodedWords: null,
  }), 268);
  assert.equal(commonCandidateWordCount({
    totalWords: 300,
    headerWords: 10,
    prefixWords: 1,
    bgeDecodedWords: null,
    e5DecodedWords: 275,
  }), 262);
});

test('input preparation runs once for documents and once for queries', async () => {
  const calls = [];
  const fakePrepare = async (entries, { kind }) => {
    calls.push(kind);
    const prepared = new Map();
    for (const [id, value] of entries) {
      const body = kind === 'document' ? `${value.title}\n\n${value.text}` : value;
      prepared.set(id, {
        nativeBody: body,
        commonBody: body,
        truncated: false,
        bgeCount: 10,
        e5Count: 11,
      });
    }
    return { entries: prepared, total: prepared.size, truncated: 0 };
  };
  const prepared = await prepareInputs({
    corpus: new Map([['d1', { title: 'T', text: 'Body' }]]),
    queries: new Map([['q1', 'Question']]),
    datasetMd5: 'fixture',
    useCache: false,
    prepareBodiesImpl: fakePrepare,
  });
  assert.deepEqual(calls, ['document', 'query']);
  assert.equal(prepared.documents.get('d1').commonBody, 'T\n\nBody');
  assert.equal(prepared.queries.get('q1').commonBody, 'Question');
});

test('prepared-body validation checks every document and query budget', () => {
  const valid = { nativeBody: 'x', commonBody: 'x', bgeCount: 512, e5Count: 512 };
  assert.equal(validatePrepared({
    documents: new Map([['d', valid]]),
    queries: new Map([['q', valid]]),
  }).ok, true);

  const invalid = { ...valid, e5Count: 513 };
  const result = validatePrepared({
    documents: new Map([['d', invalid]]),
    queries: new Map(),
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /exceeds budget/);
});

test('a corrupt prepared-input cache is rebuilt instead of aborting', async () => {
  const corpus = new Map([['d1', { title: 'T', text: 'Body' }]]);
  const queries = new Map([['q1', 'Question']]);
  const calls = [];
  const fakePrepare = async (entries, { kind }) => {
    calls.push(kind);
    const prepared = new Map([...entries].map(([id, value]) => {
      const body = kind === 'document' ? `${value.title}\n\n${value.text}` : value;
      return [id, {
        nativeBody: body,
        commonBody: body,
        truncated: false,
        bgeCount: 10,
        e5Count: 11,
      }];
    }));
    return { entries: prepared, total: prepared.size, truncated: 0 };
  };
  const options = {
    corpus,
    queries,
    datasetMd5: `corrupt-cache-fixture-${process.pid}-${Date.now()}`,
    prepareBodiesImpl: fakePrepare,
  };

  const first = await prepareInputs(options);
  try {
    writeFileSync(first.cachePath, '{partial', 'utf8');
    const second = await prepareInputs(options);
    assert.equal(second.fromCache, false);
    assert.deepEqual(calls, ['document', 'query', 'document', 'query']);
    assert.equal(second.documents.get('d1').commonBody, 'T\n\nBody');
  } finally {
    unlinkSync(first.cachePath);
  }
});
