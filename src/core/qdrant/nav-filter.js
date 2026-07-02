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
// Lives under src/core/qdrant/ (not src/mcp/) so both MCP tools and the
// storage adapter (src/core/storage/qdrant-adapter.js) can depend on it
// without the storage layer reaching up into src/mcp/.

export const NAV_POINT_KIND = 'skeleton_nav';

const NAV_EXCLUDE_CLAUSE = Object.freeze({
  key: 'point_kind',
  match: { value: NAV_POINT_KIND },
});

/**
 * Merge the nav-exclusion clause into an existing Qdrant filter (or create one).
 * Never mutates the input. Existing must_not clauses are preserved.
 *
 * @param {Object|null} filter — Qdrant filter object or null
 * @returns {Object} filter with must_not nav exclusion
 */
export function withNavExcluded(filter) {
  const base = filter ? { ...filter } : {};
  const mustNot = Array.isArray(base.must_not) ? [...base.must_not] : [];
  if (!mustNot.some(c => c?.key === 'point_kind' && c?.match?.value === NAV_POINT_KIND)) mustNot.push(NAV_EXCLUDE_CLAUSE);
  return { ...base, must_not: mustNot };
}

/**
 * Client-side counterpart for scroll-based aggregations: true when a point
 * must be skipped because it is a navigation node.
 *
 * @param {Object} point — Qdrant point ({ payload })
 * @returns {boolean}
 */
export function isNavPoint(point) {
  return point?.payload?.point_kind === NAV_POINT_KIND;
}
