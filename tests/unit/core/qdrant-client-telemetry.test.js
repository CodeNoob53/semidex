// Behavioral test for src/core/qdrant/client.js's qdrantCall() opt-in
// telemetry hook — captures real emitted events via a real telemetry file
// (SEMIDEX_BENCH_TELEMETRY_PATH), never a source-text inspection of which
// functions "look wrapped." getQdrantClient() only constructs the client
// lazily and never calls the network itself, so this never touches a real
// Qdrant instance — the QdrantClient SDK prototype is monkey-patched
// exactly like tests/unit/core/qdrant-store-upsert-without-vectors.test.js
// already does for upsertPoints/upsertPointsWithoutVectors.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QdrantClient } from '@qdrant/js-client-rest';
import { listCollections, getCollectionInfo } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalGetCollections;
let originalGetCollection;
let telemetryDir;
let telemetryPath;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  telemetryDir = mkdtempSync(join(tmpdir(), 'semidex-qdrant-telemetry-test-'));
  telemetryPath = join(telemetryDir, 'telemetry.jsonl');
  originalGetCollections = QdrantClient.prototype.getCollections;
  originalGetCollection = QdrantClient.prototype.getCollection;
});

afterEach(() => {
  QdrantClient.prototype.getCollections = originalGetCollections;
  QdrantClient.prototype.getCollection = originalGetCollection;
  resetQdrantClientCache();
  delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
  rmSync(telemetryDir, { recursive: true, force: true });
});

function readEvents() {
  if (!existsSync(telemetryPath)) return [];
  return readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('qdrantCall() — opt-in telemetry via SEMIDEX_BENCH_TELEMETRY_PATH', () => {
  it('emits no telemetry when SEMIDEX_BENCH_TELEMETRY_PATH is unset — real production calls stay silent', async () => {
    delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
    QdrantClient.prototype.getCollections = () => Promise.resolve({ collections: [] });
    await listCollections();
    assert.deepEqual(readEvents(), []);
  });

  it('emits one qdrant_sdk_op event per successful call, with the real label and ok:true', async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    QdrantClient.prototype.getCollections = () => Promise.resolve({ collections: [{ name: 'a' }] });
    await listCollections();
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'qdrant_sdk_op');
    assert.equal(events[0].ok, true);
    assert.equal(typeof events[0].label, 'string');
    assert.equal(typeof events[0].ms, 'number');
  });

  it('emits ok:false on a failed call, and still lets the error propagate', async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    QdrantClient.prototype.getCollection = () => Promise.reject(new Error('not found'));
    await assert.rejects(() => getCollectionInfo('missing-collection'));
    const events = readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, false);
  });

  it('emits a separate event per distinct SDK call — two calls, two events', async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    QdrantClient.prototype.getCollections = () => Promise.resolve({ collections: [] });
    QdrantClient.prototype.getCollection = () => Promise.resolve({ status: 'green' });
    await listCollections();
    await getCollectionInfo('some-collection');
    assert.equal(readEvents().length, 2);
  });
});
