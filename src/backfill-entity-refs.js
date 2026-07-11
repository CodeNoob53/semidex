// Backfill `entity_refs` onto prose chunks in an existing skeleton-v1
// collection (Phase 3U). Payload-only — never touches vectors, never
// re-embeds, never re-chunks. Safe to run repeatedly (idempotent): a chunk
// whose entity_refs already match what this script would compute is left
// untouched.
//
// Usage: COLLECTION=my-docs npm run backfill:entity-refs
// Optional: DRY_RUN=1 (compute and report, write nothing)
//
// computeBackfillPlan() below is the pure core (points in, plan out — no
// network) so it's directly unit-testable without a live Qdrant; only the
// bottom of this file (behind `if (COLLECTION)`) does I/O.

import { pathToFileURL } from 'url';
import { isNavPoint } from './core/qdrant/nav-filter.js';
import { isSkeletonChunk } from './indexer/skeleton-payload.js';
import { attachEntityRefs } from './indexer/entity-reference.js';

export const PAYLOAD_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'section',
  'source_file', 'text', 'raw_content', 'entity_refs', 'chunking_model',
];

// Reconstructs the snake_case chunk shape attachEntityRefs() expects from a
// stored Qdrant point payload — the same field names chunkFromSkeleton()
// itself produces, so this is the SAME matching logic fresh indexing uses,
// not a second implementation reading the same data differently.
function toChunkShape(point) {
  const p = point.payload ?? {};
  return {
    point_kind: p.point_kind,
    node_type: p.node_type,
    node_id: p.node_id,
    node_path: p.node_path,
    section: p.section ?? '',
    source_file: p.source_file ?? '',
    text: p.text ?? '',
    entity_refs: Array.isArray(p.entity_refs) ? p.entity_refs : undefined,
  };
}

function sameRefs(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((ref, i) => {
    const other = arrB[i];
    return ref.node_id === other.node_id
      && ref.node_path === other.node_path
      && ref.node_type === other.node_type
      && ref.placeholder === other.placeholder;
  });
}

/**
 * Pure planning core: given raw Qdrant points (payload-only, as returned by
 * scrollAllPoints(collection, PAYLOAD_FIELDS)), decide which points need an
 * entity_refs payload update.
 *
 * Excludes nav points (isNavPoint) and non-skeleton/legacy points
 * (isSkeletonChunk gate — mirrors skeletonPayloadFields()'s own rule: only
 * skeleton-v1 points ever carry entity_refs) BEFORE grouping/matching, so a
 * legacy collection with no skeleton points produces an empty plan —
 * scanned > 0, updates === 0, cleanly.
 *
 * Groups by source_file (attachEntityRefs() must never link a placeholder
 * to an entity from a different file) and runs attachEntityRefs() per file
 * — the identical function fresh indexing uses, not a parallel
 * implementation.
 *
 * @param {Array<{id, payload}>} points
 * @returns {{
 *   scanned: number,
 *   contentPoints: number,
 *   updates: Array<{ id: string|number, op: 'set', entityRefs: Array<Object> } | { id: string|number, op: 'clear' }>,
 *   unchanged: number,
 *   orphans: Array<{ sourceFile: string, placeholder: string }>,
 * }}
 *   Two distinct update ops, so the caller can apply each with the RIGHT
 *   Qdrant primitive:
 *     - `op: 'set'` — the point gets one or more real references; written
 *       via setPayload({ entity_refs: [...] }), same as skeletonPayloadFields()'s
 *       own write-only-if-present convention for fresh indexing.
 *     - `op: 'clear'` — the point's STORED entity_refs is now stale (its
 *       placeholder was removed from the text, or the entity it referenced
 *       became an orphan) and must be entirely REMOVED, via Qdrant's
 *       deletePayload — not overwritten with an empty array. A fresh index
 *       of the same content never writes the entity_refs key at all when a
 *       chunk has no references; the backfill's clearing path must leave
 *       the point in that exact same byte-equivalent shape (key absent),
 *       not a present-but-empty array, which setPayload cannot produce
 *       (setPayload only ever adds/overwrites keys, never removes one).
 */
export function computeBackfillPlan(points) {
  const contentPoints = points.filter(p => !isNavPoint(p) && isSkeletonChunk({ chunking_model: p.payload?.chunking_model }));

  const byFile = new Map();
  for (const point of contentPoints) {
    const sf = point.payload?.source_file ?? '';
    if (!byFile.has(sf)) byFile.set(sf, []);
    byFile.get(sf).push(point);
  }

  const updates = [];
  let unchanged = 0;
  const orphans = [];

  for (const [sourceFile, filePoints] of byFile) {
    const shapes = filePoints.map(toChunkShape);
    const { chunks: resolved, orphans: fileOrphans } = attachEntityRefs(shapes);

    for (const orphan of fileOrphans) orphans.push({ sourceFile, placeholder: orphan.placeholder });

    for (let i = 0; i < resolved.length; i++) {
      const before = shapes[i].entity_refs;
      const after = resolved[i].entity_refs;
      if (sameRefs(before, after)) { unchanged++; continue; }
      // A real change was detected (sameRefs already handles length/order/
      // field-equality) — only a genuine never-had-one-and-still-doesn't
      // case (before/after both empty/absent) counts as truly unchanged,
      // and sameRefs() already filtered that out before reaching here.
      if (Array.isArray(after) && after.length) {
        updates.push({ id: filePoints[i].id, op: 'set', entityRefs: after });
      } else {
        updates.push({ id: filePoints[i].id, op: 'clear' });
      }
    }
  }

  return { scanned: points.length, contentPoints: contentPoints.length, updates, unchanged, orphans };
}

