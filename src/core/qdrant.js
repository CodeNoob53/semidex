import 'dotenv/config';
import { envInt } from './env.js';

const QDRANT_URL = process.env.QDRANT_URL;
const KEY        = process.env.QDRANT_KEY;

if (!QDRANT_URL) throw new Error('QDRANT_URL is not set. Add it to your .env file.');

const headers = () => {
  const h = { 'Content-Type': 'application/json' };
  if (KEY) h['api-key'] = KEY;
  return h;
};

// Default timeouts: 30 s for reads, 60 s for writes (upsert/delete can be slow on large collections).
function qdrantFetch(url, init = {}) {
  const isWrite = init.method && init.method !== 'GET';
  return fetch(url, { signal: AbortSignal.timeout(isWrite ? 60_000 : 30_000), ...init });
}

const cUrl = (name, path = '') =>
  `${QDRANT_URL}/collections/${encodeURIComponent(name)}${path}`;

export async function listCollections() {
  const r = await qdrantFetch(`${QDRANT_URL}/collections`, { headers: headers() });
  if (!r.ok) throw new Error(`Qdrant listCollections failed: ${await r.text()}`);
  const data = await r.json();
  return data.result.collections.map(c => c.name);
}

export async function getCollectionInfo(name) {
  const r = await qdrantFetch(cUrl(name), { headers: headers() });
  if (!r.ok) throw new Error(`Qdrant getCollectionInfo failed: ${await r.text()}`);
  const data = await r.json();
  return data.result;
}

export async function upsertPoints(collection, points) {
  const r = await qdrantFetch(cUrl(collection, '/points'), {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points }),
  });
  if (!r.ok) throw new Error(`Qdrant upsert failed: ${await r.text()}`);
}

export async function updatePayload(collection, id, payload) {
  const r = await qdrantFetch(cUrl(collection, '/points/payload'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ payload, points: [id] }),
  });
  if (!r.ok) throw new Error(`Qdrant updatePayload failed: ${await r.text()}`);
}

export async function search(collection, vector, limit = 5, filter = null) {
  // named vector: { name: 'dense', vector: [...] }
  const body = Array.isArray(vector)
    ? { vector, limit, with_payload: true }
    : { vector: { name: vector.name, vector: vector.vector ?? vector }, limit, with_payload: true };
  if (filter) body.filter = filter;
  const r = await qdrantFetch(cUrl(collection, '/points/search'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant search failed (${collection}): ${await r.text()}`);
  const data = await r.json();
  return data.result ?? [];
}

const PREFETCH_MULT = envInt('HYBRID_PREFETCH_LIMIT', 2, 1, 100, '[qdrant] ');
const RRF_K        = envInt('RRF_K', 60, 1, 10000, '[qdrant] ');

export async function hybridSearch(collection, denseVector, sparseVector, limit = 5, filter = null) {
  const prefetchLimit = Math.max(limit * PREFETCH_MULT, limit + 1);
  const prefetch = [
    { query: sparseVector, using: 'sparse', limit: prefetchLimit, ...(filter && { filter }) },
    { query: denseVector,  using: 'dense',  limit: prefetchLimit, ...(filter && { filter }) },
  ];
  const body = { prefetch, query: { rrf: { k: RRF_K } }, limit, with_payload: true };
  const r = await qdrantFetch(cUrl(collection, '/points/query'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    // Qdrant returns "Wrong sparse vector name: sparse" when the collection has no sparse index yet.
    // Fall back to dense-only in that case; all other errors are real failures.
    if (err.includes('Wrong sparse vector name')) {
      process.stderr.write(`[qdrant] hybridSearch fallback to dense-only for "${collection}": ${err.slice(0, 120)}\n`);
      return search(collection, { name: 'dense', vector: denseVector }, limit, filter);
    }
    throw new Error(`Qdrant hybridSearch failed (${collection}): ${err}`);
  }
  const data = await r.json();
  return data.result?.points ?? [];
}

export async function mmrSearch(collection, denseVector, limit = 5, filter = null, opts = {}) {
  const diversity = opts.diversity ?? 0.5;
  const candidatesLimit = Math.max(opts.candidatesLimit ?? 100, limit);
  const body = {
    query: {
      nearest: denseVector,
      mmr: {
        diversity,
        candidates_limit: candidatesLimit,
      },
    },
    using: 'dense',
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const r = await qdrantFetch(cUrl(collection, '/points/query'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant mmrSearch failed (${collection}): ${await r.text()}`);
  const data = await r.json();
  return data.result?.points ?? [];
}

export async function scroll(collection, filter, limit = 100, withPayload = true) {
  const r = await qdrantFetch(cUrl(collection, '/points/scroll'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ filter, limit, with_payload: withPayload }),
  });
  if (!r.ok) throw new Error(`Qdrant scroll failed: ${await r.text()}`);
  const data = await r.json();
  return data.result?.points ?? [];
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

export async function deleteBySourceFile(collection, sourceFile) {
  const r = await qdrantFetch(cUrl(collection, '/points/delete'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    }),
  });
  if (!r.ok) throw new Error(`Qdrant delete failed: ${await r.text()}`);
}

export async function deleteByFilter(collection, filter) {
  const r = await qdrantFetch(cUrl(collection, '/points/delete'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ filter }),
  });
  if (!r.ok) throw new Error(`Qdrant deleteByFilter failed: ${await r.text()}`);
}

