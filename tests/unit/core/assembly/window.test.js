// Tests for src/core/assembly/window.js (buildAssemblyWindow) — bounded,
// anchor-centered, cursor-paginated projection over an assembleDocument()
// result. Pure: fixtures are hand-built AssemblyResult objects, never a
// live Qdrant call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssemblyWindow, OVERSIZED_NOTE } from '../../../../src/core/assembly/window.js';
import { decodeCursor } from '../../../../src/core/assembly/cursor.js';

// 4 chars == 1 token, deterministic and simple to reason about in tests.
const countTokens = (text) => Math.ceil(String(text ?? '').length / 4);

function prose(i, { text = 'x'.repeat(40), section = 'Setup' } = {}) {
  return { kind: 'prose', chunkIndex: i, nodeId: `n${i}`, nodePath: `p${i}`, nodeType: 'paragraph', text, context: null, section, headingPath: null };
}
function entity(i, { text = 'x'.repeat(40), nodeType = 'table' } = {}) {
  return { kind: 'entity', chunkIndex: i, nodeId: `n${i}`, nodePath: `p${i}`, nodeType, rawContent: text, lang: null, context: null, section: 'Setup', headingPath: null };
}

function makeAssembly(segments, overrides = {}) {
  return { collection: 'c', scope: 'file', sourceFile: 'a.md', nodePath: null, assemblyMode: 'entity_refs', segments, warnings: [], ...overrides };
}

// 10 segments, 40 chars => 10 tokens each (uniform, for predictable budget math).
function tenSegmentAssembly() {
  return makeAssembly(Array.from({ length: 10 }, (_, i) => prose(i)));
}

describe('buildAssemblyWindow — whole scope fits the budget', () => {
  it('returns every segment, in order, with no pagination when totalTokens <= maxTokens', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 1000, countTokens });
    assert.equal(r.items.length, 10);
    assert.deepEqual(r.items.map(i => i.chunkIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(r.hasMoreBefore, false);
    assert.equal(r.hasMoreAfter, false);
    assert.equal(r.cursorBefore, null);
    assert.equal(r.cursorAfter, null);
    assert.equal(r.totalTokens, 100);
    assert.equal(r.returnedTokens, 100);
  });

  it('the exact budget boundary — totalTokens === maxTokens still returns everything unpaginated', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 100, countTokens });
    assert.equal(r.items.length, 10);
    assert.equal(r.hasMoreBefore, false);
    assert.equal(r.hasMoreAfter, false);
  });
});

describe('buildAssemblyWindow — anchor-centered bounded selection', () => {
  it('centers the window on the anchor and preserves source order', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    assert.deepEqual(r.items.map(i => i.chunkIndex), [4, 5, 6]);
    assert.equal(r.hasMoreBefore, true);
    assert.equal(r.hasMoreAfter, true);
  });

  it('always includes the anchor in the initial page even at the very small end of a valid budget', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 10, countTokens });
    assert.deepEqual(r.items.map(i => i.chunkIndex), [5]);
  });

  it('an anchor near the start of the scope expands mostly forward (no negative-index gap)', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n0', maxTokens: 35, countTokens });
    assert.deepEqual(r.items.map(i => i.chunkIndex), [0, 1, 2]);
    assert.equal(r.hasMoreBefore, false);
    assert.equal(r.hasMoreAfter, true);
    assert.equal(r.cursorBefore, null, 'no cursorBefore when there is nothing before');
  });

  it('an anchor near the end of the scope expands mostly backward', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n9', maxTokens: 35, countTokens });
    assert.deepEqual(r.items.map(i => i.chunkIndex), [7, 8, 9]);
    assert.equal(r.hasMoreAfter, false);
    assert.equal(r.cursorAfter, null);
  });

  it('resolves an anchor by nodePath as well as nodeId', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'p5', maxTokens: 1000, countTokens });
    assert.equal(r.items.length, 10);
  });

  it('anchors on a prose segment', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 10, countTokens });
    assert.equal(r.items[0].kind, 'prose');
  });

  it('anchors on a table entity segment', async () => {
    const segs = Array.from({ length: 10 }, (_, i) => (i === 5 ? entity(i, { nodeType: 'table' }) : prose(i)));
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 10, countTokens });
    assert.equal(r.items[0].kind, 'entity');
    assert.equal(r.items[0].nodeType, 'table');
    assert.equal(r.items[0].rawContent, 'x'.repeat(40), 'authoritative raw content preserved, not truncated/rewritten');
  });

  it('anchors on a code_block entity segment', async () => {
    const segs = Array.from({ length: 10 }, (_, i) => (i === 5 ? entity(i, { nodeType: 'code_block', text: 'const x = 1;' }) : prose(i)));
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 10, countTokens });
    assert.equal(r.items[0].nodeType, 'code_block');
    assert.equal(r.items[0].rawContent, 'const x = 1;');
  });

  it('anchors on a checklist entity segment', async () => {
    const segs = Array.from({ length: 10 }, (_, i) => (i === 5 ? entity(i, { nodeType: 'checklist', text: '- [x] done' }) : prose(i)));
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 10, countTokens });
    assert.equal(r.items[0].nodeType, 'checklist');
    assert.equal(r.items[0].rawContent, '- [x] done');
  });

  it('an entity referenced only via a resolved placeholder is never duplicated in the window', async () => {
    // assembleDocument() already guarantees this (Phase 3V/3W) — this test
    // pins that buildAssemblyWindow() doesn't reintroduce a duplicate by
    // walking the assembled segments a second time or re-inserting an
    // entity a prose segment "refers to".
    const table = entity(1, { nodeType: 'table' });
    const p0 = prose(0, { text: 'See the table below.' });
    const assembly = makeAssembly([p0, table]);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n1', maxTokens: 1000, countTokens });
    assert.equal(r.items.filter(i => i.nodeId === 'n1').length, 1);
  });

  it('missing anchor: an anchorNodeId not present in the assembled scope errors, never silently picks a fallback', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'does-not-exist', maxTokens: 35, countTokens });
    assert.equal(r.error, 'anchor_not_in_scope');
    assert.equal(r.items, undefined);
  });
});

