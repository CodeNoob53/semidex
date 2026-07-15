// Bounded, anchor-centered projection over an assembleDocument() result
// (Phase 3X) — the core windowing logic behind MCP's qdrant_get_content.
// Pure: no Qdrant, no network, no filesystem. Operates entirely on an
// already-assembled AssemblyResult (see assemble.js) plus an injected
// countTokens function, so the SAME assembleDocument() output that drives
// the admin document reader (Phase 3W) also drives bounded MCP retrieval —
// there is exactly one assembly implementation; this module only adds a
// windowing/pagination layer on top of its output.
//
// maxTokens bounds ASSEMBLED CONTENT ONLY (the exact serialized segment
// text/rawContent, including the join separator rendered BETWEEN consecutive
// items, and each included oversized descriptor's own real note text — see below) —
// never other diagnostic metadata (nodeId, nodePath, chunkIndex, nodeType,
// cursors, counts). A caller summing every byte of the returned JSON
// envelope will see more than maxTokens; a caller summing the token cost of
// the final reconstructed text an LLM actually reads never will. The caller
// injects the literal separator text, not a separately counted token cost:
// BPE tokenization is not additive, and counting every segment/separator in a
// separate tokenizer call repeats special-token overhead and under-fills the
// window. Candidate pages are therefore serialized first and counted once.

import { encodeCursor, decodeCursor, cursorMatchesRequest } from './cursor.js';

const CURSOR_VERSION = 1;

// Fixed, reused note text for every oversized descriptor — its own real
// note participates in the exact serialized budget projection like normal
// segment content. This is what
// prevents an unbounded run of oversized entities from being "free":
// previously an oversized segment cost 0 tokens no matter how many were
// swept into one page (code review — 20 oversized tables at max_tokens=200
// produced returned_tokens=0 while the actual rendered text was ~747
// tokens). The MCP text format omits oversized content and reports its
// identity as metadata; budgeting this fixed surrogate still caps how many
// descriptors one page can return without pretending their raw content fits.
export const OVERSIZED_NOTE = 'This entity exceeds the requested token budget and was not included inline. '
  + 'Request it explicitly with qdrant_get_node (primarily for user display), '
  + 'not as evidence to assemble into an answer.';

function segmentContent(segment) {
  return segment.kind === 'entity' ? (segment.rawContent ?? '') : (segment.text ?? '');
}

function segmentIdentity(segment) {
  return {
    nodeId: segment.nodeId ?? null,
    nodePath: segment.nodePath ?? null,
    chunkIndex: segment.chunkIndex ?? null,
    nodeType: segment.nodeType ?? null,
  };
}

function oversizedDescriptor(segment, tokenCount) {
  return {
    ...segmentIdentity(segment),
    oversized: true,
    tokenCount,
    content: null,
    note: OVERSIZED_NOTE,
  };
}

// Resolves a possibly-sync-or-async countTokens(text) into a Promise<number>
// uniformly — token-count.js's own getTokenCounter() can return either
// (heuristic mode: sync; bge-m3 mode: async), and callers must not have to
// care which.
async function tokensOf(countTokens, text) {
  return countTokens(text ?? '');
}

// Precomputes { tokens, content, segment } for every segment once, so
// neither the initial pass nor either cursor-continuation pass ever counts
// the same text twice. Also precomputes the oversized descriptor's own
// note cost ONCE (not per-occurrence — the note text is fixed, so its
// token count is the same every time), shared by every oversized segment
// encountered.
async function tokenizeAll(segments, countTokens) {
  const out = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const content = segmentContent(segments[i]);
    out[i] = { segment: segments[i], content, tokens: await tokensOf(countTokens, content) };
  }
  return out;
}

async function countSerialized(countTokens, parts, separatorText) {
  const content = parts.filter(part => part !== '').join(separatorText);
  return content === '' ? 0 : tokensOf(countTokens, content);
}

