// Tests for src/mcp/tools/getContent.js (qdrant_get_content) — the MCP
// tool's own input validation, output formatting (format=text/nodes), and
// its DI-able handler factory (createGetContentHandler({ adapter,
// countTokens })), which is exactly why this tool is testable without a
// live Qdrant or a real tokenizer load. No live Qdrant used anywhere here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGetContentHandler, validateInput, formatResult, schema, tokenizerUnavailableMessage } from '../../../src/mcp/tools/getContent.js';

const countTokens = (text) => Math.ceil(String(text ?? '').length / 4);

function makeFixtureAdapter() {
  const sectionNode = { nodeType: 'section', nodeId: 'sec-1', nodePath: 'a.md#setup', sourceFile: 'a.md', parentId: 'file-1' };
  const proseChunk = {
    sourceFile: 'a.md', chunkIndex: 0, section: 'Setup', text: 'Some prose here.',
    nodeType: 'paragraph', nodeId: 'p0', nodePath: 'a.md#setup/paragraph-0', parentId: 'sec-1', entityRefs: [],
  };
  const tableChunk = {
    sourceFile: 'a.md', chunkIndex: 1, section: 'Setup', text: '| A | B |', rawContent: '| A | B |',
    nodeType: 'table', nodeId: 't1', nodePath: 'a.md#setup/table-1', parentId: 'sec-1', entityRefs: [],
  };
  return {
    async getContentNode(collection, { nodeId }) {
      if (nodeId === 'p0') return proseChunk;
      if (nodeId === 't1') return tableChunk;
      if (nodeId === 'sec-1') return null; // nav node — never content
      return null;
    },
    async getSkeletonNode(collection, { nodeId }) {
      if (nodeId === 'sec-1') return sectionNode;
      return null;
    },
    async getSectionChunks(collection, { nodeId }) {
      if (nodeId === 'sec-1') return [proseChunk, tableChunk];
      return null;
    },
    async getFileChunks(collection, sourceFile) {
      if (sourceFile === 'a.md') return [proseChunk, tableChunk];
      return [];
    },
  };
}

describe('qdrant_get_content — schema', () => {
  it('is registered with the expected name and required fields', () => {
    assert.equal(schema.name, 'qdrant_get_content');
    assert.deepEqual(schema.inputSchema.required, ['collection', 'anchor_node_id']);
    assert.equal(schema.inputSchema.properties.scope.default, 'section');
    assert.equal(schema.inputSchema.properties.format.default, 'text');
  });

  it('declares a defensible bounded max_tokens range with a documented default', () => {
    const p = schema.inputSchema.properties.max_tokens;
    assert.equal(p.default, 2000);
    assert.equal(p.minimum, 200);
    assert.equal(p.maximum, 8000);
  });
});

describe('qdrant_get_content — input validation', () => {
  it('requires collection', () => {
    assert.match(validateInput({ anchor_node_id: 'x' }), /collection/i);
  });
  it('requires anchor_node_id', () => {
    assert.match(validateInput({ collection: 'c' }), /anchor_node_id/i);
  });
  it('rejects an invalid scope', () => {
    assert.match(validateInput({ collection: 'c', anchor_node_id: 'x', scope: 'chunk' }), /scope/i);
  });
  it('rejects an invalid format', () => {
    assert.match(validateInput({ collection: 'c', anchor_node_id: 'x', format: 'html' }), /format/i);
  });
  it('accepts a valid minimal input', () => {
    assert.equal(validateInput({ collection: 'c', anchor_node_id: 'x' }), null);
  });

  for (const bad of [50, 100000, 1.5, 'not-a-number']) {
    it(`rejects an out-of-range/invalid max_tokens (${JSON.stringify(bad)})`, () => {
      assert.match(validateInput({ collection: 'c', anchor_node_id: 'x', max_tokens: bad }), /max_tokens/i);
    });
  }
  it('accepts max_tokens at the exact boundary values', () => {
    assert.equal(validateInput({ collection: 'c', anchor_node_id: 'x', max_tokens: 200 }), null);
    assert.equal(validateInput({ collection: 'c', anchor_node_id: 'x', max_tokens: 8000 }), null);
  });

  it('rejects a non-string cursor', () => {
    assert.match(validateInput({ collection: 'c', anchor_node_id: 'x', cursor: 42 }), /cursor/i);
  });
});

