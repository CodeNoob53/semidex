// Tests for src/backfill-entity-refs.js's pure planning core
// (computeBackfillPlan) — network I/O (scrollAllPoints/updatePayload) lives
// only behind the `isMainModule` CLI guard at the bottom of that file and is
// never exercised here; these tests call computeBackfillPlan() directly
// with fixture points, matching the DI-free but I/O-free pattern the rest
// of this module already follows (attachEntityRefs is itself pure).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackfillPlan, runBackfill, PAYLOAD_FIELDS } from '../../../src/backfill-entity-refs.js';
import { parseSkeleton } from '../../../src/indexer/phases/skeleton.js';
import { chunkFromSkeleton } from '../../../src/indexer/phases/skeleton-chunk.js';

// Converts chunkFromSkeleton() output (the real fresh-indexing chunk shape)
// into the { id, payload } point shape scrollAllPoints() would return —
// only the fields PAYLOAD_FIELDS actually requests, so the fixture matches
// exactly what the real backfill script would see over the wire. `prefix`
// keeps ids unique across multiple files combined into one points array
// (real Qdrant point ids are always globally unique within a collection;
// this fixture must not collide the way a naive per-call "pt-0, pt-1, ..."
// counter would when two files are combined).
function toStoredPoints(chunks, prefix = 'pt') {
  return chunks.map((c, i) => ({
    id: `${prefix}-${i}`,
    payload: {
      point_kind: c.point_kind,
      node_type: c.node_type,
      node_id: c.node_id,
      node_path: c.node_path,
      section: c.section,
      source_file: c.source_file,
      text: c.text,
      raw_content: c.raw_content,
      entity_refs: undefined, // simulates a Phase-3T-era collection: never wrote entity_refs
      chunking_model: c.chunking_model,
    },
  }));
}

function chunkSkeletonDoc(markdown, sourceFile = 'doc.md') {
  const nodes = parseSkeleton(markdown, { sourceFile });
  return chunkFromSkeleton(nodes, { sourceFile });
}

describe('computeBackfillPlan — legacy collections', () => {
  it('a legacy (non-skeleton) collection produces zero updates and finishes cleanly', () => {
    const points = [
      { id: 'a', payload: { source_file: 'a.md', text: 'legacy chunk, no chunking_model at all' } },
      { id: 'b', payload: { source_file: 'a.md', text: 'another legacy chunk', chunking_model: 'legacy-v0' } },
    ];
    const plan = computeBackfillPlan(points);
    assert.equal(plan.scanned, 2);
    assert.equal(plan.contentPoints, 0);
    assert.deepEqual(plan.updates, []);
    assert.equal(plan.unchanged, 0);
    assert.deepEqual(plan.orphans, []);
  });

  it('excludes skeleton_nav points from the scan even if chunking_model looks like skeleton-v1', () => {
    const points = [
      { id: 'nav', payload: { point_kind: 'skeleton_nav', chunking_model: 'skeleton-v1', source_file: 'a.md', text: '[table node: a.md#s/table-1]' } },
    ];
    const plan = computeBackfillPlan(points);
    assert.equal(plan.contentPoints, 0);
    assert.deepEqual(plan.updates, []);
  });
});

describe('computeBackfillPlan — dry-run semantics (planning only, no writes performed here)', () => {
  it('computes the exact same plan regardless of a DRY_RUN-style flag — computeBackfillPlan itself never writes; the CLI wrapper decides whether to apply', () => {
    const chunks = chunkSkeletonDoc('# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n');
    const points = toStoredPoints(chunks);
    const plan1 = computeBackfillPlan(points);
    const plan2 = computeBackfillPlan(points);
    assert.deepEqual(plan1, plan2, 'computeBackfillPlan is pure — same input always yields the same plan, independent of any DRY_RUN state');
    assert.equal(plan1.updates.length, 1, 'the one prose chunk missing entity_refs is planned for update');
  });
});

