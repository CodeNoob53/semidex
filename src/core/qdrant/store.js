// semidex Qdrant operations: collections, indexes, upsert, search, scroll,
// delete, window fetch, skeleton nav and structural node lookups.
//
// All operations go through the lazy client in client.js. MCP tools, indexer,
// sync, backfill, and benchmarks must call this adapter — never the SDK
// directly — so that future semidex lite decisions stay centralized here.
//
// Function names, signatures, and return shapes are preserved from the
// pre-SDK implementation.
import { getQdrantClient, qdrantCall, errText } from './client.js';
import { NAV_PAYLOAD_FIELDS, CONTENT_NODE_FIELDS } from './payload.js';
import { collectionVectorSchema, SPARSE_VECTOR_SCHEMA, REQUIRED_PAYLOAD_INDEXES } from './schema.js';
import { envInt } from '../../shared/core/env.js';
import { withNavExcluded, isNavPoint } from './nav-filter.js';

// ── Collections ───────────────────────────────────────────────────────────────

export async function listCollections() {
  const client = getQdrantClient();
  const result = await qdrantCall('Qdrant listCollections failed', () => client.getCollections());
  return result.collections.map(c => c.name);
}

export async function getCollectionInfo(name) {
  const client = getQdrantClient();
  return qdrantCall('Qdrant getCollectionInfo failed', () => client.getCollection(name));
}

// vectorSchema, when given, is used AS-IS (merged with metadata) instead of
// the default-shape collectionVectorSchema(size, metadata) — this is how
// qdrant-adapter.js's createCollection() passes the FULL schema derived
// from a resolved embedding profile (buildQdrantVectorSchemaFromProfile()),
// so the collection's real distance/sparse-presence/modifier match what
// the profile actually declares, not a hardcoded Cosine+always-sparse
// default. `size` remains the profile-less fallback path for any caller
// that doesn't have (or need) a full profile.
export async function createCollection(name, size = 1024, metadata, vectorSchema) {
  const client = getQdrantClient({ write: true });
  // The high-level client.createCollection(name, {...}) wrapper
  // (qdrant-client.js's destructured parameter list) silently drops a
  // `metadata` field passed in the request body — confirmed against a live
  // v1.17.1 cluster: create-with-metadata via that wrapper returns 200 but
  // the collection comes back with no metadata key at all. A two-phase
  // create-then-update workaround was tried first and rejected: it leaves a
  // window where the collection exists with no profile if the process dies
  // between the two calls, which a later run would then treat as an
  // unmigrated legacy collection. client.api() (no argument — it takes
  // none; api-client.js's api() always returns the same flat generated
  // fetch-client object regardless of any argument passed) is the SDK's own
  // generated low-level fetch wrapper — it passes the request body straight
  // through unfiltered (same as updateCollection()), so metadata reaches
  // Qdrant in the SAME atomic PUT that creates the collection. Verified
  // directly against the live cluster: a single call with `metadata` in the
  // body round-trips correctly.
  const resolvedSchema = vectorSchema ?? collectionVectorSchema(size);
  // The base create-with-metadata call above is ONE atomic Qdrant API
  // call (see the comment above it) — if IT throws, this function made no
  // lasting change, so there is nothing to clean up; the error propagates
  // unchanged. If it SUCCEEDS but a subsequent createPayloadIndex() call
  // in the loop below throws, the collection now genuinely exists
  // (correct metadata already written) but is missing a required payload
  // index — a real partial-creation state. This function is the ONLY
  // place that can safely attempt cleanup for that specific window: it is
  // the one caller that knows, by direct causality of its own preceding
  // await succeeding, that IT just created this collection — no
  // check-then-act race against a separate listCollections() read (that
  // approach was considered and rejected: a concurrent process could
  // create a same-named collection in the gap between the check and this
  // call, and a cleanup keyed off a stale check could then delete a
  // collection this call never created).
  await qdrantCall('Create collection failed', () =>
    client.api().createCollection({
      collection_name: name,
      ...resolvedSchema,
      ...(metadata !== undefined ? { metadata } : {}),
    }));
  try {
    for (const [field, payloadFieldSchema] of Object.entries(REQUIRED_PAYLOAD_INDEXES)) {
      await createPayloadIndex(name, field, payloadFieldSchema);
    }
  } catch (err) {
    try {
      await deleteCollection(name);
    } catch (cleanupErr) {
      // Never mask the original error with a cleanup failure — log for a
      // human to notice and manually remove the orphaned collection, but
      // the ORIGINAL error (thrown below, outside this catch) is always
      // what the caller sees.
      console.warn(`[qdrant] cleanup failed for partially-created collection "${name}" after a payload-index failure: ${errText(cleanupErr)} — it may need manual removal.`);
    }
    throw err;
  }
}