function budgetContent(record) {
  return record.oversizedItem ? OVERSIZED_NOTE : record.content;
}

async function countIncluded(countTokens, included, separatorText) {
  const parts = [...included.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, record]) => budgetContent(record));
  return countSerialized(countTokens, parts, separatorText);
}

// A cheap boundary fingerprint for the FIRST and LAST segment — O(1), never
// a full re-hash of every segment's content (which the task's own
// "lightweight cursor, no database-backed registry" instruction rules out
// as overkill). Segment COUNT alone (the pre-existing totalSegments check)
// misses a real case (code review, P2): a section is edited in place —
// same number of segments, but different node identities/content —
// totalSegments matches but the scope is genuinely different. Anchoring on
// the first/last segment's own stable node_id (or chunkIndex, for the
// legacy plain_chunks shape where node_id is always null) catches that
// class of drift cheaply: an in-place edit that changes segment identity
// at either boundary invalidates the cursor; edits strictly inside the
// scope (between the first and last segment) are NOT caught by this cheap
// check, same honest tradeoff as the segment-count check it augments, not
// a full-content integrity guarantee.
function boundarySegmentKey(segment) {
  if (!segment) return null;
  return segment.nodeId ?? `chunkIndex:${segment.chunkIndex ?? ''}`;
}

// A stable identity for "what scope was this assembled from" — cheap and
// deterministic, used only to bind a cursor to the request it was minted
// for (see cursor.js). Encoded as a JSON array (never string concatenation
// with an ad-hoc separator character) so a delimiter can never collide
// with field content by construction.
function sourceKeyOf(assembly) {
  const segments = Array.isArray(assembly.segments) ? assembly.segments : [];
  return JSON.stringify([
    assembly.sourceFile ?? '', assembly.nodePath ?? '', assembly.assemblyMode,
    boundarySegmentKey(segments[0]), boundarySegmentKey(segments[segments.length - 1]),
  ]);
}

function toItem(entry) {
  return entry.oversizedItem ?? entry.segment;
}

/**
 * @param {{
 *   assembly: import('./contract.js').AssemblyResult,
 *   anchorNodeId: string,
 *   maxTokens: number,
 *   cursor?: string|null,
 *   countTokens: (text: string) => number|Promise<number>,
 *   separatorText?: string — the literal separator the CALLER renders
 *     BETWEEN consecutive items when serializing this window. Candidate
 *     pages are joined with this exact string and counted in one tokenizer
 *     call because BPE token counts are not additive. Defaults to ''.
 * }} opts
 * @returns {Promise<import('./contract.js').AssemblyWindowResult & { error?: string }>}
 *   On a malformed/mismatched cursor, returns { error: 'invalid_cursor', ... }
 *   instead of a window — the caller (the MCP tool) turns that into a clear
 *   validation error rather than silently reinterpreting the cursor.
 */
