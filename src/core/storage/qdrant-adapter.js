// QdrantStorageAdapter: implements the StorageAdapter contract (adapter.js)
// by delegating to src/core/qdrant/ (store.js, schema.js, ensure-schema.js).
//
// This is the ONLY file that translates between Qdrant's snake_case payload
// shapes / filter DSL and semidex domain shapes (camelCase, no Qdrant
// internals). Callers above this layer (a future Local API) must never see
// point_kind, node_type snake_case fields, or Qdrant filter objects.
import * as store from '../qdrant/store.js';
import { isSemidexPayload } from '../qdrant/payload.js';
import { ensureCollectionSchema } from '../qdrant/ensure-schema.js';
import { classifyVectorSchema } from '../doctor-checks.js';
import { withNavExcluded, isNavPoint } from '../qdrant/nav-filter.js';
import { loadConfig } from '../config.js';
import { mergeCapabilities } from './capabilities.js';
import { createProfileCache } from './embedding-profile-cache.js';
import {
  METADATA_KEY_EMBEDDING_PROFILE, METADATA_KEY_INDEXING_STATE,
  EMBEDDING_PROFILE_SCHEMA_VERSION,
  validateEmbeddingProfile, validateIndexingState,
} from '../embedding-profile/schema.js';
import { foldPayloadConsistency, inferLegacyProfile, IDENTITY_FIELDS } from '../embedding-profile/migrate.js';
import { resolveAvailability, COLLECTION_STATUS } from '../embedding-profile/availability.js';
import { checkOnnxModelCached as defaultCheckOnnxModelCached } from '../embedding-profile/onnx-lane.js';

const QDRANT_CAPABILITIES = mergeCapabilities({
  namedVectors:     true,
  sparseVectors:    true,
  hybridSearch:     true,
  payloadIndexes:   true,
  aliases:          false,
  snapshots:        false,
  collectionExists: true,
});

// Qdrant's own Distance enum (confirmed against the installed SDK's
// generated OpenAPI types) — used to validate a profile's declared
// dense.distance before ever sending a create-collection request.
const QDRANT_DISTANCE_VALUES = new Set(['Cosine', 'Euclid', 'Dot', 'Manhattan']);

// ── Domain mapping helpers ──────────────────────────────────────────────────
// snake_case Qdrant payload -> camelCase semidex domain shapes.
// Kept as small pure functions so tests can assert on mapping without a
// live Qdrant instance.

// Maps a raw entity_refs payload entry (snake_case, as stored by
// skeletonPayloadFields()) to the camelCase domain shape returned by
// toChunk(), so no raw entity_refs/node_id snake_case field reaches a
// caller above this adapter. Structural entity chunks never carry refs.
function toEntityRef(ref) {
  return {
    nodeId:      ref?.node_id ?? null,
    nodePath:    ref?.node_path ?? null,
    nodeType:    ref?.node_type ?? null,
    placeholder: ref?.placeholder ?? null,
  };
}

function toEntityRefs(payload) {
  return Array.isArray(payload?.entity_refs) ? payload.entity_refs.map(toEntityRef) : [];
}

export function toChunk(point) {
  const p = point?.payload ?? {};
  return {
    sourceFile:   p.source_file ?? null,
    chunkIndex:   Number.isInteger(p.chunk_index) ? p.chunk_index : null,
    totalChunks:  Number.isInteger(p.total_chunks) ? p.total_chunks : null,
    section:      p.section ?? null,
    text:         p.text ?? null,
    rawContent:   p.raw_content ?? null,
    lang:         p.lang ?? null,
    context:      p.context ?? null,
    tags:         Array.isArray(p.tags) ? p.tags : [],
    nodeType:     p.node_type ?? null,
    nodeId:       p.node_id ?? null,
    nodePath:     p.node_path ?? null,
    parentId:     p.parent_id ?? null,
    headingPath:  Array.isArray(p.heading_path) ? p.heading_path : null,
    entityRefs:   toEntityRefs(p),
    score:        typeof point?.score === 'number' ? point.score : null,
    isMatch:      null,
  };
}

export function toSourceDocument(entry) {
  return {
    sourceFile:   entry.source_file,
    chunkCount:   entry.chunkCount,
    firstSection: entry.firstSection || null,
    tags:         entry.tags ?? [],
  };
}

export function toSkeletonNode(payload) {
  if (!payload) return null;
  return {
    nodeType:     payload.node_type ?? null,
    nodeId:       payload.node_id ?? null,
    nodePath:     payload.node_path ?? null,
    parentId:     payload.parent_id ?? null,
    summary:      payload.summary ?? null,
    headingPath:  payload.heading_path ?? null,
    sourceFile:   payload.source_file ?? null,
    childCount:   Array.isArray(payload.children) ? payload.children.length : 0,
    children:     Array.isArray(payload.children) ? payload.children : [],
    inventory:    payload.inventory ?? null,
    keyTopics:    payload.key_topics ?? null,
  };
}

