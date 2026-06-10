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

export const SKELETON_CHUNKING_MODEL = 'skeleton-v1';
// Indexing schema (impl spec §9): versions the point model + chunking behavior,
// separate from embedding_schema_version (vectors/providers, unchanged) and
// from chunking_schema_version (legacy chunker behavior).
export const INDEXING_SCHEMA_VERSION = 3;

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
