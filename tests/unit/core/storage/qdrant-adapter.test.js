// QdrantStorageAdapter shape, capabilities, and domain-mapping tests.
// No live Qdrant: only synchronous/pure surfaces (name, capabilities,
// filter translation, payload mapping) and adapter shape are exercised.
// Network-backed methods are checked for presence/callability only —
// invoking them requires a running Qdrant and belongs to a live-smoke tier.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStorageAdapter, REQUIRED_ADAPTER_METHODS } from '../../../../src/core/storage/adapter.js';
import {
  createQdrantStorageAdapter,
  translateSearchFilter,
  toChunk,
  toSourceDocument,
  toSkeletonNode,
  toContentNodeChunk,
  normalizeVectorSchema,
  extractEmbeddingProfile,
  extractIndexingState,
  validateProfileAgainstSchema,
  decideProfileWrite,
  embeddingProfileResultToResolveResult,
  buildQdrantVectorSchemaFromProfile,
} from '../../../../src/core/storage/qdrant-adapter.js';
import { METADATA_KEY_EMBEDDING_PROFILE, buildEmbeddingProfile } from '../../../../src/core/embedding-profile/schema.js';

describe('layering — src/core/storage never imports from src/mcp/', () => {
  it('no file under src/core/storage/ imports from ../../mcp or src/mcp', () => {
    const dir = fileURLToPath(new URL('../../../../src/core/storage/', import.meta.url));
    const offenders = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const content = readFileSync(dir + file, 'utf-8');
      if (/from\s+['"][^'"]*\/mcp\//.test(content)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `storage layer must not import from mcp/: ${offenders.join(', ')}`);
  });
});

describe('createQdrantStorageAdapter — shape', () => {
  it('validates through validateStorageAdapter', () => {
    assert.equal(validateStorageAdapter(createQdrantStorageAdapter()), true);
  });

  it('exposes every required adapter method as a callable function', () => {
    const adapter = createQdrantStorageAdapter();
    for (const method of REQUIRED_ADAPTER_METHODS) {
      assert.equal(typeof adapter[method], 'function', `${method} should be a function`);
    }
  });

  it('name() returns "qdrant"', () => {
    assert.equal(createQdrantStorageAdapter().name(), 'qdrant');
  });
});

describe('createQdrantStorageAdapter — capabilities', () => {
  it('matches current Qdrant reality', () => {
    const caps = createQdrantStorageAdapter().capabilities();
    assert.deepEqual(caps, {
      namedVectors:     true,
      sparseVectors:    true,
      hybridSearch:     true,
      payloadIndexes:   true,
      aliases:          false,
      snapshots:        false,
      collectionExists: true,
    });
  });

  it('does not claim aliases or snapshots until store methods exist', () => {
    const caps = createQdrantStorageAdapter().capabilities();
    assert.equal(caps.aliases, false);
    assert.equal(caps.snapshots, false);
  });

  it('returns a fresh object each call', () => {
    const adapter = createQdrantStorageAdapter();
    const a = adapter.capabilities();
    const b = adapter.capabilities();
    a.aliases = true;
    assert.equal(b.aliases, false);
  });
});

describe('translateSearchFilter — semidex filter -> Qdrant filter DSL', () => {
  it('returns null for no filter', () => {
    assert.equal(translateSearchFilter(undefined), null);
    assert.equal(translateSearchFilter(null), null);
  });

  it('translates sourceFile to a must clause', () => {
    const f = translateSearchFilter({ sourceFile: 'docs/readme.md' });
    assert.deepEqual(f, { must: [{ key: 'source_file', match: { value: 'docs/readme.md' } }] });
  });

  it('translates tags to a should clause nested in must', () => {
    const f = translateSearchFilter({ tags: ['a', 'b'] });
    assert.deepEqual(f, {
      must: [{ should: [
        { key: 'tags', match: { value: 'a' } },
        { key: 'tags', match: { value: 'b' } },
      ] }],
    });
  });

  it('combines sourceFile and tags', () => {
    const f = translateSearchFilter({ sourceFile: 'a.md', tags: ['x'] });
    assert.equal(f.must.length, 2);
  });

  it('applies excludeNav as a must_not point_kind clause', () => {
    const f = translateSearchFilter({ excludeNav: true });
    assert.ok(Array.isArray(f.must_not));
    assert.ok(f.must_not.some(c => c.key === 'point_kind' && c.match.value === 'skeleton_nav'));
  });

  it('combines excludeNav with sourceFile/tags filters', () => {
    const f = translateSearchFilter({ sourceFile: 'a.md', excludeNav: true });
    assert.equal(f.must.length, 1);
    assert.ok(f.must_not.some(c => c.key === 'point_kind'));
  });

  it('never leaks a bare semidex-level key (sourceFile/tags/excludeNav) into the output', () => {
    const f = translateSearchFilter({ sourceFile: 'a.md', tags: ['x'], excludeNav: true });
    const json = JSON.stringify(f);
    assert.ok(!json.includes('sourceFile'));
    assert.ok(!json.includes('excludeNav'));
  });
});

describe('domain mapping — no raw Qdrant snake_case leaks through', () => {
  it('toChunk maps a Qdrant point to a camelCase Chunk', () => {
    const point = {
      score: 0.87,
      payload: {
        source_file: 'docs/a.md', chunk_index: 2, total_chunks: 5, section: 'Intro',
        text: 'hello', context: 'ctx', tags: ['t1'],
        node_type: 'table', node_id: 'n1', node_path: 'a.md#Intro/table-1',
      },
    };
    const chunk = toChunk(point);
    assert.deepEqual(chunk, {
      sourceFile: 'docs/a.md', chunkIndex: 2, totalChunks: 5, section: 'Intro',
      text: 'hello', rawContent: null, lang: null, context: 'ctx', tags: ['t1'],
      nodeType: 'table', nodeId: 'n1', nodePath: 'a.md#Intro/table-1',
      parentId: null, headingPath: null,
      entityRefs: [], entityId: null, fragmentIndex: null, fragmentCount: null,
      score: 0.87, isMatch: null,
    });
    const keys = Object.keys(chunk);
    assert.ok(!keys.some(k => k.includes('_')), `expected only camelCase keys, got: ${keys.join(', ')}`);
  });

  it('toChunk handles a missing/empty payload without throwing', () => {
    assert.deepEqual(toChunk({}), {
      sourceFile: null, chunkIndex: null, totalChunks: null, section: null,
      text: null, rawContent: null, lang: null, context: null, tags: [],
      nodeType: null, nodeId: null, nodePath: null, parentId: null, headingPath: null,
      entityRefs: [], entityId: null, fragmentIndex: null, fragmentCount: null,
      score: null, isMatch: null,
    });
  });

  it('toChunk maps entity_id/fragment_index/fragment_count for a split-entity fragment (entity-split.js)', () => {
    const point = {
      payload: {
        source_file: 'guide.md', chunk_index: 2, section: 'Setup',
        text: '| a | b |', node_type: 'table', node_id: 'frag-2',
        node_path: 'guide.md#setup/table-1/fragment-2',
        entity_id: 'canonical-table-1', fragment_index: 1, fragment_count: 3,
      },
    };
    const chunk = toChunk(point);
    assert.equal(chunk.entityId, 'canonical-table-1');
    assert.equal(chunk.fragmentIndex, 1);
    assert.equal(chunk.fragmentCount, 3);
  });

  it('toChunk ignores non-integer fragment_index/fragment_count rather than propagating a malformed value', () => {
    const chunk = toChunk({ payload: { entity_id: 'x', fragment_index: 'one', fragment_count: null } });
    assert.equal(chunk.entityId, 'x');
    assert.equal(chunk.fragmentIndex, null);
    assert.equal(chunk.fragmentCount, null);
  });

  it('toChunk maps raw_content and lang for a structural retrieval chunk (table)', () => {
    const point = {
      score: 0.5,
      payload: {
        source_file: 'docs/a.md', chunk_index: 3, section: 'Setup',
        text: '| a | b |\n| - | - |\n| 1 | 2 |',
        raw_content: '| a | b |\n| - | - |\n| 1 | 2 |',
        node_type: 'table', node_id: 'n2', node_path: 'a.md#Setup/table-1',
      },
    };
    const chunk = toChunk(point);
    assert.equal(chunk.rawContent, '| a | b |\n| - | - |\n| 1 | 2 |');
    assert.equal(chunk.lang, null);
    assert.equal(chunk.text, chunk.rawContent, 'text and rawContent are preserved as separate but equal fields for this payload');
  });

  it('toChunk maps raw_content and lang for a fenced code_block chunk', () => {
    const point = {
      payload: {
        source_file: 'docs/a.md', chunk_index: 4, section: 'Setup',
        text: "console.log('hi')", raw_content: "console.log('hi')", lang: 'js',
        node_type: 'code_block', node_id: 'n3', node_path: 'a.md#Setup/code-1',
      },
    };
    const chunk = toChunk(point);
    assert.equal(chunk.rawContent, "console.log('hi')");
    assert.equal(chunk.lang, 'js');
  });

  it('toChunk never leaks raw_content/lang snake_case keys onto the domain Chunk', () => {
    const chunk = toChunk({ payload: { raw_content: 'x', lang: 'py' } });
    const keys = Object.keys(chunk);
    assert.ok(!keys.some(k => k.includes('_')), `expected only camelCase keys, got: ${keys.join(', ')}`);
    assert.ok(keys.includes('rawContent') && keys.includes('lang'));
  });

  it('toChunk maps entity_refs to camelCase entityRefs, preserving order', () => {
    const point = {
      payload: {
        source_file: 'guide.md', chunk_index: 0, section: 'Setup',
        text: 'Configuration options:\n\n[table node: guide.md#setup/table-1 — Option | Default]',
        node_type: 'paragraph',
        entity_refs: [
          { node_id: 'n1', node_path: 'guide.md#setup/table-1', node_type: 'table', placeholder: '[table node: guide.md#setup/table-1 — Option | Default]' },
          { node_id: 'n2', node_path: 'guide.md#setup/code_block-1', node_type: 'code_block', placeholder: '[code block node: guide.md#setup/code_block-1 — x = 1]' },
        ],
      },
    };
    const chunk = toChunk(point);
    assert.deepEqual(chunk.entityRefs, [
      { nodeId: 'n1', nodePath: 'guide.md#setup/table-1', nodeType: 'table', placeholder: '[table node: guide.md#setup/table-1 — Option | Default]' },
      { nodeId: 'n2', nodePath: 'guide.md#setup/code_block-1', nodeType: 'code_block', placeholder: '[code block node: guide.md#setup/code_block-1 — x = 1]' },
    ]);
    const keys = chunk.entityRefs.flatMap(r => Object.keys(r));
    assert.ok(!keys.some(k => k.includes('_')), `expected only camelCase keys inside entityRefs, got: ${keys.join(', ')}`);
  });

  it('toChunk maps a prose chunk with no entity_refs field to an empty array, not undefined/null', () => {
    const chunk = toChunk({ payload: { source_file: 'a.md', node_type: 'paragraph', text: 'plain prose, no placeholder' } });
    assert.deepEqual(chunk.entityRefs, []);
  });

  it('toChunk ignores a malformed entity_refs field (not an array) rather than throwing', () => {
    const chunk = toChunk({ payload: { entity_refs: 'not-an-array' } });
    assert.deepEqual(chunk.entityRefs, []);
  });

  it('toSourceDocument maps an aggregation entry to camelCase', () => {
    const doc = toSourceDocument({ source_file: 'a.md', chunkCount: 3, firstSection: 'Intro', tags: ['t'] });
    assert.deepEqual(doc, { sourceFile: 'a.md', chunkCount: 3, firstSection: 'Intro', tags: ['t'] });
    assert.ok(!Object.keys(doc).some(k => k.includes('_')));
  });

  it('toSkeletonNode maps a nav payload to camelCase, null passthrough', () => {
    assert.equal(toSkeletonNode(null), null);
    const node = toSkeletonNode({
      node_type: 'section', node_id: 'n1', node_path: 'a.md#Intro', parent_id: 'p1',
      summary: 'sum', heading_path: ['Intro'], source_file: 'a.md',
      children: ['c1', 'c2'], inventory: { tables: 1 }, key_topics: ['x'],
    });
    assert.deepEqual(node, {
      nodeType: 'section', nodeId: 'n1', nodePath: 'a.md#Intro', parentId: 'p1',
      summary: 'sum', headingPath: ['Intro'], sourceFile: 'a.md',
      childCount: 2, children: ['c1', 'c2'], inventory: { tables: 1 }, keyTopics: ['x'],
    });
    assert.ok(!Object.keys(node).some(k => k.includes('_')));
  });

  it('toContentNodeChunk maps a content-node payload and prefers raw_content for text', () => {
    const chunk = toContentNodeChunk({
      source_file: 'a.md', chunk_index: 4, section: 'Setup',
      raw_content: '| a | b |', node_type: 'table', node_id: 'n1', node_path: 'a.md#Setup/table-1',
    });
    assert.equal(chunk.text, '| a | b |');
    assert.equal(chunk.rawContent, '| a | b |');
    assert.equal(chunk.sourceFile, 'a.md');
    assert.ok(!Object.keys(chunk).some(k => k.includes('_')));
  });

  it('toContentNodeChunk maps lang for a code_block content node, null when absent', () => {
    const withLang = toContentNodeChunk({
      source_file: 'a.md', raw_content: "print('hi')", lang: 'python',
      node_type: 'code_block', node_id: 'n2', node_path: 'a.md#Setup/code-1',
    });
    assert.equal(withLang.lang, 'python');

    const withoutLang = toContentNodeChunk({
      source_file: 'a.md', raw_content: "print('hi')",
      node_type: 'code_block', node_id: 'n3', node_path: 'a.md#Setup/code-2',
    });
    assert.equal(withoutLang.lang, null);
  });

  it('toContentNodeChunk keeps text and rawContent as distinct fields, both null when payload has neither', () => {
    const chunk = toContentNodeChunk({ source_file: 'a.md', node_type: 'table', node_id: 'n4', node_path: 'a.md#x' });
    assert.equal(chunk.text, null);
    assert.equal(chunk.rawContent, null);
  });

  it('toContentNodeChunk returns null for a missing node', () => {
    assert.equal(toContentNodeChunk(null), null);
  });

  // Phase 3X: getContentNode() (renamed from getStructuralNode — the
  // underlying store primitives never filtered by node_type, only by
  // point_kind !== 'skeleton_nav', so the old name wrongly implied
  // structural-only) must resolve prose nodes exactly like structural ones,
  // and must carry parentId — the field qdrant_get_content's anchor
  // resolution uses to find the anchor's containing section.
  it('toContentNodeChunk resolves a PROSE (paragraph) content node — not structural-only, despite the old name', () => {
    const chunk = toContentNodeChunk({
      source_file: 'a.md', chunk_index: 0, section: 'Setup', text: 'Some prose.',
      node_type: 'paragraph', node_id: 'p0', node_path: 'a.md#setup/paragraph-0', parent_id: 'sec-1',
    });
    assert.equal(chunk.nodeType, 'paragraph');
    assert.equal(chunk.text, 'Some prose.');
  });

  it('toContentNodeChunk maps parentId and headingPath (Phase 3X: needed to resolve an anchor\'s containing section)', () => {
    const chunk = toContentNodeChunk({
      source_file: 'a.md', node_type: 'table', node_id: 'n1', node_path: 'a.md#x',
      parent_id: 'sec-1', heading_path: ['Setup', 'Details'],
    });
    assert.equal(chunk.parentId, 'sec-1');
    assert.deepEqual(chunk.headingPath, ['Setup', 'Details']);
    assert.ok(!Object.keys(chunk).some(k => k.includes('_')), 'no raw snake_case leaks through');
  });

  it('toContentNodeChunk defaults parentId to null and headingPath to null when absent', () => {
    const chunk = toContentNodeChunk({ source_file: 'a.md', node_type: 'table', node_id: 'n1', node_path: 'a.md#x' });
    assert.equal(chunk.parentId, null);
    assert.equal(chunk.headingPath, null);
  });
});

describe('createQdrantStorageAdapter().getContentNode — StorageAdapter contract (Phase 3X rename)', () => {
  it('the adapter exposes getContentNode, not getStructuralNode', () => {
    assert.ok(REQUIRED_ADAPTER_METHODS.includes('getContentNode'));
    assert.ok(!REQUIRED_ADAPTER_METHODS.includes('getStructuralNode'), 'no compatibility alias left behind — no real external consumer required one');
    const adapter = createQdrantStorageAdapter();
    assert.equal(typeof adapter.getContentNode, 'function');
    assert.equal(typeof adapter.getStructuralNode, 'undefined');
  });
});

describe('createQdrantStorageAdapter().listCollections — provider comes from native metadata, never config.json/env', () => {
  it('is documented to include provider/embeddingProfileState/description, and to derive provider from resolveEmbeddingProfileFromInfo(info), never resolveConfigProvider/env', () => {
    // Fixed after review: listCollections() used to join provider from
    // config.json + current env (resolveConfigProvider), which is exactly
    // the "canonical metadata" rule this whole feature violates — a
    // collection's provider must come from what's actually written to
    // Qdrant, not from a local cache or whatever the caller currently has
    // configured. listCollections() requires a live Qdrant + config.json to
    // invoke end to end; this test locks the *documented* return shape and
    // the source-level guarantee that no env/config fallback path remains.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async listCollections()'), src.indexOf('async getCollection('));
    assert.match(method, /\bprovider\b/, 'the return object must include provider (shorthand or provider:)');
    assert.match(method, /embeddingProfileState:/);
    assert.match(method, /description:/);
    assert.match(method, /resolveEmbeddingProfileFromInfo\(info\)/, 'provider must be derived from the collection\'s own native metadata, INCLUDING the live vector-schema cross-check');
    assert.ok(!/resolveConfigProvider/.test(method), 'must not use the removed config.json/env provider join');
    assert.ok(!/resolveEnvProviders/.test(method), 'must never fall back to current env providers for an existing collection\'s identity');
  });

  it('resolveConfigProvider no longer exists anywhere in the adapter — dead contract removed, not left unused', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    assert.ok(!/resolveConfigProvider/.test(src));
  });
});

describe('createQdrantStorageAdapter().listCollections — behavioral: provider from native metadata via storeOverrides', () => {
  it('reports the profile\'s own provider/model for a collection with a valid native profile, ignoring config.json/env entirely', async () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ provider: 'ollama', model: 'mxbai-embed-large' }), sparse: validSparseLane({ provider: 'hashed-tf' }), embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({
      listCollections: () => ['c1'],
      getCollectionInfo: () => ({
        points_count: 5,
        config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } }, sparse_vectors: { sparse: {} } } },
      }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.listCollections();
    assert.equal(result[0].provider.denseProvider, 'ollama');
    assert.equal(result[0].provider.denseModel, 'mxbai-embed-large');
    assert.equal(result[0].provider.sparseProvider, 'hashed-tf');
    assert.equal(result[0].embeddingProfileState, 'valid');
  });

  it('reports null provider fields (never a guessed env/config value) for a collection with no valid native profile yet', async () => {
    const fake = makeFakeStore({
      listCollections: () => ['legacy-c'],
      getCollectionInfo: () => ({ points_count: 0, config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.listCollections();
    assert.deepEqual(result[0].provider, { denseProvider: null, denseModel: null, sparseProvider: null });
    assert.equal(result[0].embeddingProfileState, 'missing');
  });

  it('reports null provider fields and embeddingProfileState: "schema_mismatch" (never "valid") for a shape-valid profile that disagrees with the live vector schema', async () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024 }), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({
      listCollections: () => ['mismatched-c'],
      getCollectionInfo: () => ({
        points_count: 3,
        config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile }, params: { vectors: { dense: { size: 768, distance: 'Cosine' } } } },
      }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.listCollections();
    assert.deepEqual(result[0].provider, { denseProvider: null, denseModel: null, sparseProvider: null });
    assert.equal(result[0].embeddingProfileState, 'schema_mismatch');
    assert.notEqual(result[0].embeddingProfileState, 'valid');
  });
});

