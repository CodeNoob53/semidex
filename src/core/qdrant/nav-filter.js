// Nav-point exclusion helpers — pure, smoke-testable, no env, no network.
//
// Navigation exclusion (impl spec §11 task 5, design §9): skeleton_nav points
// must never appear in search results or tool aggregations. Instead of a
// per-collection conditional (lookup of chunking_model before every call),
// we use a `must_not point_kind=skeleton_nav` clause:
//
//   - legacy points have NO point_kind field → the match never fires →
//     must_not is satisfied → behavior on legacy collections is IDENTICAL;
//   - skeleton retrieval points carry point_kind="retrieval_content" → pass;
//   - future skeleton_nav points are excluded from day one.
//
// This makes the filter unconditional, stateless, and safe to ship BEFORE any
// nav node exists in Qdrant — which is exactly the ordering the spec demands
// (filter first, nav upsert only after).
//
// entity_raw (entity-split.js) joins the SAME exclusion for the SAME
// reason: it is a canonical, non-searchable point (the complete raw_content
// of an oversized table/code_block/checklist, kept only so qdrant_get_node
// can resolve a fragment back to its full source) that must never appear in
// search results or normal retrieval-chunk aggregations, exactly like
// skeleton_nav. The names below stay NAV_POINT_KIND/withNavExcluded/
// isNavPoint for backward compatibility with every existing call site
// across MCP tools and the storage adapter — extending the underlying
// EXCLUDED_POINT_KINDS set here means every one of those call sites gets
// entity_raw exclusion for free, with zero changes required at the call
// site itself.
//
// Lives under src/core/qdrant/ (not src/mcp/) so both MCP tools and the
// storage adapter (src/core/storage/qdrant-adapter.js) can depend on it
// without the storage layer reaching up into src/mcp/.

export const NAV_POINT_KIND = 'skeleton_nav';
export const ENTITY_RAW_POINT_KIND = 'entity_raw';

const EXCLUDED_POINT_KINDS = Object.freeze([NAV_POINT_KIND, ENTITY_RAW_POINT_KIND]);

const EXCLUDE_CLAUSES = Object.freeze(
  EXCLUDED_POINT_KINDS.map(kind => Object.freeze({ key: 'point_kind', match: { value: kind } })),
);

/**
 * Merge the nav/entity_raw-exclusion clauses into an existing Qdrant filter
 * (or create one). Never mutates the input. Existing must_not clauses are
 * preserved.
 *
 * @param {Object|null} filter — Qdrant filter object or null
 * @returns {Object} filter with must_not nav + entity_raw exclusion
 */
export function withNavExcluded(filter) {
  const base = filter ? { ...filter } : {};
  const mustNot = Array.isArray(base.must_not) ? [...base.must_not] : [];
  for (const clause of EXCLUDE_CLAUSES) {
    if (!mustNot.some(c => c?.key === 'point_kind' && c?.match?.value === clause.match.value)) mustNot.push(clause);
  }
  return { ...base, must_not: mustNot };
}

/**
 * Client-side counterpart for scroll-based aggregations: true when a point
 * must be skipped because it is a navigation node or a split-entity's
 * canonical entity_raw point.
 *
 * @param {Object} point — Qdrant point ({ payload })
 * @returns {boolean}
 */
export function isNavPoint(point) {
  return EXCLUDED_POINT_KINDS.includes(point?.payload?.point_kind);
}