export async function deleteCollection(name) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Delete collection failed', () => client.deleteCollection(name));
}

// Updates a collection's native metadata (Qdrant v1.16+). Relies on Qdrant's
// documented shallow top-level merge — this call never reads existing
// metadata first, and never removes sibling top-level keys another tool may
// have set. Callers pass an object keyed by the exact top-level metadata
// key(s) they own (see src/core/embedding-profile/schema.js's
// METADATA_KEY_EMBEDDING_PROFILE / METADATA_KEY_INDEXING_STATE), never the
// whole metadata document.
export async function updateCollectionMetadata(name, metadata) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('updateCollectionMetadata failed', () =>
    client.updateCollection(name, { metadata }));
}

export async function createPayloadIndex(collection, field, type = 'keyword') {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Create index failed', () => client.createPayloadIndex(collection, {
    field_name: field,
    field_schema: type,
  }));
}

export async function addSparseVectorSupport(name) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('addSparseVectorSupport failed', () => client.updateCollection(name, {
    sparse_vectors: SPARSE_VECTOR_SCHEMA,
  }));
}

export async function hasSparseVectors(collection) {
  try {
    const client = getQdrantClient();
    const result = await client.scroll(collection, { limit: 1, with_vector: ['sparse'] });
    const point = result.points?.[0];
    if (!point) return true;
    const sv = point.vector?.sparse ?? point.vectors?.sparse;
    return Boolean(sv && Array.isArray(sv.indices) && sv.indices.length > 0);
  } catch {
    // Pre-migration behavior: any failure (missing collection, legacy schema,
    // unreachable Qdrant) reports "no sparse support" rather than throwing.
    return false;
  }
}

// ── Points: write ─────────────────────────────────────────────────────────────
// wait: false preserves the old REST default (the hand-written wrapper never
// sent `wait`, and Qdrant defaults to false). The SDK default would be true.

export async function upsertPoints(collection, points) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant upsert failed', () => client.upsert(collection, { points, wait: false }));
}

// Upserts points carrying NO real vector data — `vector: {}`, an empty
// named-vector map. Confirmed live against a real Qdrant Cloud cluster
// (v1.17.1, eu-central-1): `vector: {}` is accepted by upsert even when the
// collection declares real named vectors (dense/sparse), the point is
// returned by scroll/filter with `vector: {}`, and it is correctly excluded
// from vector search on every named vector — never dense-only, sparse-only,
// a zero/dummy vector, or a reused marker embedding, all of which would
// still cost a real (if cheap) embed call or falsely appear reachable via
// one search lane. This is what lets canonical entity_raw points
// (entity-split.js) skip Cloud Inference entirely — they are never
// searched, so there is nothing for a vector to represent.
//
// wait: true (unlike upsertPoints' own wait: false) — deliberately blocks
// until Qdrant has actually applied this write, not merely accepted the
// request. entity_raw points are always few (one per split entity, never
// per-chunk volume), so the extra latency here is negligible, and it is
// what makes stageD's own commit-order guarantee real rather than nominal:
// a caller that upserts fragments (their entity_id pointing at this exact
// canonical point) immediately afterward can only rely on the canonical
// point already existing if THIS call has truly finished on the server,
// not merely been queued — wait: false would let the two writes complete
// in either order despite being issued in the "right" sequence.
//
// Kept as a distinct function from upsertPoints() (rather than a parameter)
// so a caller's intent is visible at the call site — accidentally passing
// vector-bearing points here would silently upsert them with their real
// vectors dropped, which must never happen by construction.
export async function upsertPointsWithoutVectors(collection, points) {
  const withEmptyVectors = points.map(p => ({ ...p, vector: {} }));
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant upsert (vectorless) failed', () => client.upsert(collection, { points: withEmptyVectors, wait: true }));
}

