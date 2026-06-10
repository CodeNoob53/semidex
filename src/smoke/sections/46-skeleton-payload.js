// Skeleton task-3 smoke: payload extension helpers and B1 reindex detection.
// Pure — no Qdrant, no LLM.

export default async function ({ ok }) {
  console.log('\n[46] skeleton payload — additive fields + B1 reindex meta');

  const {
    expectedChunkingMeta, skeletonPayloadFields, isSkeletonChunk,
    SKELETON_CHUNKING_MODEL, INDEXING_SCHEMA_VERSION,
  } = await import('../../indexer/skeleton-payload.js');

  // ── expectedChunkingMeta (B1: skip-tuple input) ─────────────────────────────
  const on  = { SKELETON_CHUNKING: '1' };
  const off = {};

  ok('flag on + .md → skeleton meta',
     JSON.stringify(expectedChunkingMeta(on, 'docs/a.md')) ===
     JSON.stringify({ chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION }));
  ok('flag on + .txt → legacy meta (skeleton is md-only)',
     expectedChunkingMeta(on, 'notes/a.txt').chunkingModel === null);
  ok('flag on + .pdf → legacy meta',
     expectedChunkingMeta(on, 'docs/a.pdf').chunkingModel === null);
  ok('flag off + .md → legacy meta',
     expectedChunkingMeta(off, 'docs/a.md').chunkingModel === null &&
     expectedChunkingMeta(off, 'docs/a.md').indexingSchemaVersion === null);
  ok('case-insensitive extension', expectedChunkingMeta(on, 'A.MD').chunkingModel === SKELETON_CHUNKING_MODEL);

  // B1 scenario: stored legacy point vs skeleton-enabled run → tuple mismatch.
  const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
  const expectedNow  = expectedChunkingMeta(on, 'docs/a.md');
  ok('B1: legacy stored vs skeleton run → mismatch forces reindex',
     storedLegacy.chunkingModel !== expectedNow.chunkingModel);
  ok('B1: skeleton stored vs legacy run → mismatch forces reindex',
     expectedChunkingMeta(off, 'docs/a.md').chunkingModel !== expectedNow.chunkingModel);
  ok('B1: matching skeleton meta → no spurious reindex',
     JSON.stringify(expectedChunkingMeta(on, 'docs/a.md')) === JSON.stringify(expectedNow));

  // ── skeletonPayloadFields ────────────────────────────────────────────────────
  const skelChunk = {
    text: 't', chunking_model: 'skeleton-v1',
    point_kind: 'retrieval_content', node_type: 'table',
    node_id: 'uuid-1', node_path: 'a.md#sec/table-1', parent_id: 'uuid-0',
    heading_path: ['Sec'], raw_content: '| a |', lang: null,
  };
  const f = skeletonPayloadFields(skelChunk);
  ok('skeleton chunk → all additive fields present',
     f.point_kind === 'retrieval_content' && f.node_type === 'table' &&
     f.node_id === 'uuid-1' && f.node_path === 'a.md#sec/table-1' &&
     f.parent_id === 'uuid-0' && f.raw_content === '| a |');
  ok('indexing_schema_version stamped', f.indexing_schema_version === INDEXING_SCHEMA_VERSION);
  ok('chunking_model stamped', f.chunking_model === SKELETON_CHUNKING_MODEL);
  ok('lang=null omitted', !('lang' in f));
  ok('lang preserved when set',
     skeletonPayloadFields({ ...skelChunk, lang: 'js' }).lang === 'js');

  // Legacy chunks: ZERO new keys (impl spec §4 — absence is the legacy marker).
  const legacyChunk = { text: 't', section: 's', chunkIndex: 0, totalChunks: 1 };
  ok('legacy chunk → empty object', Object.keys(skeletonPayloadFields(legacyChunk)).length === 0);
  ok('isSkeletonChunk discriminates', isSkeletonChunk(skelChunk) && !isSkeletonChunk(legacyChunk));

  // ── end-to-end: chunkFromSkeleton output → payload fields round-trip ────────
  const { parseSkeleton } = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../indexer/phases/skeleton-chunk.js');
  const md = '# S\n\nProse with enough meaningful words to pass the gate.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'a.md' }), { sourceFile: 'a.md' });
  ok('every skeleton chunk yields payload fields',
     chunks.every(c => skeletonPayloadFields(c).chunking_model === SKELETON_CHUNKING_MODEL));
  ok('table chunk payload carries node_type=table',
     chunks.filter(c => c.node_type === 'table')
           .every(c => skeletonPayloadFields(c).node_type === 'table'));
}
