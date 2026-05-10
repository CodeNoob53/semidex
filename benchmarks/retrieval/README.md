# Retrieval Benchmark

Measures whether semidex can retrieve the correct document for each query.
Runs against a live Qdrant instance; no mocking.

## Metrics

| Metric | Meaning |
|--------|---------|
| fileRecall@1 | Fraction of positive queries where the correct file is rank #1 |
| fileRecall@K | Fraction of positive queries where the correct file is in top-K |
| MRR | Mean Reciprocal Rank — average of 1/rank across positive queries |
| nDCG@K | Normalised Discounted Cumulative Gain at K (binary relevance per file) |
| sectionHit@K | Fraction of queries where the expected section appears in top-K chunks *from expectedFiles* |
| tokenHit@K | Fraction of queries where expectedAllTokens + any of expectedAnyTokens appear in a top-K chunk *from expectedFiles* |
| negativePassRate | Fraction of negative queries where expectedAllTokens do NOT appear in top-1 result |
| dupSourceRate | Average fraction of top-K results that share a source_file with another result |
| sourceDiversity | Average count of unique source_file values in top-K results |
| p50 / p95 latency | Median and 95th-percentile end-to-end query latency |

## Usage

```sh
# Use whatever provider is set in .env (ONNX_EMBED, DENSE_PROVIDER, etc.)
npm run bench:retrieval

# Force bge-m3-onnx regardless of .env
BENCH_PROVIDER=onnx npm run bench:retrieval

# Skip re-indexing — reuse an already-indexed bench-retrieval collection.
# Exits with an error if the collection is empty or the stored provider differs.
BENCH_SKIP_INDEX=1 npm run bench:retrieval

# Change search depth (default 5). Recall@K label matches actual TOP_K.
BENCH_TOP_K=10 npm run bench:retrieval

# Side-by-side comparison: ollama vs onnx (two runs, no rerank).
npm run bench:retrieval:compare

# Rerank matrix: all 4 combinations (ollama±rerank, onnx±rerank).
# Explicitly forces provider env vars so .env overrides can't bleed in.
npm run bench:retrieval:rerank
RERANK_PREFETCH_MULT=8 npm run bench:retrieval:rerank
```

Prerequisites: `QDRANT_URL` and `QDRANT_KEY` must be set in `.env` or the environment.

## Fixtures

Four Markdown files in `fixtures/docs/`, each covering one semidex subsystem:

| File           | Topic                                      |
|----------------|--------------------------------------------|
| providers.md   | Embedding providers, sparseProvider config |
| qdrant.md      | Qdrant integration, RRF, hybrid search     |
| chunking.md    | Chunking logic, overlap, sentence splitting|
| sync.md        | sync command, backfill, config.json        |

## Queries

`queries.json` supports **v1** (minimal) and **v2** (full) schema. All existing fields remain valid; v2 fields are optional and enable additional metrics when present.

### v1 schema (backward compatible)

```json
{
  "id": "q1",
  "query": "your query here",
  "expected": ["filename.md"],
  "note": "what concept this tests"
}
```

### v2 schema