/**
 * Runs one backfill pass: fetch, plan, (maybe) write, report. DI-able —
 * this function itself never imports `./core/qdrant.js` (that stays behind
 * the `isMainModule` CLI guard below, the one place in this file that does
 * network I/O), so scrollAllPointsFn/updatePayloadFn/deletePayloadKeysFn are
 * REQUIRED, not optional-with-a-network-fallback: the real CLI entry point
 * supplies the real store.js functions, tests supply spies. Only dryRun and
 * logFn have real defaults (false and console.log respectively), since
 * those don't carry a network dependency either way.
 *
 * @param {{
 *   collection: string,
 *   dryRun?: boolean,
 *   scrollAllPointsFn: (collection: string, fields: string[], pageSize: number) => Promise<Array>,
 *   updatePayloadFn: (collection: string, id: string|number, payload: Object) => Promise<void>,
 *   deletePayloadKeysFn: (collection: string, id: string|number, keys: string[]) => Promise<void>,
 *   logFn?: (line: string) => void,
 * }} opts
 * @returns {Promise<ReturnType<typeof computeBackfillPlan>>} the computed plan
 */
export async function runBackfill({
  collection,
  dryRun = false,
  scrollAllPointsFn,
  updatePayloadFn,
  deletePayloadKeysFn,
  logFn = (line) => console.log(line),
}) {
  // Fail fast on a missing required DI function — updatePayloadFn/
  // deletePayloadKeysFn are only actually CALLED conditionally (inside
  // `if (!dryRun)`, and only for whichever op type shows up in the plan),
  // so without this check a caller could omit one, run a dry run
  // successfully, and only discover the mistake much later on a real run.
  for (const [name, fn] of Object.entries({ scrollAllPointsFn, updatePayloadFn, deletePayloadKeysFn })) {
    if (typeof fn !== 'function') throw new TypeError(`runBackfill: "${name}" is required and must be a function`);
  }

  logFn(`[entity-refs] scanning collection "${collection}"...`);

  const points = await scrollAllPointsFn(collection, PAYLOAD_FIELDS, 250);
  const plan = computeBackfillPlan(points);

  logFn(`[entity-refs] points scanned: ${plan.scanned}`);
  logFn(`[entity-refs] skeleton content points: ${plan.contentPoints}`);

  if (!dryRun) {
    for (const update of plan.updates) {
      if (update.op === 'set') {
        // setPayload() merges, so this touches ONLY the entity_refs key —
        // no vector, no other payload field, no re-embed.
        await updatePayloadFn(collection, update.id, { entity_refs: update.entityRefs });
      } else {
        // deletePayload() removes the key entirely — the point ends up
        // byte-equivalent to one that was freshly indexed and never had
        // entity_refs at all, not one carrying an explicit empty array.
        await deletePayloadKeysFn(collection, update.id, ['entity_refs']);
      }
    }
  }

  const setCount = plan.updates.filter(u => u.op === 'set').length;
  const clearCount = plan.updates.filter(u => u.op === 'clear').length;
  logFn(`[entity-refs] updated: ${plan.updates.length} (${setCount} set, ${clearCount} cleared)${dryRun ? ' (DRY_RUN=1, not written)' : ''}`);
  logFn(`[entity-refs] unchanged: ${plan.unchanged}`);
  logFn(`[entity-refs] orphan placeholders: ${plan.orphans.length}`);
  if (plan.orphans.length) {
    logFn('[entity-refs] orphan samples (up to 10):');
    for (const s of plan.orphans.slice(0, 10)) logFn(`  ${s.sourceFile}: ${s.placeholder}`);
  }

  return plan;
}

// ── CLI entry point (I/O — not exercised by unit tests) ─────────────────────
const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();

  const { scrollAllPoints, updatePayload, deletePayloadKeys } = await import('./core/qdrant.js');

  const COLLECTION = process.env.COLLECTION;
  const DRY_RUN = process.env.DRY_RUN === '1';

  if (!COLLECTION) {
    console.error('Usage: COLLECTION=my-docs npm run backfill:entity-refs');
    console.error('Optional: DRY_RUN=1');
    process.exit(1);
  }

  await runBackfill({
    collection: COLLECTION,
    dryRun: DRY_RUN,
    scrollAllPointsFn: scrollAllPoints,
    updatePayloadFn: updatePayload,
    deletePayloadKeysFn: deletePayloadKeys,
  });
}