describe('createQdrantStorageAdapter().getCollection — description is read from config, not hardcoded null', () => {
  it('joins config.collections[name].description the same way listCollections() does', () => {
    // Regression test: getCollection() used to hardcode `description: null`
    // even though listCollections() (same file) already correctly read it
    // from config — silently breaking any collection description from ever
    // reaching the admin UI's collection header. Source-string check, same
    // rationale as the listCollections() test above (needs live Qdrant +
    // config.json to exercise end to end).
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /const config = loadConfig\(\)/);
    assert.match(method, /config\.collections\?\.\[name\]/);
    assert.match(method, /description:\s*col\?\.description \|\| null/);
    assert.ok(!/description:\s*null,/.test(method), 'description must not be hardcoded to null anymore');
  });
});

describe('createQdrantStorageAdapter().getCollection — provider payload fallback only applies to a genuine "missing" (legacy) profile', () => {
  it('never falls back to the raw sample payload for "invalid" or "schema_mismatch" — those report provider: null/null/null like listCollections()', () => {
    // Fixed after review: `provider` used to fall back to samplePayload for
    // EVERY non-'valid' embeddingProfile.state, including 'invalid' and
    // 'schema_mismatch' — states where a profile DOES exist but is
    // corrupted or disagrees with the live vector schema. Falling back to
    // payload there would show a plausible-but-no-longer-canonical model,
    // contradicting listCollections() (which already correctly reports
    // null for the same states). Source-string check, same rationale as
    // this file's other getCollection() regression tests (needs live
    // Qdrant to exercise end to end).
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /embeddingProfile\.state === 'valid'\s*\n\s*\?\s*\{[\s\S]*?\}\s*\n\s*:\s*embeddingProfile\.state === 'missing'/, 'the provider ternary must branch on \'missing\' specifically, not a blanket else');
    assert.match(method, /legacyDetectedProvider/, 'the raw payload hint must be exposed as a distinctly-named field, never silently folded into provider');
    // The final else-branch (anything that's neither 'valid' nor 'missing')
    // must produce the same null/null/null shape listCollections() uses.
    const providerBlock = method.slice(method.indexOf('const provider ='), method.indexOf('legacyDetectedProvider:'));
    assert.match(providerBlock, /:\s*\{\s*denseProvider:\s*null,\s*denseModel:\s*null,\s*sparseProvider:\s*null\s*\}\s*;/);
  });

  it('the embeddingSchema version has the same "missing"-only fallback, never trusting payload for invalid/schema_mismatch', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    const versionsBlock = method.slice(method.indexOf('versions: {'), method.indexOf('chunkingSchema:'));
    assert.match(versionsBlock, /embeddingProfile\.state === 'valid'/);
    assert.match(versionsBlock, /embeddingProfile\.state === 'missing'/);
  });
});

