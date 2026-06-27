// Skeleton payload helpers — pure, smoke-testable (impl spec §4, §6, §9).
//
// Two responsibilities:
//   1. expectedChunkingMeta() — the per-file (chunking_model, indexing_schema_version)
//      pair the reindex detector must compare against stored points. This closes
//      review finding B1: toggling SKELETON_CHUNKING=1 on an already-indexed
//      collection must trigger a reindex instead of "unchanged, skipping",
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
export const INDEXING_SCHEMA_VERSION = 4;

export function isSkeletonChunk(chunk) {
  return chunk?.chunking_model === SKELETON_CHUNKING_MODEL;
}

/**
 * Expected chunking meta for a file under the current environment.
 * Mirrors the branch condition in chunkFileFromPath: skeleton applies only
 * when SKELETON_CHUNKING=1 AND the file is Markdown.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} filePath
 * @returns {{ chunkingModel: string|null, indexingSchemaVersion: number|null }}
 */
export function expectedChunkingMeta(env, filePath) {
  const skeleton = env.SKELETON_CHUNKING === '1'
    && extname(filePath ?? '').toLowerCase() === '.md';
  return skeleton
    ? { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION }
    : { chunkingModel: null, indexingSchemaVersion: null };
}

/**
 * Additive payload fields for a skeleton-v1 chunk; {} for legacy chunks.
 * Spread into the point payload AFTER the legacy fields so nothing legacy
 * is overwritten and legacy points carry zero new keys.
 *
 * @param {Object} chunk — output of chunkFromSkeleton (or legacy chunkFile)
 * @returns {Object}
 */
export function skeletonPayloadFields(chunk) {
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
    indexing_schema_version: INDEXING_SCHEMA_VERSION,
  };
  if (chunk.lang !== undefined && chunk.lang !== null) fields.lang = chunk.lang;
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
 *                         chunkingSchemaVersion, embedMeta }
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
    indexing_schema_version: INDEXING_SCHEMA_VERSION,

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