// Maps ANY non-nav content point (table/code_block/checklist/paragraph/
// list/blockquote/image/…) — the underlying store primitives
// (getContentNodeById/getContentNodeByPath) never filter by node_type, only
// by point_kind !== 'skeleton_nav'. Named toContentNodeChunk (not
// toStructuralNodeChunk) because "structural" would wrongly imply this
// rejects prose; it does not — a prose node_id/node_path resolves here too.
export function toContentNodeChunk(payload) {
  if (!payload) return null;
  return {
    sourceFile:   payload.source_file ?? null,
    chunkIndex:   Number.isInteger(payload.chunk_index) ? payload.chunk_index : null,
    totalChunks:  null,
    section:      payload.section ?? null,
    // Structural content nodes (table/code_block/checklist) may not always
    // carry a separate `text` field the way retrieval chunks do — fall back
    // to raw_content so callers still get displayable content, but rawContent
    // below is always the byte-exact source regardless of this fallback.
    text:         payload.text ?? payload.raw_content ?? null,
    rawContent:   payload.raw_content ?? null,
    lang:         payload.lang ?? null,
    context:      payload.context ?? null,
    tags:         [],
    nodeType:     payload.node_type ?? null,
    nodeId:       payload.node_id ?? null,
    nodePath:     payload.node_path ?? null,
    // parentId (Phase 3X): needed to resolve an anchor node's own containing
    // section without a new adapter method — getContentNode() -> parentId
    // -> getSkeletonNode({ nodeId: parentId }) is the whole chain MCP's
    // bounded content assembly needs to go from "one search-hit node_id" to
    // "the exact section it lives in."
    parentId:     payload.parent_id ?? null,
    headingPath:  Array.isArray(payload.heading_path) ? payload.heading_path : null,
    score:        null,
    isMatch:      null,
  };
}

/**
 * Translate the semidex-level search filter into a Qdrant filter object.
 * This is the ONLY place a Qdrant filter DSL shape is built from adapter
 * inputs — callers pass { sourceFile?, tags?, excludeNav? }, never Qdrant
 * `must`/`should` clauses directly.
 *
 * @param {{ sourceFile?: string, tags?: string[], excludeNav?: boolean }} [filter]
 * @returns {Object|null}
 */
export function translateSearchFilter(filter) {
  if (!filter) return null;
  const must = [];
  if (filter.sourceFile) must.push({ key: 'source_file', match: { value: filter.sourceFile } });
  if (filter.tags?.length) must.push({ should: filter.tags.map(t => ({ key: 'tags', match: { value: t } })) });

  let qdrantFilter = must.length ? { must } : null;
  if (filter.excludeNav) qdrantFilter = withNavExcluded(qdrantFilter);
  return qdrantFilter;
}

// ── Embedding profile: Qdrant-shape-reading functions ───────────────────────
// This adapter is the ONLY place that reads CollectionInfo.config.metadata /
// config.params.vectors/sparse_vectors for the embedding profile feature —
// src/core/embedding-profile/schema.js (the domain contract module) never
// sees a Qdrant response shape at all. Every function below is pure (input:
// an already-fetched CollectionInfo object; no network call inside), so
// they're directly unit-testable with plain fixtures.

/**
 * Normalizes Qdrant's raw vector schema (info.config.params.vectors /
 * sparse_vectors) into the small domain-shaped summary
 * { dense: { name, dimensions, distance } | null, sparse: { name, modifier } | null }
 * — the ONLY function in the codebase that reads this Qdrant shape for the
 * embedding-profile feature. `dense` is null when the schema is empty/
 * unrecognized (classifyVectorSchema() !== 'named'/'flat' with a dense key);
 * `sparse` is null when no sparse_vectors key is present; `sparse.modifier`
 * is null when a sparse vector exists but has no modifier configured.
 */
export function normalizeVectorSchema(collectionInfo) {
  const vectorsCfg = collectionInfo?.config?.params?.vectors ?? {};
  const kind = classifyVectorSchema(vectorsCfg);
  let dense = null;
  if (kind === 'named' && vectorsCfg.dense) {
    dense = { name: 'dense', dimensions: vectorsCfg.dense.size ?? null, distance: vectorsCfg.dense.distance ?? null };
  } else if (kind === 'flat') {
    dense = { name: 'dense', dimensions: vectorsCfg.size ?? null, distance: vectorsCfg.distance ?? null };
  }

  const sparseVectorsCfg = collectionInfo?.config?.params?.sparse_vectors ?? null;
  let sparse = null;
  if (sparseVectorsCfg && sparseVectorsCfg.sparse) {
    sparse = { name: 'sparse', modifier: sparseVectorsCfg.sparse.modifier ?? null };
  }

  return { dense, sparse };
}

// Only 'dense'/'sparse' vector names are supported end to end — every real
// profile-building path (resolveNewCollectionProfile, inferLegacyProfile)
// only ever produces these two, and Semidex's search/upsert/skeleton-nav
// code assumes these literal names throughout (classifyVectorSchema() and
// this file's own normalizeVectorSchema() only ever look for a `dense` key).
// A custom vectorName is a real, documented field in the profile schema
// (for future extensibility) but is NOT wired up anywhere else in this
// codebase — creating a collection with a custom name today would produce
// a collection none of Semidex's own search/indexing code could actually
// use. Rather than silently ignoring a custom vectorName at create time
// (which is exactly the class of bug this whole feature exists to close),
// buildQdrantVectorSchemaFromProfile() rejects it explicitly, before any
// network call.
const SUPPORTED_VECTOR_NAMES = Object.freeze({ dense: 'dense', sparse: 'sparse' });

/**
 * Builds the FULL Qdrant collection-creation vector schema
 * ({ vectors, sparse_vectors }) from a resolved embedding profile — the
 * single source of truth for what gets created, replacing the old
 * always-Cosine/always-sparse/no-modifier hardcoded default
 * (collectionVectorSchema() in core/qdrant/schema.js, still used for the
 * few genuinely profile-less/legacy test-fixture callers outside the
 * adapter). Every dense/sparse field the profile declares (distance,
 * sparse presence, modifier) is honored; nothing is assumed.
 *
 * Throws before any network call if the profile is unrepresentable in
 * Qdrant's create-collection schema — a plain-vector distance Qdrant
 * doesn't support, or (see SUPPORTED_VECTOR_NAMES above) a custom
 * vectorName nothing else in this codebase can actually use.
 *
 * @param {Object} profile — a valid (validateEmbeddingProfile-passing) embedding profile
 * @returns {{ vectors: Object, sparse_vectors?: Object }}
 */