// Applies a computeBackfillPlan() plan to a fixture points array, the same
// way runBackfill() would apply it against real Qdrant — a 'set' op writes
// entity_refs, a 'clear' op removes the key entirely (never sets []).
function applyPlan(points, plan) {
  return points.map(p => {
    const update = plan.updates.find(u => u.id === p.id);
    if (!update) return p;
    if (update.op === 'set') return { ...p, payload: { ...p.payload, entity_refs: update.entityRefs } };
    const { entity_refs, ...rest } = p.payload;
    return { ...p, payload: rest };
  });
}

describe('computeBackfillPlan — idempotency', () => {
  it('a second run against ALREADY-BACKFILLED points produces zero updates', () => {
    const chunks = chunkSkeletonDoc('# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n');
    const points = toStoredPoints(chunks);

    const firstPlan = computeBackfillPlan(points);
    assert.equal(firstPlan.updates.length, 1);
    assert.equal(firstPlan.updates[0].op, 'set');

    const applied = applyPlan(points, firstPlan);

    const secondPlan = computeBackfillPlan(applied);
    assert.deepEqual(secondPlan.updates, [], 'a second run against already-backfilled points must produce zero updates');
    assert.equal(secondPlan.unchanged, firstPlan.contentPoints, 'every content point is now unchanged');
  });

  it('is idempotent even across multiple files with mixed already-backfilled and never-backfilled points', () => {
    const chunksA = chunkSkeletonDoc('# Setup\n\nSee the configuration table referenced below for full details.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n', 'a.md');
    const chunksB = chunkSkeletonDoc('# Intro\n\nSee the reference table shown directly underneath this sentence.\n\n| X | Y |\n|---|---|\n| 9 | 8 |\n', 'b.md');
    const points = [...toStoredPoints(chunksA, 'a'), ...toStoredPoints(chunksB, 'b')];

    const firstPlan = computeBackfillPlan(points);
    const applied = applyPlan(points, firstPlan);
    const secondPlan = computeBackfillPlan(applied);
    assert.deepEqual(secondPlan.updates, []);
  });
});

describe('computeBackfillPlan — fresh-index vs. backfill equality (byte-equivalent entity_refs)', () => {
  it('backfilling a Phase-3T-era collection (indexed before entity_refs existed) reproduces exactly what fresh indexing would have produced', () => {
    const doc = '# Setup\n\nConsider these two references together in the following passage.\n\n'
      + '| A | B |\n|---|---|\n| 1 | 2 |\n\n'
      + '```python\ndef handler(event, context):\n    process(event)\n    validate(event)\n'
      + '    log_metrics(event)\n    return {"status": "ok", "code": 200, "at": now()}\n```\n\n'
      + 'A closing remark about the setup process goes here for good measure.\n';

    // "Fresh index" reference: chunkFromSkeleton's own real output already
    // carries entity_refs (Phase 3U wires attachEntityRefs into the chunker
    // itself) — this is the ground truth to backfill against.
    const freshChunks = chunkSkeletonDoc(doc);
    const freshRefsByNodeId = new Map(
      freshChunks.filter(c => c.entity_refs?.length).map(c => [c.node_id, c.entity_refs]),
    );
    assert.ok(freshRefsByNodeId.size > 0, 'fixture must actually produce at least one entity_refs-bearing chunk');

    // "Backfill" simulation: same chunks, but as if indexed before entity_refs
    // existed (entity_refs stripped before being stored), then backfilled.
    const preBackfillPoints = toStoredPoints(freshChunks);
    const plan = computeBackfillPlan(preBackfillPoints);
    const backfilledRefsById = new Map(plan.updates.filter(u => u.op === 'set').map(u => [u.id, u.entityRefs]));

    for (const [i, point] of preBackfillPoints.entries()) {
      const nodeId = point.payload.node_id;
      const expected = freshRefsByNodeId.get(nodeId);
      if (!expected) continue; // this chunk never had refs in the fresh index either
      const backfilled = backfilledRefsById.get(`pt-${i}`);
      assert.deepEqual(backfilled, expected, `entity_refs for node ${nodeId} must be byte-equivalent between fresh indexing and backfill`);
    }
  });
});