describe('qdrant_get_content — handle() via the DI factory (format=text)', () => {
  it('returns reconstructed text plus compact metadata for a section-scope anchor', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 1000 });
    const body = JSON.parse(raw);
    assert.equal(body.collection, 'c');
    assert.equal(body.scope, 'section');
    assert.equal(body.node_path, 'a.md#setup');
    assert.equal(body.anchor_node_id, 'p0');
    assert.match(body.text, /Some prose here\./);
    assert.match(body.text, /\| A \| B \|/);
    assert.equal(typeof body.total_tokens, 'number');
    assert.equal(typeof body.returned_tokens, 'number');
    assert.equal(body.has_more_before, false);
    assert.equal(body.has_more_after, false);
  });

  it('does not rewrite or summarize — reconstruction is a verbatim join of segment content', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 1000 });
    const body = JSON.parse(raw);
    assert.match(body.text, /^Some prose here\./);
  });

  it('returned content never exceeds max_tokens (checked against the actual reconstructed text length)', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    // 200 is the tool's own documented minimum (MAX_TOKENS_MIN) — a value
    // below that is a validation error, not a "small budget" case; this
    // test exercises the smallest VALID budget, still well under the two
    // fixture segments' combined size.
    const raw = await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 200 });
    const body = JSON.parse(raw);
    assert.ok(body.returned_tokens <= 200);
  });

  // Code review (P1, round 2): the reviewer's explicitly requested test —
  // the join separators ("\n\n") rendered BETWEEN items must be counted, so
  // the real serialized text (not per-segment counts in isolation) fits the
  // budget. A many-small-segment fixture is what exposed the old overflow:
  // maxTokens=200 reported returned_tokens=200 while countTokens(text)=399.
  it('countTokens(response.text) <= max_tokens, including the separators between items (the exact reviewer repro)', async () => {
    // 20 segments, each 80 chars = 20 tokens under chars/4; joined with
    // "\n\n" that would add ~1 token per boundary uncounted in the old code.
    const seg = (i) => ({
      sourceFile: 'a.md', chunkIndex: i, section: 'S', text: 'x'.repeat(80),
      nodeType: 'paragraph', nodeId: `n${i}`, nodePath: `p${i}`, parentId: 'sec-1', entityRefs: [],
    });
    const chunks = Array.from({ length: 20 }, (_, i) => seg(i));
    const sectionNode = { nodeType: 'section', nodeId: 'sec-1', nodePath: 'a.md#s', sourceFile: 'a.md' };
    const adapter = {
      async getContentNode(_, { nodeId }) { return chunks.find(c => c.nodeId === nodeId) ?? null; },
      async getSkeletonNode(_, { nodeId }) { return nodeId === 'sec-1' ? sectionNode : null; },
      async getSectionChunks() { return chunks; },
      async getFileChunks() { return chunks; },
    };
    const { handle } = createGetContentHandler({ adapter, countTokens });
    for (const maxTokens of [200, 250, 333, 500]) {
      const body = JSON.parse(await handle({ collection: 'c', anchor_node_id: 'n0', scope: 'section', max_tokens: maxTokens }));
      assert.ok(countTokens(body.text) <= maxTokens,
        `countTokens(text)=${countTokens(body.text)} must be <= max_tokens=${maxTokens} (separators counted)`);
      assert.equal(body.returned_tokens, countTokens(body.text),
        'returned_tokens must count the exact serialized response, not separately-counted parts');
      assert.ok(body.returned_tokens <= maxTokens);
    }
  });

  it('counts a serialized candidate once when the tokenizer has per-call overhead (BPE counts are not additive)', async () => {
    const nonAdditiveCount = (text) => text === '' ? 0 : Math.ceil(String(text).length / 4) + 2;
    const chunks = Array.from({ length: 30 }, (_, i) => ({
      sourceFile: 'a.md', chunkIndex: i, section: 'S', text: `segment-${i}-${'x'.repeat(40)}`,
      nodeType: 'paragraph', nodeId: `n${i}`, nodePath: `p${i}`, parentId: 'sec-1', entityRefs: [],
    }));
    const adapter = {
      async getContentNode(_, { nodeId }) { return chunks.find(c => c.nodeId === nodeId) ?? null; },
      async getSkeletonNode(_, { nodeId }) {
        return nodeId === 'sec-1'
          ? { nodeType: 'section', nodeId: 'sec-1', nodePath: 'a.md#s', sourceFile: 'a.md' }
          : null;
      },
      async getSectionChunks() { return chunks; },
      async getFileChunks() { return chunks; },
    };
    const { handle } = createGetContentHandler({ adapter, countTokens: nonAdditiveCount });
    const body = JSON.parse(await handle({ collection: 'c', anchor_node_id: 'n10', scope: 'section', max_tokens: 200 }));

    assert.equal(body.returned_tokens, nonAdditiveCount(body.text));
    assert.ok(body.returned_tokens <= 200);
    assert.ok(body.text.includes('segment-10-'), 'the anchor remains in the exact-counted page');
  });

  it('reports token_count_mode="injected" when the test injects countTokens directly (the DI seam is visible, not hidden)', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 1000 });
    const body = JSON.parse(raw);
    assert.equal(body.token_count_mode, 'injected');
  });

  it('oversized entities are excluded from `text` and reported once each in `omitted_entities` — never inlined at an uncounted cost (code review, P1)', async () => {
    const bigAdapter = makeFixtureAdapter();
    const originalGetSectionChunks = bigAdapter.getSectionChunks;
    bigAdapter.getSectionChunks = async (collection, opts) => {
      const chunks = await originalGetSectionChunks(collection, opts);
      if (!chunks) return chunks;
      return chunks.map(c => (c.nodeId === 't1' ? { ...c, rawContent: 'y'.repeat(40000), text: 'y'.repeat(40000) } : c));
    };
    const { handle } = createGetContentHandler({ adapter: bigAdapter, countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 't1', scope: 'section', max_tokens: 300, format: 'text' });
    const body = JSON.parse(raw);
    assert.doesNotMatch(body.text, /oversized|omitted|qdrant_get_node/i, 'no bracketed note text is inlined into `text` anymore');
    assert.ok(Array.isArray(body.omitted_entities));
    assert.equal(body.omitted_entities.length, 1);
    assert.equal(body.omitted_entities[0].node_id, 't1');
    assert.equal(typeof body.omitted_entities[0].token_count, 'number');
  });
});

