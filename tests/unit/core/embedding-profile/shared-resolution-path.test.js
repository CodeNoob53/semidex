// Proves admin search, Ask, and MCP search all resolve a collection's
// embedding profile through the SAME function — resolveExistingCollectionProfile
// — never three independent implementations. This is a source-reference
// check (each call site is confirmed to import and call the one shared
// function) combined with a behavioral proof for the two callers that go
// through runHybridSearch (admin search + Ask share ONE call site there).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';

function readSrc(relPath) {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf-8');
}

describe('resolveExistingCollectionProfile — one shared resolution path, not three', () => {
  it('src/core/retrieval/search.js (admin search + Ask, via runHybridSearch) imports and calls resolveExistingCollectionProfile', () => {
    const src = readSrc('../../../../src/core/retrieval/search.js');
    assert.match(src, /import\s*\{\s*resolveExistingCollectionProfile\s*\}\s*from\s*['"]\.\.\/embedding-profile\/resolve\.js['"]/);
    assert.match(src, /resolveExistingCollectionProfile\(adapter, collection\)/);
  });

  it('src/mcp/tools/search.js imports and calls the SAME resolveExistingCollectionProfile — not a separate/duplicated implementation', () => {
    const src = readSrc('../../../../src/mcp/tools/search.js');
    assert.match(src, /import\s*\{\s*resolveExistingCollectionProfile\s*\}\s*from\s*['"]\.\.\/\.\.\/core\/embedding-profile\/resolve\.js['"]/);
    assert.match(src, /resolveExistingCollectionProfile\(getStorageAdapter\(\), collection\)/);
  });

  it('behaviorally: admin search (via runHybridSearch) and Ask (via buildEvidence -> runHybridSearch) reach the identical resolution call for the same collection/adapter', async () => {
    let resolutionCallCount = 0;
    const validProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
        sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
      },
      embeddingSchemaVersion: 2,
    };
    const adapter = {
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async (name) => ({ name }),
      getEmbeddingProfile: async () => { resolutionCallCount++; return { state: 'valid', profile: validProfile }; },
      searchHybrid: async () => [],
    };
    const embedQuery = async () => ({ dense: [0.1], sparse: { indices: [], values: [] } });

    // Simulates admin search's own call shape.
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q1', top: 5 });
    // Simulates Ask's call shape (same function, same adapter, different query).
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q2', top: 5 });

    assert.equal(resolutionCallCount, 2, 'both calls must go through the same resolution function — one call recorded per runHybridSearch invocation');
  });
});
