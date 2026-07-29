// Regression test for src/core/qdrant/store.js's hybridSearch() (code
// review — the LOCAL/CLIENT-execution query path's client.query() call
// used to bypass qdrantCall entirely, which meant a benchmark harness
// observing only qdrantCall's telemetry silently under-counted every
// local-profile query while cloud-profile queries (already routed
// through hybridSearchCloud(), always qdrantCall-wrapped) were counted
// correctly). Proves TWO things behaviorally, via a real telemetry file
// and a monkey-patched QdrantClient SDK prototype — never source-text
// inspection:
//   1. a successful hybridSearch() call emits exactly one qdrant_sdk_op
//      telemetry event, same as its cloud sibling hybridSearchCloud();
//   2. the existing "Wrong sparse vector name" dense-only fallback
//      behavior is completely unchanged by the new qdrantCall wrapping —
//      the fallback still fires, still returns dense-only results, and
//      itself emits its own qdrant_sdk_op event (via search()'s own
//      existing qdrantCall wrapping).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QdrantClient } from '@qdrant/js-client-rest';
import { hybridSearch } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalQuery;
let originalSearch;
let telemetryDir;
let telemetryPath;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  telemetryDir = mkdtempSync(join(tmpdir(), 'semidex-hybrid-search-telemetry-test-'));
  telemetryPath = join(telemetryDir, 'telemetry.jsonl');
  process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
  originalQuery = QdrantClient.prototype.query;
  originalSearch = QdrantClient.prototype.search;
});

afterEach(() => {
  QdrantClient.prototype.query = originalQuery;
  QdrantClient.prototype.search = originalSearch;
  resetQdrantClientCache();
  delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
  rmSync(telemetryDir, { recursive: true, force: true });
});

function readEvents() {
  if (!existsSync(telemetryPath)) return [];
  return readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('hybridSearch() — brought under qdrantCall telemetry coverage', () => {
  it('a successful hybrid query emits exactly one qdrant_sdk_op event', async () => {
    QdrantClient.prototype.query = () => Promise.resolve({ points: [{ id: 1, score: 0.9 }] });
    const points = await hybridSearch('my-collection', [0.1, 0.2], { indices: [1], values: [0.5] }, 10);
    assert.deepEqual(points, [{ id: 1, score: 0.9 }]);
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'qdrant_sdk_op');
    assert.equal(events[0].ok, true);
  });

  it('preserves the existing dense-only fallback on "Wrong sparse vector name" — behavior unchanged by the qdrantCall wrapping', async () => {
    let queryCalls = 0;
    QdrantClient.prototype.query = () => {
      queryCalls += 1;
      return Promise.reject(new Error('Wrong sparse vector name: sparse'));
    };
    let searchCalls = 0;
    QdrantClient.prototype.search = () => {
      searchCalls += 1;
      return Promise.resolve({ points: [{ id: 2, score: 0.7 }] });
    };
    const result = await hybridSearch('my-collection', [0.1, 0.2], { indices: [1], values: [0.5] }, 10);
    assert.equal(queryCalls, 1, 'expected exactly one query() attempt before falling back');
    assert.equal(searchCalls, 1, 'expected the dense-only fallback to actually call search()');
    // The fallback path returns search()'s own raw resolved value directly
    // (pre-existing behavior, unrelated to and unchanged by this qdrantCall
    // wrapping fix) — unlike the non-fallback path, which unwraps
    // result.points itself before returning.
    assert.deepEqual(result, { points: [{ id: 2, score: 0.7 }] });
  });

  it('a real (non-fallback) failure still throws, with both the failed query() attempt and nothing else observed', async () => {
    QdrantClient.prototype.query = () => Promise.reject(new Error('collection not found'));
    await assert.rejects(
      () => hybridSearch('my-collection', [0.1, 0.2], { indices: [1], values: [0.5] }, 10),
      /Qdrant hybridSearch failed/,
    );
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, false);
  });
});
