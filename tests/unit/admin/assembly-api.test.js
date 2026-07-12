// HTTP tests for GET /api/collections/:name/assembly (Phase 3V) — the route
// is a thin shell (validate -> adapter -> core assembly service -> serialize),
// so these tests pin the HTTP contract: parameter validation, 404 envelopes,
// response ordering, fallback warning surfacing, legacy degradation, and
// domain-only (no raw Qdrant) output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeStubAdapter } from './ui-test-helpers.js';

const TABLE_PH = '[table node: guide.md#setup/table-1 — A | B]';

function proseChunk({ chunkIndex, text, entityRefs = [] }) {
  return {
    sourceFile: 'guide.md', chunkIndex, totalChunks: null, section: 'Setup', text,
    rawContent: null, lang: null, context: 'Setup', tags: [],
    nodeType: 'paragraph', nodeId: `nid-p${chunkIndex}`, nodePath: `guide.md#setup/paragraph-${chunkIndex}`,
    parentId: 'nid-section-setup', headingPath: ['Setup'],
    entityRefs, score: null, isMatch: null,
  };
}

function tableChunk({ chunkIndex }) {
  return {
    sourceFile: 'guide.md', chunkIndex, totalChunks: null, section: 'Setup',
    text: '| A | B |', rawContent: '| A | B |', lang: null, context: 'Setup > table', tags: [],
    nodeType: 'table', nodeId: 'nid-table-1', nodePath: 'guide.md#setup/table-1',
    parentId: 'nid-section-setup', headingPath: ['Setup'],
    entityRefs: [], score: null, isMatch: null,
  };
}

const TABLE_REF = { nodeId: 'nid-table-1', nodePath: 'guide.md#setup/table-1', nodeType: 'table', placeholder: TABLE_PH };