export async function updatePayload(collection, id, payload) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant updatePayload failed', () => client.setPayload(collection, {
    payload,
    points: [id],
    wait: false,
  }));
}

// Removes specific payload KEYS from a point entirely (Qdrant's
// deletePayload, distinct from setPayload/updatePayload above, which only
// ever ADDS/overwrites keys and can never remove one). Needed wherever a
// field's ABSENCE is meaningful and must be reproduced exactly — e.g. the
// entity_refs backfill script clearing a now-stale reference must leave the
// point byte-equivalent to one that was freshly indexed and never had the
// key at all, not one carrying an explicit empty array.
export async function deletePayloadKeys(collection, id, keys) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant deletePayloadKeys failed', () => client.deletePayload(collection, {
    keys,
    points: [id],
    wait: false,
  }));
}

export async function deleteBySourceFile(collection, sourceFile) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant delete failed', () => client.delete(collection, {
    filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
  }));
}

export async function deleteByFilter(collection, filter) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant deleteByFilter failed', () => client.delete(collection, { filter }));
}

// Delete points for sourceFile whose chunk_index >= fromChunkIndex.
// Used after a file shrinks: deterministic IDs overwrite existing chunks 0..N-1,
// but old points for chunk N..old_N-1 become orphans that PRUNE_STALE cannot
// detect (the source_file still exists on disk).
export async function deleteTrailingChunks(collection, sourceFile, fromChunkIndex) {
  const client = getQdrantClient({ write: true });
  await qdrantCall('Qdrant deleteTrailingChunks failed', () => client.delete(collection, {
    filter: {
      must: [
        { key: 'source_file', match: { value: sourceFile } },
        { key: 'chunk_index', range: { gte: fromChunkIndex } },
      ],
    },
  }));
}

// ── Points: search ────────────────────────────────────────────────────────────

export async function search(collection, vector, limit = 5, filter = null) {
  const client = getQdrantClient();
  // Accepts either a raw number[] or a named vector { name, vector }.
  return qdrantCall(`Qdrant search failed (${collection})`, () => client.search(collection, {
    vector,
    limit,
    with_payload: true,
    ...(filter && { filter }),
  }));
}

// Shared HYBRID_PREFETCH_LIMIT/RRF_K resolution — extracted so
// hybridSearch() (real vectors) and hybridSearchCloud() (inference
// descriptors) can never drift apart on prefetch/RRF-k behavior.
// settingsService is optional DI (next_search settings — see
// core/settings/definitions.js — resolved fresh on every call). When
// omitted, falls back to the original direct envInt() reads unchanged —
// every existing caller that doesn't pass a settingsService keeps its
// exact current behavior.
function resolvePrefetchLimit(limit, settingsService) {
  const prefetchMult = settingsService
    ? settingsService.getActiveValue('HYBRID_PREFETCH_LIMIT')
    : envInt('HYBRID_PREFETCH_LIMIT', 2, 1, 100, '[qdrant] ');
  return Math.max(limit * prefetchMult, limit + 1);
}

function resolveRrfK(settingsService) {
  return settingsService
    ? settingsService.getActiveValue('RRF_K')
    : envInt('RRF_K', 60, 1, 10000, '[qdrant] ');
}