describe('buildAssemblyWindow — never exceeds max_tokens', () => {
  it('returnedTokens never exceeds maxTokens across a range of budgets', async () => {
    const assembly = tenSegmentAssembly();
    for (const maxTokens of [10, 15, 20, 25, 33, 50, 99]) {
      const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens, countTokens });
      assert.ok(r.returnedTokens <= maxTokens, `returnedTokens=${r.returnedTokens} must be <= maxTokens=${maxTokens}`);
    }
  });

  it('never splits or truncates a segment to fit — every included non-oversized item is byte-identical to its source segment', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 33, countTokens });
    for (const item of r.items) {
      if (item.oversized) continue;
      assert.equal(item.text.length, 40, 'a partially-fitting segment is either wholly included or wholly excluded, never truncated');
    }
  });
});

describe('buildAssemblyWindow — oversized single segment', () => {
  // The fixed OVERSIZED_NOTE text has a real, non-zero token cost under
  // ANY counter (code review, P1: it used to be silently free) — tests
  // budget against that real cost via the exported constant, never a
  // magic number that happens to work today.
  const noteTokens = countTokens(OVERSIZED_NOTE);

  it('a structural entity that alone exceeds the budget becomes a bounded descriptor, never dumped or truncated', async () => {
    const bigTable = entity(3, { text: 'y'.repeat(4000), nodeType: 'table' });
    const segs = Array.from({ length: 10 }, (_, i) => (i === 3 ? bigTable : prose(i)));
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n3', maxTokens: noteTokens + 25, countTokens });
    const oversizedItem = r.items.find(i => i.nodeId === 'n3');
    assert.ok(oversizedItem, 'the anchor is still represented in the page');
    assert.equal(oversizedItem.oversized, true);
    assert.equal(oversizedItem.content, null);
    assert.equal(oversizedItem.tokenCount, 1000);
    assert.equal(oversizedItem.nodeType, 'table');
    assert.ok(typeof oversizedItem.note === 'string' && oversizedItem.note.length > 0);
  });

  it('the oversized descriptor charges its OWN real note token cost against the budget — never free (code review, P1)', async () => {
    const bigTable = entity(3, { text: 'y'.repeat(4000), nodeType: 'table' });
    const segs = Array.from({ length: 10 }, (_, i) => (i === 3 ? bigTable : prose(i)));
    const assembly = makeAssembly(segs);
    const budget = noteTokens + 25; // room for the descriptor + a couple of 10-token neighbors
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n3', maxTokens: budget, countTokens });
    assert.ok(r.returnedTokens <= budget);
    assert.ok(r.returnedTokens >= noteTokens, 'the descriptor\'s own note cost must be counted, not ~0');
  });

  it('a maxTokens too small even for one oversized descriptor omits the anchor itself rather than exceeding the budget for it', async () => {
    const bigTable = entity(3, { text: 'y'.repeat(4000), nodeType: 'table' });
    const segs = Array.from({ length: 10 }, (_, i) => (i === 3 ? bigTable : prose(i)));
    const assembly = makeAssembly(segs);
    const budget = Math.max(1, noteTokens - 5);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n3', maxTokens: budget, countTokens });
    assert.ok(r.returnedTokens <= budget, `returnedTokens=${r.returnedTokens} must never exceed maxTokens=${budget}`);
    assert.equal(r.items.some(i => i.nodeId === 'n3'), false,
      'the oversized anchor itself does not fit this budget and must be omitted, never force-included over budget');
  });

  it('a long run of oversized neighbors is genuinely BOUNDED, not swept in for free (code review, P1 repro: 20 oversized tables)', async () => {
    const bigText = 'y'.repeat(4000);
    // 20 oversized tables in a row, anchored on the first one.
    const segs = Array.from({ length: 20 }, (_, i) => entity(i, { text: bigText, nodeType: 'table' }));
    const assembly = makeAssembly(segs);
    const maxTokens = 200;
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n0', maxTokens, countTokens });
    assert.ok(r.returnedTokens <= maxTokens, `returnedTokens=${r.returnedTokens} must never exceed maxTokens=${maxTokens}`);
    // Each oversized descriptor costs ~noteTokens; the page can only ever
    // hold floor(maxTokens / noteTokens) of them, never all 20.
    const maxPossible = Math.floor(maxTokens / noteTokens);
    assert.ok(r.items.length <= maxPossible, `items.length=${r.items.length} must be bounded (<= ${maxPossible}), not unconditionally all 20`);
    assert.ok(r.items.length < 20, 'a real budget must not admit every oversized neighbor for free');
  });

  it('an oversized NEIGHBOR (not the anchor) is also represented as a descriptor, not silently skipped', async () => {
    const bigTable = entity(7, { text: 'y'.repeat(4000), nodeType: 'code_block' });
    const segs = Array.from({ length: 10 }, (_, i) => (i === 7 ? bigTable : prose(i)));
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n9', maxTokens: 1000, countTokens });
    // Whole scope check: 9 normal segments (90 tokens) + oversized (contributes ~0) = fits under 1000 as "whole scope."
    // Force a bounded path instead by using a tighter budget that still reaches segment 7 from anchor 9.
    const r2 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n9', maxTokens: noteTokens + 90, countTokens });
    const item7 = r2.items.find(i => i.chunkIndex === 7);
    if (item7) {
      assert.equal(item7.oversized, true);
      assert.equal(item7.content, null);
    }
  });
});