```json
{
  "id": "q21",
  "type": "exact-token",
  "query": "your query here",
  "expected": ["filename.md"],
  "expectedFiles": ["filename.md"],
  "expectedSections": ["Section heading as chunked"],
  "expectedAllTokens": ["token_must_exist"],
  "expectedAnyTokens": ["config.json", "hashed-tf"],
  "note": "what concept this tests"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier shown in output |
| `type` | no | Query category: `exact-token`, `paraphrase`, `mixed-lang`, `chunk-level`, `negative` |
| `query` | yes | The search query text |
| `expected` | yes (v1) | File names — v1 backward-compat field; used if `expectedFiles` absent |
| `expectedFiles` | no | File names that must appear in top-K results |
| `expectedSections` | no | Section headings (exact match as indexed) — enables `sectionHit@K` |
| `expectedAllTokens` | no | Tokens that ALL must appear in a matching chunk — enables `tokenHit@K`. Multi-part values like `"config.json"` are split automatically: `["config","json"]` |
| `expectedAnyTokens` | no | At least ONE of these tokens must appear alongside `expectedAllTokens` |
| `shouldHaveNoStrongHit` | no | `true` for negative queries — excluded from Recall/MRR, counted as `negativePassRate` |

**sectionHit@K** and **tokenHit@K** are scoped to chunks from `expectedFiles` only — a tok ✓ means the token appeared in a chunk from the correct file, not any chunk in top-K.

## Adding queries

Preferred: use v2 schema with `expectedSections` and `expectedAllTokens` filled in. Keep `expected` for v1 compat. Tokens in `expectedAllTokens`/`expectedAnyTokens` are normalised through the same tokeniser as the reranker — `"config.json"` → `["config","json"]`, so write multi-word terms as single strings and they will be split automatically.

For **negative queries** (queries that should return no strong hit):

```json
{
  "id": "q47",
  "type": "negative",
  "query": "де semidex налаштовує postgres connection pool",
  "expectedFiles": [],
  "expectedAllTokens": ["postgres"],
  "shouldHaveNoStrongHit": true,
  "note": "semidex has no postgres; should not return a confident hit"
}
```

Negative queries are evaluated separately as `negativePassRate`. A negative query passes if `expectedAllTokens` do not appear in the top-1 result's text/section.

## Latest results

**2026-05-09 · 4 fixtures · 20 queries · Top-K 5**

| Metric        | ollama + hashed-tf | bge-m3-onnx         | Δ                  |
|---------------|--------------------|---------------------|--------------------|
| Recall@1      | 90% (18/20)        | **95% (19/20)**     | +5.0 pp            |
| Recall@5      | 100%               | 100%                | —                  |
| MRR           | 0.938              | **0.975**           | +0.037             |
| Avg query ms  | 162 ms             | **88 ms**           | −45.7% (~1.8×)     |

Per-query breakdown (rank of first expected file):

| ID  | Query (truncated)                          | Expected     | ollama | onnx |
|-----|--------------------------------------------|--------------|--------|------|
| q1  | де налаштовується sparseProvider           | providers.md | #1 ✓  | #1 ✓ |
| q2  | як перемкнутися на ONNX без Ollama         | providers.md | #2 ✗  | #2 ✗ |
| q3  | як працює RRF k параметр                   | qdrant.md    | #1 ✓  | #1 ✓ |
| q4  | чому hybridSearch падає без sparse         | qdrant.md    | #1 ✓  | #1 ✓ |
| q5  | чому overlap не між секціями               | chunking.md  | #1 ✓  | #1 ✓ |
| q6  | чому фінальний чанк губиться               | chunking.md  | #1 ✓  | #1 ✓ |
| q7  | що робить npm run sync                     | sync.md      | #1 ✓  | #1 ✓ |
| q8  | коли запускати sync після апгрейду         | sync.md      | #1 ✓  | #1 ✓ |
| q9  | valid provider combinations for embedding  | providers.md | #1 ✓  | #1 ✓ |
| q10 | reindex discriminators provider change     | providers.md | #1 ✓  | #1 ✓ |
| q11 | HYBRID_PREFETCH_LIMIT RRF prefetch leg     | qdrant.md    | #1 ✓  | #1 ✓ |
| q12 | як Qdrant зберігає named vectors           | qdrant.md    | #1 ✓  | #1 ✓ |
| q13 | OVERLAP_SENTENCES default value            | chunking.md  | #1 ✓  | #1 ✓ |
| q14 | як pandoc конвертує docx epub              | chunking.md  | #1 ✓  | #1 ✓ |
| q15 | embedding_schema_version payload           | providers.md | #4 ✗  | #1 ✓ |
| q16 | sync backfill logic for missing denseProvider | sync.md   | #1 ✓  | #1 ✓ |
| q17 | коли sync перезаписує provider у config    | sync.md      | #1 ✓  | #1 ✓ |
| q18 | getStoredMeta які поля читає з Qdrant      | qdrant.md    | #1 ✓  | #1 ✓ |
| q19 | splitSentences trailing text без крапки    | chunking.md  | #1 ✓  | #1 ✓ |
| q20 | ONNX_EMBED bge-m3-onnx model download      | providers.md | #1 ✓  | #1 ✓ |

**Misses:**
- **q2** (both): "як перемкнутися на ONNX без Ollama" ranks at #2 for both providers — a
  query formulation issue, not a provider difference. The fixture text discusses ONNX in
  multiple sections that compete with the provider-configuration path.
- **q15** (ollama only): `embedding_schema_version` is a rare technical token. hashed-tf
  assigns it uniform weight and ranks `providers.md` at #4; BGE-M3 neural sparse correctly
  surfaces it at #1. This is the clearest demonstration of neural sparse advantage.

**Conclusion.** On this control corpus, `bge-m3-onnx + bge-m3-onnx` shows better
ranking quality and lower warmed query latency than `ollama + hashed-tf`. This
supports keeping bge-m3-onnx as the recommended provider for quality hybrid
retrieval, especially for Ukrainian/mixed-language queries. `ollama + hashed-tf`
remains a viable fallback when running the ~2.3 GB ONNX model is not practical.

*Note: 20 queries over 4 fixture docs is a regression/health benchmark, not a
scientific corpus evaluation. Treat results as directional signals.*

## Interpreting results

- **Higher Recall@1 and MRR on ONNX** than the default provider suggests ONNX neural
  sparse vectors genuinely improve retrieval for this content type.
- **MRR drop after a code change** is a regression signal — investigate before merging.
- **Latency spike** after switching providers is expected for ONNX (first run downloads
  the model; subsequent runs use the cache in `./models/`).

## Collection

The benchmark uses a dedicated `bench-retrieval` Qdrant collection. It is created
automatically and does not interfere with production collections.