describe('createQdrantStorageAdapter().getCollection — overviewSummary reads the skeleton root summary (Phase 3G)', () => {
  it('reuses the same skeleton-root lookup as hasSkeleton, and only surfaces summary_kind === collection_overview', () => {
    // Phase 3G: the admin UI header prefers a skeleton-generated overview
    // over the config-level description (see collection-view.js). Fetching
    // the skeleton root once and reusing it for both hasSkeleton and
    // overviewSummary (rather than two separate calls) keeps this from
    // doubling getCollection()'s network round-trips.
    //
    // Code-review fix: the root's `summary` field is not always a real
    // overview — skeleton-summary.js also stamps summary_kind: 'inventory'
    // for a plain "N files" fallback with no narrative content. Gating on
    // summary_kind === 'collection_overview' stops an inventory fallback
    // from shadowing a real config description with worse text. Source-
    // string check, same rationale as the description regression test above.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /const skeletonRoot = await store\.getCollectionSkeletonNode\(name\)/);
    assert.match(method, /skeletonRoot\?\.summary_kind === 'collection_overview'/);
    assert.match(method, /hasSkeleton:\s*Boolean\(skeletonRoot\)/);
    const callCount = (method.match(/getCollectionSkeletonNode\(/g) ?? []).length;
    assert.equal(callCount, 1, 'getCollectionSkeletonNode must be called once and reused for both overviewSummary and hasSkeleton');
  });
});

describe('createQdrantStorageAdapter().getCollection — chunkCount is a nav-excluded exact count, not the raw Qdrant total (Phase 3G)', () => {
  it('calls store.countContentPoints (not info.points_count) for chunkCount', () => {
    // Code-review fix: info.points_count is Qdrant's raw total and includes
    // skeleton_nav points on any collection with skeleton navigation on —
    // labeling that "N chunks" in the admin UI would overstate real content.
    // chunkCount must come from a nav-excluded server-side count instead.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /const chunkCount = await store\.countContentPoints\(name\)/);
    assert.match(method, /chunkCount,/);
    assert.match(method, /pointCount:\s*info\.points_count \?\? 0/, 'pointCount must stay the raw Qdrant total (used by the technical Details panel)');
  });
});

describe('createQdrantStorageAdapter().getFileChunks — a distinct primitive from windowed getChunk()', () => {
  it('calls store.getFileChunks (not store.fetchWindowChunks) and maps every point through toChunk', () => {
    // Phase 3F: the admin UI's file view needs "every chunk for this file,
    // in order" as its own primitive, not an approximation built by
    // windowing getChunk() around chunk 0. Source-string check for the same
    // reason as the description regression test above — the real call
    // needs a live Qdrant to exercise end to end.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getFileChunks('), src.indexOf('async searchHybridVectors('));
    assert.ok(method, 'getFileChunks must be defined');
    assert.match(method, /store\.getFileChunks\(/);
    assert.match(method, /\.map\(toChunk\)/);
    assert.ok(!/fetchWindowChunks/.test(method), 'getFileChunks must not go through the windowed fetchWindowChunks path');
  });
});

// ── Embedding profile: pure Qdrant-shape-reading functions ─────────────────

function validDenseLane(overrides = {}) {
  return { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client', ...overrides };
}
function validSparseLane(overrides = {}) {
  return { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'sparse', execution: 'client', ...overrides };
}
function namedVectorsInfo({ dimensions = 1024, distance = 'Cosine', sparse = true, modifier = null } = {}) {
  return {
    config: {
      params: {
        vectors: { dense: { size: dimensions, distance } },
        ...(sparse ? { sparse_vectors: { sparse: { modifier } } } : {}),
      },
      metadata: {},
    },
  };
}

describe('normalizeVectorSchema — Qdrant vector schema -> domain summary', () => {
  it('maps a named dense+sparse schema to { dense, sparse }', () => {
    const result = normalizeVectorSchema(namedVectorsInfo());
    assert.deepEqual(result, { dense: { name: 'dense', dimensions: 1024, distance: 'Cosine' }, sparse: { name: 'sparse', modifier: null } });
  });

  it('reports sparse: null when no sparse_vectors key is present', () => {
    const result = normalizeVectorSchema(namedVectorsInfo({ sparse: false }));
    assert.equal(result.sparse, null);
  });

  it('reports a configured modifier (e.g. idf)', () => {
    const result = normalizeVectorSchema(namedVectorsInfo({ modifier: 'idf' }));
    assert.equal(result.sparse.modifier, 'idf');
  });

  it('reports dense: null for an empty/unrecognized vector schema', () => {
    const result = normalizeVectorSchema({ config: { params: { vectors: {} } } });
    assert.equal(result.dense, null);
  });

  it('handles a flat (legacy, unnamed) vector schema for dense', () => {
    const info = { config: { params: { vectors: { size: 768, distance: 'Cosine' } } } };
    const result = normalizeVectorSchema(info);
    assert.deepEqual(result.dense, { name: 'dense', dimensions: 768, distance: 'Cosine' });
  });

  it('handles a missing collectionInfo entirely without throwing', () => {
    assert.deepEqual(normalizeVectorSchema(undefined), { dense: null, sparse: null });
  });
});

describe('extractEmbeddingProfile', () => {
  it('returns { state: "missing" } when no metadata key is present', () => {
    const info = { config: { metadata: {} } };
    assert.deepEqual(extractEmbeddingProfile(info), { state: 'missing' });
  });

  it('returns { state: "missing" } when config.metadata itself is absent', () => {
    const info = { config: {} };
    assert.deepEqual(extractEmbeddingProfile(info), { state: 'missing' });
  });

  it('returns { state: "valid", profile } for a structurally valid profile', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane(), embeddingSchemaVersion: 2 });
    const info = { config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile } } };
    const result = extractEmbeddingProfile(info);
    assert.equal(result.state, 'valid');
    assert.deepEqual(result.profile, profile);
  });

  it('returns { state: "invalid", errors } for a structurally broken profile', () => {
    const info = { config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: { schemaVersion: 1, managedBy: 'semidex', embedding: { dense: 'not-an-object' }, embeddingSchemaVersion: 2 } } } };
    const result = extractEmbeddingProfile(info);
    assert.equal(result.state, 'invalid');
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  });

  it('returns { state: "unsupported_schema_version", found } for a newer schemaVersion, distinct from a generic invalid', () => {
    const info = { config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: { schemaVersion: 99, managedBy: 'semidex', embedding: { dense: validDenseLane(), sparse: null }, embeddingSchemaVersion: 2 } } } };
    const result = extractEmbeddingProfile(info);
    assert.equal(result.state, 'unsupported_schema_version');
    assert.equal(result.found, 99);
  });

  it('never sees a CollectionInfo shape leak into the returned profile — profile is exactly the validated domain object', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    const info = { config: { params: { vectors: { dense: { size: 1024 } } } }, metadata: 'should-not-be-read-from-top-level' };
    info.config.metadata = { [METADATA_KEY_EMBEDDING_PROFILE]: profile };
    const result = extractEmbeddingProfile(info);
    assert.equal(result.state, 'valid');
    assert.ok(!('config' in result.profile));
  });
});

