// Skeleton payload helpers — pure, smoke-testable (impl spec §4, §6, §9).
//
// Two responsibilities:
//   1. expectedChunkingMeta() — the per-file (chunking_model, indexing_schema_version)
//      pair the reindex detector must compare against stored points. This closes
//      review finding B1: a legacy-indexed .md file must trigger a reindex into
//      the (now unconditional) skeleton model instead of "unchanged, skipping",
//      otherwise the collection silently becomes a legacy/skeleton mix.
//   2. skeletonPayloadFields() — the additive payload fields for skeleton-v1
//      chunks. Legacy chunks get NOTHING (impl spec §4: no backfill; absence of
//      chunking_model IS the legacy marker).

import { extname } from 'path';
import { uuidv5 } from '../core/point-id.js';

export const SKELETON_CHUNKING_MODEL = 'skeleton-v1';
// Indexing schema (impl spec §9): versions the point model + chunking behavior,
// separate from embedding_schema_version (vectors/providers, unchanged) and
// from chunking_schema_version (legacy chunker behavior).
// v4: deterministic structural carryover — entityContext() now uses full cleaned
//     prose block instead of last sentence only, changing embedding input for
//     all structural chunks (table / code_block / checklist).
//
// Phase 3U (entity_refs) deliberately does NOT bump this to v5. The version
// exists to flag changes that affect embedding INPUT or point/chunk
// boundaries — the reasons a collection would need reindexing, not just a
// payload patch. entity_refs is purely additive metadata derived from
// content that's already in the payload (raw_content/node_path of chunks
// already indexed) — it changes neither the text handed to the embedder nor
// how many points/chunks a file produces. Any existing skeleton-v1
// collection can receive entity_refs via `npm run backfill:entity-refs`
// (payload-only, no re-embed, no vector touch) instead of a full reindex —
// bumping the schema version would have forced exactly the reindex this
// backfill path exists to avoid, for a field that doesn't need one.
//
// v5: oversized structural entity splitting (entity-split.js). A table/
//     code_block/checklist too large for the collection's embedding budget
//     can now become a non-searchable canonical entity_raw point plus
//     multiple searchable retrieval_content fragment points — a real
//     point/chunk-boundary change (unlike entity_refs above), so this DOES
//     warrant a version bump: a collection whose profile requires
//     splitting, indexed before this existed, may have oversized entity
//     points that previously hard-failed indexing (or were silently
//     truncated by Qdrant) and must be reindexed to pick up correct
//     splitting.
//
// v5 is TOPOLOGY-AWARE, not global (code review, P2): only a collection
// whose resolved embedding profile actually requires splitting
// (chunkingBudget !== null — see resolveEmbeddingBudget,
// qdrant-cloud-catalog.js) needs this reindex. A local client-execution
// (e.g. BGE-M3) collection's topology is completely unaffected by
// entity-split.js — its chunking behavior is byte-identical to before v5
// existed — so forcing it through v5's reindex would be pure waste (a full
// re-embed for zero topology change).
//
// v6: profile-aware PROSE chunk splitting (chunk.js's *Budgeted functions,
//     effectiveBudgetFor/recursiveChunkTextForBudget) — the same gate that
//     drove v5 (chunkingBudget !== null) now ALSO makes ordinary prose
//     chunking (not just structural entities) split against the real
//     per-profile tokenizer/ceiling, which can change prose chunk
//     boundaries/count for such a profile. A v5-indexed cloud collection
//     predates this and has stale prose topology — must reindex. A v4
//     (no-budget/local) collection's prose chunking is completely
//     unaffected and must NOT be force-reindexed, same topology-aware
//     discipline as v5. v6 is a strict superset of what v5 covered (v6 =
//     v5's entity splitting + prose splitting, both gated by the same
//     boolean) — no profile can legitimately need v5-but-not-v6 behavior,
//     so the version selection below collapses to a 2-way BASE/
//     PROFILE_BUDGET choice; INDEXING_SCHEMA_VERSION_SPLIT_ENTITY is kept
//     only as a historical constant for any stored-metadata comparison
//     code that still references the literal 5, no longer selected by
//     expectedChunkingMeta().
//
// Format-agnostic (code review, round 6): earlier, expectedChunkingMeta()
// unconditionally reported indexingSchemaVersion: null for any non-.md
// file regardless of budget — a cloud-profile PDF/Pandoc/plain-text file
// already indexed would be silently skipped forever under the skip-check's
// null === null comparison, never picking up budget-aware splitting (which
// chunk.js's dispatch/chunkFileAsync fix now also applies to non-Markdown
// files). A budget-aware file of ANY extension now reports v6; a
// non-budget-aware non-Markdown file keeps reporting null exactly as
// today.
export const INDEXING_SCHEMA_VERSION_BASE = 4;
export const INDEXING_SCHEMA_VERSION_SPLIT_ENTITY = 5; // historical; no longer selected by expectedChunkingMeta()
export const INDEXING_SCHEMA_VERSION_PROFILE_BUDGET = 6;
// Kept for any external caller that still wants "the current ceiling"
// version number (e.g. a schema-version display) — never used internally
// to decide reindexing; expectedChunkingMeta() always picks between
// INDEXING_SCHEMA_VERSION_BASE and INDEXING_SCHEMA_VERSION_PROFILE_BUDGET
// based on its caller's explicit budgetAwareTopology flag.
export const INDEXING_SCHEMA_VERSION = INDEXING_SCHEMA_VERSION_PROFILE_BUDGET;