export async function buildAssemblyWindow({ assembly, anchorNodeId, maxTokens, cursor = null, countTokens, separatorText = '' }) {
  const segments = Array.isArray(assembly?.segments) ? assembly.segments : [];
  const entries = await tokenizeAll(segments, countTokens);
  const joinText = typeof separatorText === 'string' ? separatorText : '';
  const totalTokens = await countSerialized(countTokens, entries.map(e => e.content), joinText);
  const sourceKey = sourceKeyOf(assembly);
  const anchorIndex = segments.findIndex(s =>
    anchorNodeId != null && (s.nodeId === anchorNodeId || s.nodePath === anchorNodeId));

  // Two shapes for two different consumers: `matchRequest` is what
  // cursorMatchesRequest() compares against (its `version` field name);
  // `cursorBase` is the literal payload encodeCursor() writes (its `v`
  // field name, plus dir/edgeIndex filled in per-cursor below). Keeping
  // both explicit here (rather than spreading one into the other) is what
  // caught the encode/decode field-name mismatch during development — see
  // cursor.js's own `v` vs this module's request `version`.
  const matchRequest = { version: CURSOR_VERSION, collection: assembly.collection, scope: assembly.scope, sourceKey, anchorNodeId: anchorNodeId ?? null, totalSegments: segments.length };
  const cursorBase = { v: CURSOR_VERSION, collection: assembly.collection, scope: assembly.scope, sourceKey, anchorNodeId: anchorNodeId ?? null, totalSegments: segments.length };

  // ── Cursor-continuation request ──────────────────────────────────────────
  if (cursor != null) {
    const decoded = decodeCursor(cursor);
    if (!decoded || !cursorMatchesRequest(decoded, matchRequest)) {
      return { error: 'invalid_cursor' };
    }
    // decodeCursor() itself already rejects an edgeIndex out of range for
    // the cursor's OWN declared totalSegments (0 <= edgeIndex <
    // totalSegments), and cursorMatchesRequest() above already confirmed
    // that totalSegments equals THIS scope's segments.length — so by this
    // point decoded.edgeIndex is guaranteed to be a real, in-range position
    // for `segments`.
    return buildContinuationPage(entries, decoded, maxTokens, totalTokens, anchorNodeId, cursorBase, countTokens, joinText);
  }

  // ── Initial (anchor-centered) request ────────────────────────────────────
  if (anchorIndex === -1) {
    return { error: 'anchor_not_in_scope' };
  }

  if (totalTokens <= maxTokens) {
    return {
      items: entries.map(e => e.segment),
      anchorNodeId: anchorNodeId ?? null,
      totalTokens,
      returnedTokens: totalTokens,
      hasMoreBefore: false,
      hasMoreAfter: false,
      cursorBefore: null,
      cursorAfter: null,
    };
  }

  // Anchor-centered greedy expansion: the anchor is always represented in
  // the page (as itself, or — if it alone exceeds budget — as its own
  // oversized descriptor, whose own real note cost is charged against the
  // budget like any other included item). Then alternately try to grow
  // backward and forward, one whole segment at a time, stopping a direction
  // the moment the next segment (or the next oversized descriptor's own
  // cost) would exceed the remaining budget — segments are never split or
  // truncated, and an unbounded run of oversized descriptors can never be
  // swept in "for free."
  let loIdx = anchorIndex;
  let hiIdx = anchorIndex;
  let returnedTokens = 0;
  const included = new Map(); // index -> { segment, tokens, oversizedItem? }

  async function tryInclude(i) {
    const e = entries[i];
    const rec = e.tokens > maxTokens
      ? { segment: e.segment, content: OVERSIZED_NOTE, oversizedItem: oversizedDescriptor(e.segment, e.tokens) }
      : { segment: e.segment, content: e.content };
    included.set(i, rec);
    const projectedTokens = await countIncluded(countTokens, included, joinText);
    if (projectedTokens > maxTokens) {
      included.delete(i);
      return false;
    }
    returnedTokens = projectedTokens;
    return true;
  }

  // Anchor first — always attempted, per "include the anchor in the initial
  // page." If the anchor's serialized budget representation doesn't
  // fit the budget at all, tryInclude() correctly returns false and the
  // anchor is omitted rather than the budget being silently exceeded — a
  // A budget smaller than the fixed oversized note is a genuine misconfiguration the MCP
  // tool layer's own minimum (200) is chosen well above, but this function
  // does not assume that and never exceeds the budget regardless.
  await tryInclude(anchorIndex);

  let expandBefore = true;
  while (true) {
    let grew = false;
    if (expandBefore && loIdx > 0) {
      if (await tryInclude(loIdx - 1)) { loIdx -= 1; grew = true; }
    } else if (!expandBefore && hiIdx < segments.length - 1) {
      if (await tryInclude(hiIdx + 1)) { hiIdx += 1; grew = true; }
    }
    if (!grew) {
      // This direction is exhausted (either budget or scope) — try the
      // other direction once before giving up entirely.
      if (expandBefore && hiIdx < segments.length - 1 && await tryInclude(hiIdx + 1)) { hiIdx += 1; grew = true; }
      else if (!expandBefore && loIdx > 0 && await tryInclude(loIdx - 1)) { loIdx -= 1; grew = true; }
    }
    if (!grew) break;
    expandBefore = !expandBefore;
  }

  const items = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    const e = included.get(i);
    if (e) items.push(toItem(e));
  }
  const hasMoreBefore = loIdx > 0;
  const hasMoreAfter = hiIdx < segments.length - 1;

  return {
    items,
    anchorNodeId: anchorNodeId ?? null,
    totalTokens,
    returnedTokens,
    hasMoreBefore,
    hasMoreAfter,
    cursorBefore: hasMoreBefore ? encodeCursor({ ...cursorBase, dir: 'before', edgeIndex: loIdx }) : null,
    cursorAfter: hasMoreAfter ? encodeCursor({ ...cursorBase, dir: 'after', edgeIndex: hiIdx }) : null,
  };
}

