import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseJsonlRows, validateRowSchema, synthesizeRetrievalTask, validateRetrievalTask,
  downloadTo, isValidCacheHit, manifestPathFor,
  BELEBELE_REPO, BELEBELE_REVISION, BELEBELE_LICENSE, EXPECTED_ROW_COUNT, EXPECTED_CORPUS_SIZE,
} from './fetch-belebele.mjs';

function fakeFetchResponse(bodyText, { ok = true, status = 200 } = {}) {
  const bytes = Buffer.from(bodyText, 'utf-8');
  let sent = false;
  return {
    ok, status,
    headers: { get: (name) => (name === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

function fixtureRow(overrides = {}) {
  return {
    link: 'https://en.wikibooks.org/wiki/Foo',
    question_number: 1,
    flores_passage: 'Це тестовий уривок тексту з кирилицею.',
    question: 'Яке питання тут поставлено?',
    mc_answer1: 'A', mc_answer2: 'B', mc_answer3: 'C', mc_answer4: 'D',
    correct_answer_num: '1',
    dialect: 'ukr_Cyrl',
    ds: '2023-05-20',
    ...overrides,
  };
}

// ── revision/repo pinning ───────────────────────────────────────────────
describe('dataset revision and license are pinned constants', () => {
  test('BELEBELE_REPO is the public, ungated mteb/belebele — never the gated mteb/BelebeleRetrieval', () => {
    assert.equal(BELEBELE_REPO, 'mteb/belebele');
  });

  test('BELEBELE_REVISION is a specific pinned commit hash, not "main"', () => {
    assert.match(BELEBELE_REVISION, /^[0-9a-f]{40}$/);
  });

  test('BELEBELE_LICENSE is documented', () => {
    assert.equal(BELEBELE_LICENSE, 'cc-by-sa-4.0');
  });
});

// ── parseJsonlRows ───────────────────────────────────────────────────────
describe('parseJsonlRows', () => {
  test('parses one JSON object per line', () => {
    const text = `${JSON.stringify(fixtureRow({ question_number: 1 }))}\n${JSON.stringify(fixtureRow({ question_number: 2, question: 'other' }))}\n`;
    const rows = parseJsonlRows(text, 'test');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].question_number, 1);
    assert.equal(rows[1].question_number, 2);
  });

  test('skips blank lines', () => {
    const text = `${JSON.stringify(fixtureRow())}\n\n${JSON.stringify(fixtureRow({ question: 'q2' }))}\n`;
    assert.equal(parseJsonlRows(text, 'test').length, 2);
  });

  test('throws on a malformed JSON line, quoting the line number — never silently drops it', () => {
    const text = `${JSON.stringify(fixtureRow())}\nnot valid json\n`;
    assert.throws(() => parseJsonlRows(text, 'test-label'), /test-label.*line 2/s);
  });
});

// ── validateRowSchema ────────────────────────────────────────────────────
describe('validateRowSchema', () => {
  test('accepts rows with exactly the expected field set and matching dialect', () => {
    const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => fixtureRow({ question_number: i, question: `q${i}` }));
    const result = validateRowSchema(rows, 'ukr_Cyrl', 'ukr_Cyrl');
    assert.equal(result.ok, true);
  });

  test('rejects a row count that does not match EXPECTED_ROW_COUNT', () => {
    const rows = [fixtureRow()];
    const result = validateRowSchema(rows, 'ukr_Cyrl', 'ukr_Cyrl');
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /expected exactly 900 rows/);
  });

  test('rejects a row missing a required content field (e.g. flores_passage)', () => {
    const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => {
      const row = fixtureRow({ question_number: i, question: `q${i}` });
      if (i === 0) delete row.flores_passage;
      return row;
    });
    const result = validateRowSchema(rows, 'ukr_Cyrl', 'ukr_Cyrl');
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /unexpected field set/);
  });

  test('rejects a row with an unexpected EXTRA field (schema drift detection)', () => {
    const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => fixtureRow({ question_number: i, question: `q${i}`, ...(i === 0 ? { unexpected_field: 'x' } : {}) }));
    const result = validateRowSchema(rows, 'ukr_Cyrl', 'ukr_Cyrl');
    assert.equal(result.ok, false);
  });

  test('rejects a dialect field mismatch (catches a mixed-up download/cache)', () => {
    const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => fixtureRow({ question_number: i, question: `q${i}`, dialect: 'rus_Cyrl' }));
    const result = validateRowSchema(rows, 'ukr_Cyrl', 'ukr_Cyrl');
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /dialect/);
  });
});

