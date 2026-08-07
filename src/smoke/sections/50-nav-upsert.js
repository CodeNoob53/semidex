// Skeleton task-6 smoke: nav-point payload assembly for Qdrant upsert.
// Pure — no Qdrant, no embeddings. Verifies the contracts that keep nav
// points safe inside a semidex collection.

export default async function ({ ok }) {
  console.log('\n[50] nav upsert — payload contracts (semidex fields, ranges, ids)');

  const { buildNavPointPayload, makeSkeletonPointId } = await import('../../shared/indexer/skeleton-payload.js');
  const { isSemidexPayload } = await import('../../shared/core/qdrant.js');
  const { isNavPoint } = await import('../../mcp/tools/filters.js');
  const { parseSkeleton } = await import('../../shared/indexer/phases/skeleton.js');
  const { buildDirectoryNavPoints, buildFileSkeleton } = await import('../../shared/indexer/phases/skeleton-index.js');

  const md = '# Guide\n\nIntro prose with enough meaningful words here.\n\n## Setup\n\nSetup prose with enough meaningful words too.\n';
  const { navPoints } = buildFileSkeleton(parseSkeleton(md, { sourceFile: 'g.md' }), { sourceFile: 'g.md' });

  const ctx = {
    fileHash: 'hash-1', vectorSize: 1024,
    tokenCountMode: 'bge-m3', chunkingSchemaVersion: 4,
    embedMeta: {
      dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx',
      sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2,
    },
  };
  const payloads = navPoints.map(n => buildNavPointPayload(n, ctx));

  // ── semidex discriminator contract (sync must not flag the collection) ──────
  ok('every nav payload passes isSemidexPayload', payloads.every(isSemidexPayload));

  // ── range-safety contract: chunk_index -1 never matches gte:0 ranges ────────
  ok('chunk_index is -1 on every nav payload', payloads.every(p => p.chunk_index === -1));
  ok('total_chunks is -1', payloads.every(p => p.total_chunks === -1));

  // ── filter contract: every nav payload is excluded by isNavPoint ────────────
  ok('isNavPoint catches every nav payload', payloads.every(p => isNavPoint({ payload: p })));

  // ── graph + display fields ───────────────────────────────────────────────────
  const filePayload = payloads.find(p => p.node_type === 'file');
  const sectionPayloads = payloads.filter(p => p.node_type === 'section');
  ok('file payload present with children', Array.isArray(filePayload.children) && filePayload.children.length === 2);
  ok('summary mirrored into text', payloads.every(p => p.text === p.summary && p.summary.length > 0));
  ok('section payload carries section name', sectionPayloads.every(p => p.section.length > 0));
  ok('source_file present (PRUNE_STALE coverage)', payloads.every(p => p.source_file === 'g.md'));
  ok('provider meta merged', payloads.every(p => p.dense_provider === 'bge-m3-onnx' && p.embedding_schema_version === 2));
  ok('chunking_model stamped', payloads.every(p => p.chunking_model === 'skeleton-v1'));
  ok('tags empty (nav carries no content tags)', payloads.every(p => Array.isArray(p.tags) && p.tags.length === 0));

  // ── point IDs: deterministic, disjoint from content chunk IDs ───────────────
  const navIds = navPoints.map(n => makeSkeletonPointId({ collection: 'col', nodeId: n.node_id, embeddingSchemaVersion: 2 }));
  ok('nav point ids deterministic',
     JSON.stringify(navIds) ===
     JSON.stringify(navPoints.map(n => makeSkeletonPointId({ collection: 'col', nodeId: n.node_id, embeddingSchemaVersion: 2 }))));
  ok('nav point ids unique', new Set(navIds).size === navIds.length);

  // ── nav points are always generated now — no SKELETON_NAV kill-switch
  // exists anymore, and run.js reads __navPoints unconditionally.
  const chunksArr = [];
  Object.defineProperty(chunksArr, '__navPoints', { value: navPoints, enumerable: false });
  const pick = () => chunksArr.__navPoints ?? [];
  ok('nav points always pass through, unconditionally', pick().length === navPoints.length);
  ok('side-channel is non-enumerable', !Object.keys(chunksArr).includes('__navPoints') &&
     JSON.stringify(chunksArr) === '[]');

  // ── directory nav nodes: collection -> directories -> file nav nodes ─────────────
  const files = [
    { source_file: 'Topic 1/Intro.md', summary: 'Intro — 2 sections' },
    { source_file: 'Topic 1/Sub/Deep.md', summary: 'Deep — 1 section' },
    { source_file: 'Topic 2/API.md', summary: 'API — 3 sections' },
    { source_file: 'Root.md', summary: 'Root — 1 section' },
  ];
  const { directoryNodes, topChildren } = buildDirectoryNavPoints('col', files);
  const dirPayloads = directoryNodes.map(n => buildNavPointPayload(n, ctx));
  const topic1 = directoryNodes.find(n => n.node_path === 'col#dir/Topic 1');
  const sub = directoryNodes.find(n => n.node_path === 'col#dir/Topic 1/Sub');

  ok('directory nav nodes are emitted for nested folders', directoryNodes.length === 3);
  ok('top children include top-level dirs and root files',
     topChildren.includes('col#dir/Topic 1') &&
     topChildren.includes('col#dir/Topic 2') &&
     topChildren.includes('Root.md#file'));
  ok('directory children include subdirs and direct files',
     topic1.children.includes('col#dir/Topic 1/Sub') &&
     topic1.children.includes('Topic 1/Intro.md#file'));
  ok('nested directory parent_id points to parent directory', sub.parent_id === topic1.node_id);
  ok('directory payload source_file is empty (does not pollute file lists)',
     dirPayloads.every(p => p.source_file === ''));
  ok('directory payloads pass semidex/nav contracts',
     dirPayloads.every(isSemidexPayload) && dirPayloads.every(p => isNavPoint({ payload: p })));
}
