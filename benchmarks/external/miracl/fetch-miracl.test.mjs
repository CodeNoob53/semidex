import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTopicsTsv, parseMiraclQrelsTsv, validateTopicsAndQrels,
  extractDocIdCheaply, downloadTo, isValidCacheHit, manifestPathFor,
  TOPICS_DIR, QRELS_DIR, CORPUS_DIR,
  MIRACL_TOPICS_QRELS_REVISION, MIRACL_CORPUS_REVISION,
} from './fetch-miracl.mjs';

/** Minimal fake Response matching exactly what downloadTo() reads:
 * res.ok, res.headers.get('content-length'), res.body.getReader(). */
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

describe('parseTopicsTsv', () => {
  test('parses "qid\\tquery text" rows with no header', () => {
    const text = '0\tКогда начался Карибский кризис?\n2\tКак называлась Симбирская губерния?\n';
    const parsed = parseTopicsTsv(text);
    assert.equal(parsed.size, 2);
    assert.equal(parsed.get('0'), 'Когда начался Карибский кризис?');
    assert.equal(parsed.get('2'), 'Как называлась Симбирская губерния?');
  });

  test('ignores blank lines', () => {
    const text = '0\tfirst\n\n2\tsecond\n';
    const parsed = parseTopicsTsv(text);
    assert.equal(parsed.size, 2);
  });

  test('preserves tabs within the query text itself (only splits on the FIRST tab)', () => {
    const text = '0\tquery\twith\ttabs\n';
    const parsed = parseTopicsTsv(text);
    assert.equal(parsed.get('0'), 'query\twith\ttabs');
  });
});

describe('parseMiraclQrelsTsv', () => {
  test('parses standard 4-column TREC qrels with no header', () => {
    const text = '0\tQ0\t105156#0\t1\n0\tQ0\t105156#4\t0\n2\tQ0\t82404#0\t1\n';
    const parsed = parseMiraclQrelsTsv(text);
    assert.equal(parsed.size, 2);
    assert.equal(parsed.get('0').get('105156#0'), 1);
    assert.equal(parsed.get('0').get('105156#4'), 0);
    assert.equal(parsed.get('2').get('82404#0'), 1);
  });

  test('a docid in the run but absent from qrels is a distinct concept from relevance=0 in qrels (this parser preserves both)', () => {
    const text = '0\tQ0\tdocA\t1\n0\tQ0\tdocB\t0\n';
    const parsed = parseMiraclQrelsTsv(text);
    assert.equal(parsed.get('0').has('docA'), true);
    assert.equal(parsed.get('0').has('docB'), true);
    assert.equal(parsed.get('0').has('docC'), false);
  });

  test('ignores blank and malformed lines', () => {
    const text = '0\tQ0\tdocA\t1\n\nmalformed\n0\tQ0\tdocB\t0\n';
    const parsed = parseMiraclQrelsTsv(text);
    assert.equal(parsed.get('0').size, 2);
  });
});

describe('validateTopicsAndQrels', () => {
  function makeQueries(n) {
    const m = new Map();
    for (let i = 0; i < n; i++) m.set(String(i), `query ${i}`);
    return m;
  }

  test('accepts a dataset matching the exact expected dev query/judgment counts', () => {
    // Build exactly 1252 queries and exactly 13100 judgments (10.46/query
    // average via a fixed distribution) so validateTopicsAndQrels's exact
    // count checks pass — mirrors the real dev split's shape without
    // depending on live network data in a unit test.
    const queries = makeQueries(1252);
    const qrels = new Map();
    let judgments = 0;
    for (let i = 0; i < 1252; i++) {
      const qid = String(i);
      const docsMap = new Map();
      const countForThisQuery = i < 100 ? 11 : 10; // 100*11 + 1152*10 = 1100+11520 = 12620... adjust below
      for (let d = 0; d < countForThisQuery; d++) docsMap.set(`${qid}-doc${d}`, d === 0 ? 1 : 0);
      qrels.set(qid, docsMap);
      judgments += countForThisQuery;
    }
    // Top up to exactly 13100 by adding extra judgments to the first query.
    const shortfall = 13100 - judgments;
    if (shortfall > 0) {
      const extra = qrels.get('0');
      for (let d = 0; d < shortfall; d++) extra.set(`0-extra${d}`, 0);
    }
    const validation = validateTopicsAndQrels({ queries, qrels });
    assert.equal(validation.ok, true);
    assert.equal(validation.stats.queryCount, 1252);
    assert.equal(validation.stats.judgmentCount, 13100);
  });

  test('rejects a wrong query count', () => {
    const queries = makeQueries(10);
    const qrels = new Map();
    const validation = validateTopicsAndQrels({ queries, qrels });
    assert.equal(validation.ok, false);
    assert.match(validation.problems.join(';'), /expected exactly 1252 dev queries/);
  });

  test('rejects a qrels row referencing a query ID not present in topics', () => {
    const queries = makeQueries(1252);
    const qrels = new Map([['not-a-real-qid', new Map([['doc1', 1]])]]);
    const validation = validateTopicsAndQrels({ queries, qrels });
    assert.equal(validation.ok, false);
    assert.match(validation.problems.join(';'), /reference a query ID not present in topics/);
  });
});

