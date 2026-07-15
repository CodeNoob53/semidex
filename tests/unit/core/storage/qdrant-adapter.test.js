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
  resolveConfigProvider,
} from '../../../../src/core/storage/qdrant-adapter.js';

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
      entityRefs: [], score: 0.87, isMatch: null,
    });
    const keys = Object.keys(chunk);
    assert.ok(!keys.some(k => k.includes('_')), `expected only camelCase keys, got: ${keys.join(', ')}`);
  });

  it('toChunk handles a missing/empty payload without throwing', () => {
    assert.deepEqual(toChunk({}), {
      sourceFile: null, chunkIndex: null, totalChunks: null, section: null,
      text: null, rawContent: null, lang: null, context: null, tags: [],
      nodeType: null, nodeId: null, nodePath: null, parentId: null, headingPath: null,
      entityRefs: [], score: null, isMatch: null,
    });
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

describe('resolveConfigProvider — listCollections() provider join (design doc §6)', () => {
  const envProv = { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf' };

  it('falls back to env-derived providers when config.json has no entry for the collection', () => {
    assert.deepEqual(resolveConfigProvider(undefined, envProv), envProv);
  });

  it('prefers explicit config.json fields over env', () => {
    const col = { denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparseProvider: 'bge-m3-onnx' };
    assert.deepEqual(resolveConfigProvider(col, envProv), col);
  });

  it('infers denseProvider from legacy sparseProvider=bge-m3-onnx when denseProvider is unset', () => {
    const col = { sparseProvider: 'bge-m3-onnx' };
    const result = resolveConfigProvider(col, envProv);
    assert.equal(result.denseProvider, 'bge-m3-onnx');
  });

  it('falls back to legacy embedModel field for denseModel', () => {
    const col = { embedModel: 'legacy-model' };
    const result = resolveConfigProvider(col, envProv);
    assert.equal(result.denseModel, 'legacy-model');
  });
});

describe('createQdrantStorageAdapter().listCollections — return shape includes provider/description', () => {
  it('is documented to include provider and description alongside name/pointCount/vectorSchema', () => {
    // listCollections() requires a live Qdrant + config.json to invoke end to
    // end; this test locks the *documented* return shape (design doc §6:
    // "store.listCollections() + config.js provider metadata, same join
    // mcp/tools/collections.js does today") via the adapter source itself,
    // so a future edit that silently drops the join breaks this test.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    const method = src.slice(src.indexOf('async listCollections()'), src.indexOf('async getCollection('));
    assert.match(method, /provider:/);
    assert.match(method, /description:/);
    assert.match(method, /resolveConfigProvider/);
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
    const method = src.slice(src.indexOf('async getFileChunks('), src.indexOf('async searchHybrid('));
    assert.ok(method, 'getFileChunks must be defined');
    assert.match(method, /store\.getFileChunks\(/);
    assert.match(method, /\.map\(toChunk\)/);
    assert.ok(!/fetchWindowChunks/.test(method), 'getFileChunks must not go through the windowed fetchWindowChunks path');
  });
});