// Extends a page strictly in one direction from a cursor's recorded edge —
// no overlap with the page that produced the cursor (edgeIndex was the last
// index NOT included in that direction, so continuation starts exactly
// there) and no gaps (continuation is contiguous from edgeIndex).
async function buildContinuationPage(entries, decoded, maxTokens, totalTokens, anchorNodeId, cursorBase, countTokens, separatorText = '') {
  const segments = entries.map(e => e.segment);
  const included = new Map();
  let returnedTokens = 0;

  async function tryInclude(i) {
    const e = entries[i];
    const rec = e.tokens > maxTokens
      ? { segment: e.segment, content: OVERSIZED_NOTE, oversizedItem: oversizedDescriptor(e.segment, e.tokens) }
      : { segment: e.segment, content: e.content };
    included.set(i, rec);
    const projectedTokens = await countIncluded(countTokens, included, separatorText);
    if (projectedTokens > maxTokens) {
      included.delete(i);
      return false;
    }
    returnedTokens = projectedTokens;
    return true;
  }

  let loIdx = null;
  let hiIdx = null;

  if (decoded.dir === 'before') {
    // Walk backward from edgeIndex - 1 (the highest not-yet-seen index in
    // the "before" direction), filling toward index 0.
    let i = decoded.edgeIndex - 1;
    while (i >= 0 && await tryInclude(i)) { if (hiIdx === null) hiIdx = i; loIdx = i; i -= 1; }
  } else {
    // Walk forward from edgeIndex + 1, filling toward the end.
    let i = decoded.edgeIndex + 1;
    while (i < segments.length && await tryInclude(i)) { if (loIdx === null) loIdx = i; hiIdx = i; i += 1; }
  }

  const items = [];
  if (loIdx !== null) {
    for (let i = loIdx; i <= hiIdx; i++) {
      const e = included.get(i);
      if (e) items.push(toItem(e));
    }
  }

  const hasMoreBefore = loIdx !== null ? loIdx > 0 : decoded.dir === 'before' ? decoded.edgeIndex > 0 : false;
  const hasMoreAfter = hiIdx !== null ? hiIdx < segments.length - 1 : decoded.dir === 'after' ? decoded.edgeIndex < segments.length - 1 : false;
  return {
    items,
    anchorNodeId: anchorNodeId ?? null,
    totalTokens,
    returnedTokens,
    hasMoreBefore,
    hasMoreAfter,
    cursorBefore: hasMoreBefore && loIdx !== null ? encodeCursor({ ...cursorBase, dir: 'before', edgeIndex: loIdx }) : null,
    cursorAfter: hasMoreAfter && hiIdx !== null ? encodeCursor({ ...cursorBase, dir: 'after', edgeIndex: hiIdx }) : null,
  };
}
