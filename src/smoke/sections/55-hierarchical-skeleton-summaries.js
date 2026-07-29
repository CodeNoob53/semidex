// Smoke: hierarchical skeleton summaries — directory rollups + collection overview.
// Tests generateDirectorySummaries, generateNavSummaries (file←section propagation),
// and buildCollectionSummary (top-level nav nodes + dedicated overview).
// Pure — no Ollama, no Qdrant.

export default async function ({ ok }) {
  console.log('\n[55] hierarchical skeleton summaries — directory rollups + collection overview');

  const {
    generateNavSummaries,
    generateDirectorySummaries,
    buildCollectionSummary,
    SUMMARY_VERSION,
  } = await import('../../indexer/phases/skeleton-summary.js');

  const { parseSkeleton }     = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../indexer/phases/skeleton-chunk.js');
  const { buildFileSkeleton } = await import('../../indexer/phases/skeleton-index.js');

  // ── Shared stub helpers ───────────────────────────────────────────────────────

  let callCount = 0;
  function countingStub(response) {
    return async (_m, _p) => { callCount++; return response; };
  }

  function makeCtx(response) {
    return { generateFn: countingStub(response), model: 'stub', windowTokens: 8000 };
  }

  // ── generateNavSummaries: single-section file propagation ────────────────────

  // File with exactly ONE section — file should propagate section summary, no extra LLM call.
  const DOC_ONE_SECTION = '# Guide\n\nThis document explains how to deploy the service and configure it for production.\n';
  const nodes1  = parseSkeleton(DOC_ONE_SECTION, { sourceFile: 'guide.md' });
  const { chunks: chunks1 } = await chunkFromSkeleton(nodes1, { sourceFile: 'guide.md' });
  const { navPoints: navPts1 } = buildFileSkeleton(nodes1, { sourceFile: 'guide.md' });

  callCount = 0;
  const sectResponse = 'Explains service deployment and production configuration steps.';
  const enriched1 = await generateNavSummaries(navPts1, chunks1, makeCtx(sectResponse));

  const fileNode1 = enriched1.find(n => n.node_type === 'file');
  const secNode1  = enriched1.find(n => n.node_type === 'section');

  ok('one-section: section gets LLM summary',      secNode1?.summary === sectResponse);
  ok('one-section: file summary propagated from section', fileNode1?.summary === sectResponse);
  ok('one-section: file summary_kind = propagated', fileNode1?.summary_kind === 'propagated');
  ok('one-section: file summary_version stamped',   fileNode1?.summary_version === SUMMARY_VERSION);
  ok('one-section: inventory preserved on file',    typeof fileNode1?.inventory === 'string' && fileNode1.inventory !== fileNode1.summary);
  ok('one-section: only 1 LLM call (section only, file propagated)', callCount === 1);

  // File with TWO sections — file should call LLM independently.
  const DOC_TWO = '# Guide\n\nDeployment intro.\n\n## Setup\n\nInstall the runtime here.\n';
  const nodes2  = parseSkeleton(DOC_TWO, { sourceFile: 'guide2.md' });
  const { chunks: chunks2 } = await chunkFromSkeleton(nodes2, { sourceFile: 'guide2.md' });
  const { navPoints: navPts2 } = buildFileSkeleton(nodes2, { sourceFile: 'guide2.md' });

  callCount = 0;
  const enriched2 = await generateNavSummaries(navPts2, chunks2, makeCtx('Covers deployment and setup for the service.'));
  const fileNode2 = enriched2.find(n => n.node_type === 'file');

  ok('two-section: file NOT propagated (summary_kind != propagated)', fileNode2?.summary_kind !== 'propagated');
  ok('two-section: LLM called more than once', callCount > 1);
  ok('two-section: file inventory preserved', typeof fileNode2?.inventory === 'string');

  // Propagation only fires when section already has a semantic summary.
  // Simulate section LLM failure → section keeps inventory → file should NOT propagate.
  callCount = 0;
  const enriched1Fail = await generateNavSummaries(navPts1, chunks1, {
    generateFn: async () => { throw new Error('ollama down'); },
    model: 'stub', windowTokens: 8000,
  });
  const fileNodeFail = enriched1Fail.find(n => n.node_type === 'file');
  ok('one-section: if section LLM fails, file does NOT propagate (summary_kind != propagated)',
     fileNodeFail?.summary_kind !== 'propagated');

  // File with one section BUT meaningful preamble prose — no propagation.
  // The preamble is prose before the first heading; parseSkeleton assigns it no parent section.
  const DOC_PREAMBLE = 'This is preamble content before any heading. It matters.\n\n# Setup\n\nInstall the runtime.\n';
  const nodesPre  = parseSkeleton(DOC_PREAMBLE, { sourceFile: 'preamble.md' });
  const { chunks: chunksPre } = await chunkFromSkeleton(nodesPre, { sourceFile: 'preamble.md' });
  const { navPoints: navPtsPre } = buildFileSkeleton(nodesPre, { sourceFile: 'preamble.md' });

  callCount = 0;
  const enrichedPre = await generateNavSummaries(navPtsPre, chunksPre, makeCtx('Full file summary including preamble.'));
  const fileNodePre = enrichedPre.find(n => n.node_type === 'file');
  ok('preamble: file does NOT propagate when preamble chunks exist', fileNodePre?.summary_kind !== 'propagated');
  ok('preamble: file LLM was called (not skipped)', callCount >= 1);

  // ── generateDirectorySummaries ───────────────────────────────────────────────

  // Directory with ONE file child — propagation.
  const fileChild = {
    node_path:    'col#file/notes.md#file',
    source_file:  'notes.md',
    summary:      'Covers async programming patterns with asyncio and task management.',
    summary_kind: 'llm_medium',
    key_topics:   ['asyncio', 'tasks'],
    notable_terms: ['gather()', 'create_task()'],
  };
  const dirOne = {
    point_kind: 'skeleton_nav',
    node_type: 'directory',
    node_id: 'dir-one-uuid',
    node_path: 'col#dir/Topic 1',
    summary: 'Topic 1 — 1 file, 0 directories',
    children: ['col#file/notes.md#file'],
    source_file: '', heading_path: ['Topic 1'],
  };
  const childMap1 = new Map([['col#file/notes.md#file', fileChild]]);

  callCount = 0;
  const [enrichedDirOne] = await generateDirectorySummaries([dirOne], childMap1, makeCtx('unused'));
  ok('dir 1-file: summary propagated from child',    enrichedDirOne.summary === fileChild.summary);
  ok('dir 1-file: summary_kind = propagated',         enrichedDirOne.summary_kind === 'propagated');
  ok('dir 1-file: summary_version stamped',           enrichedDirOne.summary_version === SUMMARY_VERSION);
  ok('dir 1-file: key_topics propagated',             enrichedDirOne.key_topics?.includes('asyncio'));
  ok('dir 1-file: notable_terms propagated',          enrichedDirOne.notable_terms?.includes('gather()'));
  ok('dir 1-file: inventory preserved',               enrichedDirOne.inventory === dirOne.summary);
  ok('dir 1-file: no LLM call (propagation)',         callCount === 0);

  // Directory with inventory-only child — should NOT propagate, keeps inventory.
  const fileChildInv = {
    node_path:    'col#file/legacy.md#file',
    source_file:  'legacy.md',
    summary:      'Legacy — 3 sections, 10 paragraphs',
    summary_kind: 'inventory',
  };
  const dirInv = {
    ...dirOne, node_id: 'dir-inv-uuid', node_path: 'col#dir/Topic 2',
    summary: 'Topic 2 — 1 file, 0 directories',
    children: ['col#file/legacy.md#file'],
  };
  const childMapInv = new Map([['col#file/legacy.md#file', fileChildInv]]);

  callCount = 0;
  const [enrichedDirInv] = await generateDirectorySummaries([dirInv], childMapInv, makeCtx('unused'));
  ok('dir 1-file inventory-only: no propagation',     enrichedDirInv.summary_kind === undefined || enrichedDirInv.summary_kind === 'inventory');
  ok('dir 1-file inventory-only: no LLM call',        callCount === 0);

  // Directory with MULTIPLE file children — rollup.
  const fileA = { node_path: 'col#dir/T/a.md#file', source_file: 'T/a.md', summary: 'Covers setup steps for the module.', summary_kind: 'llm_short' };
  const fileB = { node_path: 'col#dir/T/b.md#file', source_file: 'T/b.md', summary: 'Explains configuration options in detail.', summary_kind: 'llm_medium' };
  const dirMulti = {
    point_kind: 'skeleton_nav', node_type: 'directory',
    node_id: 'dir-multi-uuid', node_path: 'col#dir/T',
    summary: 'T — 2 files, 0 directories',
    children: ['col#dir/T/a.md#file', 'col#dir/T/b.md#file'],
    source_file: '', heading_path: ['T'],
  };
  const childMapMulti = new Map([
    ['col#dir/T/a.md#file', fileA],
    ['col#dir/T/b.md#file', fileB],
  ]);
  const rollupResponse = 'Covers module setup and configuration for production use.';

  callCount = 0;
  const [enrichedDirMulti] = await generateDirectorySummaries([dirMulti], childMapMulti, makeCtx(rollupResponse));
  ok('dir multi-file: summary from LLM rollup',       enrichedDirMulti.summary === rollupResponse);
  ok('dir multi-file: summary_kind = rollup',          enrichedDirMulti.summary_kind === 'rollup');
  ok('dir multi-file: summary_version stamped',        enrichedDirMulti.summary_version === SUMMARY_VERSION);
  ok('dir multi-file: inventory preserved',            enrichedDirMulti.inventory === dirMulti.summary);
  ok('dir multi-file: LLM was called',                 callCount >= 1);

  // Directory with no resolvable children — keeps inventory unchanged.
  const dirEmpty = { ...dirOne, node_id: 'dir-empty', node_path: 'col#dir/Empty', children: [] };
  const [enrichedEmpty] = await generateDirectorySummaries([dirEmpty], new Map(), makeCtx('unused'));
  ok('dir no-children: inventory kept, no extra fields', !('summary_kind' in enrichedEmpty) || enrichedEmpty.summary_kind === undefined);

  // LLM failure — keeps inventory.
  const [enrichedFail] = await generateDirectorySummaries([dirMulti], childMapMulti, {
    generateFn: async () => { throw new Error('ollama down'); },
    model: 'stub', windowTokens: 8000,
  });
  ok('dir multi: LLM failure keeps inventory summary',  enrichedFail.summary === dirMulti.summary);
  ok('dir multi: LLM failure — no summary_kind stamp',  !('summary_version' in enrichedFail));

  // ── buildCollectionSummary: dedicated collection overview ───────────────────

  // One top-level directory with semantic summary → still generate collection overview.
  const topDir = {
    node_path:    'col#dir/Topic',
    summary:      'Covers async programming and deployment patterns for Python web services.',
    summary_kind: 'rollup',
    key_topics:   ['FastAPI', 'asyncio'],
    notable_terms: ['uvicorn', 'ASGI'],
  };
  const fileNodesColl = [
    { source_file: 'Topic/a.md', summary: 'Setup guide.' },
    { source_file: 'Topic/b.md', summary: 'Config guide.' },
  ];

  callCount = 0;
  const seenPrompts = [];
  const collOverviewJson = JSON.stringify({
    summary: 'The collection covers Python web service development with async programming, deployment, and configuration guidance for agents.',
    key_topics: ['FastAPI', 'asyncio', 'deployment'],
    notable_terms: ['uvicorn', 'ASGI'],
  });
  const collOverview = await buildCollectionSummary('test-col', fileNodesColl, {
    llm: true,
    generateFn: async (_m, p) => { callCount++; seenPrompts.push(p); return collOverviewJson; },
    topLevelNodes: [topDir],
  });
  ok('collection 1-dir: NOT propagated from child summary', collOverview.summary !== topDir.summary);
  ok('collection 1-dir: summary_kind = collection_overview', collOverview.summary_kind === 'collection_overview');
  ok('collection 1-dir: summary_version stamped',      collOverview.summary_version === SUMMARY_VERSION);
  ok('collection 1-dir: key_topics parsed',            collOverview.key_topics?.includes('FastAPI'));
  ok('collection 1-dir: notable_terms parsed',         collOverview.notable_terms?.includes('ASGI'));
  ok('collection 1-dir: LLM called for collection root', callCount >= 1);
  ok('collection 1-dir: prompt includes file notes',   seenPrompts.some(p => p.includes('Topic/a.md') && p.includes('Topic/b.md')));

  // One top-level dir with inventory-only summary → still collection overview.
  const topDirInv = { node_path: 'col#dir/T', summary: 'T — 3 files', summary_kind: 'inventory' };
  callCount = 0;
  const collInvTop = await buildCollectionSummary('test-col', fileNodesColl, {
    llm: true,
    generateFn: countingStub('Covers web development topics across multiple modules.'),
    topLevelNodes: [topDirInv],
  });
  ok('collection 1-dir inventory: collection overview', collInvTop.summary_kind === 'collection_overview');
  ok('collection 1-dir inventory: LLM was called',          callCount >= 1);

  // Multiple top-level nodes → collection overview.
  const topNodes2 = [
    { node_path: 'col#dir/T1', summary: 'Covers Docker basics.', summary_kind: 'rollup' },
    { node_path: 'col#dir/T2', summary: 'Covers FastAPI routing.', summary_kind: 'rollup' },
  ];
  callCount = 0;
  const collMulti = await buildCollectionSummary('test-col', fileNodesColl, {
    llm: true,
    generateFn: countingStub('Covers Docker and FastAPI for Python web development.'),
    topLevelNodes: topNodes2,
  });
  ok('collection multi-dir: collection overview',      collMulti.summary_kind === 'collection_overview');
  ok('collection multi-dir: LLM called',               callCount >= 1);
  ok('collection multi-dir: summary_version stamped',  collMulti.summary_version === SUMMARY_VERSION);

  // Single file, no directories → still collection overview.
  const singleFile = [{ source_file: 'solo.md', summary: 'A complete guide to asyncio.', summary_kind: 'llm_structured' }];
  callCount = 0;
  const collSingleFile = await buildCollectionSummary('solo-col', singleFile, {
    llm: true,
    generateFn: countingStub('A collection containing one complete asyncio guide for agents.'),
    topLevelNodes: singleFile.map(f => ({ ...f, node_path: `${f.source_file}#file` })),
  });
  ok('collection 1-file: NOT propagated from file',    collSingleFile.summary !== singleFile[0].summary);
  ok('collection 1-file: summary_kind = collection_overview', collSingleFile.summary_kind === 'collection_overview');
  ok('collection 1-file: LLM call made',               callCount >= 1);

  // No LLM → inventory always.
  const collInv = await buildCollectionSummary('inv-col', fileNodesColl, { llm: false });
  ok('collection no-llm: summary_kind = inventory',    collInv.summary_kind === 'inventory');
  ok('collection no-llm: no summary_version',          !('summary_version' in collInv));

  // Empty files → inventory.
  const collEmpty = await buildCollectionSummary('empty-col', [], { llm: true, generateFn: countingStub('x') });
  ok('collection empty: inventory',                    collEmpty.summary_kind === 'inventory');

  // ── summary_kind: 'propagated' passes through buildNavPointPayload ────────────

  const { buildNavPointPayload } = await import('../../indexer/skeleton-payload.js');
  const propNav = {
    point_kind: 'skeleton_nav', node_type: 'file',
    node_id: 'prop-id', node_path: 'f.md#file',
    source_file: 'f.md', heading_path: [],
    summary: 'Propagated summary text.',
    summary_kind: 'propagated',
    summary_version: SUMMARY_VERSION,
    key_topics: ['asyncio'],
    inventory: 'f.md — 1 section, 5 paragraphs',
    children: [], chunking_model: 'skeleton-v1',
  };
  const propPayload = buildNavPointPayload(propNav, {});
  ok('propagated: summary_kind passes through payload', propPayload.summary_kind === 'propagated');
  ok('propagated: summary_version passes through',      propPayload.summary_version === SUMMARY_VERSION);
  ok('propagated: key_topics passes through',           Array.isArray(propPayload.key_topics));
}
