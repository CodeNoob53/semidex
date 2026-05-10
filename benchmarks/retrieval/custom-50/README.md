# Custom-50 Quality Benchmark

A richer retrieval evaluation harness using graded chunk-level relevance (v3 schema).
Complements the stable 21-query regression benchmark in `benchmarks/retrieval/`.

## Purpose

- **21q regression** (`benchmarks/retrieval/`) — file-level recall, fast smoke test, run before merges.
- **custom-50** (this directory) — chunk-level recall, graded nDCG, 10 fixture docs, 50 queries.

## Metrics

| Metric | Description |
|--------|-------------|
| `chunkRecall@3` | Fraction of queries with a rel≥3 chunk in top-3 |
| `chunkRecall@5` | Fraction of queries with a rel≥3 chunk in top-5 |
| `chunkRecall@10` | Fraction of queries with a rel≥3 chunk in top-10 |
| `windowRecall@5` | Fraction of queries where exact chunk or its ±1 neighbor is in top-5 |
| `windowRecall@10` | Same with top-10; `1 − windowRecall@10` = true retrieval failures |
| `supportRecall@K` | Fraction of queries with a rel≥2 chunk in top-K |
| `nDCG@K (graded)` | Normalised DCG with gain = 2^relevance − 1 |
| `MRR@10` | Reciprocal rank of first rel≥3 chunk in top-10 |
| `fileRecall@1/K` | File-level recall (secondary, backward-compat) |
| `negativePassRate` | Fraction of negative queries with no strong hit in top-1 |
| `p50 / p95 latency` | Median and 95th-percentile query latency |

`windowRecall` matters for the MCP workflow: if the exact chunk is not in top-K but a
neighbor is, an agent can still recover the answer via `qdrant_get_chunk(window=1)`.

## Relevance Scale

| Score | Meaning |
|-------|---------|
| 3 | Exact answer — chunk directly answers the query |
| 2 | Supporting context — useful neighboring or related chunk |
| 1 | Same-topic / same-file, not sufficient alone |
| 0 | Irrelevant (implicit for any chunk not in `relevantChunks`) |

## Query Schema (v3)

```json
{
  "schemaVersion": 3,
  "queries": [
    {
      "id": "c01",
      "type": "exact-token",
      "query": "де налаштовується sparseProvider",
      "expectedFiles": ["providers.md"],
      "relevantChunks": [
        { "chunkId": "providers.md#3", "relevance": 3 },
        { "chunkId": "providers.md#1", "relevance": 2 }
      ],
      "expectedTokens": ["sparseProvider"],
      "note": "sparseProvider config field, UA query"
    }
  ]
}
```

`chunkId` format: `source_file#chunk_index` (zero-based). Matches Qdrant payload fields
`source_file` and `chunk_index`. Use `qdrant_get_chunk` to verify chunk content.

## Usage

```sh
# Default: hybrid RRF, top-10, env provider
npm run bench:custom50

# Force bge-m3-onnx
BENCH_PROVIDER=onnx npm run bench:custom50

# Skip reindex (reuse existing bench-retrieval-custom-50 collection)
BENCH_SKIP_INDEX=1 npm run bench:custom50

# Dense MMR instead of hybrid RRF
BENCH_SEARCH_MODE=dense-mmr MMR_DIVERSITY=0.5 npm run bench:custom50

# Change windowRecall adjacency window (default: 1)
BENCH_WINDOW=2 npm run bench:custom50

# Emit JSON for scripting
BENCH_JSON=1 npm run bench:custom50

# Failure analysis: pipe JSON output into the analyzer
BENCH_JSON=1 BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50 \
  | npm run bench:custom50:failures

# Save failure analysis to file
BENCH_JSON=1 BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50 \
  | node benchmarks/retrieval/custom-50/analyze-failures.js \
  > benchmarks/retrieval/results/$(date +%F)-custom50-failure-analysis.txt

# Adjust failure analysis window and snippet length
FAIL_WINDOW=2 FAIL_SNIPPET=400 FAIL_TOP_K=10 ... | npm run bench:custom50:failures
```

Prerequisites: `QDRANT_URL` and `QDRANT_KEY` in `.env` or environment.

## Collection

Uses dedicated collection `bench-retrieval-custom-50` (separate from `bench-retrieval`).
Created automatically on first run.

## Fixtures

10 Markdown files across two directories:

**Shared** (read from `benchmarks/retrieval/fixtures/docs/` — same as 21q regression):

| File | Topic |
|------|-------|
| `providers.md` | Embedding providers, sparseProvider, reindex discriminators |
| `qdrant.md` | Qdrant integration, RRF, hybrid search, payload indexes |
| `chunking.md` | Chunking logic, overlap, sentence splitting, pandoc |
| `sync.md` | sync command, backfill, config.json |

**Own** (read from `benchmarks/retrieval/custom-50/fixtures/docs/`):

| File | Topic |
|------|-------|
| `mcp-workflow.md` | MCP tools, agent workflow, qdrant_* tool reference |
| `obsidian.md` | Obsidian review output, CHUNKS_OUT_DIR, wikilinks |
| `project-structure.md` | Source tree, key modules, entry points |
| `benchmarking.md` | Benchmark tiers, query schema, metrics, running benchmarks |
| `config-env.md` | All environment variables, config.json structure |
| `multilingual.md` | Ukrainian/English support, cross-lingual retrieval, BGE-M3 |

## Queries

50 queries across 3 types (mixed Ukrainian/English throughout):

| Type | Count | Description |
|------|-------|-------------|
| `exact-token` | 38 | Query requires a specific technical token in the retrieved chunk |
| `paraphrase` | 11 | Query is a paraphrase of the fixture content |
| `negative` | 1 | Should not return a confident hit |

## Adding Queries

Use v3 schema with `relevantChunks` filled in. To find the correct `chunk_index`:

1. Index the collection: `npm run bench:custom50`
2. Use `qdrant_get_chunk` via MCP or scroll to inspect chunk boundaries.
3. Verify chunk content matches the expected answer before assigning `relevance: 3`.

For negative queries:
```json
{
  "id": "c51",
  "type": "negative",
  "query": "...",
  "expectedFiles": [],
  "relevantChunks": [],
  "expectedTokens": ["token_that_should_not_appear"],
  "shouldHaveNoStrongHit": true,
  "note": "..."
}
```