describe('extractIndexingState', () => {
  it('returns { state: "missing" } when no metadata key is present', () => {
    assert.deepEqual(extractIndexingState({ config: { metadata: {} } }), { state: 'missing' });
  });

  it('returns { state: "valid", indexingState } for a valid state', () => {
    const state = { indexingSchemaVersion: 4, chunkingSchemaVersion: 4 };
    const info = { config: { metadata: { semidex_indexing_state: state } } };
    const result = extractIndexingState(info);
    assert.equal(result.state, 'valid');
    assert.deepEqual(result.indexingState, state);
  });

  it('returns { state: "invalid" } for a broken state', () => {
    const info = { config: { metadata: { semidex_indexing_state: { indexingSchemaVersion: 'four' } } } };
    assert.equal(extractIndexingState(info).state, 'invalid');
  });
});

describe('validateProfileAgainstSchema', () => {
  it('matches when the profile agrees with the live schema exactly', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane(), embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo());
    assert.deepEqual(result, { matches: true });
  });

  it('reports a dense dimension mismatch', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 768 }), sparse: null, embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ sparse: false }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'dense.dimensions'));
  });

  it('reports a dense vector name mismatch', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ vectorName: 'wrong-name' }), sparse: null, embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ sparse: false }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'dense.vectorName'));
  });

  it('reports a dense distance mismatch', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ distance: 'Dot' }), sparse: null, embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ sparse: false }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'dense.distance'));
  });

  it('reports a sparse-presence mismatch: profile declares sparse but live schema has none', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane(), embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ sparse: false }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'sparse'));
  });

  it('reports a sparse-presence mismatch: profile declares no sparse but live schema has one', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ sparse: true }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'sparse'));
  });

  it('reports a sparse modifier mismatch', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane({ modifier: 'idf' }), embeddingSchemaVersion: 2 });
    const result = validateProfileAgainstSchema(profile, namedVectorsInfo({ modifier: null }));
    assert.equal(result.matches, false);
    assert.ok(result.mismatches.some(m => m.field === 'sparse.modifier'));
  });
});

