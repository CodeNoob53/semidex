// Projection/adapter regression (Phase 3V critical prerequisite): proves the
// COMPLETE storage path can carry stored entity_refs into the assembly
// service —
//
//   real chunker output (chunkFromSkeleton)
//     -> real stored payload composition (skeletonPayloadFields, as
//        indexer/index.js writes it)
//     -> Qdrant's with_payload field projection, simulated with the REAL
//        CONTENT_NODE_FIELDS constant (Qdrant returns exactly the requested
//        keys and drops everything else — the simulation below does the
//        same, so a field missing from CONTENT_NODE_FIELDS is dropped here
//        exactly like production would drop it)
//     -> store getFileChunks/getSectionChunks post-processing (nav filter +
//        chunk_index sort, mirrored inline; the server-side wiring of those
//        functions is pinned by source-level assertions below)
//     -> qdrant adapter toChunk() -> domain Chunk.entityRefs
//     -> assembleDocument()
//
// This exists because CONTENT_NODE_FIELDS originally OMITTED entity_refs:
// every direct toChunk() unit test passed while the real getFileChunks()
// projection silently stripped the field before toChunk() ever saw it. A
// hand-built toChunk() fixture alone can never catch that class of bug.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTENT_NODE_FIELDS } from '../../../../src/core/qdrant/payload.js';
import { skeletonPayloadFields } from '../../../../src/indexer/skeleton-payload.js';
import { toChunk } from '../../../../src/core/storage/qdrant-adapter.js';
import { assembleDocument } from '../../../../src/core/assembly/assemble.js';
import { ASSEMBLY_MODES } from '../../../../src/core/assembly/contract.js';
import { parseSkeleton } from '../../../../src/indexer/phases/skeleton.js';
import { chunkFromSkeleton } from '../../../../src/indexer/phases/skeleton-chunk.js';

const storeSrc = readFileSync(
  fileURLToPath(new URL('../../../../src/core/qdrant/store.js', import.meta.url)),
  'utf-8',
);

function chunkSkeletonDoc(markdown, sourceFile = 'guide.md') {
  const before = process.env.SKELETON_CHUNKING;
  process.env.SKELETON_CHUNKING = '1';
  try {
    const nodes = parseSkeleton(markdown, { sourceFile });
    return chunkFromSkeleton(nodes, { sourceFile });
  } finally {
    if (before === undefined) delete process.env.SKELETON_CHUNKING; else process.env.SKELETON_CHUNKING = before;
  }
}

// The stored payload as indexer/index.js composes it for a skeleton chunk
// (base retrieval fields + skeletonPayloadFields spread) — the same shape a
// real point carries in Qdrant.
function storedPayload(chunk, sourceFile) {
  return {
    source_file: sourceFile,
    section: chunk.section ?? '',
    text: chunk.text ?? '',
    context: chunk.context ?? null,
    chunk_index: chunk.chunkIndex,
    total_chunks: chunk.totalChunks,
    ...skeletonPayloadFields(chunk),
  };
}

// Qdrant's with_payload: [fields] behavior: return EXACTLY the requested
// keys that exist on the payload, drop everything else.
function qdrantProjection(payload, fields) {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => fields.includes(k)));
}