export function isSkeletonChunk(chunk) {
  return chunk?.chunking_model === SKELETON_CHUNKING_MODEL;
}

/**
 * Expected chunking meta for a file. Mirrors the branch condition in
 * chunkFileFromPath: skeleton applies unconditionally to Markdown files —
 * it is architecture, not opt-in configuration, so this no longer consults
 * any env var or setting. Non-Markdown files (PDF, Pandoc-converted formats,
 * plain text) stay on the legacy chunker (a documented scope boundary, see
 * chunkFileFromPath's own comments) for chunkingModel — but their
 * indexingSchemaVersion IS budget-aware (format-agnostic, code review round
 * 6): chunk.js's dispatch/chunkFileAsync fix makes non-Markdown chunking
 * budget-aware too, so a non-Markdown file under a budget-aware profile
 * must also report v6, not null, or it would be silently skipped forever
 * by the skip-check's null === null comparison.
 *
 * This is also the mechanism that forces a one-time, per-file reindex of
 * any collection indexed before this became unconditional: a stored legacy
 * point for a .md file has chunkingModel: null, which will never match this
 * function's now-unconditional 'skeleton-v1' result for that same file, so
 * stageA's skip-tuple comparison (src/indexer/run.js) correctly treats it
 * as changed rather than skipping it. An already-current skeleton-v1 file's
 * stored meta already matches and is correctly skipped — no needless
 * rebuild, no INDEXING_SCHEMA_VERSION bump required for this change alone.
 *
 * @param {string} filePath
 * @param {{ budgetAwareTopology?: boolean }} [opts] — budgetAwareTopology
 *   (renamed from splitEntityTopology — it now gates prose splitting too,
 *   not just structural entities): whether THIS collection's resolved
 *   embedding profile requires a token budget (i.e.
 *   resolveEmbeddingBudget(profile) !== null, qdrant-cloud-catalog.js) —
 *   passed explicitly by the caller (stageA, which already resolves the
 *   profile/budget once per run), never read from a global/env flag here.
 *   A collection whose profile never needs a budget (e.g. client/BGE-M3
 *   execution) reports v4/null, the same as it always has — this fix
 *   changes nothing about its topology, so it must never be
 *   force-reindexed (code review, P2: an earlier, non-topology-aware
 *   version bump would have forced every local skeleton collection through
 *   a needless full reindex).
 * @returns {{ chunkingModel: string|null, indexingSchemaVersion: number|null }}
 */
export function expectedChunkingMeta(filePath, { budgetAwareTopology = false } = {}) {
  const skeleton = extname(filePath ?? '').toLowerCase() === '.md';
  const chunkingModel = skeleton ? SKELETON_CHUNKING_MODEL : null;
  if (!skeleton && !budgetAwareTopology) return { chunkingModel: null, indexingSchemaVersion: null };
  const indexingSchemaVersion = budgetAwareTopology
    ? INDEXING_SCHEMA_VERSION_PROFILE_BUDGET
    : INDEXING_SCHEMA_VERSION_BASE;
  return { chunkingModel, indexingSchemaVersion };
}