// Delete points for sourceFile whose chunk_index >= fromChunkIndex.
// Used after a file shrinks: deterministic IDs overwrite existing chunks 0..N-1,
// but old points for chunk N..old_N-1 become orphans that PRUNE_STALE cannot
// detect (the source_file still exists on disk).
export async function deleteTrailingChunks(collection, sourceFile, fromChunkIndex) {
  const r = await qdrantFetch(cUrl(collection, '/points/delete'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: {
        must: [
          { key: 'source_file', match: { value: sourceFile } },
          { key: 'chunk_index', range: { gte: fromChunkIndex } },
        ],
      },
    }),
  });
  if (!r.ok) throw new Error(`Qdrant deleteTrailingChunks failed: ${await r.text()}`);
}

export async function listSourceFiles(collection) {
  const seen = new Set();
  let offset = null;
  const limit = 250;
  while (true) {
    const body = { limit, with_payload: ['source_file'] };
    if (offset !== null) body.offset = offset;
    const r = await qdrantFetch(cUrl(collection, '/points/scroll'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Qdrant scroll (listSourceFiles) failed: ${await r.text()}`);
    const data = await r.json();
    const points = data.result?.points ?? [];
    for (const p of points) {
      if (p.payload?.source_file) seen.add(p.payload.source_file);
    }
    offset = data.result?.next_page_offset ?? null;
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
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: pageSize, with_payload: payloadFields, with_vectors: false };
    if (offset !== null) body.offset = offset;
    const r = await qdrantFetch(cUrl(collection, '/points/scroll'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Qdrant scrollAllPoints failed: ${await r.text()}`);
    const data = await r.json();
    const batch = data.result?.points ?? [];
    points.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    if (offset === null) break;
  }
  return points;
}

export async function createPayloadIndex(collection, field, type = 'keyword') {
  const r = await qdrantFetch(cUrl(collection, '/index'), {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ field_name: field, field_schema: type }),
  });
  if (!r.ok) throw new Error(`Create index failed: ${await r.text()}`);
}

export async function createCollection(name, size = 1024) {
  const r = await qdrantFetch(cUrl(name), {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      vectors: { dense: { size, distance: 'Cosine' } },
      sparse_vectors: { sparse: { index: { on_disk: false } } },
    }),
  });
  if (!r.ok) throw new Error(`Create collection failed: ${await r.text()}`);
  await createPayloadIndex(name, 'source_file', 'keyword');
  await createPayloadIndex(name, 'tags', 'keyword');
  await createPayloadIndex(name, 'chunk_index', 'integer');
  await createPayloadIndex(name, 'point_kind', 'keyword');
  await createPayloadIndex(name, 'node_type',  'keyword');
  await createPayloadIndex(name, 'node_id',    'keyword');
  await createPayloadIndex(name, 'node_path',  'keyword');
}

export async function hasSparseVectors(collection) {
  const r = await qdrantFetch(cUrl(collection, '/points/scroll'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ limit: 1, with_vectors: ['sparse'] }),
  });
  if (!r.ok) return false;
  const data = await r.json();
  const point = data.result?.points?.[0];
  if (!point) return true;
  const sv = point.vectors?.sparse;
  return sv && Array.isArray(sv.indices) && sv.indices.length > 0;
}

export async function addSparseVectorSupport(name) {
  const r = await qdrantFetch(cUrl(name), {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({
      sparse_vectors: { sparse: { index: { on_disk: false } } },
    }),
  });
  if (!r.ok) throw new Error(`addSparseVectorSupport failed: ${await r.text()}`);
}

// ── isSemidexPayload ──────────────────────────────────────────────────────────
// Returns true when a payload object looks like a semidex-managed point.
// Used by sync to skip foreign collections that happen to share a Qdrant instance.
const SEMIDEX_PAYLOAD_FIELDS = [
  'source_file', 'chunk_index', 'file_hash',
  'dense_provider', 'dense_model', 'sparse_provider',
  'embedding_schema_version', 'vector_size',
  'chunking_schema_version', 'token_count_mode',
];

export function isSemidexPayload(payload) {
  if (typeof payload !== 'object' || payload === null) return false;
  return SEMIDEX_PAYLOAD_FIELDS.every(f => f in payload);
}

// ── fetchWindowChunks ─────────────────────────────────────────────────────────
export async function fetchWindowChunks(collection, sourceFile, centerIndex, windowSize) {
  const from = Math.max(0, centerIndex - windowSize);
  const to   = centerIndex + windowSize;
  const points = await scroll(
    collection,
    {
      must: [
        { key: 'source_file', match: { value: sourceFile } },
        { key: 'chunk_index', range: { gte: from, lte: to } },
      ],
    },
    (windowSize * 2) + 1,
  );
  return points.sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
}

// ── Skeleton nav helpers ──────────────────────────────────────────────────────
// These helpers scroll only skeleton_nav points; they never touch retrieval
// content chunks and never return vectors.

const NAV_PAYLOAD_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'parent_id',
  'summary', 'children', 'source_file', 'heading_path', 'inventory',
  'summary_kind', 'summary_version', 'key_topics', 'notable_terms', 'child_overview',
];

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
