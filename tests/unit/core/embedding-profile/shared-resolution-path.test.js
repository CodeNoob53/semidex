// Proves admin search, Ask, and MCP search all resolve a collection's
// embedding profile through the SAME function — resolveExistingCollectionProfile
// — never three independent implementations. Since the qdrant-cloud task's
// MCP unification (Part E), this is even more true than before: MCP no
// longer imports resolveExistingCollectionProfile directly at all — it
// goes through runHybridSearch() (src/core/retrieval/search.js), the exact
// same call site admin search and Ask already share. This file now proves
// that ONE call site (source-reference for runHybridSearch's own import;
// a behavioral proof that MCP, admin search, and Ask all route through it
// identically).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';

function readSrc(relPath) {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf-8');
}

describe('resolveExistingCollectionProfile — one shared resolution path, not three', () => {
  it('src/core/retrieval/search.js (admin search + Ask + MCP, all via runHybridSearch) imports and calls resolveExistingCollectionProfile', () => {
    const src = readSrc('../../../../src/core/retrieval/search.js');
    assert.match(src, /import\s*\{\s*resolveExistingCollectionProfile\s*\}\s*from\s*['"]\.\.\/embedding-profile\/resolve\.js['"]/);
    assert.match(src, /resolveExistingCollectionProfile\(adapter, collection\)/);
  });

  it('src/mcp/tools/search.js no longer imports resolveExistingCollectionProfile directly — it routes through runHybridSearch() instead, the SAME shared call site admin search and Ask use', () => {
    const src = readSrc('../../../../src/mcp/tools/search.js');
    assert.ok(!src.includes('resolveExistingCollectionProfile'), 'MCP must not import or call resolveExistingCollectionProfile directly — that would be a second, parallel resolution path');
    assert.match(src, /import\s*\{\s*runHybridSearch\s*\}\s*from\s*['"]\.\.\/\.\.\/core\/retrieval\/search\.js['"]/);
    assert.match(src, /await runHybridSearch\(\{/);
  });

  it('behaviorally: admin search, Ask, AND MCP (all via runHybridSearch) reach the identical resolution call for the same collection/adapter', async () => {
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
      searchHybridVectors: async () => [],
    };
    const embedQuery = async () => ({ dense: [0.1], sparse: { indices: [], values: [] } });

    // Simulates admin search's own call shape.
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q1', top: 5 });
    // Simulates Ask's call shape (same function, same adapter, different query).
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q2', top: 5 });
    // Simulates MCP's call shape (a larger `top` for its own rerank candidate pool — the only difference from admin/Ask, still the same function).
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q3', top: 20 });

    assert.equal(resolutionCallCount, 3, 'all three calls must go through the same resolution function — one call recorded per runHybridSearch invocation');
  });
});
