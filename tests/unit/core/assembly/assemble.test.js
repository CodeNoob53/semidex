// Pure tests for src/core/assembly/assemble.js — domain chunks in, ordered
// segment array out. No storage, no HTTP, no network: every fixture is a
// hand-built camelCase domain Chunk exactly as a StorageAdapter returns it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleDocument } from '../../../../src/core/assembly/assemble.js';
import { ASSEMBLY_MODES, SEGMENT_KINDS, ASSEMBLY_WARNINGS } from '../../../../src/core/assembly/contract.js';

// ── Fixture builders (skeleton-shaped domain chunks) ─────────────────────────

function prose({ chunkIndex, text, entityRefs = [], section = 'Setup', sourceFile = 'guide.md' }) {
  return {
    sourceFile, chunkIndex, totalChunks: null, section, text,
    rawContent: null, lang: null, context: 'Setup', tags: [],
    nodeType: 'paragraph', nodeId: `nid-p${chunkIndex}`, nodePath: `${sourceFile}#setup/paragraph-${chunkIndex}`,
    parentId: 'nid-section-setup', headingPath: ['Setup'],
    entityRefs, score: null, isMatch: null,
  };
}

function entity({ chunkIndex, nodeType, ordinal = 1, rawContent, section = 'Setup', sourceFile = 'guide.md', lang = null }) {
  const nodePath = `${sourceFile}#setup/${nodeType}-${ordinal}`;
  return {
    sourceFile, chunkIndex, totalChunks: null, section, text: rawContent,
    rawContent, lang, context: `Setup > ${nodeType}`, tags: [],
    nodeType, nodeId: `nid-${nodeType}-${ordinal}`, nodePath,
    parentId: 'nid-section-setup', headingPath: ['Setup'],
    entityRefs: [], score: null, isMatch: null,
  };
}

function refTo(entityChunk, placeholder) {
  return {
    nodeId: entityChunk.nodeId, nodePath: entityChunk.nodePath,
    nodeType: entityChunk.nodeType, placeholder,
  };
}

const TABLE_PH = '[table node: guide.md#setup/table-1 — A | B]';
const CODE_PH = '[code block node: guide.md#setup/code_block-1 — const x = 1;]';
const CHECK_PH = '[checklist node: guide.md#setup/checklist-1 — - [x] done]';

// ── entity_refs mode: the preferred, stored-refs path ────────────────────────

