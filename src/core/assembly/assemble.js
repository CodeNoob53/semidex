// Document assembly service (Phase 3V) — turns an ordered domain Chunk array
// (StorageAdapter output, camelCase) into a continuous document
// representation: an ordered array of prose and entity segments. Storage-
// independent and pure: no Qdrant SDK, no filter DSL, no admin UI, no MCP —
// its only dependency is the canonical placeholder/reference module
// (core/entity-reference.js), so there is exactly ONE placeholder format and
// ONE matching implementation across indexing, backfill, and assembly.
//
// Ordering model: structural chunks (table/code_block/checklist) already
// occupy their correct source positions in the chunk array — chunkFromSkeleton
// emits them in document order, interleaved with the prose they interrupted.
// So assembly walks the input in its given order and emits exactly one
// segment per chunk (prose or entity); an entity is NEVER inserted a second
// time because a prose chunk references it. The refs' only assembly job is
// placeholder REMOVAL from prose text (plus integrity warnings) — both real
// shapes stay correct without any reordering:
//
//   prose(placeholder at end) -> table chunk          (entity after prose)
//   table chunk -> prose(placeholder at start)        (entity at section start)
//
// Placeholder removal is standalone-line-exact: only a line whose trimmed
// content byte-equals a listed ref's `placeholder` is removed (one line per
// ref occurrence, in ref order). Inline placeholder-looking text is never
// touched — the real chunker only ever emits placeholders as their own
// whole line, so an inline lookalike is ordinary prose. Surrounding prose is
// preserved byte-for-byte except the newline normalization line removal
// makes unavoidable (a removed line's leftover blank-line run is collapsed).

import { attachEntityRefs, STRUCTURAL_TYPES } from '../entity-reference.js';
import { ASSEMBLY_MODES, SEGMENT_KINDS, ASSEMBLY_WARNINGS } from './contract.js';

function isStructuralChunk(chunk) {
  return STRUCTURAL_TYPES.has(chunk?.nodeType);
}

// A skeleton-v1 chunk always carries node_type (mapped to nodeType by the
// adapter); a legacy pre-skeleton chunk never does. That presence/absence is
// the mode discriminator between skeleton assembly and plain_chunks.
function isSkeletonShaped(chunk) {
  return chunk?.nodeType != null;
}

// camelCase domain ref/chunk <-> the snake_case shape the canonical matcher
// (attachEntityRefs) works in. These two tiny mappers exist ONLY so the
// placeholder fallback can call the exact same matching function fresh
// indexing and the backfill use — not a parallel implementation. They are
// internal: no snake_case shape enters or leaves this module's public API.
function toMatcherShape(chunk) {
  return {
    node_type:   chunk.nodeType,
    node_id:     chunk.nodeId,
    node_path:   chunk.nodePath,
    source_file: chunk.sourceFile ?? '',
    section:     chunk.section ?? '',
    point_kind:  'retrieval_content',
    text:        chunk.text ?? '',
  };
}

function toDomainRef(ref) {
  return {
    nodeId:      ref.node_id ?? null,
    nodePath:    ref.node_path ?? null,
    nodeType:    ref.node_type ?? null,
    placeholder: ref.placeholder ?? null,
  };
}

/**
 * Remove each listed ref's placeholder from `text` — standalone lines only,
 * one line consumed per ref, in ref order. Returns { text, removedAny } and
 * pushes integrity warnings for refs whose placeholder line is absent.
 * Never removes a line for a ref whose entity is missing from the input set
 * (the caller pre-filters those into REF_ENTITY_MISSING warnings) — a
 * placeholder whose entity segment can't be emitted must stay visible in the
 * prose rather than silently vanish.
 */
function removeListedPlaceholders(text, refs, chunkIndex, warnings) {
  const lines = String(text ?? '').split('\n');
  const consumed = new Set();

  for (const ref of refs) {
    const at = lines.findIndex((line, i) => !consumed.has(i) && line.trim() === ref.placeholder);
    if (at === -1) {
      warnings.push({
        code: ASSEMBLY_WARNINGS.REF_PLACEHOLDER_NOT_FOUND,
        message: `entityRef placeholder not found as a standalone line in chunk ${chunkIndex}`,
        chunkIndex,
        placeholder: ref.placeholder,
        nodePath: ref.nodePath,
      });
      continue;
    }
    consumed.add(at);
  }

  if (!consumed.size) return { text: String(text ?? ''), removedAny: false };

  const joined = lines.filter((_, i) => !consumed.has(i)).join('\n');
  // Unavoidable newline normalization: a removed standalone-paragraph line
  // leaves its two surrounding blank separators adjacent ("\n\n\n\n") —
  // collapse runs to one paragraph break and drop edge newlines the removal
  // exposed. Only applied when something WAS removed; untouched text passes
  // through byte-identical.
  const normalized = joined.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return { text: normalized, removedAny: true };
}

