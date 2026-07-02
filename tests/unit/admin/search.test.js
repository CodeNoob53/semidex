// POST /api/search — offline tests over a real node:http server with a stub
// StorageAdapter and a stub embedQuery. No Qdrant, no ONNX, no Ollama.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md',
  chunkIndex: 4,
  totalChunks: 10,
  section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance. '.repeat(8), // > 150 chars
  context: 'Env var reference.',
  tags: ['configuration'],
  nodeType: null, nodeId: null, nodePath: null,
  score: 0.03,
  isMatch: null,
};

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub',
    capabilities: () => ({
      namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true,
      aliases: false, snapshots: false, collectionExists: true,
    }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [{ name: 'demo' }],
    getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    searchHybrid: async () => [HIT],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
    ...overrides,
  };
}

async function embedQueryStub() {
  return { dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } };
}

async function withServer({ adapter = makeStubAdapter(), embedQuery = embedQueryStub } = {}, fn) {
  const app = createApp({ adapter, embedQuery });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function post(base, body) {
  return fetch(base + '/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/search — validation', () => {
  it('invalid JSON body → 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, '{not json');
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'bad_request');
    });
  });

  it('missing collection → 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { query: 'x' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /"collection"/);
    });
  });

  it('missing query → 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /"query"/);
    });
  });

  it('invalid top values → 400', async () => {
    await withServer({}, async (base) => {
      for (const top of [0, 21, 1.5, 'three']) {
        const res = await post(base, { collection: 'demo', query: 'x', top });
        assert.equal(res.status, 400, `top=${JSON.stringify(top)} should be rejected`);
      }
    });
  });

  it('invalid window values → 400', async () => {
    await withServer({}, async (base) => {
      for (const window of [-1, 6, 'one']) {
        const res = await post(base, { collection: 'demo', query: 'x', window });
        assert.equal(res.status, 400, `window=${JSON.stringify(window)} should be rejected`);
      }
    });
  });

  it('invalid windowFormat → 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x', window: 1, windowFormat: 'verbose' });
      assert.equal(res.status, 400);
    });
  });

  it('invalid tags → 400', async () => {
    await withServer({}, async (base) => {
      for (const tags of ['config', [], [''], [1]]) {
        const res = await post(base, { collection: 'demo', query: 'x', tags });
        assert.equal(res.status, 400, `tags=${JSON.stringify(tags)} should be rejected`);
      }
    });
  });

  it('collection not found → 404', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'nope', query: 'x' });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });
  });
});

describe('POST /api/search — adapter contract', () => {
  it('passes vectors, limit and semidex filter to adapter.searchHybrid', async () => {
    let captured = null;
    const adapter = makeStubAdapter({
      searchHybrid: async (collection, opts) => { captured = { collection, opts }; return [HIT]; },
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, {
        collection: 'demo', query: 'how to configure QDRANT_URL',
        top: 5, sourceFile: 'docs/en/configuration.md', tags: ['configuration'],
      });
      assert.equal(res.status, 200);
      assert.equal(captured.collection, 'demo');
      assert.deepEqual(captured.opts.dense, [0.1, 0.2]);
      assert.deepEqual(captured.opts.sparse, { indices: [1], values: [0.5] });
      assert.equal(captured.opts.limit, 5);
      assert.deepEqual(captured.opts.filter, {
        sourceFile: 'docs/en/configuration.md',
        tags: ['configuration'],
        excludeNav: true,
      });
    });
  });

  it('omits sourceFile/tags from the filter when not provided, keeps excludeNav', async () => {
    let captured = null;
    const adapter = makeStubAdapter({
      searchHybrid: async (_c, opts) => { captured = opts; return []; },
    });
    await withServer({ adapter }, async (base) => {
      await post(base, { collection: 'demo', query: 'x' });
      assert.deepEqual(captured.filter, { excludeNav: true });
      assert.equal(captured.limit, 3, 'default top must be 3');
    });
  });

  it('response includes searchMode and domain-shaped results', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x' });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchMode, 'hybrid');
      assert.equal(body.collection, 'demo');
      assert.equal(body.window, 0);
      assert.equal(body.windowFormat, null);
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].sourceFile, HIT.sourceFile);
      assert.equal(body.results[0].isMatch, true);
      assert.ok(!('windowChunks' in body.results[0]), 'no windowChunks when window=0');
    });
  });
});

