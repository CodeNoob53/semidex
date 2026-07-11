// Structural entity references (design §11 follow-on, Phase 3U) — the data
// foundation for document assembly. A prose chunk's placeholder line (e.g.
// "[table node: guide.md#setup/table-1 — Option | Default]") is the ONLY
// link between a piece of prose and the structural entity (table/code_block/
// checklist) it interrupted; today that link only exists as a string a human
// reads. This module makes it a structured, ordered `entity_refs` array on
// the prose chunk's own payload, so a later assembly service can replace
// each placeholder with its real entity by node_id/node_path — no heuristic
// re-parsing of the placeholder text at assembly time.
//
// Two responsibilities, kept in one file so the placeholder FORMAT is never
// duplicated:
//   - placeholderForReference(sourceFile, node, nodePath) — build a
//     placeholder line (single source of truth; skeleton-chunk.js calls
//     this instead of owning its own format).
//   - attachEntityRefs(chunks) — given a finished chunk array (skeleton-v1
//     shape, after chunkFromSkeleton has assembled every chunk's FINAL
//     text), return a new array where every prose chunk containing one or
//     more recognized placeholder occurrences gets an ordered `entity_refs`
//     array describing exactly those entities, in the order the
//     placeholders appear in the prose text.
//
// attachEntityRefs() is intentionally a pure, second pass over the finished
// chunk array — not interleaved into chunkFromSkeleton's single forward walk
// — because entity_refs must describe the ACTUAL FINAL prose text, including
// placeholders appended post-hoc (design: skeleton-chunk.js attaches a
// placeholder to the "last emitted prose chunk of this section" when an
// entity has no preceding-prose accumulator of its own — see
// skeleton-chunk.js's payload_raw_embed_context case, step 2). A single
// forward walk cannot know a later post-hoc append will happen when it first
// emits that prose chunk; a second pass over the finished array can, because
// by then every append has already happened.
//
// ── Exact matching by node_path, not by parsing the hint (code review,
// third round) ──────────────────────────────────────────────────────────
// A placeholder's HINT (the entity's own first line of raw content, e.g. a
// table's flattened cell text, or a checklist's first item) is never
// preserved on the stored/final chunk shape — chunkFromSkeleton() uses it
// only transiently, at the moment it builds the placeholder string, then
// discards it (the chunk's own `text`/`raw_content` field holds the RAW
// MARKDOWN of the entity, not the plain-text hint rendering). This means
// attachEntityRefs() can never regenerate an entity's ORIGINAL placeholder
// hint byte-for-byte from the chunk array alone — true for backfill
// (reconstructing from a stored Qdrant payload) AND for fresh indexing
// (the chunk objects chunkFromSkeleton itself just built).
//
// Two earlier approaches tried to work around this by PARSING a
// placeholder's interior generically (a bounded character class, then a
// prefix-anchored bounded-window scan) — both broke on real, unremarkable
// input: a node_path's sourceFile component can itself contain a space or
// an em dash (a real, valid filename — "docs/Guide — Draft.md" is not a
// hypothetical), and a hint can independently contain its own em dash or
// literal "]". There is no way to find "the" node_path/hint boundary by
// looking at an arbitrary placeholder string in isolation.
//
// The actual fix: never try to recover a hint or find a boundary at all.
// A node_path is the one piece of identity ALWAYS preserved verbatim on
// every real entity chunk (fresh or reconstructed from storage) — so
// attachEntityRefs() matches a placeholder-shaped span in the prose against
// the SET of known, exact node_paths for entities in that prose chunk's own
// (source_file, section) scope: the content between "node: " and the
// closing "]" EXACT-MATCHES a known node_path (no hint), or STARTS WITH a
// known node_path immediately followed by " — " (a hint follows, whatever
// it contains — its exact text is irrelevant to resolution, since only the
// node_path identifies which entity a placeholder names). Known paths are
// tried longest-first so an ordinal-suffix collision (e.g. "table-1" being
// a literal prefix of "table-10") can never falsely match the shorter path
// — the boundary check (immediately followed by end-of-content or " — ")
// makes this safe even without the length ordering, but trying longest
// first keeps the intent obvious.

const NODE_TYPE_LABEL = Object.freeze({
  table: 'table',
  code_block: 'code block',
  checklist: 'checklist',
});

const STRUCTURAL_TYPES = new Set(['table', 'code_block', 'checklist']);