export function buildQdrantVectorSchemaFromProfile(profile) {
  const dense = profile.embedding.dense;
  if (dense.vectorName !== SUPPORTED_VECTOR_NAMES.dense) {
    throw new Error(`buildQdrantVectorSchemaFromProfile: unsupported dense vectorName "${dense.vectorName}" — only "dense" is wired up end to end in this codebase today.`);
  }
  if (!QDRANT_DISTANCE_VALUES.has(dense.distance)) {
    throw new Error(`buildQdrantVectorSchemaFromProfile: unsupported dense distance "${dense.distance}" — Qdrant supports: ${[...QDRANT_DISTANCE_VALUES].join(', ')}.`);
  }

  const schema = { vectors: { [dense.vectorName]: { size: dense.dimensions, distance: dense.distance } } };

  const sparse = profile.embedding.sparse;
  if (sparse !== null) {
    if (sparse.vectorName !== SUPPORTED_VECTOR_NAMES.sparse) {
      throw new Error(`buildQdrantVectorSchemaFromProfile: unsupported sparse vectorName "${sparse.vectorName}" — only "sparse" is wired up end to end in this codebase today.`);
    }
    schema.sparse_vectors = {
      [sparse.vectorName]: {
        index: { on_disk: false },
        ...(sparse.modifier ? { modifier: sparse.modifier } : {}),
      },
    };
  }
  // sparse === null -> no sparse_vectors key at all — a genuinely dense-only
  // collection, never the old unconditional sparse-vector creation that
  // ignored what the profile actually declared.

  return schema;
}

/**
 * Reads collectionInfo.config.metadata[METADATA_KEY_EMBEDDING_PROFILE],
 * validates it via schema.js's validateEmbeddingProfile(profile) — passing
 * it a plain domain object, never a Qdrant response — and returns ONE typed
 * result. Never collapses distinct failure reasons into a single "none":
 *   { state: 'valid', profile }
 *   { state: 'missing' }                          — no key at all
 *   { state: 'invalid', errors }                  — key present, fails validateEmbeddingProfile
 *   { state: 'unsupported_schema_version', found } — schemaVersion > EMBEDDING_PROFILE_SCHEMA_VERSION
 */
export function extractEmbeddingProfile(collectionInfo) {
  const raw = collectionInfo?.config?.metadata?.[METADATA_KEY_EMBEDDING_PROFILE];
  if (raw === undefined || raw === null) return { state: 'missing' };

  // A newer schemaVersion than this codebase understands is checked BEFORE
  // full structural validation — a newer version may legitimately use a
  // shape validateEmbeddingProfile() would otherwise reject as "invalid,"
  // which would misreport a forward-compatible profile as corrupt.
  const foundVersion = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw.schemaVersion : undefined;
  if (typeof foundVersion === 'number' && foundVersion > EMBEDDING_PROFILE_SCHEMA_VERSION) {
    return { state: 'unsupported_schema_version', found: foundVersion };
  }

  const result = validateEmbeddingProfile(raw);
  if (result.valid) return { state: 'valid', profile: raw };
  return { state: 'invalid', errors: result.errors };
}

/**
 * Reads collectionInfo.config.metadata[METADATA_KEY_INDEXING_STATE]. Same
 * typed-result shape as extractEmbeddingProfile, using
 * validateIndexingState() from schema.js.
 */
export function extractIndexingState(collectionInfo) {
  const raw = collectionInfo?.config?.metadata?.[METADATA_KEY_INDEXING_STATE];
  if (raw === undefined || raw === null) return { state: 'missing' };
  const result = validateIndexingState(raw);
  if (result.valid) return { state: 'valid', indexingState: raw };
  return { state: 'invalid', errors: result.errors };
}

/**
 * Compares a domain profile against the NORMALIZED vector-schema summary
 * (never against raw Qdrant shapes) — calls normalizeVectorSchema() itself,
 * then a pure comparison of dense { name, dimensions, distance } AND, when
 * profile.embedding.sparse is non-null, sparse { name, modifier }. Returns
 * a mismatch report, never throws:
 *   { matches: true }
 *   { matches: false, mismatches: [{ field, expected, found }, ...] }
 */
export function validateProfileAgainstSchema(profile, collectionInfo) {
  const live = normalizeVectorSchema(collectionInfo);
  const mismatches = [];

  const dense = profile?.embedding?.dense;
  if (!live.dense) {
    mismatches.push({ field: 'dense', expected: dense?.vectorName ?? 'dense', found: null });
  } else {
    if (dense?.vectorName !== live.dense.name) mismatches.push({ field: 'dense.vectorName', expected: dense?.vectorName, found: live.dense.name });
    if (dense?.dimensions !== live.dense.dimensions) mismatches.push({ field: 'dense.dimensions', expected: dense?.dimensions, found: live.dense.dimensions });
    if (dense?.distance !== live.dense.distance) mismatches.push({ field: 'dense.distance', expected: dense?.distance, found: live.dense.distance });
  }

  const sparse = profile?.embedding?.sparse;
  if (sparse === null || sparse === undefined) {
    if (live.sparse) mismatches.push({ field: 'sparse', expected: null, found: live.sparse.name });
  } else if (!live.sparse) {
    mismatches.push({ field: 'sparse', expected: sparse.vectorName, found: null });
  } else {
    if (sparse.vectorName !== live.sparse.name) mismatches.push({ field: 'sparse.vectorName', expected: sparse.vectorName, found: live.sparse.name });
    const expectedModifier = sparse.modifier ?? null;
    const foundModifier = live.sparse.modifier ?? null;
    if (expectedModifier !== foundModifier) mismatches.push({ field: 'sparse.modifier', expected: expectedModifier, found: foundModifier });
  }

  return mismatches.length === 0 ? { matches: true } : { matches: false, mismatches };
}

