// ensureCollectionSchema logic, exercised offline via injected store stubs
// (options.deps) rather than a live Qdrant instance.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_PAYLOAD_INDEXES } from '../../../src/core/qdrant/schema.js';
import { ensureCollectionSchema } from '../../../src/core/qdrant/ensure-schema.js';

function namedVectorInfo(overrides = {}) {
  return { config: { params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } }, ...overrides };
}

function flatVectorInfo() {
  return { config: { params: { vectors: { size: 1024, distance: 'Cosine' } } } };
}

function makeDeps(overrides = {}) {
  const calls = { createPayloadIndex: [], addSparseVectorSupport: [], hasSparseVectors: [] };
  const deps = {
    getCollectionInfo: async () => namedVectorInfo(),
    createPayloadIndex: async (name, field, schema) => { calls.createPayloadIndex.push([name, field, schema]); },
    addSparseVectorSupport: async (name) => { calls.addSparseVectorSupport.push(name); },
    hasSparseVectors: async (name) => { calls.hasSparseVectors.push(name); return true; },
    ...overrides,
  };
  return { deps, calls };
}

describe('ensureCollectionSchema — named vector schema (healthy collection)', () => {
  it('creates every required payload index exactly once', async () => {
    const { deps, calls } = makeDeps();
    const { repaired } = await ensureCollectionSchema('col', { deps });
    assert.equal(calls.createPayloadIndex.length, Object.keys(REQUIRED_PAYLOAD_INDEXES).length);
    for (const field of Object.keys(REQUIRED_PAYLOAD_INDEXES)) {
      assert.ok(repaired.some(r => r.includes(`"${field}"`)), `expected repaired to mention ${field}`);
    }
  });

  it('does not duplicate the index list — uses REQUIRED_PAYLOAD_INDEXES as the source', async () => {
    const { deps, calls } = makeDeps();
    await ensureCollectionSchema('col', { deps });
    const fields = calls.createPayloadIndex.map(([, field]) => field);
    assert.deepEqual(fields.sort(), Object.keys(REQUIRED_PAYLOAD_INDEXES).sort());
  });

  it('attempts sparse vector support and reports it as repaired', async () => {
    const { deps, calls } = makeDeps();
    const { repaired } = await ensureCollectionSchema('col', { deps });
    assert.equal(calls.addSparseVectorSupport.length, 1);
    assert.ok(repaired.includes('sparse vector support'));
  });

  it('does not report sparse vector support as repaired when addSparseVectorSupport throws (already present)', async () => {
    const { deps } = makeDeps({ addSparseVectorSupport: async () => { throw new Error('already exists'); } });
    const { repaired } = await ensureCollectionSchema('col', { deps });
    assert.ok(!repaired.includes('sparse vector support'));
  });

  it('warns when points have no sparse vectors yet', async () => {
    const { deps } = makeDeps({ hasSparseVectors: async () => false });
    const { warnings } = await ensureCollectionSchema('col', { deps });
    assert.ok(warnings.some(w => w.includes('no sparse vectors')));
  });

  it('produces no warnings for a fully healthy collection', async () => {
    const { deps } = makeDeps();
    const { warnings } = await ensureCollectionSchema('col', { deps });
    assert.deepEqual(warnings, []);
  });
});

describe('ensureCollectionSchema — flat (legacy) vector schema', () => {
  it('still creates payload indexes so MCP filters keep working', async () => {
    const { deps, calls } = makeDeps({ getCollectionInfo: async () => flatVectorInfo() });
    await ensureCollectionSchema('legacy-col', { deps });
    assert.equal(calls.createPayloadIndex.length, Object.keys(REQUIRED_PAYLOAD_INDEXES).length);
  });

  it('skips the sparse vector repair and warns about legacy schema', async () => {
    const { deps, calls } = makeDeps({ getCollectionInfo: async () => flatVectorInfo() });
    const { warnings } = await ensureCollectionSchema('legacy-col', { deps });
    assert.equal(calls.addSparseVectorSupport.length, 0);
    assert.equal(calls.hasSparseVectors.length, 0);
    assert.ok(warnings.some(w => w.includes('LEGACY SCHEMA')));
    assert.ok(warnings.some(w => w.includes('Skipped sparse vector check')));
  });
});

describe('ensureCollectionSchema — options.collectionInfo short-circuit', () => {
  it('does not call getCollectionInfo when collectionInfo is provided', async () => {
    let called = false;
    const { deps } = makeDeps({ getCollectionInfo: async () => { called = true; return namedVectorInfo(); } });
    await ensureCollectionSchema('col', { deps, collectionInfo: namedVectorInfo() });
    assert.equal(called, false);
  });
});
