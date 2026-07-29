// Node policy layer — the single source of truth for "what each node type
// becomes". Contract: design §5.1 (mapping), §7.2 (policy matrix),
// §7.3 (isContentBearing gate). Pure functions, no I/O.
//
// Policy semantics:
//   chunk_text                — prose; chunked and embedded as today
//   payload_raw_embed_context — raw preserved whole in payload; embedding built
//                               from context+terms+excerpt (later task)
//   nav_summary               — navigation node (skeleton_nav), never searched
//   payload_metadata_only     — metadata carrier (frontmatter)
//   future_processor          — preserved in skeleton, processed later (images/OCR)
//   drop                      — recognized non-content (thematic break)
//
// Unknown fallback (design §5.1, fixed): anything unmapped indexes as a
// paragraph (retrieval_content) so content is NEVER silently lost; the fact is
// logged separately to the warnings JSONL. Indexing and logging are two
// independent streams.

import { envInt } from '../../core/env.js';
import { PLACEHOLDER_LINE_RE } from '../../core/entity-reference.js';

export const POINT_KINDS = Object.freeze({
  RETRIEVAL:  'retrieval_content',
  NAV:        'skeleton_nav',
  // Canonical, non-searchable point carrying a structural entity's complete,
  // unsplit raw_content (table/code_block/checklist too large to embed
  // whole under a cloud model's token budget — see entity-split.js). Never
  // embedded against its real content, never returned by search or normal
  // retrieval-chunk sequences (getFileChunks/getSectionChunks) — excluded
  // the same way skeleton_nav points are, via nav-filter.js-style
  // must_not filtering. Produced dynamically by skeleton-chunk.js at
  // chunk-time (only when an entity is actually split), not assigned
  // statically per nodeType here — table/code_block/checklist keep
  // pointKind: RETRIEVAL below, which becomes each fragment's point kind.
  ENTITY_RAW: 'entity_raw',
});

// nodeType → { policy, pointKind } (design §7.2).
// pointKind null = the node never becomes a Qdrant point in MVP.
export const NODE_POLICY = Object.freeze({
  paragraph:   { policy: 'chunk_text',                pointKind: POINT_KINDS.RETRIEVAL },
  list:        { policy: 'chunk_text',                pointKind: POINT_KINDS.RETRIEVAL },
  blockquote:  { policy: 'chunk_text',                pointKind: POINT_KINDS.RETRIEVAL },
  table:       { policy: 'payload_raw_embed_context', pointKind: POINT_KINDS.RETRIEVAL },
  code_block:  { policy: 'payload_raw_embed_context', pointKind: POINT_KINDS.RETRIEVAL },
  checklist:   { policy: 'payload_raw_embed_context', pointKind: POINT_KINDS.RETRIEVAL },
  section:     { policy: 'nav_summary',               pointKind: POINT_KINDS.NAV },
  file:        { policy: 'nav_summary',               pointKind: POINT_KINDS.NAV },
  collection:  { policy: 'nav_summary',               pointKind: POINT_KINDS.NAV },
  image:       { policy: 'future_processor',          pointKind: POINT_KINDS.NAV },
  frontmatter: { policy: 'payload_metadata_only',     pointKind: null },
  // Unknown fallback: index as paragraph + warning (design §5.1).
  unknown:     { policy: 'chunk_text',                pointKind: POINT_KINDS.RETRIEVAL },
});

// ── Tiny code blocks (vault-validated rule, 2026-06-10) ─────────────────────
//
// Empirical pattern from a real Obsidian corpus (49 files, "Основи Node.js"):
// 3364 fenced code blocks, of which 84% are one-liners and 73% are a SINGLE
// token ("LTS", "PATH", "nvm use", ".editor") — inline terms styled as fences
// by the export. Treating them as standalone structural entities would flood
// the index with ~2.5k one-word retrieval points.
//
// Rule (re-calibrated 2026-06-10 against a manual ground-truth count on a
// second real corpus — visual target was 60-65 entities, the original rule
// produced 93; this rule lands on 65):
//
//   entity  ⇔  (lines >= CODE_ENTITY_MIN_LINES  AND  tokens >= CODE_ENTITY_MIN_TOKENS)
//            OR tokens >= CODE_ENTITY_ONELINE_TOKENS
//
// Defaults: MIN_LINES=2, MIN_TOKENS=12 (multi-line token floor — kills 2-line
// `mkdir x / cd y` pairs and sparse output dumps), ONELINE_TOKENS=16 (only
// genuinely long one-line commands stay entities).
// Anything smaller merges into the surrounding prose (policy merge_with_parent):
// still searchable through the prose chunk's sparse leg, but never a point of
// its own and never a placeholder.
// Note: fence `lang` is NOT used for this decision — language autodetection in
// real exports is unreliable (observed: "apache"/"arduino" on shell commands).