describe('qdrant_get_content — always uses the accurate tokenizer; failure is a hard error, never a heuristic fallback (code review, P1)', () => {
  it('a real tokenizer load failure returns a clear error mentioning the underlying cause, never chars/4 substituted silently', async () => {
    const loadError = new Error('BGE-M3 tokenizer not cached locally.');
    const { handle } = createGetContentHandler({
      adapter: makeFixtureAdapter(),
      getTokenCounterFn: async () => { throw loadError; },
    });
    const result = await handle({ collection: 'c', anchor_node_id: 'p0' });
    assert.match(result, /^Error:/);
    assert.match(result, /tokenizer failed to load/i);
    assert.match(result, /BGE-M3 tokenizer not cached locally/);
    assert.doesNotMatch(result, /token_count_mode="heuristic"/, 'must not advertise heuristic as a fallback for this tool');
  });

  it('tokenizerUnavailableMessage is a pure formatter producing the same shape independent of the handler', () => {
    const msg = tokenizerUnavailableMessage(new Error('network unreachable'));
    assert.match(msg, /^Error:/);
    assert.match(msg, /network unreachable/);
    assert.match(msg, /never falls back to the heuristic/i);
  });

  it('always requests the accurate bge-m3 tokenizer, ignoring any TOKEN_COUNT env setting — the indexer\'s heuristic choice must not weaken THIS tool\'s hard cap', async () => {
    let requestedMode = null;
    const { handle } = createGetContentHandler({
      adapter: makeFixtureAdapter(),
      getTokenCounterFn: async ({ mode }) => { requestedMode = mode; return countTokens; },
    });
    // TOKEN_COUNT would default to whatever the env has — the tool must
    // hard-code mode:'bge-m3' regardless.
    await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 1000 });
    assert.equal(requestedMode, 'bge-m3', 'the tool must force the accurate tokenizer, never defer to TOKEN_COUNT');
  });
});

