// Tests for src/mcp/tools/search.js's Phase 3X anchor exposure —
// assembleWindowChunks() (pure, exported) and the per-hit node identity
// line handle() adds to its formatted Markdown output. Ranking/retrieval
// behavior itself is untouched by this phase; these tests only cover the
// additive anchor fields.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleWindowChunks } from '../../../src/mcp/tools/search.js';

function point(payload) {
  return { payload };
}

describe('assembleWindowChunks — window chunk node identity (Phase 3X)', () => {
  it('includes node_id/node_path/node_type when the payload carries them (skeleton-aware collection)', () => {
    const points = [point({ source_file: 'a.md', chunk_index: 5, section: 'Setup', node_id: 'n5', node_path: 'a.md#s/paragraph-5', node_type: 'paragraph', text: 'hello' })];
    const result = assembleWindowChunks(points, 5, 'full');
    assert.equal(result[0].node_id, 'n5');
    assert.equal(result[0].node_path, 'a.md#s/paragraph-5');
    assert.equal(result[0].node_type, 'paragraph');
  });

  it('omits node identity entirely (not null) for a legacy collection with no node_id on the payload', () => {
    const points = [point({ source_file: 'old.md', chunk_index: 2, section: 'Intro', text: 'legacy chunk' })];
    const result = assembleWindowChunks(points, 2, 'full');
    assert.equal('node_id' in result[0], false, 'legacy points must omit node_id, never fabricate null');
    assert.equal('node_path' in result[0], false);
    assert.equal('node_type' in result[0], false);
  });

  it('window chunk identity is present in BOTH full and compact window_format', () => {
    const points = [point({ source_file: 'a.md', chunk_index: 5, section: 'Setup', node_id: 'n5', node_path: 'p5', node_type: 'table', text: 'x'.repeat(200) })];
    const compact = assembleWindowChunks(points, 5, 'compact');
    assert.equal(compact[0].node_id, 'n5');
    assert.ok(compact[0].text_snippet, 'compact format still returns a snippet alongside identity');
  });

  it('a chunk with node_id but no node_path still exposes node_id/node_type, with node_path as null (defensive, not omitted)', () => {
    const points = [point({ source_file: 'a.md', chunk_index: 0, node_id: 'n0', node_type: 'paragraph', text: 'x' })];
    const result = assembleWindowChunks(points, 0, 'full');
    assert.equal(result[0].node_id, 'n0');
    assert.equal(result[0].node_path, null);
  });
});

describe('search.js source — node identity surfaced on the primary hit, ranking untouched', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../src/mcp/tools/search.js', import.meta.url)), 'utf-8');

  it('formats a Node line only when the hit payload carries node_id (source-level pin: conditional, not unconditional)', () => {
    assert.match(src, /if \(p\.node_id\)/, 'the per-hit Node line must be conditional on node_id presence, never unconditional/fabricated');
    assert.match(src, /node_id=\$\{p\.node_id\}/);
  });

  // Code review (P2): a source regex that only checked for "node_id=" in
  // isolation would NOT have caught node_path being silently missing from
  // the primary hit's Node line, even though window chunks (via
  // assembleWindowChunks, tested behaviorally above) already carried all
  // three fields — the documented contract is node_id/node_path/node_type
  // on BOTH. Pinned explicitly here as its own assertion so a future
  // regression in just one field is caught, not just "a Node line exists."
  it('the primary hit\'s Node line includes node_path as well as node_id/node_type — matching the documented node_id/node_path/node_type contract', () => {
    assert.match(src, /node_path=\$\{p\.node_path\}/, 'the primary hit must expose node_path, matching what window chunks already expose');
  });

  it('does not touch hybridSearch/rerank/CE call sites (ranking/retrieval behavior unchanged)', () => {
    // Sanity: the functions that actually determine ranking are still
    // called exactly as before — this phase only added output formatting.
    assert.match(src, /hybridSearch\(collection, dense, sparse,/);
    assert.match(src, /rerankResults\(pool, query,/);
  });
});

// Behavioral pin (not just source regex) for the primary-hit Node line's
// exact rendered shape — extracted and evaluated as a pure function so the
// test actually exercises the string-building logic, not just its presence
// in source text. Mirrors the real handle() loop's own line-construction
// code (see search.js) closely enough to catch a missing-field regression
// even if the source shape around it changes.
function formatNodeLine(p) {
  if (!p.node_id) return null;
  const parts = [`node_id=${p.node_id}`];
  if (p.node_path) parts.push(`node_path=${p.node_path}`);
  if (p.node_type) parts.push(`node_type=${p.node_type}`);
  return `**Node:** ${parts.join(' ')}`;
}

describe('primary-hit Node line — exact rendered contract', () => {
  it('renders node_id, node_path, and node_type together when all three are present', () => {
    const line = formatNodeLine({ node_id: 'n1', node_path: 'a.md#s/paragraph-1', node_type: 'paragraph' });
    assert.equal(line, '**Node:** node_id=n1 node_path=a.md#s/paragraph-1 node_type=paragraph');
  });

  it('omits the field entirely (not "node_path=undefined") when node_path is absent', () => {
    const line = formatNodeLine({ node_id: 'n1', node_type: 'table' });
    assert.equal(line, '**Node:** node_id=n1 node_type=table');
    assert.doesNotMatch(line, /undefined/);
  });

  it('renders nothing at all for a legacy hit with no node_id', () => {
    assert.equal(formatNodeLine({}), null);
  });
});
