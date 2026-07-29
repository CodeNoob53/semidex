// Tests for src/indexer/entity-reference.js (placeholderForReference,
// attachEntityRefs) — both as a standalone pure module and end-to-end
// through chunkFromSkeleton(), since entity_refs must describe the chunk's
// FINAL text (including placeholders chunkFromSkeleton appends post-hoc),
// not just what attachEntityRefs() does to a hand-built fixture in
// isolation.
//
// Resolution is EXACT MATCHING BY node_path (code review, third round) —
// attachEntityRefs() never parses a placeholder's interior to recover a
// path/hint split (that split is fundamentally ambiguous: a node_path's
// source_file component and a hint can each independently contain spaces
// or em dashes). Instead it checks whether a placeholder-shaped span's
// content, after "node: ", exactly equals — or starts with, immediately
// followed by " — " — one of the KNOWN, real node_path values from entity
// chunks in the same (source_file, section) scope. There is deliberately
// no standalone "extract a placeholder's node_path from arbitrary text"
// function any more — resolution always requires the entity context.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachEntityRefs, placeholderForReference, PLACEHOLDER_LINE_RE } from '../../../src/core/entity-reference.js';
import { parseSkeleton } from '../../../src/indexer/phases/skeleton.js';
import { chunkFromSkeleton } from '../../../src/indexer/phases/skeleton-chunk.js';

async function chunkSkeletonDoc(markdown, sourceFile = 'doc.md') {
  const nodes = parseSkeleton(markdown, { sourceFile });
  const { chunks } = await chunkFromSkeleton(nodes, { sourceFile });
  return chunks;
}

describe('placeholderForReference — single source of truth for the placeholder format', () => {
  it('builds "[table node: <path> — <hint>]" for a table', () => {
    const ph = placeholderForReference('a.md', { nodeType: 'table', text: 'Option | Default\n---|---' }, 'a.md#setup/table-1');
    assert.equal(ph, '[table node: a.md#setup/table-1 — Option | Default]');
  });

  it('builds "[code block node: ...]" (two-word label) for code_block', () => {
    const ph = placeholderForReference('a.md', { nodeType: 'code_block', text: 'const x = 1;' }, 'a.md#setup/code_block-1');
    assert.equal(ph, '[code block node: a.md#setup/code_block-1 — const x = 1;]');
  });

  it('builds "[checklist node: ...]" for a checklist', () => {
    const ph = placeholderForReference('a.md', { nodeType: 'checklist', text: '- [x] done' }, 'a.md#tasks/checklist-1');
    assert.equal(ph, '[checklist node: a.md#tasks/checklist-1 — - [x] done]');
  });

  it('omits the " — <hint>" suffix when the node has no text', () => {
    const ph = placeholderForReference('a.md', { nodeType: 'table', text: '' }, 'a.md#setup/table-1');
    assert.equal(ph, '[table node: a.md#setup/table-1]');
  });

  it('truncates the hint to the first line, max 60 chars', () => {
    const longFirstLine = 'x'.repeat(100);
    const ph = placeholderForReference('a.md', { nodeType: 'table', text: `${longFirstLine}\nsecond line` }, 'a.md#s/table-1');
    assert.equal(ph, `[table node: a.md#s/table-1 — ${'x'.repeat(60)}]`);
  });
});

describe('PLACEHOLDER_LINE_RE — the canonical whole-line "looks like a placeholder" pattern (shared with node-policy.js)', () => {
  it('matches a full placeholder line', () => {
    assert.ok(PLACEHOLDER_LINE_RE.test('[table node: a.md#s/table-1 — hint]'));
    assert.ok(PLACEHOLDER_LINE_RE.test('[checklist node: a.md#s/checklist-1]'));
  });

  it('does not match prose containing a placeholder as a substring (line-anchored)', () => {
    assert.equal(PLACEHOLDER_LINE_RE.test('prefix [table node: a.md#s/table-1] suffix'), false);
  });

  it('matches even when the hint contains its own "]" (a checklist item)', () => {
    const ph = placeholderForReference('tasks.md', { nodeType: 'checklist', text: '- [x] done' }, 'tasks.md#todo/checklist-1');
    assert.ok(PLACEHOLDER_LINE_RE.test(ph));
  });
});