describe('decideProfileWrite — pure write-guard decision', () => {
  it('allows a write only when current state is "missing"', () => {
    assert.equal(decideProfileWrite('missing'), 'write');
  });

  it('rejects when current state is "valid"', () => {
    assert.equal(decideProfileWrite('valid'), 'reject');
  });

  it('rejects when current state is "invalid"', () => {
    assert.equal(decideProfileWrite('invalid'), 'reject');
  });

  it('rejects when current state is "unsupported_schema_version"', () => {
    assert.equal(decideProfileWrite('unsupported_schema_version'), 'reject');
  });
});

// ── Embedding profile: adapter methods via the storeOverrides DI seam ──────

function makeFakeStore(overrides = {}) {
  const calls = { getCollectionInfo: 0, updateCollectionMetadata: 0, createCollection: 0, scrollFilteredPages: 0, listCollections: 0 };
  return {
    calls,
    storeOverrides: {
      getCollectionInfo: async (name) => { calls.getCollectionInfo++; return overrides.getCollectionInfo ? overrides.getCollectionInfo(name) : namedVectorsInfo(); },
      updateCollectionMetadata: async (name, metadata) => { calls.updateCollectionMetadata++; if (overrides.updateCollectionMetadata) return overrides.updateCollectionMetadata(name, metadata); },
      createCollection: async (name, size, metadata, vectorSchema) => { calls.createCollection++; if (overrides.createCollection) return overrides.createCollection(name, size, metadata, vectorSchema); },
      scrollFilteredPages: async (name, filter, fields, opts) => { calls.scrollFilteredPages++; if (overrides.scrollFilteredPages) return overrides.scrollFilteredPages(name, filter, fields, opts); },
      listCollections: async () => { calls.listCollections++; return overrides.listCollections ? overrides.listCollections() : []; },
    },
  };
}