/**
 * The ONE canonical way to derive a profile's typed state from a
 * CollectionInfo — combines extractEmbeddingProfile() (metadata shape) with
 * validateProfileAgainstSchema() (live vector schema agreement), so a
 * shape-valid profile that disagrees with the collection's REAL vector
 * schema is never reported as 'valid'. Used by every canonical read path
 * (resolveEmbeddingProfile(), listCollections(), getCollection()) so none
 * of them can accidentally skip the schema check — extractEmbeddingProfile()
 * alone is intentionally NOT sufficient to trust a profile as usable.
 *
 * @param {Object} collectionInfo
 * @returns {{ state: 'valid', profile: Object }
 *   | { state: 'missing' }
 *   | { state: 'invalid', errors: string[] }
 *   | { state: 'unsupported_schema_version', found: number }
 *   | { state: 'schema_mismatch', profile: Object, mismatches: Array }}
 */
export function resolveEmbeddingProfileFromInfo(collectionInfo) {
  const extracted = extractEmbeddingProfile(collectionInfo);
  if (extracted.state !== 'valid') return extracted;
  const schemaCheck = validateProfileAgainstSchema(extracted.profile, collectionInfo);
  if (!schemaCheck.matches) {
    return { state: 'schema_mismatch', profile: extracted.profile, mismatches: schemaCheck.mismatches };
  }
  return extracted;
}

/**
 * Pure write-guard decision for setEmbeddingProfile(): returns 'write' or
 * 'reject', never a boolean, so a caller can't accidentally invert the
 * meaning. Only a genuinely MISSING current profile is safe to write
 * automatically — 'valid' (write-once, already established), 'invalid',
 * and 'unsupported_schema_version' (might belong to a newer semidex
 * version this codebase must not clobber) all reject.
 */
export function decideProfileWrite(currentState) {
  return currentState === 'missing' ? 'write' : 'reject';
}

/**
 * Translates Part B's typed extractEmbeddingProfile() result shape
 * ({ state: 'valid'|'missing'|'invalid'|'unsupported_schema_version', ... })
 * into Part C's resolveExistingCollectionProfile()-shaped input
 * ({ resolved: true, profile } | { resolved: false, reason }) that
 * resolveAvailability() (Part F) is written against — used by
 * getCollection() so availability is computed via the SAME resolution
 * contract the query path (resolve.js) already uses, rather than teaching
 * resolveAvailability a second input shape.
 *
 * @param {{ state: string, profile?: Object, errors?: string[], found?: Object }} embeddingProfileResult
 * @returns {{ resolved: true, profile: Object } | { resolved: false, reason: string }}
 */
export function embeddingProfileResultToResolveResult(embeddingProfileResult) {
  if (embeddingProfileResult.state === 'valid') {
    return { resolved: true, profile: embeddingProfileResult.profile };
  }
  const reason = embeddingProfileResult.state === 'missing' ? 'legacy_unmigrated' : embeddingProfileResult.state;
  return { resolved: false, reason };
}