// ── synthesizeRetrievalTask: monolingual construction ────────────────────
describe('synthesizeRetrievalTask', () => {
  test('deduplicates corpus by link — multiple questions sharing a passage produce ONE corpus doc', () => {
    const rows = [
      fixtureRow({ link: 'L1', question: 'Q1', flores_passage: 'Passage text' }),
      fixtureRow({ link: 'L1', question: 'Q2', flores_passage: 'Passage text' }),
      fixtureRow({ link: 'L2', question: 'Q3', flores_passage: 'Other passage' }),
    ];
    const task = synthesizeRetrievalTask(rows);
    assert.equal(task.corpus.size, 2);
    assert.equal(task.queries.size, 3);
  });

  test('every query has exactly one relevant document (MRC-derived qrels contract)', () => {
    const rows = [
      fixtureRow({ link: 'L1', question: 'Q1' }),
      fixtureRow({ link: 'L2', question: 'Q2' }),
    ];
    const task = synthesizeRetrievalTask(rows);
    for (const docsMap of task.qrels.values()) {
      assert.equal(docsMap.size, 1);
    }
  });

  test('never invents a qrels row beyond exactly what the raw rows specify', () => {
    const rows = [fixtureRow({ link: 'L1', question: 'Q1' })];
    const task = synthesizeRetrievalTask(rows);
    assert.equal(task.stats.qrelsJudgmentCount, 1);
  });

  test('throws if the same link has inconsistent flores_passage text across rows (data integrity check)', () => {
    const rows = [
      fixtureRow({ link: 'L1', question: 'Q1', flores_passage: 'Text A' }),
      fixtureRow({ link: 'L1', question: 'Q2', flores_passage: 'Text B (different!)' }),
    ];
    assert.throws(() => synthesizeRetrievalTask(rows), /inconsistent flores_passage/);
  });

  test('never produces dangling qrels references', () => {
    const rows = [fixtureRow({ link: 'L1', question: 'Q1' }), fixtureRow({ link: 'L2', question: 'Q2' })];
    const task = synthesizeRetrievalTask(rows);
    assert.equal(task.stats.danglingQrelsRefs.length, 0);
  });

  // ── content preservation: title/text/unicode never lost or mangled ────
  test('preserves the full flores_passage text VERBATIM as the corpus doc text, never truncated or reformatted', () => {
    const longUnicodeText = 'Довгий уривок з кирилицею, латиницею (abc), цифрами 123, і символами: «—…».repeat'.repeat(3);
    const rows = [fixtureRow({ link: 'L1', question: 'Q1', flores_passage: longUnicodeText })];
    const task = synthesizeRetrievalTask(rows);
    const doc = [...task.corpus.values()][0];
    assert.equal(doc.text, longUnicodeText);
  });

  test('title is always the empty string (Belebele/FLORES passages carry no separate title field) — never fabricated', () => {
    const rows = [fixtureRow({ link: 'L1', question: 'Q1' })];
    const task = synthesizeRetrievalTask(rows);
    const doc = [...task.corpus.values()][0];
    assert.equal(doc.title, '');
  });

  test('preserves the exact question text verbatim, including Unicode combining characters and punctuation', () => {
    const unicodeQuestion = 'Что из перечисленного не является правильным? «Пример» — 100%.';
    const rows = [fixtureRow({ link: 'L1', question: unicodeQuestion })];
    const task = synthesizeRetrievalTask(rows);
    assert.equal([...task.queries.values()][0], unicodeQuestion);
  });

  test('IDs are deterministic hashes of content, not array indices — same input always produces the same IDs', () => {
    const rows = [fixtureRow({ link: 'L1', question: 'Q1' })];
    const task1 = synthesizeRetrievalTask(rows);
    const task2 = synthesizeRetrievalTask(rows);
    assert.deepEqual([...task1.corpus.keys()], [...task2.corpus.keys()]);
    assert.deepEqual([...task1.queries.keys()], [...task2.queries.keys()]);
  });

  test('two different passages never collide onto the same doc ID', () => {
    const rows = [
      fixtureRow({ link: 'link-a', question: 'Q1', flores_passage: 'Passage A' }),
      fixtureRow({ link: 'link-b', question: 'Q2', flores_passage: 'Passage B' }),
    ];
    const task = synthesizeRetrievalTask(rows);
    assert.equal(task.corpus.size, 2);
    const ids = [...task.corpus.keys()];
    assert.notEqual(ids[0], ids[1]);
  });
});