describe('cache directory revision namespacing (P1 regression test)', () => {
  test('TOPICS_DIR/QRELS_DIR embed the pinned topics/qrels revision', () => {
    assert.match(TOPICS_DIR, new RegExp(MIRACL_TOPICS_QRELS_REVISION));
    assert.match(QRELS_DIR, new RegExp(MIRACL_TOPICS_QRELS_REVISION));
  });

  test('CORPUS_DIR embeds the pinned corpus revision', () => {
    assert.match(CORPUS_DIR, new RegExp(MIRACL_CORPUS_REVISION));
  });

  test('topics/qrels and corpus cache directories are distinct from each other', () => {
    assert.notEqual(TOPICS_DIR, QRELS_DIR);
    assert.notEqual(TOPICS_DIR, CORPUS_DIR);
  });
});

describe('extractDocIdCheaply: fast pre-check before JSON.parse (P3 regression test)', () => {
  test('extracts the docid from a real-shaped corpus line without parsing the rest', () => {
    const line = '{"docid": "7#0", "title": "Литва", "text": "Литва — государство..."}';
    assert.equal(extractDocIdCheaply(line), '7#0');
  });

  test('returns null (triggering the JSON.parse fallback) for a line that does not match the expected prefix shape', () => {
    assert.equal(extractDocIdCheaply('{"title": "no docid first"}'), null);
    assert.equal(extractDocIdCheaply('not even json'), null);
    assert.equal(extractDocIdCheaply(''), null);
  });

  test('agrees with JSON.parse(line).docid on a batch of real-shaped lines (no silent divergence)', () => {
    const lines = [
      '{"docid": "1#0", "title": "A", "text": "x"}',
      '{"docid": "12345#99", "title": "B", "text": "y \\"quoted\\" z"}',
      '{"docid": "0#0", "title": "", "text": ""}',
    ];
    for (const line of lines) {
      const cheap = extractDocIdCheaply(line);
      const real = JSON.parse(line).docid;
      assert.equal(cheap, real, `mismatch for line: ${line}`);
    }
  });
});

describe('downloadTo / isValidCacheHit: atomic download + checksum manifest (P1 regression test)', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'miracl-fetch-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a successful download writes the final file, a manifest, and no leftover .part file', async () => {
    const destPath = join(dir, 'topics.tsv');
    const fetchImpl = async () => fakeFetchResponse('0\tquery text\n');
    await downloadTo('https://example.invalid/topics.tsv', destPath, { fetchImpl });

    assert.equal(existsSync(destPath), true);
    assert.equal(existsSync(`${destPath}.part`), false, 'no leftover .part file after a successful download');
    assert.equal(existsSync(manifestPathFor(destPath)), true);
    const manifest = JSON.parse(readFileSync(manifestPathFor(destPath), 'utf-8'));
    assert.equal(manifest.url, 'https://example.invalid/topics.tsv');
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  });

  test('isValidCacheHit is true only after a real successful download with a matching manifest', async () => {
    const destPath = join(dir, 'topics.tsv');
    const url = 'https://example.invalid/topics.tsv';
    assert.equal(isValidCacheHit(destPath, url), false, 'nothing downloaded yet');
    await downloadTo(url, destPath, { fetchImpl: async () => fakeFetchResponse('content') });
    assert.equal(isValidCacheHit(destPath, url), true);
  });

  test('a file present WITHOUT a manifest is treated as an invalid cache hit (simulates a pre-fix stale/partial file)', () => {
    const destPath = join(dir, 'topics.tsv');
    writeFileSync(destPath, 'some content with no manifest written for it', 'utf-8');
    assert.equal(isValidCacheHit(destPath, 'https://example.invalid/topics.tsv'), false);
  });

  test('a manifest recorded for a DIFFERENT url is not trusted for the current url (revision/source change detection)', async () => {
    const destPath = join(dir, 'topics.tsv');
    await downloadTo('https://example.invalid/old-revision/topics.tsv', destPath, { fetchImpl: async () => fakeFetchResponse('content') });
    assert.equal(isValidCacheHit(destPath, 'https://example.invalid/new-revision/topics.tsv'), false);
  });

  test('a file whose content was tampered with after download fails checksum validation', async () => {
    const destPath = join(dir, 'topics.tsv');
    const url = 'https://example.invalid/topics.tsv';
    await downloadTo(url, destPath, { fetchImpl: async () => fakeFetchResponse('original content') });
    writeFileSync(destPath, 'tampered content', 'utf-8'); // simulates disk corruption / manual edit
    assert.equal(isValidCacheHit(destPath, url), false);
  });

  test('a failed fetch (non-ok response) never leaves a final file or manifest behind — only .part is used mid-download', async () => {
    const destPath = join(dir, 'topics.tsv');
    const fetchImpl = async () => fakeFetchResponse('', { ok: false, status: 500 });
    await assert.rejects(() => downloadTo('https://example.invalid/topics.tsv', destPath, { fetchImpl }));
    assert.equal(existsSync(destPath), false);
    assert.equal(existsSync(manifestPathFor(destPath)), false);
  });

  test('a stream error mid-download cleans up the .part file rather than leaving a corrupt partial download', async () => {
    const destPath = join(dir, 'topics.tsv');
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ async read() { throw new Error('synthetic network drop'); } }) },
    });
    await assert.rejects(() => downloadTo('https://example.invalid/topics.tsv', destPath, { fetchImpl }));
    assert.equal(existsSync(destPath), false);
    assert.equal(existsSync(`${destPath}.part`), false, '.part file must be cleaned up, not left as a poisoned cache candidate');
  });
});