export async function hybridSearch(collection, denseVector, sparseVector, limit = 5, filter = null, { settingsService } = {}) {
  const client = getQdrantClient();
  const prefetchLimit = resolvePrefetchLimit(limit, settingsService);
  const rrfK = resolveRrfK(settingsService);
  const prefetch = [
    { query: sparseVector, using: 'sparse', limit: prefetchLimit, ...(filter && { filter }) },
    { query: denseVector,  using: 'dense',  limit: prefetchLimit, ...(filter && { filter }) },
  ];
  try {
    // Wrapped in qdrantCall (code review — bring this call under the same
    // telemetry hook as its cloud sibling hybridSearchCloud() below; an
    // earlier version called client.query() raw here, which meant a
    // benchmark harness observing only qdrantCall's telemetry silently
    // under-counted every LOCAL/CLIENT-execution query while cloud
    // queries were counted correctly). qdrantCall re-wraps a thrown error
    // as `Error("${label}: ${errText(err)}")`, so the dense-only-fallback
    // detection below matches against that re-wrapped message text.
    const result = await qdrantCall('Qdrant hybridSearch failed', () => client.query(collection, {
      prefetch,
      query: { rrf: { k: rrfK } },
      limit,
      with_payload: true,
    }));
    return result.points ?? [];
  } catch (err) {
    const text = errText(err);
    // Qdrant returns "Wrong sparse vector name: sparse" when the collection has
    // no sparse index yet. Fall back to dense-only in that case; all other
    // errors are real failures.
    if (text.includes('Wrong sparse vector name')) {
      process.stderr.write(`[qdrant] hybridSearch fallback to dense-only for "${collection}": ${text.slice(0, 120)}\n`);
      return search(collection, { name: 'dense', vector: denseVector }, limit, filter);
    }
    throw new Error(`Qdrant hybridSearch failed (${collection}): ${text}`);
  }
}

// Cloud-inference counterpart of hybridSearch() — denseQuery/sparseQuery
// are ALREADY-BUILT {text, model} inference descriptors (see
// cloud/embedding/qdrant-cloud-catalog.js's buildCloudQueryInputs())
// — this function never constructs or calls an embedding function itself,
// only forwards data the caller already built, exactly like hybridSearch()
// only forwards real vectors it's handed. RRF fusion stays server-side —
// never computed in JS here.
export async function hybridSearchCloud(collection, denseQuery, sparseQuery, limit = 5, filter = null, { settingsService } = {}) {
  const client = getQdrantClient();
  const prefetchLimit = resolvePrefetchLimit(limit, settingsService);
  const rrfK = resolveRrfK(settingsService);
  const prefetch = [
    { query: denseQuery, using: 'dense', limit: prefetchLimit, ...(filter && { filter }) },
    ...(sparseQuery ? [{ query: sparseQuery, using: 'sparse', limit: prefetchLimit, ...(filter && { filter }) }] : []),
  ];
  const result = await qdrantCall(`Qdrant hybridSearchCloud failed (${collection})`, () => client.query(collection, {
    prefetch,
    query: { rrf: { k: rrfK } },
    limit,
    with_payload: true,
  }));
  return result.points ?? [];
}

// ── Qdrant Cloud Inference reachability + inference probe ───────────────────
// Kept here, alongside hybridSearchCloud(), so every Qdrant-specific
// operation (including admin-triggered probes) goes through this one module
// — src/admin/ never imports the raw SDK/client directly, only the
// provider-neutral StorageAdapter.probeInference()/ping() methods that call
// these (qdrant-adapter.js is the only caller of either function below).

/**
 * Cheap reachability + auth check. Never attempts inference — used as the
 * ping()-equivalent for the qdrant-cloud lane; the routine, low-cost check
 * every collection-browsing/listing call can afford.
 * @returns {Promise<{ status: 'ok'|'unreachable'|'auth_failed', message?: string }>}
 */
export async function checkQdrantReachable() {
  let client;
  try {
    client = getQdrantClient();
  } catch (err) {
    return { status: 'unreachable', message: err.message };
  }
  try {
    await client.getCollections();
    return { status: 'ok' };
  } catch (err) {
    const text = errText(err);
    const status = /401|403|unauthoriz|forbidden|invalid api key/i.test(text) ? 'auth_failed' : 'unreachable';
    return { status, message: text };
  }
}

const PROBE_COLLECTION_PREFIX = 'semidex-cloud-inference-probe-';