/**
 * indexing_schema_version for ANY chunk (skeleton or legacy/non-Markdown),
 * mirroring expectedChunkingMeta()'s own three-way contract EXACTLY (code
 * review): expectedChunkingMeta()'s skip-tuple check compares
 * indexingSchemaVersion for non-Markdown files too once the collection's
 * profile requires a budget (round-6/format-agnostic fix), but
 * skeletonPayloadFields itself early-returns {} for any non-skeleton
 * chunk (isSkeletonChunk gate) — so a budget-aware PDF/Pandoc/plain-text
 * point never actually got this field written, and stageA's skip-check
 * would compare a stored `null` against an expected `6` on every single
 * run, forcing that file to reindex forever.
 *
 * The contract this function must match, from expectedChunkingMeta():
 *   - non-skeleton (non-Markdown) AND not budget-aware -> null (absent key,
 *     via `?? null` on read-back) — the untouched legacy contract; writing
 *     BASE here instead would cause the OPPOSITE bug (every ordinary local
 *     PDF/plain-text file spuriously reindexing forever, since
 *     expectedChunkingMeta itself still reports null for this exact case).
 *   - budget-aware (any file type) -> PROFILE_BUDGET (v6).
 *   - skeleton (Markdown), not budget-aware -> BASE (v4).
 * @param {{ isSkeleton: boolean, budgetAwareTopology?: boolean }} opts —
 *   isSkeleton: whether this chunk is a skeleton-v1 (Markdown) chunk,
 *   i.e. isSkeletonChunk(chunk) — required, no default, so a caller can
 *   never silently pass the wrong branch by omission.
 * @returns {{}|{ indexing_schema_version: number }} empty object (no key
 *   at all) for the non-skeleton/non-budget-aware case, matching
 *   expectedChunkingMeta()'s null exactly once read back via `?? null`.
 */
export function indexingSchemaVersionField({ isSkeleton, budgetAwareTopology = false }) {
  if (!isSkeleton && !budgetAwareTopology) return {};
  return {
    indexing_schema_version: budgetAwareTopology ? INDEXING_SCHEMA_VERSION_PROFILE_BUDGET : INDEXING_SCHEMA_VERSION_BASE,
  };
}

/**
 * Additive payload fields for a skeleton-v1 chunk; {} for legacy chunks.
 * Spread into the point payload AFTER the legacy fields so nothing legacy
 * is overwritten and legacy points carry zero new keys.
 *
 * indexing_schema_version is included here too (skeleton chunks still get
 * it from this function, unchanged call shape for existing callers) — but
 * see indexingSchemaVersionField() above for the format-agnostic sibling
 * that non-Markdown callers must ALSO apply, since this function as a
 * whole is a no-op ({}) for any non-skeleton chunk.
 *
 * @param {Object} chunk — output of chunkFromSkeleton (or legacy chunkFile)
 * @param {{ budgetAwareTopology?: boolean }} [opts] — same flag and same
 *   meaning as expectedChunkingMeta's own parameter above (renamed from
 *   splitEntityTopology — it now gates prose splitting too): whether THIS
 *   collection's profile requires a token budget. Every chunk in one file
 *   shares the same collection-level topology, so this is a per-call flag,
 *   not something derived per chunk — even an ordinary, never-split chunk
 *   in a budget-aware-topology collection must still be stamped v6,
 *   matching expectedChunkingMeta's own per-file (not per-chunk) version
 *   so stageA's skip-tuple comparison stays consistent.
 * @returns {Object}
 */
