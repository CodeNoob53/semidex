// Opaque, versioned, deterministic pagination cursors for buildAssemblyWindow()
// (Phase 3X). A lightweight base64url-encoded JSON envelope — deliberately
// not encrypted, not persisted, not backed by any registry. The cursor's
// only job is to let a caller ask for "the block right before/after what I
// already saw" without re-deriving that boundary itself, and to let the
// window builder REJECT a cursor that no longer matches the request it was
// minted for (a different collection/scope/anchor/source, or the assembled
// scope's shape changed underneath it).
//
// Independent of Qdrant scroll offsets by construction: a cursor encodes a
// plain array INDEX into the already-assembled, already-ordered `segments`
// array buildAssemblyWindow() receives — it has no relationship to a Qdrant
// scroll `next_page_offset` token at all.

const CURSOR_PREFIX = 'ac1.'; // "assembly cursor, version 1" — bumped on any breaking shape change

/**
 * @param {{
 *   v: number, collection: string, scope: string, sourceKey: string,
 *   anchorNodeId: string|null, totalSegments: number,
 *   dir: 'before'|'after', edgeIndex: number,
 * }} payload
 * @returns {string} opaque cursor string
 */
export function encodeCursor(payload) {
  const json = JSON.stringify(payload);
  return CURSOR_PREFIX + Buffer.from(json, 'utf-8').toString('base64url');
}

/**
 * Decodes and shape-validates a cursor. Returns null for anything malformed
 * (wrong prefix, invalid base64url, invalid JSON, missing/wrong-typed
 * fields) — malformed input is rejected, never guessed at or repaired.
 *
 * @param {string} cursor
 * @returns {Object|null}
 */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null;
  let payload;
  try {
    const json = Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf-8');
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { v, collection, scope, sourceKey, anchorNodeId, totalSegments, dir, edgeIndex } = payload;
  if (typeof v !== 'number') return null;
  if (typeof collection !== 'string' || !collection) return null;
  if (scope !== 'file' && scope !== 'section') return null;
  if (typeof sourceKey !== 'string') return null;
  if (anchorNodeId !== null && typeof anchorNodeId !== 'string') return null;
  if (!Number.isInteger(totalSegments) || totalSegments < 0) return null;
  if (dir !== 'before' && dir !== 'after') return null;
  if (!Number.isInteger(edgeIndex)) return null;
  // Code review (P2, two rounds): a structurally well-formed cursor whose
  // edgeIndex is out of range for its OWN declared totalSegments (e.g.
  // edgeIndex=999 against totalSegments=3 — a tampered or hand-built cursor,
  // not one this module ever produced) must be rejected here, not accepted
  // and left to quietly produce an empty "successful" page later. edgeIndex
  // is always a REAL segment array index (encodeCursor writes it as loIdx/
  // hiIdx, which are the actual indices of segments included in a page), so
  // the last valid value is totalSegments - 1. edgeIndex === totalSegments
  // is one past the end — it can never be legitimately minted and must be
  // rejected too (the earlier round wrongly allowed it as a "boundary").
  if (edgeIndex < 0 || edgeIndex >= totalSegments) return null;
  return { v, collection, scope, sourceKey, anchorNodeId, totalSegments, dir, edgeIndex };
}

/**
 * Validates a decoded cursor against the CURRENT request's identity —
 * version, collection, scope, anchor, and the assembled source's shape
 * (sourceKey, which folds in a cheap first/last-segment boundary
 * fingerprint — see window.js's sourceKeyOf/boundarySegmentKey — plus the
 * segment count). A cursor minted for a different request, or one whose
 * scope has since changed shape (segment count changed, OR the scope's
 * first/last segment identity changed — e.g. a reindex or an in-place edit
 * touching either boundary), is rejected outright rather than silently
 * reinterpreted against a different scope. This is a boundary check, not a
 * full-content integrity guarantee: an edit strictly INSIDE the scope
 * (between the first and last segment, leaving segment count and both
 * boundary identities unchanged) is not detected — a deliberate, documented
 * tradeoff against a real content hash, which the task's own "lightweight
 * cursor" instruction rules out.
 *
 * @returns {boolean}
 */
export function cursorMatchesRequest(decoded, { version, collection, scope, sourceKey, anchorNodeId, totalSegments }) {
  if (!decoded) return false;
  return decoded.v === version
    && decoded.collection === collection
    && decoded.scope === scope
    && decoded.sourceKey === sourceKey
    && decoded.anchorNodeId === anchorNodeId
    && decoded.totalSegments === totalSegments;
}