describe('qdrant_get_content — handle() format=nodes', () => {
  it('returns ordered structured items with full identity, anchor marker, and authoritative content', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 't1', scope: 'section', max_tokens: 1000, format: 'nodes' });
    const body = JSON.parse(raw);
    assert.ok(Array.isArray(body.items));
    const tableItem = body.items.find(i => i.node_id === 't1');
    assert.equal(tableItem.node_type, 'table');
    assert.equal(tableItem.content, '| A | B |');
    assert.equal(tableItem.is_anchor, true);
    const proseItem = body.items.find(i => i.node_id === 'p0');
    assert.equal(proseItem.is_anchor, false);
    assert.equal(proseItem.chunk_index, 0);
  });

  it('never returns vectors, provider internals, or raw Qdrant payload fields', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 'p0', scope: 'section', max_tokens: 1000, format: 'nodes' });
    const body = JSON.parse(raw);
    // Check for forbidden KEYS specifically (not a raw substring match) —
    // "assembly_mode" legitimately carries the VALUE "entity_refs" (the
    // documented ASSEMBLY_MODES constant), which a naive substring check
    // against '"entity_refs"' would false-positive on.
    const keys = new Set();
    (function collect(v) {
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v)) { keys.add(k); collect(val); } }
    })(body);
    for (const forbidden of ['vector', 'vectors', 'dense', 'sparse', 'point_kind', 'entity_refs', 'payload']) {
      assert.ok(!keys.has(forbidden), `response must not contain raw field key "${forbidden}"`);
    }
  });

  it('an oversized item in format=nodes carries the oversized marker and null content', async () => {
    const bigAdapter = makeFixtureAdapter();
    const originalGetSectionChunks = bigAdapter.getSectionChunks;
    bigAdapter.getSectionChunks = async (collection, opts) => {
      const chunks = await originalGetSectionChunks(collection, opts);
      if (!chunks) return chunks;
      return chunks.map(c => (c.nodeId === 't1' ? { ...c, rawContent: 'y'.repeat(40000), text: 'y'.repeat(40000) } : c));
    };
    const { handle } = createGetContentHandler({ adapter: bigAdapter, countTokens });
    const raw = await handle({ collection: 'c', anchor_node_id: 't1', scope: 'section', max_tokens: 200, format: 'nodes' });
    const body = JSON.parse(raw);
    const oversizedItem = body.items.find(i => i.node_id === 't1');
    assert.equal(oversizedItem.oversized, true);
    assert.equal(oversizedItem.content, null);
    assert.equal(typeof oversizedItem.token_count, 'number');
  });
});

describe('qdrant_get_content — error surfaces', () => {
  it('a missing anchor produces a clear, non-JSON error string', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const result = await handle({ collection: 'c', anchor_node_id: 'ghost' });
    assert.match(result, /^Error:/);
    assert.match(result, /ghost/);
  });

  it('a navigation-node anchor is explicitly rejected with a clear explanation', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const result = await handle({ collection: 'c', anchor_node_id: 'sec-1' });
    assert.match(result, /^Error:/);
    assert.match(result, /navigation/i);
  });

  it('an invalid cursor is rejected with a clear explanation, not silently reinterpreted', async () => {
    const { handle } = createGetContentHandler({ adapter: makeFixtureAdapter(), countTokens });
    const result = await handle({ collection: 'c', anchor_node_id: 'p0', cursor: 'garbage-cursor' });
    assert.match(result, /^Error:/);
    assert.match(result, /cursor/i);
  });

  it('an invalid max_tokens value is rejected before any adapter call is made', async () => {
    let called = false;
    const adapter = { ...makeFixtureAdapter(), getContentNode: async () => { called = true; return null; } };
    const { handle } = createGetContentHandler({ adapter, countTokens });
    const result = await handle({ collection: 'c', anchor_node_id: 'p0', max_tokens: 50 });
    assert.match(result, /^Error:/);
    assert.equal(called, false, 'validation must fail fast, before any adapter I/O');
  });
});

describe('qdrant_get_content — no direct Qdrant dependency under the MCP tool', () => {
  it('getContent.js never imports the Qdrant SDK or core/qdrant directly', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../src/mcp/tools/getContent.js', import.meta.url)), 'utf-8');
    assert.doesNotMatch(src, /from ['"].*core\/qdrant/i);
    assert.doesNotMatch(src, /@qdrant\/js-client-rest/);
    assert.match(src, /from '\.\.\/\.\.\/core\/storage\/factory\.js'/, 'must go through StorageAdapter');
  });
});
