# Benchmarking

semidex includes a retrieval benchmark harness that measures search quality
against a fixed corpus of fixture documents. There are two benchmark tiers:

## Benchmark Tiers

### 21-query regression benchmark (`benchmarks/retrieval/`)

The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2
schema. It is run before merges to detect retrieval regressions. The collection name is
`bench-retrieval`.

### 50-query quality benchmark (`benchmarks/retrieval/custom-50/`)

A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema
with graded relevance (`relevantChunks`, `relevance: 1/2/3`). Metrics include
chunk-level recall, graded nDCG, and support recall. The collection name is
`bench-retrieval-custom-50`.

## Query Schema Versions

### v1 (minimal)

```json
{ "id": "q1", "query": "...", "expected": ["file.md"], "note": "..." }
```

### v2 (extended file-level)

```json
{
  "id": "q1", "type": "exact-token", "query": "...",
  "expectedFiles": ["file.md"],
  "expectedSections": ["Section heading"],
  "expectedAllTokens": ["token"],
  "expectedAnyTokens": ["alt_token"],
  "expectedAnyTokenGroups": ["bge-m3-onnx"],
  "shouldHaveNoStrongHit": false,
  "note": "..."
}
```

### v3 (graded chunk-level)

```json
{
  "schemaVersion": 3,
  "queries": [{
    "id": "c01", "type": "exact-token", "query": "...",
    "expectedFiles": ["file.md"],
    "relevantChunks": [
      { "chunkId": "file.md#2", "relevance": 3 },
      { "chunkId": "file.md#3", "relevance": 2 }
    ],
    "expectedTokens": ["token"],
    "note": "..."
  }]
}
```

`chunkId` format is `source_file#chunk_index` (zero-based). This matches the
`source_file` and `chunk_index` fields in Qdrant payloads.

## Relevance Scale

| Score | Meaning |
|-------|---------|
| 3 | Exact answer — chunk contains the direct answer |
| 2 | Supporting context — useful for multi-hop or neighboring section |
| 1 | Same-topic / same-file, not sufficient alone |
| 0 | Irrelevant |

Grades are used for:
- `nDCG@K` with gain formula `2^relevance − 1`
- `chunkRecall@K`: counts only `relevance >= 3`
- `supportRecall@K`: counts `relevance >= 2`

## Metrics

### Chunk-level (v3 only)

| Metric | Description |
|--------|-------------|
| `chunkRecall@3` | Fraction of queries with a rel≥3 chunk in top-3 |
| `chunkRecall@5` | Fraction of queries with a rel≥3 chunk in top-5 |
| `supportRecall@K` | Fraction of queries with a rel≥2 chunk in top-K |
| `nDCG@K` | Normalised Discounted Cumulative Gain with graded relevance |
| `MRR@10` | Reciprocal rank of the first rel≥3 chunk across top-10 |

### File-level (backward-compatible)

| Metric | Description |
|--------|-------------|
| `fileRecall@1` | Expected file appears at rank 1 |
| `fileRecall@K` | Expected file appears in top-K |

### Latency

| Metric | Description |
|--------|-------------|
| `p50` | Median query latency (ms) |
| `p95` | 95th-percentile query latency (ms) |
| `avgLatency` | Mean query latency (ms) |

## Running Benchmarks

```bash
# Stable 21q regression benchmark
npm run bench:retrieval

# Quality 50q benchmark
npm run bench:custom50

# Force ONNX provider
BENCH_PROVIDER=onnx npm run bench:custom50

# Skip reindex (reuse existing collection)
BENCH_SKIP_INDEX=1 npm run bench:custom50

# Dense MMR instead of hybrid RRF
BENCH_SEARCH_MODE=dense-mmr npm run bench:custom50

# Comparison: ollama vs onnx (two runs)
npm run bench:retrieval:compare

# MMR diversity matrix
npm run bench:retrieval:mmr

# Rerank matrix (4 combinations)
npm run bench:retrieval:rerank
```

## Collection Isolation

Each benchmark tier uses a dedicated Qdrant collection:

| Benchmark | Collection |
|-----------|-----------|
| 21q regression | `bench-retrieval` |
| 50q quality | `bench-retrieval-custom-50` |

This isolation ensures that running one benchmark does not affect the other.
Both collections are created automatically on first run.

## BENCH_SKIP_INDEX

When `BENCH_SKIP_INDEX=1` is set, the runner skips re-indexing and reuses
the existing collection. The stored provider is validated against the current
env provider — if they differ, the run fails with an explicit error.

This flag is used by matrix scripts (`mmr-matrix.js`, `rerank-matrix.js`) to
run multiple search-mode variants on the same index without measuring reindex
variance between runs.