export function skeletonPayloadFields(chunk, { budgetAwareTopology = false } = {}) {
  if (!isSkeletonChunk(chunk)) return {};
  const fields = {
    point_kind:              chunk.point_kind,
    node_type:               chunk.node_type,
    node_id:                 chunk.node_id,
    node_path:               chunk.node_path,
    parent_id:               chunk.parent_id ?? null,
    heading_path:            chunk.heading_path ?? [],
    raw_content:             chunk.raw_content,
    chunking_model:          SKELETON_CHUNKING_MODEL,
    ...indexingSchemaVersionField({ isSkeleton: true, budgetAwareTopology }),
  };
  if (chunk.lang !== undefined && chunk.lang !== null) fields.lang = chunk.lang;
  // Phase 3U: additive, written only when references exist — a prose chunk
  // with no recognized placeholder gets no entity_refs key at all (not an
  // empty array), matching this file's existing convention for `lang`. No
  // payload index is created for this field (see docs/admin-ui-phase3u-...
  // .md's Schema Decision — it is never used as a Qdrant filter).
  if (Array.isArray(chunk.entity_refs) && chunk.entity_refs.length) fields.entity_refs = chunk.entity_refs;
  // Split-entity fragment linkage (entity-split.js) — additive, present
  // only on retrieval_content fragment chunks (chunk.entity_id set by
  // chunkFromSkeleton's payload_raw_embed_context split branch). Absent on
  // the canonical entity_raw point and on ordinary unsplit chunks, matching
  // this function's existing convention for lang/entity_refs: a field that
  // doesn't apply to a chunk is omitted entirely, never written as null/0.
  if (chunk.entity_id !== undefined && chunk.entity_id !== null) {
    fields.entity_id = chunk.entity_id;
    fields.fragment_index = chunk.fragment_index;
    fields.fragment_count = chunk.fragment_count;
  }
  return fields;
}

/**
 * Point ID for a skeleton-v1 chunk — derived from node_id, NOT chunk_index.
 *
 * Transitional stage collapsed (2026-06-10): impl spec §6 originally kept
 * chunkIndex-based point IDs "for MVP" with a later migration. Migrating after
 * collections grow would force a full reindex of every skeleton collection;
 * doing it while skeleton is opt-in and collections are experimental is free.
 *
 * Identity = collection + node_id + embedding schema version. The "point:"
 * domain prefix keeps this ID space disjoint from makePointId and makeNodeId.
 * Cleanup contract: node-derived IDs do not overwrite positionally on
 * structural edits, so skeleton files ALWAYS pre-delete before upsert —
 * SKIP_PRE_DELETE is ignored for skeleton-v1 files (stageA logs this).
 *
 * @param {{ collection: string, nodeId: string, embeddingSchemaVersion: number }} parts
 * @returns {string} UUID
 */
export function makeSkeletonPointId({ collection, nodeId, embeddingSchemaVersion }) {
  return uuidv5(`point:${collection ?? ''}\x00${nodeId ?? ''}\x00${embeddingSchemaVersion ?? ''}`);
}

/**
 * Payload for a skeleton_nav point (impl spec task 6). Pure assembly.
 *
 * Nav points carry ALL semidex discriminator fields (source_file, file_hash,
 * provider metadata, schema versions) so isSemidexPayload() recognises them —
 * otherwise a nav point sampled by `npm run sync` would mark the collection
 * "foreign". chunk_index is -1 by contract: never matched by the range
 * filters in fetchWindowChunks / deleteTrailingChunks (both use gte: 0+).
 *
 * Cleanup: nav points carry source_file, so deleteBySourceFile (skeleton
 * files always pre-delete) and PRUNE_STALE cover them automatically.
 *
 * @param {Object} navPoint — node from buildFileSkeleton()
 * @param {Object} ctx — { fileHash, vectorSize, tokenCountMode,
 *                         chunkingSchemaVersion, embedMeta,
 *                         budgetAwareTopology } — budgetAwareTopology
 *                         (renamed from splitEntityTopology) has the same
 *                         meaning as expectedChunkingMeta's own parameter:
 *                         whether this collection's profile requires a
 *                         token budget.
 * @returns {Object} Qdrant payload
 */