function randomProbeCollectionName() {
  return `${PROBE_COLLECTION_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Matched against a real Qdrant error message to distinguish "inference
// itself is disabled/unavailable for this model" from a generic
// network/auth failure (already distinguishable by checkQdrantReachable,
// and re-thrown as-is here rather than re-labeled).
const INFERENCE_ERROR_PATTERN = /inference|model.*(not found|unavailable|unknown)/i;

/**
 * Real, minimal inference round-trip against a disposable collection,
 * created and deleted entirely within this call. Never touches any
 * existing user collection. Only ever invoked on an explicit user action
 * (the Admin UI's "Test Cloud Inference" button, via
 * adapter.probeInference()) — never by routine availability resolution.
 *
 * vectorSchema/denseQuery/sparseQuery are ALREADY-BUILT by the adapter
 * (buildQdrantVectorSchemaFromProfile() for the schema, the same
 * {text,model} descriptor shape embedForIndexCloud()/buildCloudQueryInputs()
 * use elsewhere) — this function only executes storage requests, never
 * decides what schema/model a profile implies.
 *
 * @param {{ vectorSchema: Object, denseQuery: {text: string, model: string}, sparseQuery?: {text: string, model: string}|null }} params
 * @returns {Promise<
 *   | { status: 'inference_available' }
 *   | { status: 'inference_disabled_or_model_unavailable', message: string }
 * >}
 * @throws for any other (network/auth) failure — already distinguishable
 *   from checkQdrantReachable(), so this is not re-labeled.
 */
export async function probeInference({ vectorSchema, denseQuery, sparseQuery = null }) {
  const client = getQdrantClient({ write: true });
  const name = randomProbeCollectionName();

  try {
    await client.api().createCollection({ collection_name: name, ...vectorSchema });

    try {
      await client.upsert(name, {
        wait: true,
        points: [{
          id: 1,
          vector: {
            dense: denseQuery,
            ...(sparseQuery && { sparse: sparseQuery }),
          },
        }],
      });
      return { status: 'inference_available' };
    } catch (err) {
      const text = errText(err);
      if (INFERENCE_ERROR_PATTERN.test(text)) {
        return { status: 'inference_disabled_or_model_unavailable', message: text };
      }
      throw new Error(text);
    }
  } finally {
    // Guaranteed cleanup, gated to only ever delete a name this call itself
    // generated with the declared prefix — mirrors the live-acceptance
    // script's own cleanup discipline.
    if (name.startsWith(PROBE_COLLECTION_PREFIX)) {
      try { await client.deleteCollection(name); } catch { /* best-effort cleanup */ }
    }
  }
}

export async function mmrSearch(collection, denseVector, limit = 5, filter = null, opts = {}) {
  const client = getQdrantClient();
  const diversity = opts.diversity ?? 0.5;
  const candidatesLimit = Math.max(opts.candidatesLimit ?? 100, limit);
  const result = await qdrantCall(`Qdrant mmrSearch failed (${collection})`, () => client.query(collection, {
    query: {
      nearest: denseVector,
      mmr: { diversity, candidates_limit: candidatesLimit },
    },
    using: 'dense',
    limit,
    with_payload: true,
    ...(filter && { filter }),
  }));
  return result.points ?? [];
}

// ── Points: read ──────────────────────────────────────────────────────────────

export async function scroll(collection, filter, limit = 100, withPayload = true) {
  const client = getQdrantClient();
  const result = await qdrantCall('Qdrant scroll failed', () => client.scroll(collection, {
    filter,
    limit,
    with_payload: withPayload,
  }));
  return result.points ?? [];
}

// Server-side exact count of real content chunks (excludes skeleton_nav
// points) — cheap, no payload/vector transfer. Qdrant's raw
// getCollectionInfo().points_count includes skeleton_nav points on
// collections with skeleton navigation, so it overstates "how many chunks
// does this collection have" whenever skeleton nav is on; this gives the
// admin UI header an honest number to label "chunks".
export async function countContentPoints(collection) {
  const client = getQdrantClient();
  const result = await qdrantCall('Qdrant count failed', () => client.count(collection, {
    filter: withNavExcluded(null),
    exact: true,
  }));
  return result.count ?? 0;
}

export async function getStoredMeta(collection, sourceFile) {
  const points = await scroll(
    collection,
    { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    1,
    ['file_hash', 'dense_provider', 'dense_model', 'sparse_provider', 'embedding_schema_version', 'vector_size', 'chunking_schema_version', 'token_count_mode', 'chunking_model', 'indexing_schema_version']
  );
  const p = points[0]?.payload;
  return p ? {
    hash:                   p.file_hash                ?? null,
    denseProvider:          p.dense_provider           ?? null,
    denseModel:             p.dense_model              ?? null,
    sparseProvider:         p.sparse_provider          ?? null,
    embeddingSchemaVersion: p.embedding_schema_version ?? null,
    vectorSize:             p.vector_size              ?? null,
    chunkingSchemaVersion:  p.chunking_schema_version  ?? null,
    tokenCountMode:         p.token_count_mode          ?? null,
    // Skeleton-v1 markers (impl spec §4): absence = legacy point.
    chunkingModel:          p.chunking_model            ?? null,
    indexingSchemaVersion:  p.indexing_schema_version   ?? null,
  } : null;
}

export async function listSourceFiles(collection) {
  const client = getQdrantClient();
  const seen = new Set();
  let offset = null;
  const limit = 250;
  while (true) {
    const result = await qdrantCall('Qdrant scroll (listSourceFiles) failed', () => client.scroll(collection, {
      limit,
      with_payload: ['source_file'],
      ...(offset !== null && { offset }),
    }));
    const points = result.points ?? [];
    for (const p of points) {
      if (p.payload?.source_file) seen.add(p.payload.source_file);
    }
    offset = result.next_page_offset ?? null;
    if (!points.length || offset === null) break;
  }
  return [...seen];
}

/**
 * Paginate through all points in a collection, requesting only the specified
 * payload fields (no vectors). Returns the full flat array of points.
 * payloadFields: string[] of payload field names, e.g. ['source_file', 'tags']
 */
export async function scrollAllPoints(collection, payloadFields, pageSize = 250) {
  return scrollAllFiltered(collection, null, payloadFields, pageSize);
}

/**
 * Paginate through all points matching a filter, requesting only the
 * specified payload fields (no vectors). Returns the full flat array of
 * points — unlike scroll(), this follows next_page_offset until exhausted
 * instead of stopping at a single page, so callers that need every match
 * (not just the first `limit`) don't silently miss points past the first
 * page.
 */
export async function scrollAllFiltered(collection, filter, payloadFields, pageSize = 250) {
  const client = getQdrantClient();
  const points = [];
  let offset = null;
  while (true) {
    const result = await qdrantCall('Qdrant scrollAllFiltered failed', () => client.scroll(collection, {
      ...(filter && { filter }),
      limit: pageSize,
      with_payload: payloadFields,
      with_vector: false,
      ...(offset !== null && { offset }),
    }));
    const batch = result.points ?? [];
    points.push(...batch);
    offset = result.next_page_offset ?? null;
    if (offset === null) break;
  }
  return points;
}

/**
 * Paginate through all points matching a filter, invoking onPage(batch) for
 * each page as it arrives. If onPage returns `false` (or a Promise
 * resolving to `false`), pagination stops immediately WITHOUT fetching any
 * further page — the one real difference from scrollAllFiltered() above,
 * which always exhausts every page into one in-memory array. Used by
 * migrateEmbeddingProfile() (src/core/storage/qdrant-adapter.js) so a
 * disagreement found on an early page never pays for scanning the rest of
 * a large collection.
 */
export async function scrollFilteredPages(collection, filter, payloadFields, { pageSize = 250, onPage } = {}) {
  const client = getQdrantClient();
  let offset = null;
  while (true) {
    const result = await qdrantCall('Qdrant scrollFilteredPages failed', () => client.scroll(collection, {
      ...(filter && { filter }),
      limit: pageSize,
      with_payload: payloadFields,
      with_vector: false,
      ...(offset !== null && { offset }),
    }));
    const batch = result.points ?? [];
    const keepGoing = await onPage(batch);
    if (keepGoing === false) return;
    offset = result.next_page_offset ?? null;
    if (offset === null) return;
  }
}

// ── fetchWindowChunks ─────────────────────────────────────────────────────────
export async function fetchWindowChunks(collection, sourceFile, centerIndex, windowSize) {
  const from = Math.max(0, centerIndex - windowSize);
  const to   = centerIndex + windowSize;
  const points = await scroll(
    collection,
    withNavExcluded({
      must: [
        { key: 'source_file', match: { value: sourceFile } },
        { key: 'chunk_index', range: { gte: from, lte: to } },
      ],
    }),
    (windowSize * 2) + 1,
  );
  return points.sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

// ── getFileChunks ────────────────────────────────────────────────────────────
// Returns every retrieval-content chunk for one source file, sorted by
// chunk_index — the "whole file" primitive the admin UI's file view needs,
// distinct from fetchWindowChunks() above (a retrieval-context window
// centered on a specific chunk). Exhaustively paginated via
// scrollAllFiltered (not scroll()'s single-page limit), since a file can
// have more chunks than fit in one Qdrant scroll page.
export async function getFileChunks(collection, sourceFile) {
  const points = await scrollAllFiltered(
    collection,
    withNavExcluded({ must: [{ key: 'source_file', match: { value: sourceFile } }] }),
    CONTENT_NODE_FIELDS,
  );
  return points
    .filter(p => !isNavPoint(p) && Number.isInteger(p.payload?.chunk_index))
    .sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

// ── getSectionChunks ─────────────────────────────────────────────────────────
// Returns every retrieval-content chunk anchored directly under one skeleton
// section node (content chunk parent_id === section nav node_id, by
// construction — see skeleton-index.js), sorted by chunk_index. The
// "whole section" primitive the assembly service's section scope needs —
// exact parent identity, never a heading-text or chunk-index-range guess
// (headings can repeat within a file; parent_id cannot). Same projection,
// nav exclusion, and exhaustive pagination as getFileChunks above. Never
// fetches vectors.
export async function getSectionChunks(collection, parentId) {
  const points = await scrollAllFiltered(
    collection,
    withNavExcluded({ must: [{ key: 'parent_id', match: { value: parentId } }] }),
    CONTENT_NODE_FIELDS,
  );
  return points
    .filter(p => !isNavPoint(p) && Number.isInteger(p.payload?.chunk_index))
    .sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

// ── Skeleton nav helpers ──────────────────────────────────────────────────────
// These helpers scroll only skeleton_nav points; they never touch retrieval
// content chunks and never return vectors.

/**
 * Find the single collection-level skeleton_nav node (node_type: "collection").
 * Returns the point payload or null if not found.
 */
export async function getCollectionSkeletonNode(collection) {
  const points = await scroll(
    collection,
    {
      must: [
        { key: 'point_kind', match: { value: 'skeleton_nav' } },
        { key: 'node_type',  match: { value: 'collection' } },
      ],
    },
    1,
    NAV_PAYLOAD_FIELDS,
  );
  return points[0]?.payload ?? null;
}

/**
 * Find a skeleton_nav node by its node_id.
 * Returns the point payload or null.
 */
export async function getSkeletonNodeById(collection, nodeId) {
  const points = await scroll(
    collection,
    {
      must: [
        { key: 'point_kind', match: { value: 'skeleton_nav' } },
        { key: 'node_id',    match: { value: nodeId } },
      ],
    },
    1,
    NAV_PAYLOAD_FIELDS,
  );
  return points[0]?.payload ?? null;
}

/**
 * Find a skeleton_nav node by its node_path.
 * Returns the point payload or null.
 */
export async function getSkeletonNodeByPath(collection, nodePath) {
  const points = await scroll(
    collection,
    {
      must: [
        { key: 'point_kind', match: { value: 'skeleton_nav' } },
        { key: 'node_path',  match: { value: nodePath } },
      ],
    },
    1,
    NAV_PAYLOAD_FIELDS,
  );
  return points[0]?.payload ?? null;
}

/**
 * Fetch skeleton_nav children of a node by their node_path values.
 * childPaths: string[] from parent.children
 * Returns an array of payloads in the same order as childPaths (missing paths skipped).
 */
export async function getSkeletonChildren(collection, childPaths, limit = 50) {
  if (!childPaths || childPaths.length === 0) return [];
  const capped = childPaths.slice(0, limit);
  const points = await scroll(
    collection,
    {
      must: [
        { key: 'point_kind', match: { value: 'skeleton_nav' } },
        { key: 'node_path',  match: { any: capped } },
      ],
    },
    capped.length,
    NAV_PAYLOAD_FIELDS,
  );
  // Restore order from childPaths
  const byPath = new Map(points.map(p => [p.payload?.node_path, p.payload]));
  return capped.map(path => byPath.get(path)).filter(Boolean);
}

/**
 * Find a non-nav content node (table, code_block, checklist, image, etc.) by node_id.
 * Returns the point payload or null. Never returns skeleton_nav points.
 */
export async function getContentNodeById(collection, nodeId) {
  const points = await scroll(
    collection,
    { must: [{ key: 'node_id', match: { value: nodeId } }] },
    2,
    CONTENT_NODE_FIELDS,
  );
  const payload = points.find(p => p.payload?.point_kind !== 'skeleton_nav')?.payload ?? null;
  return payload;
}

/**
 * Find a non-nav content node by node_path.
 * Returns the point payload or null. Never returns skeleton_nav points.
 */
export async function getContentNodeByPath(collection, nodePath) {
  const points = await scroll(
    collection,
    { must: [{ key: 'node_path', match: { value: nodePath } }] },
    2,
    CONTENT_NODE_FIELDS,
  );
  const payload = points.find(p => p.payload?.point_kind !== 'skeleton_nav')?.payload ?? null;
  return payload;
}

/**
 * Find any node by node_id without filtering — used to detect nav vs content.
 * Returns the raw payload or null.
 */
export async function getAnyNodeById(collection, nodeId) {
  const points = await scroll(
    collection,
    { must: [{ key: 'node_id', match: { value: nodeId } }] },
    2,
    [...CONTENT_NODE_FIELDS, ...NAV_PAYLOAD_FIELDS],
  );
  return points[0]?.payload ?? null;
}

/**
 * Find any node by node_path without filtering.
 */
export async function getAnyNodeByPath(collection, nodePath) {
  const points = await scroll(
    collection,
    { must: [{ key: 'node_path', match: { value: nodePath } }] },
    2,
    [...CONTENT_NODE_FIELDS, ...NAV_PAYLOAD_FIELDS],
  );
  return points[0]?.payload ?? null;
}

/**
 * Bounded, single-page sibling lookup for graph-expanded retrieval
 * (docs/design/graph-expanded-retrieval.md): every non-nav content point
 * whose parent_id matches the given section nav node id, via ONE indexed
 * scroll() call capped at `limit + 1` (the +1 headroom accounts for the
 * seed chunk itself, which the caller filters out afterward — never an
 * exhaustive scrollAllFiltered() pagination like getSectionChunks()/
 * getFirstContentChunkByParent() above use for their own, different,
 * "give me the WHOLE section" contract). A large section is intentionally
 * NOT fully paginated here — this is a bounded expansion primitive, not a
 * section-assembly one.
 */
export async function getSectionSiblings(collection, parentId, limit = 5) {
  const points = await scroll(
    collection,
    withNavExcluded({ must: [{ key: 'parent_id', match: { value: parentId } }] }),
    Math.max(1, limit) + 1,
  );
  return points
    .filter(p => !isNavPoint(p) && Number.isInteger(p.payload?.chunk_index))
    .sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

/**
 * Find the earliest (lowest chunk_index) content chunk whose parent_id
 * matches the given skeleton nav node id. A section nav node and its
 * content chunks are separate points linked only via parent_id (nav node_id
 * === content chunk parent_id, by construction — see skeleton-index.js) —
 * this is how "open this section" resolves to an actual readable chunk
 * instead of guessing chunk_index 0 for the whole file.
 * Returns the point payload or null if the section has no content chunks
 * (e.g. an empty section, or a legacy/non-skeleton collection).
 */
export async function getFirstContentChunkByParent(collection, parentId) {
  const points = await scrollAllFiltered(
    collection,
    { must: [{ key: 'parent_id', match: { value: parentId } }] },
    CONTENT_NODE_FIELDS,
  );
  const content = points
    .map(p => p.payload)
    .filter(p => p && p.point_kind !== 'skeleton_nav' && Number.isInteger(p.chunk_index));
  if (!content.length) return null;
  return content.reduce((min, p) => (p.chunk_index < min.chunk_index ? p : min));
}
