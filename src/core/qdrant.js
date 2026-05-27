import 'dotenv/config';

const URL = process.env.QDRANT_URL;
const KEY = process.env.QDRANT_KEY;

const headers = () => ({ 'api-key': KEY, 'Content-Type': 'application/json' });

export async function listCollections() {
  const r = await fetch(`${URL}/collections`, { headers: headers() });
  if (!r.ok) throw new Error(`Qdrant listCollections failed: ${await r.text()}`);
  const data = await r.json();
  return data.result.collections.map(c => c.name);
}

export async function getCollectionInfo(name) {
  const r = await fetch(`${URL}/collections/${name}`, { headers: headers() });
  if (!r.ok) throw new Error(`Qdrant getCollectionInfo failed: ${await r.text()}`);
  const data = await r.json();
  return data.result;
}

export async function upsertPoints(collection, points) {
  const r = await fetch(`${URL}/collections/${collection}/points`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points }),
  });
  if (!r.ok) throw new Error(`Qdrant upsert failed: ${await r.text()}`);
}

export async function updatePayload(collection, id, payload) {
  const r = await fetch(`${URL}/collections/${collection}/points/payload`, {
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
  const r = await fetch(`${URL}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant search failed (${collection}): ${await r.text()}`);
  const data = await r.json();
  return data.result ?? [];
}

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[qdrant] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}`);
    return defaultVal;
  }
  return v;
}

const PREFETCH_MULT = envInt('HYBRID_PREFETCH_LIMIT', 2, 1, 100);
const RRF_K        = envInt('RRF_K', 60, 1, 10000);

export async function hybridSearch(collection, denseVector, sparseVector, limit = 5, filter = null) {
  const prefetchLimit = Math.max(limit * PREFETCH_MULT, limit + 1);
  const prefetch = [
    { query: sparseVector, using: 'sparse', limit: prefetchLimit, ...(filter && { filter }) },
    { query: denseVector,  using: 'dense',  limit: prefetchLimit, ...(filter && { filter }) },
  ];
  const body = { prefetch, query: { rrf: { k: RRF_K } }, limit, with_payload: true };
  const r = await fetch(`${URL}/collections/${collection}/points/query`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // fall back to dense-only search if collection has no sparse vectors yet
    const err = await r.text();
    if (err.includes('sparse') || err.includes('Wrong input')) return search(collection, { name: 'dense', vector: denseVector }, limit, filter);
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

  const r = await fetch(`${URL}/collections/${collection}/points/query`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant mmrSearch failed (${collection}): ${await r.text()}`);
  const data = await r.json();
  return data.result?.points ?? [];
}