describe('createQdrantStorageAdapter().getEmbeddingProfile', () => {
  it('returns { state: "missing" } for a collection with no metadata, and caches the result', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {} } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.getEmbeddingProfile('c1');
    assert.deepEqual(result, { state: 'missing' });
    await adapter.getEmbeddingProfile('c1');
    assert.equal(fake.calls.getCollectionInfo, 1, 'second call within TTL must hit the cache, not fetch again');
  });

  it('returns { state: "valid", profile } for a collection with a valid profile', async () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.getEmbeddingProfile('c1');
    assert.equal(result.state, 'valid');
    assert.deepEqual(result.profile, profile);
  });

  it('returns { state: "schema_mismatch" }, never "valid", when a shape-valid profile disagrees with the live vector schema (dimension mismatch)', async () => {
    // Fixed after review: extractEmbeddingProfile() alone only checks
    // metadata SHAPE, never whether it agrees with the collection's REAL
    // vector schema — that check used to run only at write time
    // (setEmbeddingProfile), so a read (search/Ask/MCP/Admin) would trust
    // corrupted/tampered/third-party-written metadata as 'valid' and only
    // fail later on a real embedding/Qdrant request. This proves the
    // canonical read path (getEmbeddingProfile) now catches it.
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024 }), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({
      getCollectionInfo: () => ({
        config: {
          metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile },
          // Live schema disagrees: 768, not the 1024 the profile declares.
          params: { vectors: { dense: { size: 768, distance: 'Cosine' } } },
        },
      }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.getEmbeddingProfile('c1');
    assert.equal(result.state, 'schema_mismatch');
    assert.notEqual(result.state, 'valid');
    assert.ok(Array.isArray(result.mismatches) && result.mismatches.length > 0);
    assert.ok(result.mismatches.some(m => m.field === 'dense.dimensions'));
  });

  it('returns { state: "schema_mismatch" } for a sparse-presence disagreement (profile declares sparse, live schema has none)', async () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane(), embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({
      getCollectionInfo: () => ({
        config: {
          metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile },
          params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } }, // no sparse_vectors key
        },
      }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.getEmbeddingProfile('c1');
    assert.equal(result.state, 'schema_mismatch');
    assert.ok(result.mismatches.some(m => m.field === 'sparse'));
  });

  it('caches the schema_mismatch result the same way as any other state (one getCollectionInfo call within TTL)', async () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024 }), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({
      getCollectionInfo: () => ({
        config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile }, params: { vectors: { dense: { size: 768, distance: 'Cosine' } } } },
      }),
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    await adapter.getEmbeddingProfile('c1');
    await adapter.getEmbeddingProfile('c1');
    assert.equal(fake.calls.getCollectionInfo, 1);
  });
});

describe('createQdrantStorageAdapter().setEmbeddingProfile — write-once guard', () => {
  it('writes when current state is missing', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    await adapter.setEmbeddingProfile('c1', profile);
    assert.equal(fake.calls.updateCollectionMetadata, 1);
  });

  it('throws and never writes when current state is "valid"', async () => {
    const existingProfile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: existingProfile }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const newProfile = buildEmbeddingProfile({ dense: validDenseLane({ model: 'different-model' }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', newProfile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('throws and never writes when current state is "invalid"', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: { schemaVersion: 1, embedding: {} } }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('throws and never writes when current state is "unsupported_schema_version"', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: { schemaVersion: 99, managedBy: 'semidex', embedding: { dense: validDenseLane(), sparse: null }, embeddingSchemaVersion: 2 } }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('rejects a schema-mismatched profile (dense dimension mismatch) before any write', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 768 }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('rejects a schema-mismatched profile (dense vector name mismatch) before any write', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ vectorName: 'wrong' }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('rejects a schema-mismatched profile (dense distance mismatch) before any write', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ distance: 'Dot' }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('rejects a schema-mismatched profile (sparse presence mismatch) before any write', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane(), embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('rejects a schema-mismatched profile (sparse modifier mismatch) before any write', async () => {
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' }, }, sparse_vectors: { sparse: { modifier: null } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane({ modifier: 'idf' }), embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.setEmbeddingProfile('c1', profile));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('writes under METADATA_KEY_EMBEDDING_PROFILE and invalidates the cache on success', async () => {
    let written;
    const fake = makeFakeStore({
      getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }),
      updateCollectionMetadata: (name, metadata) => { written = metadata; },
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    await adapter.setEmbeddingProfile('c1', profile);
    assert.ok(METADATA_KEY_EMBEDDING_PROFILE in written);
    assert.deepEqual(written[METADATA_KEY_EMBEDDING_PROFILE], profile);
  });
});

describe('createQdrantStorageAdapter().setIndexingState', () => {
  it('writes under the indexing-state key, never touching the embedding profile key', async () => {
    let written;
    const fake = makeFakeStore({ updateCollectionMetadata: (name, metadata) => { written = metadata; } });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    await adapter.setIndexingState('c1', { indexingSchemaVersion: 4, chunkingSchemaVersion: 4 });
    assert.ok('semidex_indexing_state' in written);
    assert.ok(!(METADATA_KEY_EMBEDDING_PROFILE in written));
  });

  it('rejects an invalid state before writing', async () => {
    const fake = makeFakeStore();
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    await assert.rejects(() => adapter.setIndexingState('c1', { indexingSchemaVersion: 'bad' }));
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });
});

describe('buildQdrantVectorSchemaFromProfile — the FULL Qdrant vector schema is derived from the profile, never a hardcoded default', () => {
  // Fixed after review: createCollection() used to always create Cosine +
  // an unconditional sparse vector with no modifier, regardless of what the
  // profile actually declared — a valid profile with sparse: null, a
  // non-Cosine distance, or a sparse modifier would immediately create a
  // collection that disagreed with its own just-written profile (and would
  // then correctly report schema_mismatch on the very next read).

  it('builds { vectors: { dense: { size, distance } } } with no sparse_vectors key when profile.embedding.sparse is null', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 768, distance: 'Dot' }), sparse: null, embeddingSchemaVersion: 2 });
    const schema = buildQdrantVectorSchemaFromProfile(profile);
    assert.deepEqual(schema, { vectors: { dense: { size: 768, distance: 'Dot' } } });
    assert.ok(!('sparse_vectors' in schema), 'a dense-only profile must never get an unconditional sparse vector created');
  });

  it('honors a non-Cosine dense distance', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ distance: 'Euclid' }), sparse: null, embeddingSchemaVersion: 2 });
    const schema = buildQdrantVectorSchemaFromProfile(profile);
    assert.equal(schema.vectors.dense.distance, 'Euclid');
  });

  it('creates sparse_vectors when profile.embedding.sparse is present, with no modifier key when modifier is null', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane({ modifier: null }), embeddingSchemaVersion: 2 });
    const schema = buildQdrantVectorSchemaFromProfile(profile);
    assert.deepEqual(schema.sparse_vectors, { sparse: { index: { on_disk: false } } });
    assert.ok(!('modifier' in schema.sparse_vectors.sparse), 'no modifier key at all when the profile declares none — must not send modifier: null to Qdrant');
  });

  it('applies the sparse modifier when the profile declares one (e.g. "idf")', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane({ modifier: 'idf' }), embeddingSchemaVersion: 2 });
    const schema = buildQdrantVectorSchemaFromProfile(profile);
    assert.equal(schema.sparse_vectors.sparse.modifier, 'idf');
  });

  it('throws before any network call for an unsupported dense vectorName (nothing else in this codebase can use it)', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ vectorName: 'my_custom_dense' }), sparse: null, embeddingSchemaVersion: 2 });
    assert.throws(() => buildQdrantVectorSchemaFromProfile(profile), /unsupported dense vectorName/);
  });

  it('throws before any network call for an unsupported sparse vectorName', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: validSparseLane({ vectorName: 'my_custom_sparse' }), embeddingSchemaVersion: 2 });
    assert.throws(() => buildQdrantVectorSchemaFromProfile(profile), /unsupported sparse vectorName/);
  });

  it('throws before any network call for a distance value Qdrant does not support', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ distance: 'NotARealDistance' }), sparse: null, embeddingSchemaVersion: 2 });
    assert.throws(() => buildQdrantVectorSchemaFromProfile(profile), /unsupported dense distance/);
  });

  it('a real qdrant-cloud E5+BM25 profile (384d Cosine dense, sparse with modifier: idf) needs ZERO code changes here — the existing execution-agnostic function already generalizes', () => {
    const profile = buildEmbeddingProfile({
      dense: {
        provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense',
        dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud',
      },
      sparse: {
        provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse',
        execution: 'qdrant-cloud', modifier: 'idf',
      },
      embeddingSchemaVersion: 2,
    });
    const schema = buildQdrantVectorSchemaFromProfile(profile);
    assert.deepEqual(schema, {
      vectors: { dense: { size: 384, distance: 'Cosine' } },
      sparse_vectors: { sparse: { index: { on_disk: false }, modifier: 'idf' } },
    });
  });
});