describe('attachEntityRefs — exact matching against a hand-built chunk array', () => {
  const tableEntity = {
    node_type: 'table', node_id: 'nid-table-1', node_path: 'a.md#setup/table-1',
    source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
    text: '| A | B |', entity_refs: undefined,
  };
  const codeEntity = {
    node_type: 'code_block', node_id: 'nid-code-1', node_path: 'a.md#setup/code_block-1',
    source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
    text: 'const x = 1;', entity_refs: undefined,
  };

  it('one table after prose: attaches a single-entry entity_refs to the prose chunk', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'Configuration options:\n\n[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity]);
    assert.deepEqual(orphans, []);
    assert.deepEqual(chunks[0].entity_refs, [
      { node_id: 'nid-table-1', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — A | B]' },
    ]);
    assert.equal(chunks[1].entity_refs, undefined, 'the entity chunk itself never receives entity_refs');
  });

  it('multiple entities referenced from one chunk are returned in textual order', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'See both:\n\n[code block node: a.md#setup/code_block-1 — x]\n\n[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks } = attachEntityRefs([prose, tableEntity, codeEntity]);
    assert.deepEqual(chunks[0].entity_refs.map(r => r.node_path), [
      'a.md#setup/code_block-1', 'a.md#setup/table-1',
    ], 'order matches placeholder order in the text (code first), not entity-array order');
  });

  it('two placeholders in one chunk preserve textual order even when listed out of that order in the chunk array', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'First the table:\n\n[table node: a.md#setup/table-1 — A | B]\n\nThen the code:\n\n[code block node: a.md#setup/code_block-1 — x]',
    };
    // codeEntity listed BEFORE tableEntity in the input array — resolution
    // order must still follow TEXT position, not chunk-array position.
    const { chunks } = attachEntityRefs([prose, codeEntity, tableEntity]);
    assert.deepEqual(chunks[0].entity_refs.map(r => r.node_path), [
      'a.md#setup/table-1', 'a.md#setup/code_block-1',
    ]);
  });

  it('unrelated bracketed prose on its own line next to a real placeholder on its own line does not produce a spurious ref', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'See [the appendix] below.\n\n[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks } = attachEntityRefs([prose, tableEntity]);
    assert.equal(chunks[0].entity_refs.length, 1);
    assert.equal(chunks[0].entity_refs[0].placeholder, '[table node: a.md#setup/table-1 — A | B]', 'the resolved placeholder must be byte-exact');
  });

  // Regression (code review, fifth round): a placeholder-shaped substring
  // embedded INLINE within a larger line of ordinary prose is never a real
  // placeholder — skeleton-chunk.js only ever emits one as its own whole
  // line/paragraph — so it must be ignored entirely: no ref, no orphan.
  it('a placeholder-shaped string embedded inline within a line of prose (not its own whole line) is ignored, not matched or orphaned', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'See [table node: a.md#setup/table-1 — A | B] below.',
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity]);
    assert.equal(chunks[0].entity_refs, undefined, 'an inline mention must not resolve to a ref');
    assert.deepEqual(orphans, [], 'an inline mention is not a real placeholder, so it must not be reported as an orphan either');
  });

  // Regression (code review, fourth round): scanPlaceholderShapedSpans()
  // used to bound a placeholder's closing "]" search by "the next prefix
  // occurrence, or end of the WHOLE TEXT" — when the placeholder was
  // followed (on a LATER line, separated by "\n\n") by ordinary Markdown
  // bracketed prose with no placeholder prefix of its own (e.g.
  // "[appendix]"), that later bracket's "]" became "the last ']' in the
  // window" and got swallowed into the FIRST placeholder's match, producing
  // a corrupted `placeholder`/`raw` value spanning both lines. Confirmed
  // broken before this fix: entity_refs[0].placeholder came back as
  // '[table node: a.md#s/table-1 — A | B]\n\nSee [appendix]' instead of
  // stopping at the real closing bracket on line 1.
  it('a placeholder followed by unrelated bracketed prose on a LATER line resolves to a byte-exact placeholder, never swallowing the later bracket', () => {
    const entity = {
      node_type: 'table', node_id: 'nid-late', node_path: 'a.md#s/table-1',
      source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content', text: 'A | B',
    };
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: '[table node: a.md#s/table-1 — A | B]\n\nSee [appendix] for details.',
    };
    const { chunks, orphans } = attachEntityRefs([prose, entity]);
    assert.deepEqual(orphans, []);
    assert.equal(chunks[0].entity_refs.length, 1);
    assert.equal(chunks[0].entity_refs[0].placeholder, '[table node: a.md#s/table-1 — A | B]');
  });

  it('two placeholder lines without an intervening blank line both resolve', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: '[table node: a.md#setup/table-1 — A | B]\n[code block node: a.md#setup/code_block-1 — x]',
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity, codeEntity]);
    assert.deepEqual(orphans, []);
    assert.deepEqual(chunks[0].entity_refs.map(ref => ref.node_path), [
      'a.md#setup/table-1',
      'a.md#setup/code_block-1',
    ]);
  });

  it('duplicate-looking placeholders (same node referenced twice in one chunk) both resolve, in order', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: '[table node: a.md#setup/table-1 — A | B]\n\nas shown again:\n\n[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks } = attachEntityRefs([prose, tableEntity]);
    assert.equal(chunks[0].entity_refs.length, 2);
    assert.ok(chunks[0].entity_refs.every(r => r.node_path === 'a.md#setup/table-1'));
  });

  it('an orphan placeholder (well-formed, but no matching entity chunk) is reported, not fabricated', () => {
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'Missing:\n\n[table node: a.md#setup/table-99 — ghost]',
    };
    const { chunks, orphans } = attachEntityRefs([prose]);
    assert.equal(chunks[0].entity_refs, undefined, 'no ref is fabricated for an orphan');
    assert.deepEqual(orphans, [{ chunkIndex: 0, sourceFile: 'a.md', placeholder: '[table node: a.md#setup/table-99 — ghost]' }]);
  });

  it('never links a placeholder to an entity from a different section, even with the same node_path text', () => {
    const otherSectionEntity = { ...tableEntity, section: 'Other Section' };
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: '[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks, orphans } = attachEntityRefs([prose, otherSectionEntity]);
    assert.equal(chunks[0].entity_refs, undefined, 'entity in a different section must not resolve');
    assert.equal(orphans.length, 1);
  });

  it('never links a placeholder to an entity from a different file, even with the same node_path text', () => {
    const otherFileEntity = { ...tableEntity, source_file: 'b.md' };
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: '[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks, orphans } = attachEntityRefs([prose, otherFileEntity]);
    assert.equal(chunks[0].entity_refs, undefined);
    assert.equal(orphans.length, 1);
  });

  it('structural (table/code_block/checklist) chunks never receive entity_refs even if their own text happens to contain a placeholder-shaped string', () => {
    const weirdTable = { ...tableEntity, text: '| [table node: a.md#setup/table-1] |' };
    const { chunks } = attachEntityRefs([weirdTable]);
    assert.equal(chunks[0].entity_refs, undefined);
  });

  it('nav (skeleton_nav) chunks never receive entity_refs', () => {
    const navChunk = {
      node_type: 'section', source_file: 'a.md', section: 'Setup', point_kind: 'skeleton_nav',
      text: '[table node: a.md#setup/table-1 — A | B]',
    };
    const { chunks } = attachEntityRefs([navChunk, tableEntity]);
    assert.equal(chunks[0].entity_refs, undefined);
  });

  it('a chunk with no placeholder at all is returned unchanged (same object reference)', () => {
    const prose = { node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content', text: 'no entities mentioned here' };
    const { chunks } = attachEntityRefs([prose]);
    assert.equal(chunks[0], prose, 'unchanged chunks are returned by reference, not cloned');
  });

  // Regression (code review, round 1 P1): attachEntityRefs() must always
  // FULLY RECOMPUTE entity_refs from the chunk's current text — never echo
  // back a stale entity_refs value the input object happened to already
  // carry.
  it('a chunk with a STALE entity_refs but no placeholder in its current text has entity_refs removed, not echoed back', () => {
    const staleProse = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'The placeholder was removed from this text at some point.',
      entity_refs: [{ node_id: 'stale', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
    };
    const { chunks } = attachEntityRefs([staleProse]);
    assert.equal(chunks[0].entity_refs, undefined, 'stale entity_refs must be cleared (key removed), not left as-is');
    assert.notEqual(chunks[0], staleProse, 'a chunk whose entity_refs actually changed must be a new object, not the original reference');
  });

  it('a chunk with a STALE entity_refs whose only placeholder is now an orphan also has entity_refs cleared', () => {
    const staleProse = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: 'Still mentions it:\n\n[table node: a.md#setup/table-1 — old]',
      entity_refs: [{ node_id: 'stale', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
    };
    // No entity chunk for a.md#setup/table-1 in this array — genuinely gone.
    const { chunks, orphans } = attachEntityRefs([staleProse]);
    assert.equal(chunks[0].entity_refs, undefined);
    assert.equal(orphans.length, 1);
  });
});

// Regression (code review, third round): node_path/hint parsing is
// fundamentally ambiguous when either the source_file (part of node_path)
// or the hint can independently contain " — " (em dash) or other
// "separator-shaped" characters. All four cases below were confirmed
// broken (orphaned) before switching to exact node_path matching, using
// the EXACT reproductions from the review.
describe('attachEntityRefs — em-dash-in-path and em-dash-in-hint ambiguity (code review, third round)', () => {
  it('a source_file containing " — " (em dash) resolves correctly — "docs/Guide — Draft.md"', () => {
    const nodePath = 'docs/Guide — Draft.md#setup/table-1';
    const tableEntity = {
      node_type: 'table', node_id: 'nid-1', node_path: nodePath,
      source_file: 'docs/Guide — Draft.md', section: 'Setup', point_kind: 'retrieval_content', text: 'x',
    };
    const ph = placeholderForReference('docs/Guide — Draft.md', { nodeType: 'table', text: 'x' }, nodePath);
    const prose = {
      node_type: 'paragraph', source_file: 'docs/Guide — Draft.md', section: 'Setup', point_kind: 'retrieval_content',
      text: `See below.\n\n${ph}`,
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity]);
    assert.deepEqual(orphans, [], 'an em dash inside the source_file must not orphan the reference');
    assert.equal(chunks[0].entity_refs?.[0]?.node_id, 'nid-1');
    assert.equal(chunks[0].entity_refs?.[0]?.node_path, nodePath);
  });

  it('a hint containing " — " resolves correctly — hint "Option — Default"', () => {
    const tableEntity = {
      node_type: 'table', node_id: 'nid-2', node_path: 'a.md#setup/table-1',
      source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content', text: 'Option — Default',
    };
    const ph = placeholderForReference('a.md', { nodeType: 'table', text: 'Option — Default' }, 'a.md#setup/table-1');
    assert.equal(ph, '[table node: a.md#setup/table-1 — Option — Default]');
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: `See:\n\n${ph}`,
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity]);
    assert.deepEqual(orphans, [], 'an em dash inside the hint must not orphan the reference');
    assert.equal(chunks[0].entity_refs?.[0]?.node_id, 'nid-2');
    assert.equal(chunks[0].entity_refs?.[0]?.node_path, 'a.md#setup/table-1', 'the resolved node_path must be the real, short path — never "...table-1 — Option"');
  });

  it('a Cyrillic source_file path containing both a space and a dash resolves correctly', () => {
    const sourceFile = 'Документи/Тема 1 — Вступ.md';
    const nodePath = `${sourceFile}#setup/table-1`;
    const tableEntity = {
      node_type: 'table', node_id: 'nid-3', node_path: nodePath,
      source_file: sourceFile, section: 'Налаштування', point_kind: 'retrieval_content', text: 'Опція | Типово',
    };
    const ph = placeholderForReference(sourceFile, { nodeType: 'table', text: 'Опція | Типово' }, nodePath);
    const prose = {
      node_type: 'paragraph', source_file: sourceFile, section: 'Налаштування', point_kind: 'retrieval_content',
      text: `Дивіться таблицю нижче.\n\n${ph}`,
    };
    const { chunks, orphans } = attachEntityRefs([prose, tableEntity]);
    assert.deepEqual(orphans, [], 'a Cyrillic path with a space and a dash must not orphan the reference');
    assert.equal(chunks[0].entity_refs?.[0]?.node_id, 'nid-3');
    assert.equal(chunks[0].entity_refs?.[0]?.node_path, nodePath);
  });

  it('a checklist hint containing a literal "]" ("- [x] done") resolves correctly', () => {
    const checklistEntity = {
      node_type: 'checklist', node_id: 'nid-cl-1', node_path: 'tasks.md#todo/checklist-1',
      source_file: 'tasks.md', section: 'Tasks', point_kind: 'retrieval_content', text: '- [x] done',
    };
    const ph = placeholderForReference('tasks.md', { nodeType: 'checklist', text: '- [x] done' }, 'tasks.md#todo/checklist-1');
    assert.equal(ph, '[checklist node: tasks.md#todo/checklist-1 — - [x] done]');
    const prose = {
      node_type: 'paragraph', source_file: 'tasks.md', section: 'Tasks', point_kind: 'retrieval_content',
      text: `Complete the checklist below:\n\n${ph}`,
    };
    const { chunks, orphans } = attachEntityRefs([prose, checklistEntity]);
    assert.deepEqual(orphans, [], 'a checklist hint containing "]" must not orphan the reference');
    assert.equal(chunks[0].entity_refs?.[0]?.node_id, 'nid-cl-1');
    assert.equal(chunks[0].entity_refs?.[0]?.placeholder, ph, 'the stored placeholder must be the exact, untruncated text');
  });

  it('an ordinal-suffix collision (table-1 vs table-10) resolves to the CORRECT, longer path, never the shorter prefix', () => {
    const entity1 = {
      node_type: 'table', node_id: 'nid-t1', node_path: 'a.md#s/table-1',
      source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content', text: 'x',
    };
    const entity10 = {
      node_type: 'table', node_id: 'nid-t10', node_path: 'a.md#s/table-10',
      source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content', text: 'y',
    };
    const ph10 = placeholderForReference('a.md', { nodeType: 'table', text: 'y' }, 'a.md#s/table-10');
    const prose = {
      node_type: 'paragraph', source_file: 'a.md', section: 'Setup', point_kind: 'retrieval_content',
      text: `See:\n\n${ph10}`,
    };
    const { chunks, orphans } = attachEntityRefs([prose, entity1, entity10]);
    assert.deepEqual(orphans, []);
    assert.equal(chunks[0].entity_refs?.[0]?.node_id, 'nid-t10', 'must resolve to table-10, not falsely match table-1 as a prefix');
  });
});

