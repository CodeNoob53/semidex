// Skeleton task-3 smoke: payload extension helpers and B1 reindex detection.
// Pure — no Qdrant, no LLM.

export default async function ({ ok }) {
  console.log('\n[46] skeleton payload — additive fields + B1 reindex meta');

  const {
    expectedChunkingMeta, skeletonPayloadFields, isSkeletonChunk, makeSkeletonPointId,
    SKELETON_CHUNKING_MODEL, INDEXING_SCHEMA_VERSION,
  } = await import('../../indexer/skeleton-payload.js');
  const { makePointId } = await import('../../core/point-id.js');

  // ── expectedChunkingMeta (B1: skip-tuple input) ─────────────────────────────
  // Signature dropped its env parameter — skeleton chunking is unconditional
  // for .md now, not gated by SKELETON_CHUNKING (which no longer exists).
  ok('.md → skeleton meta, unconditionally',
     JSON.stringify(expectedChunkingMeta('docs/a.md')) ===
     JSON.stringify({ chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION }));
  ok('.txt → legacy meta (skeleton is md-only)',
     expectedChunkingMeta('notes/a.txt').chunkingModel === null);
  ok('.pdf → legacy meta',
     expectedChunkingMeta('docs/a.pdf').chunkingModel === null);
  ok('case-insensitive extension', expectedChunkingMeta('A.MD').chunkingModel === SKELETON_CHUNKING_MODEL);
  {
    const before = process.env.SKELETON_CHUNKING;
    let envHasNoEffect;
    try {
      process.env.SKELETON_CHUNKING = '0';
      const withZero = expectedChunkingMeta('docs/a.md');
      process.env.SKELETON_CHUNKING = '1';
      const withOne = expectedChunkingMeta('docs/a.md');
      delete process.env.SKELETON_CHUNKING;
      const withUnset = expectedChunkingMeta('docs/a.md');
      envHasNoEffect = JSON.stringify(withZero) === JSON.stringify(withOne)
        && JSON.stringify(withOne) === JSON.stringify(withUnset);
    } finally {
      if (before === undefined) delete process.env.SKELETON_CHUNKING;
      else process.env.SKELETON_CHUNKING = before;
    }
    ok('setting SKELETON_CHUNKING as a raw OS env var has no effect on .md meta', envHasNoEffect);
  }

  // B1 scenario: stored legacy point vs the now-unconditional skeleton
  // expectation → tuple mismatch, forcing exactly the one-time reindex.
  const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
  const expectedNow  = expectedChunkingMeta('docs/a.md');
  ok('B1: legacy stored vs current skeleton expectation → mismatch forces reindex',
     storedLegacy.chunkingModel !== expectedNow.chunkingModel);
  ok('B1: matching skeleton meta → no spurious reindex',
     JSON.stringify(expectedChunkingMeta('docs/a.md')) === JSON.stringify(expectedNow));

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

  // ── makeSkeletonPointId (transitional stage collapsed) ──────────────────────
  const pidArgs = { collection: 'col-a', nodeId: 'node-uuid-1', embeddingSchemaVersion: 2 };
  ok('skeleton point ID deterministic', makeSkeletonPointId(pidArgs) === makeSkeletonPointId(pidArgs));
  ok('skeleton point ID is a UUID',
     /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(makeSkeletonPointId(pidArgs)));
  ok('changes with collection', makeSkeletonPointId({ ...pidArgs, collection: 'col-b' }) !== makeSkeletonPointId(pidArgs));
  ok('changes with node_id',    makeSkeletonPointId({ ...pidArgs, nodeId: 'node-uuid-2' }) !== makeSkeletonPointId(pidArgs));
  ok('changes with embedding schema', makeSkeletonPointId({ ...pidArgs, embeddingSchemaVersion: 3 }) !== makeSkeletonPointId(pidArgs));
  // Disjoint from the legacy point-ID space even on colliding inputs.
  ok('disjoint from makePointId space',
     makeSkeletonPointId(pidArgs) !== makePointId({ collection: 'col-a', sourceFile: 'node-uuid-1', chunkIndex: 0, embeddingSchemaVersion: 2 }));

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