export function buildNavPointPayload(navPoint, ctx = {}) {
  return {
    // Display/content: agents read the summary; text mirrors it for tools
    // that render payload.text.
    text:        navPoint.summary ?? '',
    summary:     navPoint.summary ?? '',
    // Structural complement to the semantic summary ("what's inside" vs
    // "what it's about"). Stored ONLY when it differs from summary — i.e.
    // after LLM summary generation. In inventory mode summary IS the
    // inventory, so the field would be pure duplication. Also serves as the
    // marker for selective re-generation: summary === inventory → LLM failed
    // or was never run for this node.
    ...(navPoint.inventory && navPoint.inventory !== navPoint.summary
        ? { inventory: navPoint.inventory } : {}),
    context:     '',
    section:     navPoint.node_type === 'section' ? (navPoint.heading_path?.at(-1) ?? '') : '',
    tags:        [],
    links:       [],
    children:    navPoint.children ?? [],

    // Skeleton graph fields.
    point_kind:              navPoint.point_kind,
    node_type:               navPoint.node_type,
    node_id:                 navPoint.node_id,
    node_path:               navPoint.node_path,
    parent_id:               navPoint.parent_id ?? null,
    heading_path:            navPoint.heading_path ?? [],
    chunking_model:          SKELETON_CHUNKING_MODEL,
    indexing_schema_version: ctx.budgetAwareTopology ? INDEXING_SCHEMA_VERSION_PROFILE_BUDGET : INDEXING_SCHEMA_VERSION_BASE,

    // Adaptive summary metadata (additive, absent on inventory-only nodes).
    ...(navPoint.summary_kind    ? { summary_kind:    navPoint.summary_kind }    : {}),
    ...(navPoint.summary_version ? { summary_version: navPoint.summary_version } : {}),
    ...(navPoint.key_topics      ? { key_topics:      navPoint.key_topics }      : {}),
    ...(navPoint.notable_terms   ? { notable_terms:   navPoint.notable_terms }   : {}),
    ...(navPoint.child_overview  ? { child_overview:  navPoint.child_overview }  : {}),

    // semidex discriminator fields (isSemidexPayload contract).
    source_file:             navPoint.source_file,
    chunk_index:             -1,               // nav contract: outside all ranges
    total_chunks:            -1,
    file_hash:               ctx.fileHash ?? null,
    vector_size:             ctx.vectorSize ?? null,
    chunking_schema_version: ctx.chunkingSchemaVersion ?? null,
    token_count_mode:        ctx.tokenCountMode ?? null,
    ...(ctx.embedMeta ?? {}),                  // dense/sparse provider fields
  };
}

/**
 * Payload for a canonical entity_raw point (entity-split.js) — pure
 * assembly, mirrors buildNavPointPayload's own shape/contract above.
 *
 * entity_raw carries NO vector at all (code review: Qdrant points do not
 * require one — a vector-less point remains fetchable via scroll/filter
 * and simply never participates in vector search), so this payload also
 * carries no dense/sparse provider metadata derived from a real embed call
 * — the profile's OWN static config values are used instead (embedCfg,
 * the same object stageA/stageC already thread through the pipeline),
 * exactly the way buildNavPointPayload takes `embedMeta` from a REAL embed
 * call for nav summaries (which ARE embedded) — the two payloads look
 * similar but this one's provider fields are never embed-call output.
 *
 * chunk_index/total_chunks are -1 by the same contract buildNavPointPayload
 * uses: entity_raw is never part of the retrieval chunk_index sequence
 * (code review: sharing that index space created a gap a window=1 query
 * around a fragment could silently walk into), so -1 keeps it outside
 * every range filter (fetchWindowChunks/deleteTrailingChunks, both use
 * gte: 0+) the same way a nav point already is.
 *
 * @param {Object} chunk — an entityRawPoints[] entry from chunkFromSkeleton
 * @param {Object} ctx — { fileHash, chunkingSchemaVersion, tokenCountMode,
 *                         denseProvider, denseModel, sparseProvider,
 *                         embeddingSchemaVersion }
 * @returns {Object} Qdrant payload
 */
export function buildEntityRawPointPayload(chunk, ctx = {}) {
  return {
    section:                 chunk.section ?? '',
    source_file:             chunk.source_file,
    chunk_index:             -1,               // entity_raw contract: outside all retrieval ranges
    total_chunks:            -1,
    file_hash:               ctx.fileHash ?? null,
    vector_size:             null,             // no vector — see this function's own doc comment
    chunking_schema_version: ctx.chunkingSchemaVersion ?? null,
    token_count_mode:        ctx.tokenCountMode ?? null,
    dense_provider:          ctx.denseProvider ?? null,
    dense_model:             ctx.denseModel ?? null,
    sparse_provider:         ctx.sparseProvider ?? null,
    embedding_schema_version: ctx.embeddingSchemaVersion ?? null,
    // An entity_raw point exists ONLY when the collection's profile
    // required a budget (entity-split.js), so its own indexing_schema_version
    // is always the profile-budget version by construction — never passed
    // in from ctx, since there is no other possibility for this point kind.
    ...skeletonPayloadFields(chunk, { budgetAwareTopology: true }),
  };
}