function proseSegment(chunk, text) {
  return {
    kind: SEGMENT_KINDS.PROSE,
    chunkIndex:  chunk.chunkIndex ?? null,
    nodeType:    chunk.nodeType ?? null,
    text,
    context:     chunk.context ?? null,
    section:     chunk.section ?? null,
    headingPath: chunk.headingPath ?? null,
  };
}

function entitySegment(chunk) {
  return {
    kind: SEGMENT_KINDS.ENTITY,
    chunkIndex:  chunk.chunkIndex ?? null,
    nodeId:      chunk.nodeId ?? null,
    nodePath:    chunk.nodePath ?? null,
    nodeType:    chunk.nodeType ?? null,
    // Authoritative raw source. For skeleton entity chunks `text` IS the raw
    // markdown too (same bytes stored twice), so it is a truthful fallback
    // when raw_content wasn't projected — never context/summary.
    rawContent:  chunk.rawContent ?? chunk.text ?? null,
    lang:        chunk.lang ?? null,
    context:     chunk.context ?? null,
    section:     chunk.section ?? null,
    headingPath: chunk.headingPath ?? null,
  };
}

/**
 * Assemble an ordered segment array from domain chunks. Pure — never mutates
 * `chunks` or any chunk object; input must already be ordered by chunkIndex
 * (both adapter primitives, getFileChunks and getSectionChunks, guarantee
 * that).
 *
 * Reference resolution is PER CHUNK, hybrid (code review, first round): a
 * chunk's stored entityRefs are always used first, and any standalone
 * placeholder occurrence they do NOT cover is resolved through the canonical
 * matcher — so a partially-backfilled scope (one point's refs written, a
 * sibling's not) still assembles every resolvable placeholder instead of
 * leaving it in the prose. If the fallback path was needed for ANY chunk,
 * the whole result is marked placeholder_fallback (a scope is only
 * entity_refs when stored refs alone fully covered it).
 *
 * @param {{
 *   collection: string,
 *   scope: 'file'|'section',
 *   sourceFile?: string|null,
 *   nodePath?: string|null,
 *   chunks: Array<Object>,
 *   skeleton?: boolean — explicit skeleton marker from a caller that KNOWS
 *     (the section route resolved a real skeleton node, so the scope is
 *     skeleton even when it contains zero chunks). When omitted, inferred
 *     from the chunks themselves. Without this, a real-but-empty skeleton
 *     section would be indistinguishable from a legacy collection and
 *     mislabeled plain_chunks (code review, first round).
 *   logFn?: (line: string) => void — called once per request when the
 *     placeholder fallback engages (transitional un-backfilled collection);
 *     defaults to a no-op so pure callers/tests stay silent, the HTTP route
 *     passes a real logger
 * }} opts
 * @returns {import('./contract.js').AssemblyResult}
 */