describe('POST /api/search — window expansion', () => {
  const neighbor = (chunkIndex) => ({
    ...HIT, chunkIndex, text: `neighbor ${chunkIndex} text`, section: 'Qdrant',
  });

  it('window=1 compact: windowChunks with isMatch flags and capped snippets', async () => {
    const adapter = makeStubAdapter({
      getChunk: async (_c, _sf, center, { window }) => {
        assert.equal(center, HIT.chunkIndex);
        assert.equal(window, 1);
        return [neighbor(3), { ...HIT }, neighbor(5)];
      },
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x', window: 1 });
      const body = await res.json();
      assert.equal(body.windowFormat, 'compact', 'compact must be the default when window > 0');
      const wc = body.results[0].windowChunks;
      assert.equal(wc.length, 3);
      assert.deepEqual(wc.map(c => c.isMatch), [false, true, false]);
      for (const c of wc) {
        assert.equal(typeof c.textSnippet, 'string');
        assert.ok(!('text' in c), 'compact window chunks must not carry full text');
        assert.ok(c.textSnippet.length <= 153);
      }
      assert.ok(wc[1].textSnippet.endsWith('...'), 'long matched text must be truncated');
    });
  });

  it('window=1 full: untruncated text, no snippet', async () => {
    const adapter = makeStubAdapter({
      getChunk: async () => [{ ...HIT }],
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x', window: 1, windowFormat: 'full' });
      const body = await res.json();
      const wc = body.results[0].windowChunks;
      assert.equal(wc[0].text, HIT.text);
      assert.ok(!('textSnippet' in wc[0]));
    });
  });

  it('duplicate non-match neighbors across results are emitted once', async () => {
    const hit2 = { ...HIT, chunkIndex: 5 };
    const adapter = makeStubAdapter({
      searchHybrid: async () => [HIT, hit2],
      // both windows include chunk 5 — as hit2's match and as HIT's neighbor
      getChunk: async (_c, _sf, center) =>
        center === 4 ? [{ ...HIT }, { ...hit2 }] : [{ ...HIT }, { ...hit2 }],
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x', window: 1 });
      const body = await res.json();
      const all = body.results.flatMap(r => r.windowChunks);
      const chunk4 = all.filter(c => c.chunkIndex === 4);
      const chunk5 = all.filter(c => c.chunkIndex === 5);
      // each chunk appears once as a match (always preserved) and duplicates
      // as a non-match neighbor are suppressed
      assert.equal(chunk4.filter(c => c.isMatch).length, 1);
      assert.equal(chunk5.filter(c => c.isMatch).length, 1);
      assert.ok(chunk4.length + chunk5.length <= 3, 'duplicate neighbor must be deduped');
    });
  });
});

describe('POST /api/search — capabilities and failures', () => {
  it('adapter without hybrid/sparse capabilities → 501', async () => {
    const adapter = makeStubAdapter({
      capabilities: () => ({
        namedVectors: true, sparseVectors: false, hybridSearch: false, payloadIndexes: true,
        aliases: false, snapshots: false, collectionExists: true,
      }),
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x' });
      assert.equal(res.status, 501);
      assert.equal((await res.json()).error.code, 'not_implemented');
    });
  });

  it('embedding failure → 500 embedding_failed with a useful message', async () => {
    const embedQuery = async () => { throw new Error('Ollama unreachable at http://localhost:11434'); };
    await withServer({ embedQuery }, async (base) => {
      const res = await post(base, { collection: 'demo', query: 'x' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error.code, 'embedding_failed');
      assert.match(body.error.message, /Ollama unreachable/);
    });
  });
});