describe('createQdrantStorageAdapter().createCollection — metadata wiring and dimension guard', () => {
  it('passes metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: profile } through to store.createCollection when profile is given', async () => {
    let capturedMetadata;
    let capturedSize;
    const fake = makeFakeStore({ createCollection: (name, size, metadata) => { capturedSize = size; capturedMetadata = metadata; } });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024 }), sparse: null, embeddingSchemaVersion: 2 });
    await adapter.createCollection('c1', { profile });
    assert.equal(capturedSize, 1024, 'vectorSize must be derived from profile.embedding.dense.dimensions');
    assert.deepEqual(capturedMetadata, { [METADATA_KEY_EMBEDDING_PROFILE]: profile });
  });

  it('passes the FULL profile-derived vector schema through to store.createCollection as the 4th argument, not just a bare size', async () => {
    let capturedVectorSchema;
    const fake = makeFakeStore({ createCollection: (name, size, metadata, vectorSchema) => { capturedVectorSchema = vectorSchema; } });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024, distance: 'Dot' }), sparse: validSparseLane({ modifier: 'idf' }), embeddingSchemaVersion: 2 });
    await adapter.createCollection('c1', { profile });
    assert.deepEqual(capturedVectorSchema, {
      vectors: { dense: { size: 1024, distance: 'Dot' } },
      sparse_vectors: { sparse: { index: { on_disk: false }, modifier: 'idf' } },
    });
  });

  it('rejects an unsupported profile (e.g. unsupported dense vectorName) before any network call', async () => {
    const fake = makeFakeStore();
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ vectorName: 'my_custom_dense' }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.createCollection('c1', { profile }));
    assert.equal(fake.calls.createCollection, 0);
  });

  it('throws before any network call when vectorSize disagrees with profile.embedding.dense.dimensions', async () => {
    const fake = makeFakeStore();
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const profile = buildEmbeddingProfile({ dense: validDenseLane({ dimensions: 1024 }), sparse: null, embeddingSchemaVersion: 2 });
    await assert.rejects(() => adapter.createCollection('c1', { vectorSize: 768, profile }));
    assert.equal(fake.calls.createCollection, 0);
  });

  it('throws before any network call for a bare { vectorSize } call with no profile — there is no metadata-less creation path', async () => {
    // Fixed after review: an earlier draft allowed creating a collection
    // with no embedding profile at all when profile was omitted, which
    // contradicts the whole point of this feature — every real caller
    // (indexer's run.js, benchmarks' resolveBenchProfile()) already always
    // passes profile, so this path was pure unused foot-gun surface.
    const fake = makeFakeStore();
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    await assert.rejects(() => adapter.createCollection('c1', { vectorSize: 1024 }));
    assert.equal(fake.calls.createCollection, 0);
  });

  it('throws before any network call when createCollection is called with no arguments at all', async () => {
    const fake = makeFakeStore();
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    await assert.rejects(() => adapter.createCollection('c1'));
    assert.equal(fake.calls.createCollection, 0);
  });
});

describe('createQdrantStorageAdapter().migrateEmbeddingProfile', () => {
  it('is idempotent: a no-op returning already_migrated when current state is already valid, without scrolling', async () => {
    const existingProfile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    const fake = makeFakeStore({ getCollectionInfo: () => ({ config: { metadata: { [METADATA_KEY_EMBEDDING_PROFILE]: existingProfile }, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } } } } }) });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.migrateEmbeddingProfile('c1');
    assert.deepEqual(result, { status: 'already_migrated' });
    assert.equal(fake.calls.scrollFilteredPages, 0, 'must not scroll once a valid profile already exists');
    assert.equal(fake.calls.updateCollectionMetadata, 0);
  });

  it('infers and writes a profile from a consistent legacy payload sample', async () => {
    const fake = makeFakeStore({
      getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } }, sparse_vectors: { sparse: { modifier: null } } } } }),
      scrollFilteredPages: async (name, filter, fields, opts) => {
        await opts.onPage([
          { source_file: 'a.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 },
          { source_file: 'b.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 },
        ]);
      },
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.migrateEmbeddingProfile('c1');
    assert.equal(result.status, 'inferred');
    assert.equal(fake.calls.updateCollectionMetadata, 1);
  });

  it('infers correctly when onPage receives REAL Qdrant point objects ({ id, payload }), not bare payloads — live-cluster regression guard', async () => {
    // Live-verification finding: store.js's real scrollFilteredPages() hands
    // onPage actual Qdrant scroll results (each item is { id, payload, ... }),
    // never a bare payload object. The test above (and this file's other
    // migrateEmbeddingProfile fixtures) call onPage with bare payloads
    // directly, which masked a real bug where migrateEmbeddingProfile()
    // folded the raw point object instead of point.payload and always
    // inferred null identity fields against a live cluster. This test uses
    // the REALISTIC { id, payload } shape to guard against that regression.
    const fake = makeFakeStore({
      getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } }, sparse_vectors: { sparse: { modifier: null } } } } }),
      scrollFilteredPages: async (name, filter, fields, opts) => {
        await opts.onPage([
          { id: 1, payload: { source_file: 'a.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 } },
          { id: 2, payload: { source_file: 'b.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 } },
        ]);
      },
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.migrateEmbeddingProfile('c1');
    assert.equal(result.status, 'inferred', `expected 'inferred', got ${JSON.stringify(result)}`);
    assert.equal(result.profile.embedding.dense.provider, 'bge-m3-onnx');
    assert.equal(fake.calls.updateCollectionMetadata, 1);
  });

  it('stops paginating after the page containing the first disagreement (real early-exit, not exhaustive)', async () => {
    let pagesRequested = 0;
    const fake = makeFakeStore({
      getCollectionInfo: () => ({ config: { metadata: {}, params: { vectors: { dense: { size: 1024, distance: 'Cosine' } }, sparse_vectors: { sparse: { modifier: null } } } } }),
      scrollFilteredPages: async (name, filter, fields, opts) => {
        // Page 1 itself contains a disagreement (two payloads that
        // disagree with each other) — onPage's own return value must
        // reflect that immediately, before this fake ever offers a
        // second page, exercising the real early-exit contract.
        pagesRequested++;
        const keepGoing = await opts.onPage([
          { source_file: 'a.md', dense_provider: 'ollama', dense_model: 'bge-m3', sparse_provider: 'hashed-tf', embedding_schema_version: 2, vector_size: 1024 },
          { source_file: 'b.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 },
        ]);
        if (keepGoing === false) return;
        pagesRequested++;
        await opts.onPage([
          { source_file: 'c.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx', sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024 },
        ]);
      },
    });
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake.storeOverrides });
    const result = await adapter.migrateEmbeddingProfile('c1');
    assert.equal(result.status, 'ambiguous');
    assert.equal(pagesRequested, 1, 'a second page must never be requested once the first page disagreed');
  });

  it('never rewrites point payloads', async () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async migrateEmbeddingProfile('), src.indexOf('async listSourceDocuments('));
    assert.ok(!/updatePayload|upsertPoints/.test(method), 'migrateEmbeddingProfile must never call point-level write primitives');
  });
});