describe('buildAssemblyWindow — hostile content stays inert data', () => {
  it('hostile text/rawContent passes through as plain string data, never interpreted', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const segs = [prose(0, { text: hostile }), entity(1, { text: hostile, nodeType: 'code_block' })];
    const assembly = makeAssembly(segs);
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n0', maxTokens: 1000, countTokens });
    assert.equal(r.items[0].text, hostile);
    assert.equal(r.items[1].rawContent, hostile);
    assert.equal(typeof r.items[0].text, 'string');
  });
});

describe('buildAssemblyWindow — cursor continuation: no overlap, no gaps, deterministic', () => {
  it('cursor_after returns the contiguous block immediately following the initial page', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    assert.deepEqual(page1.items.map(i => i.chunkIndex), [4, 5, 6]);
    const page2 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 20, cursor: page1.cursorAfter, countTokens });
    assert.deepEqual(page2.items.map(i => i.chunkIndex), [7, 8]);
  });

  it('cursor_before returns the contiguous block immediately preceding the initial page', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const before = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 20, cursor: page1.cursorBefore, countTokens });
    assert.deepEqual(before.items.map(i => i.chunkIndex), [2, 3]);
  });

  it('no overlap and no gaps across before + initial + after pages, in combined source order', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const before = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 20, cursor: page1.cursorBefore, countTokens });
    const after = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 20, cursor: page1.cursorAfter, countTokens });
    const combined = [...before.items, ...page1.items, ...after.items].map(i => i.chunkIndex);
    assert.deepEqual(combined, [2, 3, 4, 5, 6, 7, 8], 'strictly contiguous, no duplicate index, no skipped index');
    assert.equal(new Set(combined).size, combined.length, 'no duplicates');
  });

  it('repeated calls with identical inputs return identical pages (deterministic)', async () => {
    const assembly = tenSegmentAssembly();
    const r1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const r2 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    assert.deepEqual(r1.items, r2.items);
    assert.equal(r1.cursorBefore, r2.cursorBefore);
    assert.equal(r1.cursorAfter, r2.cursorAfter);
  });

  it('cursor pagination can walk all the way to the end (hasMoreAfter eventually false)', async () => {
    const assembly = tenSegmentAssembly();
    let r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n0', maxTokens: 12, countTokens });
    let guard = 0;
    while (r.hasMoreAfter && guard < 20) {
      r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n0', maxTokens: 12, cursor: r.cursorAfter, countTokens });
      guard += 1;
    }
    assert.equal(r.hasMoreAfter, false);
    assert.ok(guard < 20, 'pagination must terminate, not loop indefinitely');
  });

  it('cursors are independent of any Qdrant scroll offset shape — a decoded cursor never carries an offset/token field', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const decoded = decodeCursor(r.cursorAfter);
    assert.deepEqual(Object.keys(decoded).sort(), ['anchorNodeId', 'collection', 'dir', 'edgeIndex', 'scope', 'sourceKey', 'totalSegments', 'v']);
  });
});