export function assembleDocument({ collection, scope, sourceFile = null, nodePath = null, chunks, skeleton, logFn = () => {} }) {
  const warnings = [];
  const input = Array.isArray(chunks) ? chunks : [];

  const isSkeleton = skeleton === true || input.some(isSkeletonShaped);
  if (!isSkeleton) {
    return {
      collection, scope, sourceFile, nodePath, assemblyMode: ASSEMBLY_MODES.PLAIN_CHUNKS,
      segments: input.map(c => proseSegment(c, String(c.text ?? ''))),
      warnings,
    };
  }

  // ── Pre-pass: per-chunk resolution plan ──────────────────────────────────
  // One canonical run over the whole scope (the same attachEntityRefs()
  // fresh indexing and the backfill use — never a second parser), then per
  // chunk: which derived occurrences do the stored refs already cover, which
  // are extras the fallback must handle, and which placeholder-shaped lines
  // resolve to nothing at all.
  const { chunks: resolved, orphans } = attachEntityRefs(input.map(toMatcherShape));
  const derivedPerChunk = resolved.map(c => (Array.isArray(c.entity_refs) ? c.entity_refs.map(toDomainRef) : []));
  const orphansPerChunk = new Map(); // input index -> [placeholder, ...]
  for (const orphan of orphans) {
    if (!orphansPerChunk.has(orphan.chunkIndex)) orphansPerChunk.set(orphan.chunkIndex, []);
    orphansPerChunk.get(orphan.chunkIndex).push(orphan.placeholder);
  }

  const plans = input.map((chunk, i) => {
    if (isStructuralChunk(chunk)) return { entity: true };

    const storedRefs = Array.isArray(chunk.entityRefs) ? chunk.entityRefs : [];
    // Occurrence-count coverage by placeholder string: each stored ref
    // accounts for one standalone occurrence, so duplicates (the same entity
    // referenced twice) stay balanced — two stored refs cover two derived
    // occurrences; a third derived occurrence would be an extra.
    const remaining = new Map();
    for (const ref of storedRefs) remaining.set(ref.placeholder, (remaining.get(ref.placeholder) ?? 0) + 1);

    const extras = [];
    for (const ref of derivedPerChunk[i]) {
      const n = remaining.get(ref.placeholder) ?? 0;
      if (n > 0) remaining.set(ref.placeholder, n - 1);
      else extras.push(ref); // resolvable, but no stored ref covers it — fallback work
    }

    const uncoveredOrphans = [];
    for (const placeholder of orphansPerChunk.get(i) ?? []) {
      const n = remaining.get(placeholder) ?? 0;
      // Covered-but-unresolvable = a stored ref exists for this line but its
      // entity is absent from the scope — the stored-ref path below reports
      // that as REF_ENTITY_MISSING; reporting it here too would duplicate.
      if (n > 0) { remaining.set(placeholder, n - 1); continue; }
      uncoveredOrphans.push(placeholder);
    }

    return { entity: false, storedRefs, extras, uncoveredOrphans };
  });

  // The scope is entity_refs ONLY when stored refs fully covered every
  // placeholder occurrence — the moment the canonical resolver had to handle
  // anything (a resolvable extra OR an uncovered unresolvable line), the
  // result is fallback-assembled and says so.
  const fallbackEngaged = plans.some(p => !p.entity && (p.extras.length > 0 || p.uncoveredOrphans.length > 0));
  const mode = fallbackEngaged ? ASSEMBLY_MODES.PLACEHOLDER_FALLBACK : ASSEMBLY_MODES.ENTITY_REFS;
  if (fallbackEngaged) {
    warnings.push({
      code: ASSEMBLY_WARNINGS.PLACEHOLDER_FALLBACK,
      message: 'one or more placeholders in scope are not covered by stored entity_refs — '
        + 'references derived from placeholder lines via the canonical matcher; '
        + 'run "npm run backfill:entity-refs" on this collection for the preferred path',
    });
    logFn(`[assembly] placeholder fallback engaged for ${collection} ${scope}=`
      + `${scope === 'file' ? sourceFile : nodePath} — stored entity_refs do not cover this scope`);
  }

  // Which entities are actually present in the input, so a STORED ref
  // pointing outside the scope is warned about (and its placeholder KEPT)
  // rather than its pointer silently deleted with no entity segment to land
  // on. Fallback extras never need this check — the canonical matcher only
  // ever resolves against entities in the scope.
  const presentEntityKeys = new Set();
  for (const c of input) {
    if (!isStructuralChunk(c)) continue;
    if (c.nodeId) presentEntityKeys.add(c.nodeId);
    if (c.nodePath) presentEntityKeys.add(c.nodePath);
  }

  // ── Emission (original order, one segment per chunk) ─────────────────────
  const segments = [];
  input.forEach((chunk, i) => {
    const plan = plans[i];
    if (plan.entity) {
      segments.push(entitySegment(chunk));
      return;
    }

    const removable = [];
    for (const ref of plan.storedRefs) {
      const present = (ref.nodeId && presentEntityKeys.has(ref.nodeId))
        || (ref.nodePath && presentEntityKeys.has(ref.nodePath));
      if (present) {
        removable.push(ref);
      } else {
        warnings.push({
          code: ASSEMBLY_WARNINGS.REF_ENTITY_MISSING,
          message: `entityRef points at an entity absent from this ${scope} scope — placeholder kept in prose`,
          chunkIndex: chunk.chunkIndex ?? null,
          placeholder: ref.placeholder,
          nodePath: ref.nodePath,
        });
      }
    }
    removable.push(...plan.extras);

    const { text } = removeListedPlaceholders(chunk.text, removable, chunk.chunkIndex ?? null, warnings);

    for (const placeholder of plan.uncoveredOrphans) {
      warnings.push({
        code: ASSEMBLY_WARNINGS.ORPHAN_PLACEHOLDER,
        message: `placeholder resolves to no entity in scope (chunk ${chunk.chunkIndex ?? '?'}) — left in prose`,
        chunkIndex: chunk.chunkIndex ?? null,
        placeholder,
      });
    }

    // A prose chunk whose entire text was placeholders yields nothing to
    // read — omit rather than emit an empty segment.
    if (text.trim() === '') return;
    segments.push(proseSegment(chunk, text));
  });

  return { collection, scope, sourceFile, nodePath, assemblyMode: mode, segments, warnings };
}