// storeOverrides: optional per-instance overrides for individual store.js
// functions (e.g. { getCollectionInfo, updateCollectionMetadata,
// scrollFilteredPages }), used only by tests to fake the Qdrant-facing
// primitives the new embedding-profile methods below call, without
// requiring live Qdrant. Additive/backward-compatible — the existing
// zero-arg createQdrantStorageAdapter() call is unaffected (storeOverrides
// defaults to {}, so every call falls through to the real store.js
// function). Everything else in this adapter keeps calling `store.*`
// directly, unaffected by this seam.
export function createQdrantStorageAdapter({ storeOverrides = {} } = {}) {
  const s = {
    getCollectionInfo: storeOverrides.getCollectionInfo ?? store.getCollectionInfo,
    updateCollectionMetadata: storeOverrides.updateCollectionMetadata ?? store.updateCollectionMetadata,
    createCollection: storeOverrides.createCollection ?? store.createCollection,
    scrollFilteredPages: storeOverrides.scrollFilteredPages ?? store.scrollFilteredPages,
    listCollections: storeOverrides.listCollections ?? store.listCollections,
  };
  const profileCache = createProfileCache();

  // Shared resolution used by both getEmbeddingProfile() and getCollection()
  // — fetches CollectionInfo exactly once and derives the typed profile
  // result from it, so getCollection() never fetches CollectionInfo twice
  // for the same purpose.
  //
  // Fixed after review: a shape-valid profile was previously trusted as
  // 'valid' on every read without ever being cross-checked against the
  // collection's REAL live vector schema — validateProfileAgainstSchema()
  // was only ever invoked at write time (setEmbeddingProfile). If metadata
  // were corrupted or edited by a third-party client to declare different
  // dimensions/vector names/sparse modifier than the collection actually
  // has, every read (search, Ask, MCP, Admin) would report it as resolved
  // and valid, only to fail later on a real embedding/Qdrant request. The
  // schema check now runs on every canonical read too, reusing the SAME
  // already-fetched `info` (never a second CollectionInfo fetch) — a
  // shape-valid-but-schema-mismatched profile is reported as a new,
  // distinct 'schema_mismatch' state, never silently treated as 'valid'.
  async function resolveEmbeddingProfile(name, { bypassCache = false } = {}) {
    if (!bypassCache) {
      const cached = profileCache.get(name);
      if (cached !== undefined) return cached;
    }
    const info = await s.getCollectionInfo(name);
    const result = resolveEmbeddingProfileFromInfo(info);
    if (!bypassCache) profileCache.set(name, result);
    return result;
  }

  return {
    name() {
      return 'qdrant';
    },

    capabilities() {
      return { ...QDRANT_CAPABILITIES };
    },

    async ping() {
      try {
        await store.listCollections();
        return { ok: true, detail: 'Qdrant reachable' };
      } catch (err) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },

    async listCollections() {
      const names = await s.listCollections();
      const config = loadConfig();
      return Promise.all(names.map(async (name) => {
        const info = await s.getCollectionInfo(name);
        const col = config.collections?.[name];
        // Provider MUST come from the collection's own native metadata, the
        // same canonical source getCollection() and query-time resolution
        // use — never from config.json/env. A collection's real identity is
        // determined by what's actually written to Qdrant, not by whatever
        // the caller currently has configured, which can be stale or belong
        // to an entirely different collection. When no valid native profile
        // exists yet (legacy, not-yet-migrated collection), provider is
        // reported as unknown rather than falling back to config.json/env —
        // an unresolved collection's identity is genuinely unknown until
        // `npm run sync` migrates it or it's reindexed, and reporting a
        // guessed value here would be exactly the silent-wrong-model risk
        // this whole feature exists to close.
        const embeddingProfile = resolveEmbeddingProfileFromInfo(info);
        const provider = embeddingProfile.state === 'valid'
          ? {
              denseProvider: embeddingProfile.profile.embedding.dense.provider,
              denseModel: embeddingProfile.profile.embedding.dense.model,
              sparseProvider: embeddingProfile.profile.embedding.sparse?.provider ?? null,
            }
          : { denseProvider: null, denseModel: null, sparseProvider: null };
        return {
          name,
          pointCount: info.points_count ?? 0,
          vectorSchema: classifyVectorSchema(info.config?.params?.vectors ?? {}),
          provider,
          embeddingProfileState: embeddingProfile.state,
          description: col?.description || null,
        };
      }));
    },

    // checkOllamaLane/checkOnnxModelCached are optional DI, forwarded
    // straight to resolveAvailability() (Part F) — this adapter never
    // imports Ollama-probing code itself (core/ never imports admin/); the
    // caller (Admin API, MCP) supplies its own. When omitted, `availability`
    // is computed using only the ONNX/hashed-tf lanes that don't require
    // injection, and an Ollama lane's availability check throws — callers
    // that need availability for an Ollama-backed collection must supply
    // checkOllamaLane.
    async getCollection(name, { checkOllamaLane, checkOnnxModelCached = defaultCheckOnnxModelCached } = {}) {
      const collections = await s.listCollections();
      if (!collections.includes(name)) return null;

      const config = loadConfig();
      const col = config.collections?.[name];
      const info = await s.getCollectionInfo(name);
      const vectorsCfg = info.config?.params?.vectors ?? {};
      const vectorSchemaKind = classifyVectorSchema(vectorsCfg);
      const denseSize = vectorSchemaKind === 'named'
        ? (vectorsCfg.dense?.size ?? null)
        : (vectorSchemaKind === 'flat' ? vectorsCfg.size ?? null : null);
      const hasSparse = Boolean(info.config?.params?.sparse_vectors?.sparse);

      const samplePoints = await store.scroll(name, null, 1, true);
      const samplePayload = samplePoints[0]?.payload ?? null;
      const skeletonRoot = await store.getCollectionSkeletonNode(name);
      // info.points_count is Qdrant's raw total and includes skeleton_nav
      // points on any collection with skeleton navigation on — using it to
      // label "N chunks" in the admin UI would overstate real content by
      // however many nav points exist. chunkCount is the exact server-side
      // count of real content points only.
      const chunkCount = await store.countContentPoints(name);

      const warnings = [];
      if (vectorSchemaKind === 'flat') warnings.push('legacy flat vector schema — hybrid search unavailable');
      if (vectorSchemaKind === 'empty') warnings.push('no vector schema found on this collection');

      // Reuses the SAME `info` object already fetched above — never a
      // second CollectionInfo fetch for the embedding-profile fields.
      // resolveEmbeddingProfileFromInfo() (not the bare extractEmbeddingProfile)
      // so a shape-valid-but-schema-mismatched profile is never reported or
      // cached as 'valid' here either.
      const embeddingProfile = resolveEmbeddingProfileFromInfo(info);
      const indexingState = extractIndexingState(info);
      profileCache.set(name, embeddingProfile);

      const availabilityResolveResult = embeddingProfileResultToResolveResult(embeddingProfile);
      // resolveLaneAvailability() throws when a profile has an ollama lane
      // and no checkOllamaLane was injected (core/ never imports Ollama-
      // probing code itself, and this method must stay a safe plain
      // existence/detail check for the many existing callers — chunks.js,
      // assembly.js, documents.js, node.js, skeleton.js, search.js — that
      // call getCollection(name) with no second argument and have never
      // needed to supply Ollama DI just to read pointCount/vectorSchema).
      // Caught here rather than propagated: those callers must keep
      // working unchanged; availability degrades to an honest
      // "unknown_dependencies" status instead of breaking the whole call.
      let availability;
      try {
        availability = await resolveAvailability(availabilityResolveResult, { checkOllamaLane, checkOnnxModelCached });
      } catch {
        availability = {
          status: COLLECTION_STATUS.UNKNOWN_DEPENDENCIES,
          dense: null,
          sparse: null,
          aggregate: { hybridSearchAvailable: false, searchAttemptable: false, browsingAvailable: true },
        };
      }

      // provider prefers the resolved native profile when valid (Part C
      // precedence). Fixed after review: the fallback to the raw
      // sample-point payload used to apply to EVERY non-'valid' state —
      // including 'invalid' and 'schema_mismatch', where a profile DOES
      // exist but is corrupted or disagrees with the live vector schema.
      // Falling back to payload there would show a plausible-looking but
      // no-longer-canonical model, silently contradicting
      // listCollections() (which correctly reports null for the exact same
      // states) and misleading anyone reading this collection's detail.
      // The payload-derived fallback is now legitimate ONLY for 'missing'
      // (a genuine pre-migration legacy collection, where a payload-derived
      // guess is the honest best-effort signal npm run sync itself uses).
      // For every other non-valid state, `provider` reports null/null/null,
      // matching listCollections() exactly — the raw payload hint, when one
      // exists, is still surfaced separately as `legacyDetectedProvider` so
      // it's never silently lost, but it can never be mistaken for the
      // canonical value.
      const legacyDetectedProvider = samplePayload
        ? {
            denseProvider: samplePayload.dense_provider ?? null,
            denseModel: samplePayload.dense_model ?? null,
            sparseProvider: samplePayload.sparse_provider ?? null,
          }
        : null;
      const provider = embeddingProfile.state === 'valid'
        ? {
            denseProvider: embeddingProfile.profile.embedding.dense.provider,
            denseModel: embeddingProfile.profile.embedding.dense.model,
            sparseProvider: embeddingProfile.profile.embedding.sparse?.provider ?? null,
          }
        : embeddingProfile.state === 'missing'
          ? (legacyDetectedProvider ?? { denseProvider: null, denseModel: null, sparseProvider: null })
          : { denseProvider: null, denseModel: null, sparseProvider: null };

      return {
        name,
        pointCount: info.points_count ?? 0,
        chunkCount,
        vectorSchema: {
          dense: { size: denseSize, distance: vectorsCfg.dense?.distance ?? vectorsCfg.distance ?? null },
          sparse: hasSparse,
        },
        provider,
        // Only populated for a genuine legacy ('missing') collection, or
        // when the profile is invalid/mismatched and there's a raw payload
        // hint available — always distinct from `provider`, never presented
        // as canonical. null when there's no sample payload to derive it
        // from (empty collection) or the profile is already valid (nothing
        // to fall back to).
        legacyDetectedProvider: embeddingProfile.state === 'valid' ? null : legacyDetectedProvider,
        versions: {
          // Same precedence fix as `provider` above — only 'missing' falls
          // back to the raw payload value; 'invalid'/'schema_mismatch'
          // report null rather than a value that may not actually be
          // trustworthy given the profile itself is broken.
          embeddingSchema: embeddingProfile.state === 'valid'
            ? embeddingProfile.profile.embeddingSchemaVersion
            : embeddingProfile.state === 'missing'
              ? (samplePayload?.embedding_schema_version ?? null)
              : null,
          chunkingSchema: samplePayload?.chunking_schema_version ?? null,
          indexingSchema: samplePayload?.indexing_schema_version ?? null,
          tokenCountMode: samplePayload?.token_count_mode ?? null,
        },
        embeddingProfile,
        indexingState,
        availability,
        description: col?.description || null,
        // The skeleton root's own generated summary is a better
        // library-overview description than the config-level `description`
        // above when both exist, since it's generated from the actual
        // indexed content rather than typed once at index time and often
        // left stale/unset. But the root's `summary` field is not always a
        // real overview — skeleton-summary.js stamps summary_kind, and only
        // 'collection_overview' means an actual generated blurb (LLM rollup
        // or a single-child propagation); 'inventory' means a plain fallback
        // like "N files" with no real narrative content. Only surface the
        // former as overviewSummary — an inventory-kind summary is worse
        // than the admin UI's own "no overview yet" empty state, and must
        // not shadow a real config description. See collection-view.js for
        // the fallback chain (overviewSummary -> description -> empty state).
        overviewSummary: skeletonRoot?.summary_kind === 'collection_overview'
          ? skeletonRoot.summary ?? null
          : null,
        semidexManaged: isSemidexPayload(samplePayload),
        hasSkeleton: Boolean(skeletonRoot),
        warnings,
      };
    },

    // profile is REQUIRED — every new Semidex collection must get a
    // canonical embedding profile atomically at creation time; there is no
    // metadata-less creation path (fixed after review: an earlier draft
    // allowed a bare { vectorSize } call that created a collection with no
    // profile at all, contradicting the whole point of this feature — every
    // real caller, indexer's run.js and benchmarks' resolveBenchProfile(),
    // already always passes profile). This is the ONE atomic creation path:
    // profile and vector space are established together, never via a
    // follow-up setEmbeddingProfile() call. `vectorSize` is never trusted as
    // an independently-drifting value — the real vector size is always
    // derived from profile.embedding.dense.dimensions, and if the caller
    // also passed an explicit vectorSize that disagrees, this throws before
    // any network call (metadata/schema drift guard).
    async createCollection(name, { vectorSize, profile } = {}) {
      if (!profile) {
        throw new Error(`createCollection: a profile is required to create collection "${name}" — every new Semidex collection must carry a canonical embedding profile from creation; there is no metadata-less creation path.`);
      }
      const validation = validateEmbeddingProfile(profile);
      if (!validation.valid) {
        throw new Error(`createCollection: invalid embedding profile for "${name}": ${validation.errors.join('; ')}`);
      }
      const profileDimensions = profile.embedding.dense.dimensions;
      if (vectorSize !== undefined && vectorSize !== profileDimensions) {
        throw new Error(`createCollection: vectorSize (${vectorSize}) disagrees with profile.embedding.dense.dimensions (${profileDimensions}) for "${name}"`);
      }
      // The FULL Qdrant vector schema is built from the profile itself
      // (buildQdrantVectorSchemaFromProfile) — distance, sparse presence,
      // and modifier all come from what the profile actually declares, not
      // a hardcoded Cosine+always-sparse default. Throws before any
      // network call for anything Qdrant/this codebase can't represent.
      const vectorSchema = buildQdrantVectorSchemaFromProfile(profile);
      await s.createCollection(name, profileDimensions, { [METADATA_KEY_EMBEDDING_PROFILE]: profile }, vectorSchema);
      profileCache.invalidate(name);
    },

    async deleteCollection(name) {
      await store.deleteCollection(name);
      profileCache.invalidate(name);
    },

    async ensureCollectionSchema(name) {
      return ensureCollectionSchema(name);
    },

    // Read-only, cached (Part B's dedicated resolved-profile cache — never
    // a cache of the whole getCollection() response). Returns
    // resolveEmbeddingProfileFromInfo()'s typed result — extractEmbeddingProfile()
    // PLUS a live vector-schema cross-check, so a shape-valid profile that
    // disagrees with the collection's real vectors is never reported as
    // 'valid':
    //   { state: 'valid', profile } | { state: 'missing' } |
    //   { state: 'invalid', errors } | { state: 'unsupported_schema_version', found } |
    //   { state: 'schema_mismatch', profile, mismatches }
    async getEmbeddingProfile(name) {
      return resolveEmbeddingProfile(name);
    },

    // Write-once: only succeeds when the collection's current embedding
    // profile state is 'missing'. Rejects 'valid' (already established —
    // profiles identify a vector space, they are not a generic setting),
    // 'invalid', and 'unsupported_schema_version' (never silently
    // overwrite a profile this codebase doesn't fully understand — it may
    // belong to a newer semidex version). Also verifies the incoming
    // profile against the collection's LIVE vector schema before writing —
    // a structurally valid profile describing a different vector space
    // (wrong dimensions/vectorName/distance/sparse modifier) must never be
    // written as if it were correct. No override parameter exists — a
    // future explicit reindex/migration workflow gets its own clearly-named
    // method when it's built, not a flag on this one.
    async setEmbeddingProfile(name, profile) {
      const validation = validateEmbeddingProfile(profile);
      if (!validation.valid) {
        throw new Error(`setEmbeddingProfile: invalid profile for "${name}": ${validation.errors.join('; ')}`);
      }

      const info = await s.getCollectionInfo(name);
      const current = resolveEmbeddingProfileFromInfo(info);
      if (decideProfileWrite(current.state) !== 'write') {
        throw new Error(`setEmbeddingProfile: refusing to overwrite existing embedding profile for "${name}" (current state: ${current.state})`);
      }

      const schemaCheck = validateProfileAgainstSchema(profile, info);
      if (!schemaCheck.matches) {
        const details = schemaCheck.mismatches.map(m => `${m.field}: expected ${JSON.stringify(m.expected)}, found ${JSON.stringify(m.found)}`).join('; ');
        throw new Error(`setEmbeddingProfile: profile does not match live vector schema for "${name}": ${details}`);
      }

      await s.updateCollectionMetadata(name, { [METADATA_KEY_EMBEDDING_PROFILE]: profile });
      profileCache.invalidate(name);
    },

    // Mutable counterpart to setEmbeddingProfile — no write-once guard,
    // updated freely by any indexing job. Writes under its own dedicated
    // top-level metadata key, never touching the embedding profile key
    // (Qdrant's updateCollection merges across distinct top-level keys).
    async setIndexingState(name, state) {
      const validation = validateIndexingState(state);
      if (!validation.valid) {
        throw new Error(`setIndexingState: invalid state for "${name}": ${validation.errors.join('; ')}`);
      }
      await s.updateCollectionMetadata(name, { [METADATA_KEY_INDEXING_STATE]: state });
      profileCache.invalidate(name);
    },

    // Recovers a collection's embedding profile from its own legacy point
    // payloads when native metadata is absent, and writes it via
    // setEmbeddingProfile() once inferred. This is an EXPLICIT, sanctioned
    // write-triggering operation — callers are sync.js and the indexer's
    // own preflight (both user-initiated actions), NEVER a read path
    // (search/Ask/MCP resolution never calls this — see Part C's
    // resolveExistingCollectionProfile, which is strictly read-only).
    //
    // Idempotent: if the collection already has a valid profile, this is a
    // no-op returning { status: 'already_migrated' } BEFORE any scroll —
    // the single most important cost guard, so a healthy, already-migrated
    // collection never pays the full-scan cost on a repeated `npm run sync`.
    // Scans EVERY non-nav content point (not a bounded sample) with a
    // narrow payload projection (IDENTITY_FIELDS only — never text/
    // raw_content/vectors) and stops at the first page containing a
    // disagreement, via the real early-exit support in
    // store.scrollFilteredPages(). Never rewrites point payloads.
    async migrateEmbeddingProfile(name) {
      const current = await resolveEmbeddingProfile(name, { bypassCache: true });
      if (current.state === 'valid') return { status: 'already_migrated' };

      const info = await s.getCollectionInfo(name);
      const vectorSchemaInfo = normalizeVectorSchema(info);

      let accumulator = null;
      await s.scrollFilteredPages(
        name,
        withNavExcluded(null),
        IDENTITY_FIELDS,
        {
          // store.js's scrollFilteredPages() hands onPage real Qdrant point
          // objects ({ id, payload, ... }), not bare payloads — confirmed
          // against a live cluster (Part H verification): folding the raw
          // point array directly always produced null identity fields since
          // foldPayloadConsistency()/extractIdentity() read straight off
          // the object passed in. Must unwrap .payload here first.
          onPage: (page) => {
            const payloads = (page ?? []).map(point => point?.payload ?? point);
            accumulator = foldPayloadConsistency(accumulator, payloads);
            return accumulator.consistent !== false; // stop as soon as a page produces a disagreement
          },
        },
      );

      const inference = inferLegacyProfile(accumulator, vectorSchemaInfo);
      if (inference.status !== 'inferred') return inference;

      await this.setEmbeddingProfile(name, inference.profile);
      return inference;
    },

    async listSourceDocuments(name, { prefix = null, limit = 100 } = {}) {
      const points = await store.scrollAllPoints(name, ['source_file', 'chunk_index', 'section', 'point_kind', 'tags']);
      const normalizedPrefix = prefix ? prefix.replace(/\\/g, '/') : null;

      const fileMap = new Map();
      for (const p of points) {
        if (isNavPoint(p)) continue;
        const sf = (p.payload?.source_file ?? '').replace(/\\/g, '/');
        if (!sf) continue;
        if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

        if (!fileMap.has(sf)) {
          fileMap.set(sf, { source_file: sf, chunkCount: 0, firstSection: '', minChunkIndex: Infinity, tags: new Set() });
        }
        const entry = fileMap.get(sf);
        entry.chunkCount++;
        const ci = p.payload?.chunk_index ?? Infinity;
        if (ci < entry.minChunkIndex) {
          entry.minChunkIndex = ci;
          entry.firstSection = p.payload?.section || '';
        }
        for (const t of p.payload?.tags ?? []) entry.tags.add(t);
      }

      const entries = [...fileMap.values()]
        .map(e => ({ ...e, tags: [...e.tags] }))
        .sort((a, b) => a.source_file.localeCompare(b.source_file))
        .slice(0, limit);

      return entries.map(toSourceDocument);
    },

    async getChunk(name, sourceFile, chunkIndex, { window = 0 } = {}) {
      const points = await store.fetchWindowChunks(name, sourceFile, chunkIndex, window);
      return points.map(toChunk);
    },

    // Every retrieval-content chunk for one file, in order — the primitive
    // the admin UI's file view needs to open a file directly and see its
    // real content, rather than approximating "the whole file" with a
    // window centered on chunk 0 (getChunk() above, which is a genuinely
    // different retrieval-context concept, not a file-listing one).
    async getFileChunks(name, sourceFile) {
      const points = await store.getFileChunks(name, sourceFile);
      return points.map(toChunk);
    },

    // Every retrieval-content chunk anchored under one skeleton section
    // node, in chunk_index order — the section-scope primitive for the
    // assembly service. Section identity is the skeleton nav node itself
    // (resolved by nodeId or nodePath), never a heading-text match; chunks
    // are matched by exact parent_id === section node_id in the store.
    // Returns null when the nav node doesn't exist (unknown section, or a
    // collection with no skeleton) — distinct from [] (real section with
    // zero content chunks), so the API can 404 the former honestly.
    async getSectionChunks(name, { nodeId, nodePath } = {}) {
      const navNode = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      if (!navNode?.node_id) return null;
      const points = await store.getSectionChunks(name, navNode.node_id);
      return points.map(toChunk);
    },

    async searchHybrid(name, { dense, sparse, limit = 5, filter, settingsService } = {}) {
      const qdrantFilter = translateSearchFilter(filter);
      const points = await store.hybridSearch(name, dense, sparse, limit, qdrantFilter, { settingsService });
      return points.map(toChunk);
    },

    async getSkeletonRoot(name) {
      const node = await store.getCollectionSkeletonNode(name);
      return toSkeletonNode(node);
    },

    async getSkeletonNode(name, { nodeId, nodePath } = {}) {
      const node = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      return toSkeletonNode(node);
    },

    async getSkeletonChildren(name, { nodeId, nodePath, limit = 50 } = {}) {
      const parent = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      if (!parent) return [];
      const childPaths = Array.isArray(parent.children) ? parent.children : [];
      const children = await store.getSkeletonChildren(name, childPaths, limit);
      return children.map(toSkeletonNode);
    },

    // Resolves ANY non-nav content node by identity — table/code_block/
    // checklist/paragraph/list/blockquote/image, whatever the indexer
    // stamped a node_id/node_path onto. Not "structural" — a prose node_id
    // resolves here exactly like a table's does (see getContentNodeById's
    // own contract: it filters by point_kind, never node_type).
    async getContentNode(name, { nodeId, nodePath } = {}) {
      const node = nodeId
        ? await store.getContentNodeById(name, nodeId)
        : await store.getContentNodeByPath(name, nodePath);
      return toContentNodeChunk(node);
    },

    // Resolves a skeleton nav node (e.g. a section) to the earliest content
    // chunk anchored under it, so "open this section" can jump to a real
    // chunkIndex instead of guessing chunk 0 for the whole file. A section
    // nav node and its content chunks are separate Qdrant points linked only
    // by parent_id === section's node_id (design: skeleton-index.js) — this
    // is the one place that link is followed.
    async getSectionAnchor(name, { nodeId, nodePath } = {}) {
      const navNode = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      if (!navNode?.node_id) return null;
      const chunk = await store.getFirstContentChunkByParent(name, navNode.node_id);
      return chunk ? toChunk({ payload: chunk }) : null;
    },
  };
}