describe('assembleDocument — entity_refs mode (stored refs)', () => {
  it('prose + table: prose placeholder removed, one entity segment at its own position', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |\n|---|---|\n| 1 | 2 |' });
    const p = prose({ chunkIndex: 0, text: `Options below.\n\n${TABLE_PH}`, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.segments.length, 2);
    assert.equal(out.segments[0].kind, SEGMENT_KINDS.PROSE);
    assert.equal(out.segments[0].text, 'Options below.', 'placeholder line removed, surrounding prose intact');
    assert.equal(out.segments[1].kind, SEGMENT_KINDS.ENTITY);
    assert.equal(out.segments[1].nodeType, 'table');
    assert.equal(out.segments[1].rawContent, '| A | B |\n|---|---|\n| 1 | 2 |', 'authoritative raw content, never context/summary');
    assert.equal(out.segments[1].nodeId, 'nid-table-1');
  });

  it('prose + code block: same shape, lang carried through on the entity segment', () => {
    const code = entity({ chunkIndex: 1, nodeType: 'code_block', rawContent: 'const x = 1;', lang: 'js' });
    const p = prose({ chunkIndex: 0, text: `Snippet:\n\n${CODE_PH}`, entityRefs: [refTo(code, CODE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, code] });

    assert.equal(out.segments[0].text, 'Snippet:');
    assert.equal(out.segments[1].nodeType, 'code_block');
    assert.equal(out.segments[1].lang, 'js');
    assert.equal(out.segments[1].rawContent, 'const x = 1;');
  });

  it('prose + checklist: a hint containing "]" removes cleanly (byte-exact line match)', () => {
    const check = entity({ chunkIndex: 1, nodeType: 'checklist', rawContent: '- [x] done\n- [ ] next' });
    const p = prose({ chunkIndex: 0, text: `Tasks:\n\n${CHECK_PH}`, entityRefs: [refTo(check, CHECK_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, check] });

    assert.equal(out.segments[0].text, 'Tasks:');
    assert.equal(out.segments[1].nodeType, 'checklist');
    assert.equal(out.segments[1].rawContent, '- [x] done\n- [ ] next');
  });

  it('two consecutive entities (both placeholders on the SAME preceding prose) emit two entity segments in original order, no duplicates', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const code = entity({ chunkIndex: 2, nodeType: 'code_block', rawContent: 'const x = 1;' });
    const p = prose({
      chunkIndex: 0,
      text: `Consider both.\n\n${TABLE_PH}\n\n${CODE_PH}`,
      entityRefs: [refTo(table, TABLE_PH), refTo(code, CODE_PH)],
    });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table, code] });

    assert.deepEqual(out.segments.map(s => s.kind), ['prose', 'entity', 'entity']);
    assert.deepEqual(out.segments.slice(1).map(s => s.nodeType), ['table', 'code_block'], 'original chunkIndex order preserved');
    assert.equal(out.segments[0].text, 'Consider both.');
    assert.equal(out.segments.filter(s => s.kind === 'entity' && s.nodeId === 'nid-table-1').length, 1,
      'an entity referenced by prose is never emitted a second time');
  });

  it('entity at section start (placeholder in the FOLLOWING prose): entity segment stays first, prose follows cleaned', () => {
    const table = entity({ chunkIndex: 0, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 1, text: `${TABLE_PH}\n\nFollowing remark.`, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [table, p] });

    assert.deepEqual(out.segments.map(s => s.kind), ['entity', 'prose'], 'entity keeps its original source position (first)');
    assert.equal(out.segments[1].text, 'Following remark.');
  });

  it('exact placeholder removal: only the exact standalone line goes; prose around it is byte-identical', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const before = 'Intro line with  double spaces preserved.';
    const after = 'Outro — em dash and [brackets] kept as-is.';
    const p = prose({ chunkIndex: 0, text: `${before}\n\n${TABLE_PH}\n\n${after}`, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.segments[0].text, `${before}\n\n${after}`);
  });

  it('inline placeholder-looking prose remains untouched (not a standalone line, so never removed)', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const inline = `See ${TABLE_PH} mentioned mid-sentence.`;
    const p = prose({ chunkIndex: 0, text: `${inline}\n\n${TABLE_PH}`, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.segments[0].text, inline, 'the standalone line is removed; the inline lookalike stays byte-for-byte');
  });

  it('a prose chunk that was placeholder-only is omitted entirely (no empty prose segment)', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 0, text: TABLE_PH, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.deepEqual(out.segments.map(s => s.kind), ['entity'], 'no empty prose segment is emitted');
    assert.deepEqual(out.warnings, []);
  });

  it('a ref whose placeholder is NOT in the text produces a warning, removes nothing, fabricates nothing', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 0, text: 'No placeholder here at all.', entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.segments[0].text, 'No placeholder here at all.');
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].code, ASSEMBLY_WARNINGS.REF_PLACEHOLDER_NOT_FOUND);
    assert.equal(out.warnings[0].placeholder, TABLE_PH);
  });

  it('a ref whose entity is absent from the input set warns and KEEPS the placeholder line (pointer never silently lost)', () => {
    // Ref present on the prose, but no table chunk in the input at all.
    const p = prose({
      chunkIndex: 0,
      text: `Options:\n\n${TABLE_PH}`,
      entityRefs: [{ nodeId: 'nid-table-1', nodePath: 'guide.md#setup/table-1', nodeType: 'table', placeholder: TABLE_PH }],
    });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p] });

    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].text, `Options:\n\n${TABLE_PH}`, 'placeholder stays in the prose');
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].code, ASSEMBLY_WARNINGS.REF_ENTITY_MISSING);
    assert.equal(out.segments.filter(s => s.kind === 'entity').length, 0, 'no entity segment is guessed into existence');
  });

  // Code review (first round): partial backfill must not disable the
  // canonical fallback for what stored refs don't cover. An UNRESOLVABLE
  // uncovered placeholder (no entity in scope) stays in the prose with an
  // orphan warning — and because the fallback path had to engage, the whole
  // result is honestly marked placeholder_fallback, not entity_refs.
  it('an uncovered UNRESOLVABLE placeholder (partial backfill drift, entity gone) warns as orphan, stays in prose, and marks the result placeholder_fallback', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    // This chunk has stored refs for the table but its text ALSO carries an
    // uncovered checklist placeholder whose entity is NOT in the scope.
    const p = prose({
      chunkIndex: 0,
      text: `Both below.\n\n${TABLE_PH}\n\n${CHECK_PH}`,
      entityRefs: [refTo(table, TABLE_PH)],
    });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLACEHOLDER_FALLBACK, 'stored refs did not fully cover the scope');
    assert.equal(out.segments[0].text, `Both below.\n\n${CHECK_PH}`, 'covered placeholder removed, unresolvable one kept');
    assert.deepEqual(out.warnings.map(w => w.code),
      [ASSEMBLY_WARNINGS.PLACEHOLDER_FALLBACK, ASSEMBLY_WARNINGS.ORPHAN_PLACEHOLDER]);
    assert.equal(out.warnings[1].placeholder, CHECK_PH);
  });

  // Code review (first round, the exact required case): one entity's refs
  // are backfilled, a sibling's are not — the uncovered placeholder must
  // still resolve through the canonical matcher and be removed, because its
  // entity IS present in the scope. Previously the whole scope switched to
  // stored-refs-only the moment ANY chunk had refs, leaving the code block's
  // placeholder in the assembled text.
  it('mixed scope (table backfilled, code block not): both placeholders removed, both entities emitted, result marked placeholder_fallback', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const code = entity({ chunkIndex: 3, nodeType: 'code_block', rawContent: 'const x = 1;' });
    const pStored = prose({ chunkIndex: 0, text: `Table:\n\n${TABLE_PH}`, entityRefs: [refTo(table, TABLE_PH)] });
    const pUnbackfilled = prose({ chunkIndex: 2, text: `Code:\n\n${CODE_PH}`, entityRefs: [] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [pStored, table, pUnbackfilled, code] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLACEHOLDER_FALLBACK);
    assert.equal(out.segments.find(s => s.chunkIndex === 0).text, 'Table:', 'stored-ref placeholder removed');
    assert.equal(out.segments.find(s => s.chunkIndex === 2).text, 'Code:',
      'the uncovered placeholder resolved via the canonical fallback and was removed — its entity is right there in scope');
    assert.deepEqual(out.segments.filter(s => s.kind === 'entity').map(s => s.nodeType), ['table', 'code_block']);
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].code, ASSEMBLY_WARNINGS.PLACEHOLDER_FALLBACK);
  });

  // Split-entity fragments (entity-split.js): the canonical entity_raw point
  // is deliberately excluded upstream (never returned by getFileChunks/
  // getSectionChunks, same exclusion as skeleton_nav) — only its fragments
  // reach assembleDocument. A stored ref's placeholder still names the
  // CANONICAL entity's own node_id/node_path (placeholders are built from
  // the entity node, never a fragment), so without entityId registration
  // the canonical would appear "absent from scope" even though its
  // fragments are right there — this regression is the exact bug an earlier
  // manual end-to-end check caught (REF_ENTITY_MISSING + placeholder left
  // visible in prose, table split into 2 fragments neither of which shares
  // the canonical's identity).
  it('a placeholder naming a split entity resolves via its fragments (entityId), not the excluded canonical point', () => {
    const canonicalNodeId = 'nid-table-1';
    const canonicalNodePath = 'guide.md#setup/table-1';
    const fragment1 = {
      sourceFile: 'guide.md', chunkIndex: 1, totalChunks: null, section: 'Setup',
      text: '| A | B |\n|---|---|\n| 1 | 2 |', rawContent: '| A | B |\n|---|---|\n| 1 | 2 |',
      lang: null, context: 'Setup > table', tags: [],
      nodeType: 'table', nodeId: 'nid-table-1-fragment-1', nodePath: `${canonicalNodePath}/fragment-1`,
      parentId: 'nid-section-setup', headingPath: ['Setup'],
      entityRefs: [], entityId: canonicalNodeId, fragmentIndex: 0, fragmentCount: 2,
      score: null, isMatch: null,
    };
    const fragment2 = {
      ...fragment1, chunkIndex: 2,
      text: '| A | B |\n|---|---|\n| 3 | 4 |', rawContent: '| A | B |\n|---|---|\n| 3 | 4 |',
      nodeId: 'nid-table-1-fragment-2', nodePath: `${canonicalNodePath}/fragment-2`,
      fragmentIndex: 1,
    };
    const ph = `[table node: ${canonicalNodePath} — A | B]`;
    const p = prose({
      chunkIndex: 0, text: `Options below.\n\n${ph}`,
      entityRefs: [{ nodeId: canonicalNodeId, nodePath: canonicalNodePath, nodeType: 'table', placeholder: ph }],
    });

    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, fragment1, fragment2] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS, 'stored ref fully covers the placeholder — no fallback needed');
    assert.deepEqual(out.warnings, [], 'the canonical entity is considered present because its fragments are in scope');
    assert.equal(out.segments[0].kind, SEGMENT_KINDS.PROSE);
    assert.equal(out.segments[0].text, 'Options below.', 'placeholder removed even though it names the excluded canonical node_path');
    const entitySegments = out.segments.filter(s => s.kind === SEGMENT_KINDS.ENTITY);
    assert.equal(entitySegments.length, 2, 'both fragments emitted as separate entity segments, in order');
    assert.equal(entitySegments[0].rawContent, '| A | B |\n|---|---|\n| 1 | 2 |');
    assert.equal(entitySegments[1].rawContent, '| A | B |\n|---|---|\n| 3 | 4 |');
  });

  it('duplicate refs to the same entity remove both standalone occurrences but still emit exactly one entity segment', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({
      chunkIndex: 0,
      text: `${TABLE_PH}\n\nas shown again:\n\n${TABLE_PH}`,
      entityRefs: [refTo(table, TABLE_PH), refTo(table, TABLE_PH)],
    });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.segments[0].text, 'as shown again:');
    assert.equal(out.segments.filter(s => s.kind === 'entity').length, 1);
    assert.deepEqual(out.warnings, []);
  });

  it('segment field contract: prose and entity segments carry exactly the documented keys', () => {
    // Phase 3X (additive): prose segments now carry nodeId/nodePath, the
    // same stable identity entity segments always had — bounded anchored
    // retrieval needs every segment addressable, prose included.
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [refTo(table, TABLE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.deepEqual(Object.keys(out.segments[0]).sort(),
      ['chunkIndex', 'context', 'headingPath', 'kind', 'nodeId', 'nodePath', 'nodeType', 'section', 'text']);
    assert.deepEqual(Object.keys(out.segments[1]).sort(),
      ['chunkIndex', 'context', 'headingPath', 'kind', 'lang', 'nodeId', 'nodePath', 'nodeType', 'rawContent', 'section']);
    assert.deepEqual(Object.keys(out).sort(),
      ['assemblyMode', 'collection', 'nodePath', 'scope', 'segments', 'sourceFile', 'warnings']);
  });

  it('a prose segment carries its own node identity (nodeId/nodePath), the same shape an entity segment already had', () => {
    const p = prose({ chunkIndex: 0, text: 'Plain prose with no entities.' });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'a.md', chunks: [p] });
    assert.equal(out.segments[0].nodeId, p.nodeId);
    assert.equal(out.segments[0].nodePath, p.nodePath);
    assert.ok(out.segments[0].nodeId, 'sanity: the fixture really has a node id to propagate');
  });

  it('prose segment identity is null for legacy (plain_chunks) input, never fabricated', () => {
    const legacy = { sourceFile: 'old.md', chunkIndex: 0, section: 'Intro', text: 'legacy prose', nodeType: null, entityRefs: [] };
    const out = assembleDocument({ collection: 'legacy', scope: 'file', sourceFile: 'old.md', chunks: [legacy] });
    assert.equal(out.assemblyMode, 'plain_chunks');
    assert.equal(out.segments[0].nodeId, null);
    assert.equal(out.segments[0].nodePath, null);
  });

  // Phase 3X (bounded anchored content, MCP): every segment kind must carry
  // enough identity to be used as a qdrant_get_content anchor_node_id —
  // table identity was already covered above; code_block and checklist are
  // pinned explicitly here since they're the other two structural types the
  // task calls out by name.
  it('a code_block entity segment carries its own nodeId/nodePath', () => {
    const code = entity({ chunkIndex: 1, nodeType: 'code_block', rawContent: 'const x = 1;' });
    const p = prose({ chunkIndex: 0, text: `See:\n\n${CODE_PH}`, entityRefs: [refTo(code, CODE_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, code] });
    const codeSeg = out.segments.find(s => s.nodeType === 'code_block');
    assert.equal(codeSeg.nodeId, code.nodeId);
    assert.equal(codeSeg.nodePath, code.nodePath);
  });

  it('a checklist entity segment carries its own nodeId/nodePath', () => {
    const checklist = entity({ chunkIndex: 1, nodeType: 'checklist', rawContent: '- [x] done' });
    const p = prose({ chunkIndex: 0, text: `See:\n\n${CHECK_PH}`, entityRefs: [refTo(checklist, CHECK_PH)] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, checklist] });
    const clSeg = out.segments.find(s => s.nodeType === 'checklist');
    assert.equal(clSeg.nodeId, checklist.nodeId);
    assert.equal(clSeg.nodePath, checklist.nodePath);
  });

  it('never mutates the input array or any input chunk object', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [refTo(table, TABLE_PH)] });
    const chunks = [p, table];
    const snapshot = JSON.parse(JSON.stringify(chunks));

    assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks });

    assert.deepEqual(JSON.parse(JSON.stringify(chunks)), snapshot, 'input chunks byte-identical after assembly');
    assert.equal(chunks[0].text, `Options:\n\n${TABLE_PH}`, 'prose text untouched on the input object');
  });
});

