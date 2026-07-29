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
// re-embed for zero topology change). expectedChunkingMeta() below takes
// this as an explicit parameter from its caller (stageA, which already
// resolves the budget) rather than reading any global/env state itself.
export const INDEXING_SCHEMA_VERSION_BASE = 4;
export const INDEXING_SCHEMA_VERSION_SPLIT_ENTITY = 5;
// Kept for any external caller that still wants "the current ceiling"
// version number (e.g. a schema-version display) — never used internally
// to decide reindexing; expectedChunkingMeta() always picks between the
// two topology-specific constants above based on its caller's explicit
// splitEntityTopology flag.
export const INDEXING_SCHEMA_VERSION = INDEXING_SCHEMA_VERSION_SPLIT_ENTITY;

export function isSkeletonChunk(chunk) {
  return chunk?.chunking_model === SKELETON_CHUNKING_MODEL;
}

/**
 * Expected chunking meta for a file. Mirrors the branch condition in
 * chunkFileFromPath: skeleton applies unconditionally to Markdown files —
 * it is architecture, not opt-in configuration, so this no longer consults
 * any env var or setting. Non-Markdown files (PDF, Pandoc-converted formats,
 * plain text) stay on the legacy chunker (a documented scope boundary, see
 * chunkFileFromPath's own comments) and report legacy (null) meta here too.
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
 * @param {{ splitEntityTopology?: boolean }} [opts] — splitEntityTopology:
 *   whether THIS collection's resolved embedding profile requires
 *   structural entity splitting (i.e. resolveEmbeddingBudget(profile) !==
 *   null, qdrant-cloud-catalog.js) — passed explicitly by the caller
 *   (stageA, which already resolves the profile/budget once per run), never
 *   read from a global/env flag here. A collection whose profile never
 *   needs splitting (e.g. client/BGE-M3 execution) reports v4, the same
 *   version it always has — entity-split.js changes nothing about its
 *   topology, so it must never be force-reindexed by this version bump
 *   (code review, P2: an earlier, non-topology-aware v5 would have forced
 *   every local skeleton collection through a needless full reindex).
 * @returns {{ chunkingModel: string|null, indexingSchemaVersion: number|null }}
 */
export function expectedChunkingMeta(filePath, { splitEntityTopology = false } = {}) {
  const skeleton = extname(filePath ?? '').toLowerCase() === '.md';
  if (!skeleton) return { chunkingModel: null, indexingSchemaVersion: null };
  const indexingSchemaVersion = splitEntityTopology
    ? INDEXING_SCHEMA_VERSION_SPLIT_ENTITY
    : INDEXING_SCHEMA_VERSION_BASE;
  return { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion };
}

/**
 * Additive payload fields for a skeleton-v1 chunk; {} for legacy chunks.
 * Spread into the point payload AFTER the legacy fields so nothing legacy
 * is overwritten and legacy points carry zero new keys.
 *
 * @param {Object} chunk — output of chunkFromSkeleton (or legacy chunkFile)
 * @param {{ splitEntityTopology?: boolean }} [opts] — same flag and same
 *   meaning as expectedChunkingMeta's own parameter above: whether THIS
 *   collection's profile requires structural entity splitting. Every chunk
 *   in one file shares the same collection-level topology, so this is a
 *   per-call flag, not something derived per chunk — even an ordinary,
 *   never-split chunk in a split-entity-topology collection must still be
 *   stamped v5, matching expectedChunkingMeta's own per-file (not
 *   per-chunk) version so stageA's skip-tuple comparison stays consistent.
 * @returns {Object}
 */
export function skeletonPayloadFields(chunk, { splitEntityTopology = false } = {}) {
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
    indexing_schema_version: splitEntityTopology ? INDEXING_SCHEMA_VERSION_SPLIT_ENTITY : INDEXING_SCHEMA_VERSION_BASE,
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
 *                         splitEntityTopology } — splitEntityTopology has
 *                         the same meaning as expectedChunkingMeta's own
 *                         parameter: whether this collection's profile
 *                         requires structural entity splitting.
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
    indexing_schema_version: ctx.splitEntityTopology ? INDEXING_SCHEMA_VERSION_SPLIT_ENTITY : INDEXING_SCHEMA_VERSION_BASE,

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
    // required splitting (entity-split.js), so its own indexing_schema_version
    // is always the split-entity version by construction — never passed in
    // from ctx, since there is no other possibility for this point kind.
    ...skeletonPayloadFields(chunk, { splitEntityTopology: true }),
  };
}