async function withApp(adapter, fn, appOpts = {}) {
  const app = createApp({ adapter, embedQuery: async () => ({ dense: [], sparse: {} }), ...appOpts });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function knownCollectionAdapter(overrides = {}) {
  const adapter = makeStubAdapter();
  adapter.getCollection = async (name) => (name === 'my-docs' ? { name: 'my-docs', pointCount: 3 } : null);
  return Object.assign(adapter, overrides);
}

describe('GET /api/collections/:name/assembly — file scope', () => {
  it('valid file request: 200, entity_refs mode, segments in original order, placeholder removed', async () => {
    const adapter = knownCollectionAdapter({
      getFileChunks: async (name, sourceFile) => (sourceFile === 'guide.md'
        ? [proseChunk({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [TABLE_REF] }), tableChunk({ chunkIndex: 1 })]
        : []),
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=file&sourceFile=guide.md`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.collection, 'my-docs');
      assert.equal(body.scope, 'file');
      assert.equal(body.sourceFile, 'guide.md');
      assert.equal(body.nodePath, null);
      assert.equal(body.assemblyMode, 'entity_refs');
      assert.deepEqual(body.warnings, []);
      assert.deepEqual(body.segments.map(s => s.kind), ['prose', 'entity'], 'original chunkIndex order preserved');
      assert.equal(body.segments[0].text, 'Options:');
      assert.equal(body.segments[1].rawContent, '| A | B |');
    });
  });

  it('unknown collection: normal 404 envelope', async () => {
    await withApp(knownCollectionAdapter(), async (base) => {
      const res = await fetch(`${base}/api/collections/nope/assembly?scope=file&sourceFile=guide.md`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'not_found');
    });
  });

  it('unknown file (adapter returns no chunks): 404 envelope', async () => {
    await withApp(knownCollectionAdapter({ getFileChunks: async () => [] }), async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=file&sourceFile=ghost.md`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'not_found');
      assert.match(body.error.message, /ghost\.md/);
    });
  });

  it('legacy plain-chunk response: ordered prose segments, plain_chunks mode, no fabricated entities', async () => {
    const legacy = (chunkIndex, text) => ({
      sourceFile: 'old.md', chunkIndex, totalChunks: 2, section: 'Intro', text,
      rawContent: null, lang: null, context: null, tags: [],
      nodeType: null, nodeId: null, nodePath: null, parentId: null, headingPath: null,
      entityRefs: [], score: null, isMatch: null,
    });
    const adapter = knownCollectionAdapter({ getFileChunks: async () => [legacy(0, 'First.'), legacy(1, 'Second.')] });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=file&sourceFile=old.md`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.assemblyMode, 'plain_chunks');
      assert.deepEqual(body.segments.map(s => [s.kind, s.text]), [['prose', 'First.'], ['prose', 'Second.']]);
      assert.deepEqual(body.warnings, []);
    });
  });

  it('transitional fallback: no stored refs -> placeholder_fallback mode, machine-readable warning, one log line', async () => {
    const logged = [];
    const adapter = knownCollectionAdapter({
      getFileChunks: async () => [
        proseChunk({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [] }),
        tableChunk({ chunkIndex: 1 }),
      ],
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=file&sourceFile=guide.md`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.assemblyMode, 'placeholder_fallback');
      assert.equal(body.warnings[0].code, 'placeholder_fallback');
      assert.equal(body.segments[0].text, 'Options:', 'fallback still assembles deterministically');
      assert.equal(logged.length, 1, 'fallback logged exactly once per request');
    }, { assemblyLogFn: (line) => logged.push(line) });
  });

  it('response contains no vectors and no raw snake_case Qdrant field KEYS anywhere in the JSON', async () => {
    const adapter = knownCollectionAdapter({
      getFileChunks: async () => [
        proseChunk({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [TABLE_REF] }),
        tableChunk({ chunkIndex: 1 }),
      ],
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=file&sourceFile=guide.md`);
      const body = await res.json();
      const keys = new Set();
      (function collect(v) {
        if (Array.isArray(v)) { v.forEach(collect); return; }
        if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v)) { keys.add(k); collect(val); } }
      })(body);
      // Note assemblyMode's VALUE is legitimately the string "entity_refs"
      // (the task's own mode vocabulary) — the backend-neutrality contract is
      // about field KEYS, so that's what is checked.
      for (const forbidden of ['vector', 'vectors', 'dense', 'sparse', 'entity_refs', 'node_id', 'node_path', 'source_file', 'chunk_index', 'point_kind', 'raw_content', 'heading_path', 'parent_id', 'payload']) {
        assert.ok(!keys.has(forbidden), `response must not contain raw field key "${forbidden}"`);
      }
    });
  });
});

describe('GET /api/collections/:name/assembly — section scope', () => {
  const sectionNode = {
    nodeType: 'section', nodeId: 'nid-section-setup', nodePath: 'guide.md#setup',
    parentId: 'nid-file-guide', summary: null, headingPath: ['Setup'], sourceFile: 'guide.md',
    childCount: 0, children: [], inventory: null, keyTopics: null,
  };

  it('valid section request: resolves identity via the skeleton node, assembles that exact section', async () => {
    const seen = { skeleton: [], section: [] };
    const adapter = knownCollectionAdapter({
      getSkeletonNode: async (name, opts) => { seen.skeleton.push(opts); return opts.nodePath === 'guide.md#setup' ? sectionNode : null; },
      getSectionChunks: async (name, opts) => {
        seen.section.push(opts);
        return [proseChunk({ chunkIndex: 3, text: `Options:\n\n${TABLE_PH}`, entityRefs: [TABLE_REF] }), tableChunk({ chunkIndex: 4 })];
      },
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=section&nodePath=${encodeURIComponent('guide.md#setup')}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.scope, 'section');
      assert.equal(body.nodePath, 'guide.md#setup');
      assert.equal(body.sourceFile, 'guide.md', 'sourceFile comes from the skeleton node, not a query param');
      assert.deepEqual(body.segments.map(s => s.kind), ['prose', 'entity']);
      assert.deepEqual(seen.section, [{ nodeId: 'nid-section-setup' }],
        'section chunks are fetched by the resolved nodeId — exact section identity, never a heading-text guess');
    });
  });

  it('unknown section (or collection without a skeleton): 404 envelope', async () => {
    const adapter = knownCollectionAdapter({ getSkeletonNode: async () => null });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=section&nodePath=${encodeURIComponent('guide.md#ghost')}`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'not_found');
    });
  });

  it('a nodePath identifying a non-section node (e.g. a file node): 400', async () => {
    const adapter = knownCollectionAdapter({
      getSkeletonNode: async () => ({ ...sectionNode, nodeType: 'file', nodePath: 'guide.md' }),
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=section&nodePath=${encodeURIComponent('guide.md')}`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /section/);
    });
  });

  it('a real section with zero content chunks: 200 with empty segments AND skeleton-correct mode, never plain_chunks', async () => {
    const adapter = knownCollectionAdapter({
      getSkeletonNode: async () => sectionNode,
      getSectionChunks: async () => [],
    });
    await withApp(adapter, async (base) => {
      const res = await fetch(`${base}/api/collections/my-docs/assembly?scope=section&nodePath=${encodeURIComponent('guide.md#setup')}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.segments, []);
      // Code review (first round): the route resolved a REAL skeleton node,
      // so an empty section must not be mislabeled as a legacy collection —
      // the route passes the explicit skeleton marker to the service.
      assert.equal(body.assemblyMode, 'entity_refs');
      assert.deepEqual(body.warnings, []);
    });
  });
});

describe('GET /api/collections/:name/assembly — parameter validation', () => {
  const cases = [
    ['missing scope', '/api/collections/my-docs/assembly'],
    ['invalid scope value', '/api/collections/my-docs/assembly?scope=chunk'],
    ['scope=file without sourceFile', '/api/collections/my-docs/assembly?scope=file'],
    ['scope=file with a conflicting nodePath', '/api/collections/my-docs/assembly?scope=file&sourceFile=a.md&nodePath=a.md%23s'],
    ['scope=section without nodePath', '/api/collections/my-docs/assembly?scope=section'],
    ['scope=section with a conflicting sourceFile', '/api/collections/my-docs/assembly?scope=section&nodePath=a.md%23s&sourceFile=a.md'],
  ];

  for (const [label, path] of cases) {
    it(`${label}: 400 bad_request envelope`, async () => {
      await withApp(knownCollectionAdapter(), async (base) => {
        const res = await fetch(base + path);
        assert.equal(res.status, 400, `expected 400 for ${label}`);
        const body = await res.json();
        assert.equal(body.error.code, 'bad_request');
      });
    });
  }
});
