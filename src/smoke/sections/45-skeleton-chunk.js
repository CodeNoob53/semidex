// Skeleton task-2 smoke: legacy path intact without the flag, CRLF parity in
// legacy, and chunkFromSkeleton behavior — tiny-code merge, entity emission,
// single placeholder, empty-section suppression.

const DOC = `---
tags: node, basics
---
# Install

Use nvm to manage versions. Run the check below to confirm.

\`\`\`
node -v
\`\`\`

Create the service unit with these directives in mind.

| Directive | Meaning |
|-----------|---------|
| ExecStart | start command |

\`\`\`js
const svc = require('./svc');
const result = svc.start({ retries: 3, timeout: 5000 });
if (!result.ok) throw new Error('startup failed: ' + result.reason);
console.log('started', result.pid);
\`\`\`

## Empty Section

# Tasks

- [x] pull model
- [ ] run indexer
`;

export default async function ({ ok }) {
  console.log('\n[45] skeleton chunking — legacy intact, tiny-code merge, entities');

  const { chunkFile, chunkFileFromPath } = await import('../../indexer/phases/chunk.js');
  const { parseSkeleton } = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../indexer/phases/skeleton-chunk.js');

  // ── legacy intact: flag unset → legacy output unaffected by skeleton modules ─
  const flagBefore = process.env.SKELETON_CHUNKING;
  delete process.env.SKELETON_CHUNKING;

  const legacy = chunkFile('doc.md', DOC, 'doc.md');
  ok('legacy path still produces chunks', legacy.length > 0);
  ok('legacy chunks carry no skeleton fields',
     legacy.every(c => c.node_id === undefined && c.point_kind === undefined));

  // CRLF parity in legacy (CHUNKING_SCHEMA_VERSION v4 behavior).
  const sig = cs => JSON.stringify(cs.map(c => ({ s: c.section, t: c.text, m: c.meta })));
  ok('legacy CRLF input === LF input',
     sig(chunkFile('doc.md', DOC.replace(/\n/g, '\r\n'), 'doc.md')) === sig(legacy));
  ok('legacy CRLF frontmatter parsed',
     chunkFile('doc.md', DOC.replace(/\n/g, '\r\n'), 'doc.md')[0]?.meta?.tags?.length === 2);

  // ── skeleton chunking behavior ───────────────────────────────────────────────
  const chunks = chunkFromSkeleton(parseSkeleton(DOC, { sourceFile: 'doc.md' }), { sourceFile: 'doc.md' });
  const byType = t => chunks.filter(c => c.node_type === t);

  ok('skeleton produces chunks', chunks.length > 0);
  ok('chunkIndex sequential from 0', chunks.every((c, i) => c.chunkIndex === i));
  ok('totalChunks consistent', chunks.every(c => c.totalChunks === chunks.length));
  ok('all chunks are retrieval_content', chunks.every(c => c.point_kind === 'retrieval_content'));
  ok('chunking_model stamped', chunks.every(c => c.chunking_model === 'skeleton-v1'));
  ok('frontmatter meta propagated', chunks.every(c => Array.isArray(c.meta?.tags)));

  // tiny code: merged inline, never a standalone entity
  ok('tiny code merged into prose', byType('paragraph').some(c => c.text.includes('`node -v`')));
  ok('tiny code is NOT an entity', !byType('code_block').some(c => c.text.includes('node -v')));

  // real entities
  ok('table entity emitted whole', byType('table').length === 1 &&
     byType('table')[0].raw_content.includes('ExecStart'));
  ok('big code entity emitted', byType('code_block').length === 1 &&
     byType('code_block')[0].raw_content.includes("svc.start"));
  ok('checklist entity emitted', byType('checklist').length === 1);
  ok('entities carry node_id/parent_id', [...byType('table'), ...byType('code_block')]
     .every(c => typeof c.node_id === 'string' && typeof c.parent_id === 'string'));

  // placeholders: exactly one per entity, inside meaningful prose
  const tablePh = chunks.filter(c => /\[table node: doc\.md#install\/table-1/.test(c.text));
  // Ordinals are STRUCTURAL (assigned at parse time): the merged tiny block
  // consumed code_block-1, so the entity is code_block-2. This keeps node_id
  // stable when CODE_ENTITY_MIN_* thresholds are tuned later.
  const codePh  = chunks.filter(c => /\[code block node: doc\.md#install\/code_block-2/.test(c.text));
  ok('exactly one table placeholder', tablePh.length === 1 && tablePh[0].node_type === 'paragraph');
  ok('exactly one code placeholder',  codePh.length === 1 && codePh[0].node_type === 'paragraph');

  // empty section: no chunk emitted for it, heading-only never becomes content
  ok('empty section emits nothing', !chunks.some(c => c.section === 'Empty Section'));

  // node_id determinism across runs
  const again = chunkFromSkeleton(parseSkeleton(DOC, { sourceFile: 'doc.md' }), { sourceFile: 'doc.md' });
  ok('node_ids deterministic across reindex',
     JSON.stringify(chunks.map(c => c.node_id)) === JSON.stringify(again.map(c => c.node_id)));

  // ── flag branch in chunkFileFromPath (file-level, end to end) ────────────────
  const { writeFileSync, mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'semidex-skel-'));
  const fp = join(dir, 'doc.md');
  writeFileSync(fp, DOC, 'utf8');

  process.env.SKELETON_CHUNKING = '1';
  process.env.TOKEN_COUNT = 'heuristic'; // avoid tokenizer download in smoke
  try {
    const viaPath = await chunkFileFromPath(fp, 'doc.md');
    ok('flag branch returns skeleton chunks', viaPath.some(c => c.chunking_model === 'skeleton-v1'));
    ok('flag branch table entity present', viaPath.some(c => c.node_type === 'table'));
  } finally {
    delete process.env.TOKEN_COUNT;
    if (flagBefore === undefined) delete process.env.SKELETON_CHUNKING;
    else process.env.SKELETON_CHUNKING = flagBefore;
  }
}