describe('attachEntityRefs — end to end through chunkFromSkeleton (real prose text assembly)', () => {
  it('one table after prose gets a real entity_refs entry with a real node_id', async () => {
    const doc = `# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n`;
    const chunks = await chunkSkeletonDoc(doc);
    const prose = chunks.find(c => c.node_type === 'paragraph');
    const table = chunks.find(c => c.node_type === 'table');
    assert.ok(prose.entity_refs?.length === 1);
    assert.equal(prose.entity_refs[0].node_id, table.node_id, 'the ref points at the SAME node_id the table chunk itself carries');
    assert.equal(prose.entity_refs[0].node_path, table.node_path);
    assert.equal(prose.entity_refs[0].node_type, 'table');
  });

  it('consecutive entities (table immediately followed by code, no prose between) both attach to the SAME preceding prose chunk, in order', async () => {
    const doc = `# Setup\n\nConsider these two references together.\n\n`
      + `| A | B |\n|---|---|\n| 1 | 2 |\n\n`
      + '```python\ndef handler(event, context):\n    process(event)\n    validate(event)\n'
      + '    log_metrics(event)\n    return {"status": "ok", "code": 200, "at": now()}\n```\n\n'
      + 'More closing remark text about setup goes here.\n';
    const chunks = await chunkSkeletonDoc(doc);
    const table = chunks.find(c => c.node_type === 'table');
    const code = chunks.find(c => c.node_type === 'code_block');
    const proseWithRefs = chunks.find(c => c.node_type === 'paragraph' && c.entity_refs?.length === 2);
    assert.ok(proseWithRefs, 'exactly one prose chunk carries both refs');
    assert.deepEqual(proseWithRefs.entity_refs.map(r => r.node_id), [table.node_id, code.node_id]);
  });

  it('an entity at the very start of a section (no preceding prose) attaches to the FOLLOWING prose chunk', async () => {
    const doc = `# Setup\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nFollowing remark about the table above.\n`;
    const chunks = await chunkSkeletonDoc(doc);
    const table = chunks.find(c => c.node_type === 'table');
    const prose = chunks.find(c => c.node_type === 'paragraph');
    assert.ok(prose.text.startsWith('[table node:'), 'placeholder is prepended to the following prose text');
    assert.equal(prose.entity_refs?.[0]?.node_id, table.node_id);
  });

  it('no cross-section attachment: an entity in one section is never referenced by prose in a different section', async () => {
    const doc = `# Setup\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n# Other\n\nUnrelated prose in a different section entirely with no table mention.\n`;
    const chunks = await chunkSkeletonDoc(doc);
    const otherProse = chunks.find(c => c.section === 'Other' && c.node_type === 'paragraph');
    assert.equal(otherProse.entity_refs, undefined, 'a later section\'s prose must never pick up an earlier section\'s orphaned entity');
  });

  it('structural and nav chunks never carry entity_refs in the real chunker output', async () => {
    const doc = `# Setup\n\nSome intro text before the table appears here.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`;
    const chunks = await chunkSkeletonDoc(doc);
    const table = chunks.find(c => c.node_type === 'table');
    assert.equal(table.entity_refs, undefined);
    // chunkFromSkeleton() itself never emits nav (section/file/collection)
    // points — that's skeleton-index.js's job — so this collection's chunks
    // are entirely prose/entity retrieval_content, confirming there is no
    // nav-shaped chunk in this array to accidentally pick up a ref either.
    assert.ok(chunks.every(c => c.point_kind === 'retrieval_content'));
  });

  // Regression through the REAL chunker — a checklist item's own text
  // ("- [x] ...") is exactly the shape that produces a hint containing "]",
  // so this exercises placeholderFor() (skeleton-chunk.js) ->
  // placeholderForReference() -> attachEntityRefs() as one real pipeline.
  it('a checklist entity (whose own content contains "]") gets a real, correctly-resolved entity_refs entry', async () => {
    const doc = `# Tasks\n\nComplete the checklist below before shipping the release.\n\n`
      + '- [x] pull model\n- [ ] run indexer\n- [ ] verify output correctness across every supported platform target\n';
    const chunks = await chunkSkeletonDoc(doc, 'tasks.md');
    const checklist = chunks.find(c => c.node_type === 'checklist');
    const prose = chunks.find(c => c.node_type === 'paragraph');
    assert.ok(checklist, 'fixture must actually produce a real checklist entity, not merge it away');
    assert.ok(prose.entity_refs?.length === 1, 'the checklist hint containing "]" must not prevent resolution');
    assert.equal(prose.entity_refs[0].node_id, checklist.node_id);
    assert.equal(prose.entity_refs[0].node_type, 'checklist');
    assert.equal(prose.entity_refs[0].placeholder, prose.text.match(/\[checklist node:.*\]/)?.[0], 'the stored placeholder field must be the exact, untruncated text that actually appears in the prose');
  });

  // Regression through the real chunker — a source_file whose name contains
  // a space (a legitimate, common real-world filename, e.g. an exported
  // Obsidian note) must resolve its own entity references, not silently
  // orphan every one of them.
  it('a source_file whose name contains a space gets a real, correctly-resolved entity_refs entry', async () => {
    const doc = `# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n`;
    const chunks = await chunkSkeletonDoc(doc, 'docs/My Guide.md');
    const table = chunks.find(c => c.node_type === 'table');
    const prose = chunks.find(c => c.node_type === 'paragraph');
    assert.ok(table.node_path.includes('docs/My Guide.md'), 'fixture sanity check — the space really is in the node_path being tested');
    assert.ok(prose.entity_refs?.length === 1, 'a space in the source_file/node_path must not prevent resolution');
    assert.equal(prose.entity_refs[0].node_id, table.node_id);
  });

  // Regression through the real chunker — a source_file whose name itself
  // contains " — " (em dash), the exact review repro ("docs/Guide — Draft.md").
  it('a source_file whose name contains " — " (em dash) gets a real, correctly-resolved entity_refs entry', async () => {
    const doc = `# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n`;
    const chunks = await chunkSkeletonDoc(doc, 'docs/Guide — Draft.md');
    const table = chunks.find(c => c.node_type === 'table');
    const prose = chunks.find(c => c.node_type === 'paragraph');
    assert.ok(table.node_path.startsWith('docs/Guide — Draft.md'), 'fixture sanity check — the em dash really is in the node_path being tested');
    assert.ok(prose.entity_refs?.length === 1, 'an em dash in the source_file/node_path must not prevent resolution');
    assert.equal(prose.entity_refs[0].node_id, table.node_id);
  });
});