// ── validateRetrievalTask ─────────────────────────────────────────────────
describe('validateRetrievalTask', () => {
  function fullFixtureTask() {
    const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => fixtureRow({
      link: `link-${i % EXPECTED_CORPUS_SIZE}`, question: `q${i}`, question_number: i,
      flores_passage: `passage ${i % EXPECTED_CORPUS_SIZE}`,
    }));
    return synthesizeRetrievalTask(rows);
  }

  test('accepts a fixture matching EXPECTED_CORPUS_SIZE with valid 1-relevant-doc-per-query qrels', () => {
    const task = fullFixtureTask();
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, true);
  });

  test('rejects a corpus size that does not match EXPECTED_CORPUS_SIZE', () => {
    const rows = [fixtureRow({ link: 'L1', question: 'Q1' })];
    const task = synthesizeRetrievalTask(rows);
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /expected exactly 488/);
  });

  test('rejects dangling qrels references', () => {
    const task = fullFixtureTask();
    task.qrels.get([...task.qrels.keys()][0]).set('nonexistent-doc-id', 1);
    task.stats.danglingQrelsRefs = [{ queryId: 'x', docId: 'nonexistent-doc-id' }];
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
  });

  test('rejects empty corpus text', () => {
    const task = fullFixtureTask();
    const firstDocId = [...task.corpus.keys()][0];
    task.corpus.set(firstDocId, { title: '', text: '' });
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /empty\/missing text/);
  });

  test('rejects empty query text', () => {
    const task = fullFixtureTask();
    const firstQueryId = [...task.queries.keys()][0];
    task.queries.set(firstQueryId, '   ');
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /empty\/missing/);
  });

  test('rejects a query with more than one relevant document (violates this dataset\'s MRC-derived contract)', () => {
    const task = fullFixtureTask();
    const [qid, docsMap] = [...task.qrels.entries()][0];
    const someOtherDocId = [...task.corpus.keys()].find((id) => !docsMap.has(id));
    docsMap.set(someOtherDocId, 1);
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(';'), /exactly 1 relevant document/);
  });

  test('rejects a query with zero relevant documents', () => {
    const task = fullFixtureTask();
    const [qid] = [...task.qrels.keys()];
    task.qrels.delete(qid);
    const result = validateRetrievalTask(task);
    assert.equal(result.ok, false);
  });
});

// ── download/cache machinery (mirrors fetch-miracl.test.mjs's own coverage) ─
describe('isValidCacheHit / downloadTo', () => {
  let tmpDir;
  test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'fetch-belebele-test-')); });
  test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('a file with no manifest is treated as an invalid cache hit', () => {
    const destPath = join(tmpDir, 'x.jsonl');
    writeFileSync(destPath, 'content');
    assert.equal(isValidCacheHit(destPath, 'https://example.com/x'), false);
  });

  test('downloadTo writes the final file and a matching manifest atomically', async () => {
    const destPath = join(tmpDir, 'lang.jsonl');
    const url = 'https://example.com/lang.jsonl';
    await downloadTo(url, destPath, { fetchImpl: async () => fakeFetchResponse('{"a":1}\n') });
    assert.ok(existsSync(destPath));
    assert.ok(existsSync(manifestPathFor(destPath)));
    assert.equal(isValidCacheHit(destPath, url), true);
  });

  test('downloadTo never leaves a partial file at the final path on failure', async () => {
    const destPath = join(tmpDir, 'lang.jsonl');
    await assert.rejects(() => downloadTo('https://example.com/x', destPath, { fetchImpl: async () => fakeFetchResponse('', { ok: false, status: 404 }) }));
    assert.equal(existsSync(destPath), false);
  });

  test('isValidCacheHit rejects a manifest for a different URL (revision/source mismatch guard)', async () => {
    const destPath = join(tmpDir, 'lang.jsonl');
    await downloadTo('https://example.com/old-revision/lang.jsonl', destPath, { fetchImpl: async () => fakeFetchResponse('{"a":1}\n') });
    assert.equal(isValidCacheHit(destPath, 'https://example.com/new-revision/lang.jsonl'), false);
  });
});