// Recognizes "this looks like a placeholder" for locating candidate SPANS
// in the prose text and for ORPHAN REPORTING when a span's node_path can't
// be matched against any known entity. Never used to derive a node_path by
// itself — see the module-level comment above for why that split is
// fundamentally ambiguous. Also used by node-policy.js's isContentBearing()
// gate for its own, separate concern (stripping non-content lines before
// counting meaningful tokens) — that usage only needs "is this whole line
// placeholder-shaped", never a path/hint split.
export const PLACEHOLDER_LINE_RE = /^\[(?:table|code block|checklist|list|image) node: .*\]$/;

// Fixed prefix marking the start of a placeholder-shaped span. Not global —
// only ever matched at the start of a line already confirmed by
// PLACEHOLDER_LINE_RE to be a whole-line placeholder, so there is exactly
// one prefix per line to find.
const PLACEHOLDER_PREFIX_RE = /^\[(?:table|code block|checklist) node: /;

/**
 * Build the placeholder line for a structural node — the single source of
 * truth for the placeholder format. skeleton-chunk.js calls this at
 * chunk-build time (with the real node's own text, giving a real hint).
 *
 * @param {string} sourceFile
 * @param {{ nodeType: string, text?: string, headingPath?: string[], parentStructuralPath?: string, structuralPath?: string, ordinalWithinParent?: number }} n — skeleton node shape (post applyNodePolicy)
 * @param {string} nodePath — precomputed node_path (sourceFile#structuralPath), passed in rather than recomputed here to avoid a second nodePathOf() implementation
 * @returns {string}
 */
export function placeholderForReference(sourceFile, n, nodePath) {
  const label = NODE_TYPE_LABEL[n.nodeType] ?? n.nodeType;
  const hint = String(n.text ?? '').trim().split('\n')[0].slice(0, 60);
  return `[${label} node: ${nodePath}${hint ? ` — ${hint}` : ''}]`;
}

// Finds every placeholder-shaped LINE in `text`, in order. A placeholder is
// never an inline substring of a larger line of prose — skeleton-chunk.js
// always emits it as its own WHOLE paragraph/line, joined with "\n\n" (see
// the module-level comment), and PLACEHOLDER_LINE_RE already encodes "a
// placeholder is an entire line" as this module's contract. So scanning
// first requires the trimmed line, in full, to match PLACEHOLDER_LINE_RE —
// a line like "prefix [table node: a.md#s/table-1] suffix" is real prose
// that merely CONTAINS placeholder-shaped text and must be ignored, not
// matched (code review, fifth round: the previous version still located the
// "[<label> node: " prefix anywhere inside a line, so an inline mention
// embedded in ordinary prose was still scanned and could still resolve).
// Only once a line qualifies as a real, whole-line placeholder is its
// single prefix/closing-bracket span extracted. Returns
// [{ index, raw, afterPrefix }] — afterPrefix is everything between
// "node: " and the final "]", still UNPARSED (no node_path/hint split is
// attempted here — see the module-level comment).
function scanPlaceholderShapedSpans(text) {
  const str = String(text ?? '');
  const out = [];
  let lineStart = 0;
  for (const line of str.split('\n')) {
    const trimmed = line.trim();
    // PLACEHOLDER_LINE_RE also accepts "list"/"image" labels (node-policy.js's
    // broader gate), which are not structural entity types this module
    // resolves (STRUCTURAL_TYPES) — PLACEHOLDER_PREFIX_RE is narrower on
    // purpose, so a "[list node: ...]"/"[image node: ...]" line correctly
    // fails to produce a span here and is never even orphan-reported (it was
    // never a table/code_block/checklist reference to begin with).
    const prefixMatch = PLACEHOLDER_PREFIX_RE.exec(trimmed);
    if (PLACEHOLDER_LINE_RE.test(trimmed) && prefixMatch) {
      const contentStart = prefixMatch[0].length;
      const closeIndex = trimmed.lastIndexOf(']'); // the line's own final "]" — PLACEHOLDER_LINE_RE already anchored the line to end in "]"
      out.push({
        index: lineStart + line.indexOf(trimmed),
        raw: trimmed,
        afterPrefix: trimmed.slice(contentStart, closeIndex),
      });
    }
    lineStart += line.length + 1; // +1 for the '\n' split() consumed
  }
  return out;
}

// Resolves a placeholder span's `afterPrefix` content to one of the KNOWN,
// exact node_paths in `candidatePaths` (longest first) — matching either
// the whole content (no hint) or a known path immediately followed by
// " — " (a hint follows, its exact text never inspected). Returns the
// matched node_path, or null if none of the known paths resolve it (an
// orphan).
function resolveNodePath(afterPrefix, candidatePaths) {
  for (const path of candidatePaths) {
    if (afterPrefix === path) return path;
    if (afterPrefix.startsWith(`${path} — `)) return path;
  }
  return null;
}

/**
 * Attach ordered `entity_refs` to every prose chunk in `chunks` that
 * contains one or more placeholder occurrences resolving, by EXACT
 * node_path match, to a real structural entity in its own scope. Pure —
 * returns a NEW array (chunks with no matching placeholder are returned
 * unchanged, by reference, so callers doing `chunk === original` elsewhere
 * are not broken); never mutates the input array or its chunk objects.
 *
 * Contract:
 *   - for every structural chunk (table/code_block/checklist) in `chunks`,
 *     its OWN real node_path (already on the chunk, verbatim — never
 *     recomputed or guessed) is indexed by (source_file, section);
 *   - for every prose chunk, every placeholder-SHAPED span in its text
 *     (see PLACEHOLDER_LINE_RE) is resolved against ONLY the candidate
 *     node_paths from its own (source_file, section) scope — via exact
 *     string matching (resolveNodePath), never a generic hint/path
 *     boundary guess. This means a node_path containing a space, an em
 *     dash, or any other character a real filename can hold resolves
 *     correctly, and a hint containing its own em dash or literal "]"
 *     never confuses which node_path a placeholder names;
 *   - never links a placeholder to an entity from a different source_file
 *     or a different section — enforced structurally, since the candidate
 *     set searched for a given prose chunk is scoped to its own
 *     (source_file, section) pair, never the whole collection;
 *   - preserves the textual order placeholders appear in within each
 *     chunk's text (spans are found and sorted by character position);
 *   - a placeholder-shaped span that does not resolve to any known
 *     node_path in scope (orphan) is never silently turned into a
 *     fabricated reference — it is omitted from entity_refs and reported
 *     back via the second return value.
 *
 * @param {Array<Object>} chunks — skeleton-v1 chunk array (chunkFromSkeleton
 *   output, or the equivalent shape reconstructed from stored Qdrant
 *   payloads by the backfill script) — snake_case field names throughout,
 *   matching chunkFromSkeleton's own output shape.
 * @returns {{ chunks: Array<Object>, orphans: Array<{ chunkIndex: number, sourceFile: string, placeholder: string }> }}
 */
export function attachEntityRefs(chunks) {
  // candidateIndex: sourceFile -> section -> Map(node_path -> entity chunk),
  // plus a parallel sorted-longest-first node_path array per scope so
  // resolveNodePath() can try longer (more specific) paths before shorter
  // ones that might otherwise falsely prefix-match.
  const candidateIndex = new Map();
  for (const c of chunks) {
    if (!STRUCTURAL_TYPES.has(c.node_type)) continue;
    if (!c.node_id || !c.node_path) continue;
    const sf = c.source_file ?? '';
    const section = c.section ?? '';
    if (!candidateIndex.has(sf)) candidateIndex.set(sf, new Map());
    const bySection = candidateIndex.get(sf);
    if (!bySection.has(section)) bySection.set(section, { byPath: new Map(), sortedPaths: [] });
    const scope = bySection.get(section);
    scope.byPath.set(c.node_path, c);
  }
  for (const bySection of candidateIndex.values()) {
    for (const scope of bySection.values()) {
      scope.sortedPaths = [...scope.byPath.keys()].sort((a, b) => b.length - a.length);
    }
  }

  const orphans = [];
  const out = chunks.map((c, chunkIndex) => {
    if (STRUCTURAL_TYPES.has(c.node_type)) return c;      // entities never reference themselves
    if (c.point_kind && c.point_kind !== 'retrieval_content') return c; // nav points excluded

    const text = String(c.text ?? '');
    const sf = c.source_file ?? '';
    const section = c.section ?? '';
    const scope = candidateIndex.get(sf)?.get(section);
    const spans = scanPlaceholderShapedSpans(text);

    const refs = [];
    for (const span of spans) {
      const nodePath = scope ? resolveNodePath(span.afterPrefix, scope.sortedPaths) : null;
      const entity = nodePath ? scope.byPath.get(nodePath) : null;
      if (!entity) {
        orphans.push({ chunkIndex, sourceFile: sf, placeholder: span.raw });
        continue;
      }
      refs.push({ node_id: entity.node_id, node_path: entity.node_path, node_type: entity.node_type, placeholder: span.raw });
    }

    if (!refs.length) {
      if (c.entity_refs === undefined) return c; // nothing resolved AND nothing stale to clear — genuinely unchanged
      const { entity_refs, ...rest } = c;
      return rest;
    }
    return { ...c, entity_refs: refs };
  });

  return { chunks: out, orphans };
}
