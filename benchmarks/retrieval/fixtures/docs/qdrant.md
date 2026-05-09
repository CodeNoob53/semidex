# Qdrant Integration

semidex uses Qdrant as its vector database. All Qdrant calls go through
`src/core/qdrant.js`. The module reads `QDRANT_URL` and `QDRANT_KEY` from the
environment and exposes typed functions for collections, points, and search.

## Collections

Each collection stores named vectors: a `dense` vector (cosine distance) and a `sparse`
vector. Collections are created via `createCollection(name, size)` which also creates
payload indexes on `source_file` and `tags` for efficient filtering.

## Hybrid Search and RRF

Hybrid search combines dense and sparse retrieval using Reciprocal Rank Fusion (RRF).
The implementation uses the Qdrant Query API (`/points/query`) with two prefetch legs
followed by an RRF fusion step.

The RRF formula scores each result as the sum of `1 / (k + rank_i)` across all retrieval
legs, where `k` is a smoothing constant. A higher `k` makes the ranking smoother
(differences between adjacent ranks matter less). The default value is 60, which is the
standard RRF constant from the original paper.

### RRF k parameter

The `k` parameter in RRF controls rank sensitivity. It is configured via the `RRF_K`
environment variable (default: 60, range: 1–10000). Lower values give more weight to
top-ranked results from each leg; higher values smooth the fusion across more results.

The Qdrant request body shape for RRF (available since Qdrant 1.16.0):

```json
{
  "prefetch": [
    { "query": "<sparse_vector>", "using": "sparse", "limit": 10 },
    { "query": "<dense_vector>",  "using": "dense",  "limit": 10 }
  ],
  "query": { "rrf": { "k": 60 } },
  "limit": 5,
  "with_payload": true
}
```

The prefetch limit for each leg is `max(limit * HYBRID_PREFETCH_LIMIT, limit + 1)` where
`HYBRID_PREFETCH_LIMIT` defaults to 2. This ensures each leg fetches enough candidates
for RRF to have meaningful re-ranking material.

### Fallback to dense-only

If a collection has no sparse vectors yet (e.g. old index before sparse support was
added), `hybridSearch` falls back to `search` (dense-only) automatically. The fallback
is triggered when the Qdrant response contains `"sparse"` or `"Wrong input"` in the
error message.

## Payload Indexes

Two payload indexes are created on every collection: `source_file` (keyword) and `tags`
(keyword). These allow Qdrant to filter points efficiently without scanning all vectors.
The `source_file` index is used by `getStoredMeta` and `deleteBySourceFile`.

## getStoredMeta

`getStoredMeta(collection, sourceFile)` scrolls one point matching the given source file
and returns the six reindex discriminator fields from its payload:
`file_hash`, `dense_provider`, `dense_model`, `sparse_provider`,
`embedding_schema_version`, and `vector_size`.

## Env tuning

| Variable               | Default | Range      | Effect                              |
|------------------------|---------|------------|-------------------------------------|
| `HYBRID_PREFETCH_LIMIT`| 2       | 1–100      | Prefetch multiplier per RRF leg     |
| `RRF_K`                | 60      | 1–10000    | RRF smoothing constant              |

Invalid values produce a warning and fall back to the default.