// ── placeholder_fallback mode: skeleton collection, no backfilled refs ───────

describe('assembleDocument — placeholder_fallback mode (transitional, un-backfilled skeleton collection)', () => {
  it('derives refs from placeholder lines via the canonical matcher and marks the mode + machine-readable warning', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const p = prose({ chunkIndex: 0, text: `Options:\n\n${TABLE_PH}`, entityRefs: [] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p, table] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLACEHOLDER_FALLBACK);
    assert.equal(out.segments[0].text, 'Options:', 'the derived ref still drives exact placeholder removal');
    assert.equal(out.segments[1].kind, SEGMENT_KINDS.ENTITY);
    assert.equal(out.warnings[0].code, ASSEMBLY_WARNINGS.PLACEHOLDER_FALLBACK);
  });

  it('logs the fallback exactly once per request through the injected logFn', () => {
    const table = entity({ chunkIndex: 1, nodeType: 'table', rawContent: '| A | B |' });
    const code = entity({ chunkIndex: 3, nodeType: 'code_block', rawContent: 'x' });
    const p1 = prose({ chunkIndex: 0, text: `A:\n\n${TABLE_PH}`, entityRefs: [] });
    const p2 = prose({ chunkIndex: 2, text: `B:\n\n${CODE_PH}`, entityRefs: [] });
    const logged = [];
    assembleDocument({
      collection: 'c', scope: 'file', sourceFile: 'guide.md',
      chunks: [p1, table, p2, code], logFn: (line) => logged.push(line),
    });
    assert.equal(logged.length, 1, 'one log line per request, not per chunk');
    assert.match(logged[0], /placeholder fallback/);
  });

  it('a fallback orphan (placeholder resolving to no entity) is a warning, never guessed content', () => {
    const p = prose({ chunkIndex: 0, text: `Ghost:\n\n${TABLE_PH}`, entityRefs: [] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLACEHOLDER_FALLBACK);
    assert.equal(out.segments[0].text, `Ghost:\n\n${TABLE_PH}`, 'unresolved placeholder stays in the prose');
    const codes = out.warnings.map(w => w.code);
    assert.ok(codes.includes(ASSEMBLY_WARNINGS.ORPHAN_PLACEHOLDER));
    assert.equal(codes.filter(c => c === ASSEMBLY_WARNINGS.ORPHAN_PLACEHOLDER).length, 1, 'reported once, not duplicated by a second scan');
    assert.equal(out.segments.filter(s => s.kind === 'entity').length, 0);
  });

  it('a skeleton scope with NO placeholders at all stays entity_refs mode (nothing to fall back from) with zero warnings', () => {
    const p = prose({ chunkIndex: 0, text: 'Plain skeleton prose, no entities in this section.', entityRefs: [] });
    const out = assembleDocument({ collection: 'c', scope: 'file', sourceFile: 'guide.md', chunks: [p] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.segments[0].text, 'Plain skeleton prose, no entities in this section.');
  });
});

// ── plain_chunks mode: legacy non-skeleton collections ───────────────────────

describe('assembleDocument — plain_chunks mode (legacy non-skeleton collection)', () => {
  function legacyChunk(chunkIndex, text) {
    return {
      sourceFile: 'old.md', chunkIndex, totalChunks: 3, section: 'Intro', text,
      rawContent: null, lang: null, context: null, tags: [],
      nodeType: null, nodeId: null, nodePath: null, parentId: null, headingPath: null,
      entityRefs: [], score: null, isMatch: null,
    };
  }

  it('returns ordered prose segments, fabricates no entities, marks plain_chunks', () => {
    const out = assembleDocument({
      collection: 'legacy', scope: 'file', sourceFile: 'old.md',
      chunks: [legacyChunk(0, 'First.'), legacyChunk(1, 'Second.'), legacyChunk(2, 'Third.')],
    });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLAIN_CHUNKS);
    assert.deepEqual(out.segments.map(s => [s.kind, s.text]),
      [['prose', 'First.'], ['prose', 'Second.'], ['prose', 'Third.']]);
    assert.deepEqual(out.warnings, []);
  });

  it('legacy text containing bracketed lines is passed through untouched (no placeholder handling at all)', () => {
    const text = 'Legacy notes:\n\n[table node: old.md#s/table-1 — looks like one]\n\nBut this collection predates placeholders.';
    const out = assembleDocument({ collection: 'legacy', scope: 'file', sourceFile: 'old.md', chunks: [legacyChunk(0, text)] });

    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLAIN_CHUNKS);
    assert.equal(out.segments[0].text, text, 'byte-identical — plain_chunks never removes or warns');
    assert.deepEqual(out.warnings, []);
  });

  it('empty input WITHOUT a skeleton marker yields empty plain_chunks segments (nothing to infer from)', () => {
    const out = assembleDocument({ collection: 'c', scope: 'section', sourceFile: 'a.md', nodePath: 'a.md#empty', chunks: [] });
    assert.deepEqual(out.segments, []);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.assemblyMode, ASSEMBLY_MODES.PLAIN_CHUNKS);
  });

  // Code review (first round): a real-but-empty skeleton section must not be
  // mislabeled as a legacy collection. The caller that RESOLVED the skeleton
  // node knows the scope is skeleton — the explicit marker carries that
  // knowledge past the empty chunk array the inference alone can't see into.
  it('empty input WITH skeleton: true is entity_refs (an empty skeleton section is not a legacy collection)', () => {
    const out = assembleDocument({ collection: 'c', scope: 'section', sourceFile: 'a.md', nodePath: 'a.md#empty', chunks: [], skeleton: true });
    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS);
    assert.deepEqual(out.segments, []);
    assert.deepEqual(out.warnings, []);
  });

  it('skeleton: true with legacy-shaped chunks still assembles them as skeleton scope (marker is authoritative)', () => {
    // Degenerate but deterministic: the marker says skeleton, so the chunks
    // go through skeleton assembly — prose with no nodeType has no
    // placeholders/refs and comes out as plain prose segments either way,
    // but the MODE must reflect the marker, not the inference.
    const out = assembleDocument({
      collection: 'c', scope: 'section', sourceFile: 'a.md', nodePath: 'a.md#s', skeleton: true,
      chunks: [{ sourceFile: 'a.md', chunkIndex: 0, section: 'S', text: 'plain', nodeType: null, entityRefs: [] }],
    });
    assert.equal(out.assemblyMode, ASSEMBLY_MODES.ENTITY_REFS);
    assert.deepEqual(out.segments.map(s => [s.kind, s.text]), [['prose', 'plain']]);
  });
});