export async function scroll(collection, filter, limit = 100, withPayload = true) {
  const r = await fetch(`${URL}/collections/${collection}/points/scroll`, {
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
    ['file_hash', 'dense_provider', 'dense_model', 'sparse_provider', 'embedding_schema_version', 'vector_size']
  );
  const p = points[0]?.payload;
  return p ? {
    hash:                   p.file_hash                ?? null,
    denseProvider:          p.dense_provider           ?? null,
    denseModel:             p.dense_model              ?? null,
    sparseProvider:         p.sparse_provider          ?? null,
    embeddingSchemaVersion: p.embedding_schema_version ?? null,
    vectorSize:             p.vector_size              ?? null,
  } : null;
}

export async function deleteBySourceFile(collection, sourceFile) {
  const r = await fetch(`${URL}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    }),
  });
  if (!r.ok) throw new Error(`Qdrant delete failed: ${await r.text()}`);
}

// Delete points for sourceFile whose chunk_index >= fromChunkIndex.
// Used after a file shrinks: deterministic IDs overwrite existing chunks 0..N-1,
// but old points for chunk N..old_N-1 become orphans that PRUNE_STALE cannot
// detect (the source_file still exists on disk).
export async function deleteTrailingChunks(collection, sourceFile, fromChunkIndex) {
  const r = await fetch(`${URL}/collections/${collection}/points/delete`, {
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
    const r = await fetch(`${URL}/collections/${collection}/points/scroll`, {
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
    const r = await fetch(`${URL}/collections/${collection}/points/scroll`, {
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
  const r = await fetch(`${URL}/collections/${collection}/index`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ field_name: field, field_schema: type }),
  });
  if (!r.ok) throw new Error(`Create index failed: ${await r.text()}`);
}

export async function createCollection(name, size = 1024) {
  const r = await fetch(`${URL}/collections/${name}`, {
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
  await createPayloadIndex(name, 'entities.paths', 'keyword');
  await createPayloadIndex(name, 'entities.symbols', 'keyword');
  await createPayloadIndex(name, 'entities.env_vars', 'keyword');
  await createPayloadIndex(name, 'entities.commands', 'keyword');
  await createPayloadIndex(name, 'doc_role', 'keyword');
}

export async function deleteCollection(name) {
  const r = await fetch(`${URL}/collections/${name}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!r.ok) throw new Error(`Delete collection failed: ${await r.text()}`);
}

export async function hasSparseVectors(collection) {
  const r = await fetch(`${URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ limit: 1, with_vectors: ['sparse'] }),
  });
  if (!r.ok) return false;
  const data = await r.json();
  const point = data.result?.points?.[0];
  if (!point) return true; // empty collection, assume fine
  const sv = point.vectors?.sparse;
  return sv && Array.isArray(sv.indices) && sv.indices.length > 0;
}

// Discriminator fields that every semidex-indexed point carries in its payload.
// Used by sync to distinguish semidex-managed collections from foreign ones.
const SEMIDEX_PAYLOAD_FIELDS = [
  'source_file', 'chunk_index', 'file_hash',
  'dense_provider', 'dense_model', 'sparse_provider',
  'embedding_schema_version', 'vector_size',
];

// Pure helper — returns true when the given payload object contains all
// semidex discriminator fields. Safe to call with null/undefined.
export function isSemidexPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return SEMIDEX_PAYLOAD_FIELDS.every(f => f in payload);
}

// Fetches one point payload from the collection without pulling vectors or text.
// Return value contract (important — sync.js relies on this distinction):
//   null  → collection is empty (no points); caller should NOT mark linkDisabled
//   {}    → point exists but Qdrant returned no payload or an empty payload object;
//           isSemidexPayload({}) = false → caller should mark linkDisabled
//   {...} → normal payload; caller checks isSemidexPayload to decide
// Throws on Qdrant errors so the caller can handle failures conservatively.
export async function getCollectionSamplePayload(collection) {
  const r = await fetch(`${URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      limit: 1,
      with_payload: SEMIDEX_PAYLOAD_FIELDS,
      with_vectors: false,
    }),
  });
  if (!r.ok) throw new Error(`Qdrant samplePayload failed (${collection}): ${await r.text()}`);
  const data = await r.json();
  const point = data.result?.points?.[0];
  if (!point) return null;          // empty collection → do not disable
  return point.payload ?? {};       // non-empty but missing payload → {} → disabled
}

export async function addSparseVectorSupport(name) {
  const r = await fetch(`${URL}/collections/${name}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({
      sparse_vectors: { sparse: { index: { on_disk: false } } },
    }),
  });
  if (!r.ok) throw new Error(`addSparseVectorSupport failed: ${await r.text()}`);
}

export async function fetchWindowChunks(collection, source_file, chunk_index, window) {
  const idx = parseInt(chunk_index, 10);
  if (!Number.isFinite(idx) || idx < 0) return [];
  window = Math.max(0, parseInt(window) || 0);
  const from = Math.max(0, idx - window);
  const to = idx + window;

  const points = await scroll(collection, {
    must: [
      { key: 'source_file', match: { value: source_file } },
      { key: 'chunk_index', range: { gte: from, lte: to } },
    ],
  }, to - from + 1);

  points.sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);
  return points;
}
