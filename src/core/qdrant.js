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

export async function hybridSearch(collection, denseVector, sparseVector, limit = 5, filter = null) {
  const prefetch = [
    { query: sparseVector, using: 'sparse', limit: limit * 2, ...(filter && { filter }) },
    { query: denseVector,  using: 'dense',  limit: limit * 2, ...(filter && { filter }) },
  ];
  const body = { prefetch, query: { fusion: 'rrf' }, limit, with_payload: true };
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
    ['file_hash', 'sparse_provider']
  );
  const p = points[0]?.payload;
  return p ? { hash: p.file_hash ?? null, sparseProvider: p.sparse_provider ?? 'hashed-tf' } : null;
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

export async function createPayloadIndex(collection, field) {
  const r = await fetch(`${URL}/collections/${collection}/index`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
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
  await createPayloadIndex(name, 'source_file');
  await createPayloadIndex(name, 'tags');
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