describe('computeBackfillPlan — orphan reporting', () => {
  it('reports (not fabricates) a placeholder whose entity chunk is missing from the scanned points', () => {
    const points = [
      {
        id: 'p1',
        payload: {
          point_kind: 'retrieval_content', node_type: 'paragraph', chunking_model: 'skeleton-v1',
          source_file: 'a.md', section: 'Setup',
          text: 'Missing reference:\n\n[table node: a.md#setup/table-99 — ghost]',
        },
      },
    ];
    const plan = computeBackfillPlan(points);
    assert.deepEqual(plan.updates, []);
    assert.equal(plan.orphans.length, 1);
    assert.equal(plan.orphans[0].sourceFile, 'a.md');
    assert.match(plan.orphans[0].placeholder, /table-99/);
  });
});

// Regression (code review, round 1 P1): a point whose STORED entity_refs is
// now stale — its placeholder was removed from the prose, or the entity
// chunk it pointed at is gone/renamed — must be planned for an update that
// CLEARS the field, not silently left alone. Before this fix,
// computeBackfillPlan()'s "write only if after.length" gate meant a
// transition from [stale] -> [] fell through to `unchanged`, so the stale
// reference would sit in Qdrant forever and a future assembly service
// would resolve it to the wrong (or a deleted) entity.
//
// Round 2 (P2): the clearing op is `{ id, op: 'clear' }`, not
// `{ id, op: 'set', entityRefs: [] }` — a fresh index of the same content
// never writes the entity_refs key at all when a chunk has no references,
// so the backfill's clearing path must REMOVE the key (Qdrant deletePayload)
// to end up byte-equivalent, not leave a present-but-empty array (which
// setPayload cannot avoid, since it only ever adds/overwrites keys).
describe('computeBackfillPlan — stale entity_refs must be cleared, not left alone', () => {
  it('a point whose placeholder was removed from the prose text is planned for a clear op', () => {
    const points = [
      {
        id: 'p1',
        payload: {
          point_kind: 'retrieval_content', node_type: 'paragraph', chunking_model: 'skeleton-v1',
          source_file: 'a.md', section: 'Setup',
          // The placeholder is GONE from the current text (as if the table
          // was deleted from the source doc and the file was re-chunked
          // without a full reindex writing fresh entity_refs) — but the
          // STORED payload still carries the old reference.
          text: 'No placeholder mentioned here anymore, just plain prose.',
          entity_refs: [{ node_id: 'stale-node', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
        },
      },
    ];
    const plan = computeBackfillPlan(points);
    assert.equal(plan.updates.length, 1, 'a stale entity_refs is a real change that must be planned');
    assert.deepEqual(plan.updates[0], { id: 'p1', op: 'clear' });
    assert.equal(plan.unchanged, 0, 'must NOT be counted as unchanged — that was the round-1 P1 bug');
  });

  it('a point whose referenced entity chunk is now missing (orphaned) is planned for a clear op, not left with a dangling stale ref', () => {
    const points = [
      {
        id: 'p1',
        payload: {
          point_kind: 'retrieval_content', node_type: 'paragraph', chunking_model: 'skeleton-v1',
          source_file: 'a.md', section: 'Setup',
          // The placeholder text is STILL present, but the entity chunk it
          // names is no longer in the scanned points at all — this is the
          // "orphan" path, and it must still result in a clear op for the
          // stale stored ref.
          text: 'See below:\n\n[table node: a.md#setup/table-1 — old]',
          entity_refs: [{ node_id: 'stale-node', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
        },
      },
      // No table chunk at a.md#setup/table-1 in this scan — genuinely gone.
    ];
    const plan = computeBackfillPlan(points);
    assert.equal(plan.updates.length, 1);
    assert.deepEqual(plan.updates[0], { id: 'p1', op: 'clear' });
    assert.equal(plan.orphans.length, 1, 'the now-unresolvable placeholder is still reported as an orphan');
  });

  it('a second run after clearing a stale ref is idempotent (does not re-clear an already-absent entity_refs)', () => {
    const stalePoint = {
      id: 'p1',
      payload: {
        point_kind: 'retrieval_content', node_type: 'paragraph', chunking_model: 'skeleton-v1',
        source_file: 'a.md', section: 'Setup',
        text: 'No placeholder mentioned here anymore, just plain prose.',
        entity_refs: [{ node_id: 'stale-node', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
      },
    };
    const firstPlan = computeBackfillPlan([stalePoint]);
    assert.equal(firstPlan.updates.length, 1);
    assert.equal(firstPlan.updates[0].op, 'clear');

    // Simulate the real effect of applying a 'clear' op: the key is REMOVED
    // from the payload entirely (deletePayload), not set to [].
    const { entity_refs, ...clearedPayload } = stalePoint.payload;
    const cleared = { ...stalePoint, payload: clearedPayload };
    const secondPlan = computeBackfillPlan([cleared]);
    assert.deepEqual(secondPlan.updates, [], 'once the key is removed, a re-scan must not plan another update');
    assert.equal(secondPlan.unchanged, 1);
  });
});

describe('runBackfill — DI-able CLI core, DRY_RUN write-skip and set-vs-clear primitive choice actually verified', () => {
  function makeSpies(points) {
    const updateCalls = [];
    const deleteCalls = [];
    const logLines = [];
    return {
      scrollAllPointsFn: async () => points,
      updatePayloadFn: async (collection, id, payload) => { updateCalls.push({ collection, id, payload }); },
      deletePayloadKeysFn: async (collection, id, keys) => { deleteCalls.push({ collection, id, keys }); },
      logFn: (line) => logLines.push(line),
      updateCalls,
      deleteCalls,
      logLines,
    };
  }

  it('DRY_RUN (dryRun: true) computes the plan but never calls updatePayloadFn or deletePayloadKeysFn', async () => {
    const chunks = chunkSkeletonDoc('# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n');
    const points = toStoredPoints(chunks);
    const spies = makeSpies(points);

    const plan = await runBackfill({ collection: 'test-col', dryRun: true, ...spies });

    assert.equal(plan.updates.length, 1, 'the plan still reports what WOULD be updated');
    assert.deepEqual(spies.updateCalls, [], 'updatePayloadFn must never be called when dryRun is true');
    assert.deepEqual(spies.deleteCalls, [], 'deletePayloadKeysFn must never be called when dryRun is true');
    assert.ok(spies.logLines.some(l => l.includes('DRY_RUN=1, not written')));
  });

  it('a real (non-dry) "set" update calls updatePayloadFn exactly once, with the correct id/payload, and never calls deletePayloadKeysFn', async () => {
    const chunks = chunkSkeletonDoc('# Setup\n\nConfiguration options are summarized in the table below for reference.\n\n| Option | Default |\n|---|---|\n| retries | 3 |\n');
    const points = toStoredPoints(chunks);
    const spies = makeSpies(points);

    const plan = await runBackfill({ collection: 'test-col', dryRun: false, ...spies });

    assert.equal(plan.updates[0].op, 'set');
    assert.equal(spies.updateCalls.length, 1);
    assert.deepEqual(spies.deleteCalls, []);
    assert.equal(spies.updateCalls[0].collection, 'test-col');
    assert.equal(spies.updateCalls[0].id, plan.updates[0].id);
    assert.deepEqual(spies.updateCalls[0].payload, { entity_refs: plan.updates[0].entityRefs });
  });

  it('a real run against a stale-ref point calls deletePayloadKeysFn with ["entity_refs"], never updatePayloadFn with an empty array', async () => {
    const points = [{
      id: 'p1',
      payload: {
        point_kind: 'retrieval_content', node_type: 'paragraph', chunking_model: 'skeleton-v1',
        source_file: 'a.md', section: 'Setup',
        text: 'No placeholder mentioned here anymore, just plain prose.',
        entity_refs: [{ node_id: 'stale-node', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — old]' }],
      },
    }];
    const spies = makeSpies(points);
    await runBackfill({ collection: 'test-col', dryRun: false, ...spies });
    assert.deepEqual(spies.updateCalls, [], 'a clearing update must never go through setPayload, even with an empty array');
    assert.equal(spies.deleteCalls.length, 1);
    assert.equal(spies.deleteCalls[0].collection, 'test-col');
    assert.equal(spies.deleteCalls[0].id, 'p1');
    assert.deepEqual(spies.deleteCalls[0].keys, ['entity_refs']);
  });

  it('a legacy collection with DRY_RUN calls neither write primitive', async () => {
    const points = [{ id: 'a', payload: { source_file: 'a.md', text: 'legacy chunk' } }];
    const spies = makeSpies(points);
    const plan = await runBackfill({ collection: 'test-col', dryRun: true, ...spies });
    assert.equal(plan.updates.length, 0);
    assert.deepEqual(spies.updateCalls, []);
    assert.deepEqual(spies.deleteCalls, []);
  });

  // Regression (code review): the JSDoc marked scrollAllPointsFn/
  // updatePayloadFn/deletePayloadKeysFn as optional ("?") and claimed they
  // "default to the real network calls", but no such defaults ever
  // existed in the destructuring — omitting one would only surface as a
  // confusing "undefined is not a function" deep inside the call site
  // (and, for updatePayloadFn/deletePayloadKeysFn specifically, only on a
  // REAL run, never a dry run, since they're called conditionally). Fixed
  // by making the contract match reality (required, no defaults) and
  // failing fast with a clear TypeError up front instead.
  describe('runBackfill — required DI functions fail fast with a clear error, not a confusing crash mid-run', () => {
    it('throws a clear TypeError when scrollAllPointsFn is missing', async () => {
      const spies = makeSpies([]);
      delete spies.scrollAllPointsFn;
      await assert.rejects(
        runBackfill({ collection: 'test-col', dryRun: true, ...spies }),
        /runBackfill: "scrollAllPointsFn" is required and must be a function/,
      );
    });

    it('throws a clear TypeError when updatePayloadFn is missing, even under DRY_RUN (fails at call time, not deferred to a real run)', async () => {
      const spies = makeSpies([]);
      delete spies.updatePayloadFn;
      await assert.rejects(
        runBackfill({ collection: 'test-col', dryRun: true, ...spies }),
        /runBackfill: "updatePayloadFn" is required and must be a function/,
      );
    });

    it('throws a clear TypeError when deletePayloadKeysFn is missing, even under DRY_RUN', async () => {
      const spies = makeSpies([]);
      delete spies.deletePayloadKeysFn;
      await assert.rejects(
        runBackfill({ collection: 'test-col', dryRun: true, ...spies }),
        /runBackfill: "deletePayloadKeysFn" is required and must be a function/,
      );
    });

    it('never calls scrollAllPointsFn (or anything else) before the required-function check runs', async () => {
      let scrollCalled = false;
      const spies = makeSpies([]);
      spies.scrollAllPointsFn = async () => { scrollCalled = true; return []; };
      delete spies.updatePayloadFn;
      await assert.rejects(runBackfill({ collection: 'test-col', dryRun: true, ...spies }));
      assert.equal(scrollCalled, false, 'the missing-function check must run before any network call, including scroll');
    });
  });
});

describe('PAYLOAD_FIELDS — the field list the real CLI requests from scrollAllPoints', () => {
  it('includes every field toChunkShape()/attachEntityRefs() actually needs', () => {
    for (const f of ['point_kind', 'node_type', 'node_id', 'node_path', 'section', 'source_file', 'text', 'entity_refs', 'chunking_model']) {
      assert.ok(PAYLOAD_FIELDS.includes(f), `PAYLOAD_FIELDS must include "${f}"`);
    }
  });
});