describe('embeddingProfileResultToResolveResult — Part B -> Part C shape bridge for getCollection()\'s availability wiring', () => {
  it('maps { state: "valid", profile } to { resolved: true, profile }', () => {
    const profile = buildEmbeddingProfile({ dense: validDenseLane(), sparse: null, embeddingSchemaVersion: 2 });
    assert.deepEqual(
      embeddingProfileResultToResolveResult({ state: 'valid', profile }),
      { resolved: true, profile },
    );
  });

  it('maps { state: "missing" } to { resolved: false, reason: "legacy_unmigrated" }', () => {
    assert.deepEqual(
      embeddingProfileResultToResolveResult({ state: 'missing' }),
      { resolved: false, reason: 'legacy_unmigrated' },
    );
  });

  it('maps { state: "invalid" } to { resolved: false, reason: "invalid" }, passing the state through as-is', () => {
    assert.deepEqual(
      embeddingProfileResultToResolveResult({ state: 'invalid', errors: ['bad'] }),
      { resolved: false, reason: 'invalid' },
    );
  });

  it('maps { state: "unsupported_schema_version" } to { resolved: false, reason: "unsupported_schema_version" }', () => {
    assert.deepEqual(
      embeddingProfileResultToResolveResult({ state: 'unsupported_schema_version', found: { schemaVersion: 99 } }),
      { resolved: false, reason: 'unsupported_schema_version' },
    );
  });
});

describe('createQdrantStorageAdapter().getCollection — availability wiring (Part F)', () => {
  it('accepts an optional second { checkOllamaLane, checkOnnxModelCached } argument, defaulting checkOnnxModelCached to the safe core-only onnx-lane.js implementation', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /async getCollection\(name, \{ checkOllamaLane, checkOnnxModelCached = defaultCheckOnnxModelCached, checkQdrantReachable = s\.checkQdrantReachable \} = \{\}\)/);
  });

  it('computes availability via embeddingProfileResultToResolveResult() + resolveAvailability(), reusing the SAME embeddingProfile already extracted (no second profile resolution)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /embeddingProfileResultToResolveResult\(embeddingProfile\)/);
    assert.match(method, /resolveAvailability\(availabilityResolveResult, \{ checkOllamaLane, checkOnnxModelCached, checkQdrantReachable \}\)/);
    assert.match(method, /availability,/, 'the returned object must include an availability field');
  });

  it('catches a missing-checkOllamaLane throw and degrades to COLLECTION_STATUS.UNKNOWN_DEPENDENCIES rather than propagating, so existing single-argument getCollection(name) callers never break', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async getCollection('), src.indexOf('async createCollection('));
    assert.match(method, /try\s*\{\s*availability = await resolveAvailability/);
    assert.match(method, /catch\s*\{/);
    assert.match(method, /status:\s*COLLECTION_STATUS\.UNKNOWN_DEPENDENCIES/);
  });
});

describe('createQdrantStorageAdapter().checkCloudInferenceReachable — Tier 1 delegation', () => {
  it('delegates directly to the injected store.checkQdrantReachable, returning its result unchanged', async () => {
    const fake = { checkQdrantReachable: async () => ({ status: 'ok' }) };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    const result = await adapter.checkCloudInferenceReachable();
    assert.deepEqual(result, { status: 'ok' });
  });
});

describe('createQdrantStorageAdapter().probeInference — provider-neutral capability, builds schema from the profile', () => {
  const cloudProfile = buildEmbeddingProfile({
    dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
    sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
    embeddingSchemaVersion: 2,
  });

  it('returns { status: "unsupported" } for a non-qdrant-cloud profile, WITHOUT calling store.probeInference at all', async () => {
    let called = false;
    const fake = { probeInference: async () => { called = true; return { status: 'inference_available' }; } };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    const clientProfile = buildEmbeddingProfile({
      dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: null,
      embeddingSchemaVersion: 2,
    });
    const result = await adapter.probeInference({ profile: clientProfile });
    assert.equal(result.status, 'unsupported');
    assert.equal(called, false);
  });

  it('builds the vectorSchema from buildQdrantVectorSchemaFromProfile() — never a hand-rolled shape — and passes it through to store.probeInference', async () => {
    let received;
    const fake = { probeInference: async (opts) => { received = opts; return { status: 'inference_available' }; } };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    await adapter.probeInference({ profile: cloudProfile });
    assert.deepEqual(received.vectorSchema, buildQdrantVectorSchemaFromProfile(cloudProfile));
  });

  it('builds denseQuery/sparseQuery as {text, model} descriptors from the profile\'s own model fields, using the default sampleText when none is given', async () => {
    let received;
    const fake = { probeInference: async (opts) => { received = opts; return { status: 'inference_available' }; } };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    await adapter.probeInference({ profile: cloudProfile });
    assert.equal(received.denseQuery.model, 'intfloat/multilingual-e5-small');
    assert.equal(received.sparseQuery.model, 'qdrant/bm25');
    assert.equal(received.denseQuery.text, received.sparseQuery.text, 'both descriptors must use the same sample text');
    assert.ok(!('modifier' in received.denseQuery) && !('options' in received.denseQuery), 'inference descriptors must never carry schema-only fields');
    assert.ok(!('modifier' in received.sparseQuery) && !('options' in received.sparseQuery));
  });

  it('honors a custom sampleText when provided', async () => {
    let received;
    const fake = { probeInference: async (opts) => { received = opts; return { status: 'inference_available' }; } };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    await adapter.probeInference({ profile: cloudProfile, sampleText: 'custom probe text' });
    assert.equal(received.denseQuery.text, 'custom probe text');
  });

  it('sparseQuery is null when the profile has no sparse lane', async () => {
    let received;
    const fake = { probeInference: async (opts) => { received = opts; return { status: 'inference_available' }; } };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    const denseOnlyProfile = buildEmbeddingProfile({
      dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
      sparse: null,
      embeddingSchemaVersion: 2,
    });
    await adapter.probeInference({ profile: denseOnlyProfile });
    assert.equal(received.sparseQuery, null);
  });

  it('returns the store result unchanged (inference_available / inference_disabled_or_model_unavailable pass straight through)', async () => {
    const fake = { probeInference: async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'model not found' }) };
    const adapter = createQdrantStorageAdapter({ storeOverrides: fake });
    const result = await adapter.probeInference({ profile: cloudProfile });
    assert.deepEqual(result, { status: 'inference_disabled_or_model_unavailable', message: 'model not found' });
  });
});