// getFileChunks()'s client-side post-processing, mirrored: nav exclusion +
// integer chunk_index + chunk_index sort (the server-side filter/projection
// wiring is pinned by the source-level suite below).
function storePostProcess(points) {
  return points
    .filter(p => p.payload?.point_kind !== 'skeleton_nav' && Number.isInteger(p.payload?.chunk_index))
    .sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

describe('CONTENT_NODE_FIELDS — the projection every content read goes through', () => {
  it('includes entity_refs (the Phase 3V prerequisite fix)', () => {
    assert.ok(CONTENT_NODE_FIELDS.includes('entity_refs'),
      'entity_refs missing from CONTENT_NODE_FIELDS — getFileChunks/getSectionChunks would silently strip stored references');
  });

  it('includes parent_id and heading_path (section identity + segment headingPath)', () => {
    assert.ok(CONTENT_NODE_FIELDS.includes('parent_id'));
    assert.ok(CONTENT_NODE_FIELDS.includes('heading_path'));
  });
});

describe('store.getFileChunks / store.getSectionChunks — source-level projection wiring', () => {
  it('getFileChunks projects through CONTENT_NODE_FIELDS', () => {
    const start = storeSrc.indexOf('export async function getFileChunks');
    const fn = storeSrc.slice(start, storeSrc.indexOf('\n}\n', start));
    assert.match(fn, /CONTENT_NODE_FIELDS/, 'getFileChunks must request the CONTENT_NODE_FIELDS projection');
  });

  it('getSectionChunks exists, matches by exact parent_id, projects CONTENT_NODE_FIELDS, excludes nav, sorts by chunk_index, no vectors', () => {
    const start = storeSrc.indexOf('export async function getSectionChunks');
    assert.ok(start > -1, 'getSectionChunks must be defined');
    const fn = storeSrc.slice(start, storeSrc.indexOf('\n}\n', start));
    assert.match(fn, /parent_id/, 'section identity is exact parent_id — never heading text or a chunk-index range guess');
    assert.match(fn, /CONTENT_NODE_FIELDS/);
    assert.match(fn, /withNavExcluded\(/);
    assert.match(fn, /isNavPoint\(/);
    assert.match(fn, /scrollAllFiltered\(/, 'must paginate exhaustively (and scrollAllFiltered always sets with_vector: false)');
    assert.match(fn, /sort\(/, 'must return chunks in chunk_index order');
  });
});

describe('complete path: real payload -> CONTENT_NODE_FIELDS projection -> toChunk -> assembleDocument', () => {
  const doc = '# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n'
    + '| Option | Default |\n|---|---|\n| retries | 3 |\n';

  it('a stored prose point round-trips its entity_refs into domain entityRefs and an entity_refs-mode assembly', () => {
    const chunks = chunkSkeletonDoc(doc, 'guide.md');
    const proseChunk = chunks.find(c => c.node_type === 'paragraph');
    const tableChunk = chunks.find(c => c.node_type === 'table');
    assert.ok(proseChunk.entity_refs?.length === 1, 'fixture sanity: the real chunker attached a ref');

    // Store -> projection -> adapter.
    const points = chunks.map((c, i) => ({ id: `pt-${i}`, payload: qdrantProjection(storedPayload(c, 'guide.md'), CONTENT_NODE_FIELDS) }));
    const domainChunks = storePostProcess(points).map(toChunk);

    const domainProse = domainChunks.find(c => c.nodeType === 'paragraph');
    assert.equal(domainProse.entityRefs.length, 1,
      'entityRefs must survive the real CONTENT_NODE_FIELDS projection — this is the bug the prerequisite fix closes');
    assert.equal(domainProse.entityRefs[0].nodeId, tableChunk.node_id);
    assert.equal(domainProse.entityRefs[0].nodePath, tableChunk.node_path);
    assert.equal(domainProse.entityRefs[0].nodeType, 'table');
    assert.ok(Array.isArray(domainProse.headingPath), 'heading_path projected and mapped to headingPath');
    assert.ok(domainProse.parentId, 'parent_id projected and mapped to parentId');

    // No raw snake_case leaks above the adapter.
    assert.equal('entity_refs' in domainProse, false);
    assert.equal('node_id' in domainProse.entityRefs[0], false);
    assert.equal('node_path' in domainProse.entityRefs[0], false);

    // Adapter -> assembly service: the stored refs actually drive assembly.
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: domainChunks });
    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS,
      'stored refs recognized — NOT the placeholder fallback, which is what a stripped projection would silently degrade to');
    assert.deepEqual(out.warnings, []);
    const entitySeg = out.segments.find(s => s.kind === 'entity');
    assert.equal(entitySeg.nodeId, tableChunk.node_id);
    assert.equal(entitySeg.rawContent, tableChunk.raw_content, 'authoritative raw content survives the whole path');
    const proseSeg = out.segments.find(s => s.kind === 'prose');
    assert.ok(!proseSeg.text.includes('[table node:'), 'the placeholder was removed using the round-tripped refs');
  });

  it('regression shape: with entity_refs REMOVED from the projection, the same path silently degrades to the fallback — proving the field is load-bearing', () => {
    const chunks = chunkSkeletonDoc(doc, 'guide.md');
    const withoutEntityRefs = CONTENT_NODE_FIELDS.filter(f => f !== 'entity_refs');
    const points = chunks.map((c, i) => ({ id: `pt-${i}`, payload: qdrantProjection(storedPayload(c, 'guide.md'), withoutEntityRefs) }));
    const domainChunks = storePostProcess(points).map(toChunk);

    assert.equal(domainChunks.find(c => c.nodeType === 'paragraph').entityRefs.length, 0);
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: domainChunks });
    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLACEHOLDER_FALLBACK,
      'this is exactly the silent degradation the CONTENT_NODE_FIELDS fix prevents');
  });
});