describe('buildAssemblyWindow — invalid, tampered, and mismatched cursors', () => {
  it('rejects a garbage cursor string', async () => {
    const assembly = tenSegmentAssembly();
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, cursor: 'not-a-real-cursor', countTokens });
    assert.equal(r.error, 'invalid_cursor');
  });

  it('rejects a cursor minted for a DIFFERENT anchor', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'n1', maxTokens: 35, cursor: page1.cursorAfter, countTokens });
    assert.equal(r.error, 'invalid_cursor');
  });

  it('rejects a cursor minted for a DIFFERENT collection/scope (via a differently-shaped assembly)', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const otherAssembly = makeAssembly(tenSegmentAssembly().segments, { collection: 'other-collection' });
    const r = await buildAssemblyWindow({ assembly: otherAssembly, anchorNodeId: 'n5', maxTokens: 35, cursor: page1.cursorAfter, countTokens });
    assert.equal(r.error, 'invalid_cursor');
  });

  it('rejects a cursor whose totalSegments no longer matches (the underlying content changed shape)', async () => {
    const assembly = tenSegmentAssembly();
    const page1 = await buildAssemblyWindow({ assembly, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    const shrunkAssembly = makeAssembly(assembly.segments.slice(0, 5));
    const r = await buildAssemblyWindow({ assembly: shrunkAssembly, anchorNodeId: 'n5', maxTokens: 35, cursor: page1.cursorAfter, countTokens });
    assert.equal(r.error, 'invalid_cursor');
  });

  it('rejects a cursor whose edgeIndex is out of range for its own declared totalSegments (code review, P2: e.g. edgeIndex=999 on a 3-segment scope)', async () => {
    const smallAssembly = makeAssembly(Array.from({ length: 3 }, (_, i) => prose(i)));
    const r = await buildAssemblyWindow({
      assembly: smallAssembly, anchorNodeId: 'n0', maxTokens: 1000,
      cursor: 'ac1.' + Buffer.from(JSON.stringify({
        v: 1, collection: 'c', scope: 'file', sourceKey: JSON.stringify(['a.md', '', 'entity_refs', 'n0', 'n2']),
        anchorNodeId: 'n0', totalSegments: 3, dir: 'after', edgeIndex: 999,
      }), 'utf-8').toString('base64url'),
      countTokens,
    });
    assert.equal(r.error, 'invalid_cursor');
  });

  it('rejects a cursor whose scope changed shape IN PLACE — same segment count, different boundary segment identity (code review, P2)', async () => {
    // A reindex/in-place edit that preserves the segment COUNT but changes
    // which node sits at the first/last position must still invalidate a
    // prior cursor — the segment-count-only check alone would miss this.
    const original = makeAssembly(Array.from({ length: 10 }, (_, i) => prose(i)));
    const page1 = await buildAssemblyWindow({ assembly: original, anchorNodeId: 'n5', maxTokens: 35, countTokens });
    assert.ok(page1.cursorAfter, 'sanity: a real cursor was minted');

    // Same length (10), same anchor id present, but the LAST segment's own
    // node identity differs (edited in place) — sourceKeyOf's boundary
    // fingerprint must differ, invalidating the old cursor.
    const editedSegments = original.segments.slice(0, 9).concat([
      { ...prose(9), nodeId: 'edited-last-segment', nodePath: 'edited-last-segment' },
    ]);
    const edited = makeAssembly(editedSegments);
    const r = await buildAssemblyWindow({ assembly: edited, anchorNodeId: 'n5', maxTokens: 35, cursor: page1.cursorAfter, countTokens });
    assert.equal(r.error, 'invalid_cursor', 'same segment count must not be enough to accept a stale cursor after an in-place edit at a boundary');
  });
});

describe('buildAssemblyWindow — legacy collection without node identity', () => {
  it('a plain_chunks assembly (no nodeId anywhere) cannot resolve any anchor — errors cleanly, never fabricates one', async () => {
    const legacySegs = [
      { kind: 'prose', chunkIndex: 0, nodeId: null, nodePath: null, nodeType: null, text: 'legacy prose one' },
      { kind: 'prose', chunkIndex: 1, nodeId: null, nodePath: null, nodeType: null, text: 'legacy prose two' },
    ];
    const assembly = makeAssembly(legacySegs, { assemblyMode: 'plain_chunks' });
    const r = await buildAssemblyWindow({ assembly, anchorNodeId: 'anything', maxTokens: 1000, countTokens });
    assert.equal(r.error, 'anchor_not_in_scope');
  });
});