export function isTinyCodeBlock(node) {
  if (node?.nodeType !== 'code_block') return false;
  const minLines      = envInt('CODE_ENTITY_MIN_LINES', 2, 1, 100, '[skeleton] ');
  const minTokens     = envInt('CODE_ENTITY_MIN_TOKENS', 12, 1, 1000, '[skeleton] ');
  const onelineTokens = envInt('CODE_ENTITY_ONELINE_TOKENS', 16, 1, 1000, '[skeleton] ');
  const text   = String(node.text ?? '');
  const lines  = text.split('\n').filter(l => l.trim()).length;
  const tokens = text.trim().split(/\s+/).filter(Boolean).length;
  const isEntity = (lines >= minLines && tokens >= minTokens) || tokens >= onelineTokens;
  return !isEntity;
}

/**
 * Assign policy and pointKind to a skeleton node. Pure — returns a new object.
 * Unmapped nodeType values degrade to the `unknown` row (never throws).
 *
 * @param {SkeletonNode} node
 * @returns {SkeletonNode & { policy: string, pointKind: string|null }}
 */
export function applyNodePolicy(node) {
  // Tiny code never becomes its own entity — it merges into parent prose.
  if (isTinyCodeBlock(node)) {
    return { ...node, policy: 'merge_with_parent', pointKind: null };
  }
  const entry = NODE_POLICY[node?.nodeType] ?? NODE_POLICY.unknown;
  return { ...node, policy: entry.policy, pointKind: entry.pointKind };
}

// ── isContentBearing (design §7.3) ───────────────────────────────────────────

// Structural retrieval types always carry content (raw_content / metadata).
const STRUCTURAL_CONTENT_TYPES = new Set(['table', 'code_block', 'checklist']);

// Placeholder lines produced by parent-prose extraction (design §11) — never
// counted as content, so placeholder-only prose can't become a search chunk.
// PLACEHOLDER_LINE_RE (imported above, from entity-reference.js) is the
// single source of truth for the placeholder format — this module must not
// keep its own copy of the pattern.
const PLACEHOLDER_RE = PLACEHOLDER_LINE_RE;

// Bare heading line (defensive — heading-only sections never reach prose in
// the skeleton model, but the gate must hold even on malformed input).
const BARE_HEADING_RE = /^#{1,6}\s/;

function meaningfulTokenCount(text) {
  let count = 0;
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (PLACEHOLDER_RE.test(t)) continue;
    if (BARE_HEADING_RE.test(t)) continue;
    for (const tok of t.split(/\s+/)) {
      // Skip lone punctuation / list markers.
      if (/[\p{L}\p{N}]/u.test(tok)) count++;
    }
  }
  return count;
}

/**
 * The single emission gate against empty retrieval chunks (design §7.3):
 * a retrieval_content point is created if and only if this returns true.
 * Nodes that fail are never emitted — there is nothing to post-filter.
 *
 * - non-retrieval nodes (section/image/frontmatter/...) → false
 *   (they are not retrieval content by definition);
 * - structural retrieval types (table/code_block/checklist) → true;
 * - prose → at least MIN_CONTENT_TOKENS meaningful tokens after stripping
 *   whitespace, placeholders, and bare heading lines.
 *
 * @param {SkeletonNode & { pointKind?: string }} node — after applyNodePolicy
 * @returns {boolean}
 */
export function isContentBearing(node) {
  if (!node) return false;
  if (node.pointKind !== POINT_KINDS.RETRIEVAL) return false;
  if (STRUCTURAL_CONTENT_TYPES.has(node.nodeType)) return true;
  const minTokens = envInt('MIN_CONTENT_TOKENS', 4, 1, 1000, '[skeleton] ');
  return meaningfulTokenCount(node.text) >= minTokens;
}
