# Retrieval Benchmark

Measures whether semidex can retrieve the correct document for each query.
Runs against a live Qdrant instance; no mocking.

## Metrics

| Metric    | Meaning                                                  |
|-----------|----------------------------------------------------------|
| Recall@1  | Fraction of queries where the correct file is rank #1   |
| Recall@K  | Fraction of queries where the correct file is in top-K (default K=5) |
| MRR       | Mean Reciprocal Rank — average of 1/rank across queries  |
| Avg ms    | Average end-to-end query latency (embed + search)        |

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

8 queries in `queries.json` — 2 per fixture file. Each query has an `expected` list of
source file names that must appear in top-K results for the query to count as a hit.

## Adding queries

Add an entry to `queries.json`:

```json
{
  "id": "q9",
  "query": "your query here",
  "expected": ["filename.md"],
  "note": "what concept this tests"
}
```

The `id` field is used in output; keep it unique. `expected` is a list — a query counts
as a hit if any expected file appears in the ranked results.

## Latest results

**2026-05-09 · 4 fixtures · 8 queries · Top-K 5**

| Metric        | ollama + hashed-tf | bge-m3-onnx        | Δ                  |
|---------------|--------------------|--------------------|--------------------|
| Recall@1      | 88% (7/8)          | **100% (8/8)**     | +12.5 pp           |
| Recall@5      | 100%               | 100%               | —                  |
| MRR           | 0.938              | **1.000**          | +0.062             |
| Avg query ms  | 166 ms             | **92 ms**          | −44.6% (~1.8×)     |

Per-query breakdown (rank of first expected file):

| ID | Query (truncated)                        | Expected     | ollama | onnx |
|----|------------------------------------------|--------------|--------|------|
| q1 | де налаштовується sparseProvider         | providers.md | #1 ✓  | #1 ✓ |
| q2 | як перемкнутися на ONNX без Ollama       | providers.md | #2 ✗  | #1 ✓ |
| q3 | як працює RRF k параметр                 | qdrant.md    | #1 ✓  | #1 ✓ |
| q4 | чому hybridSearch падає без sparse       | qdrant.md    | #1 ✓  | #1 ✓ |
| q5 | чому overlap не між секціями             | chunking.md  | #1 ✓  | #1 ✓ |
| q6 | чому фінальний чанк губиться             | chunking.md  | #1 ✓  | #1 ✓ |
| q7 | що робить npm run sync                   | sync.md      | #1 ✓  | #1 ✓ |
| q8 | коли запускати sync після апгрейду       | sync.md      | #1 ✓  | #1 ✓ |

**q2** is the only split. The query contains specific terms ("ONNX", "Ollama",
"перемкнутися") that appear across multiple fixture files. BGE-M3 neural sparse
weighting ranked the provider-configuration document first; hashed-tf (uniform
term weights, no IDF) could not separate it from competing documents, leaving it
at rank #2.

**Conclusion.** On this control corpus, `bge-m3-onnx + bge-m3-onnx` shows better
ranking quality and lower warmed query latency than `ollama + hashed-tf`. This
supports keeping bge-m3-onnx as the recommended provider for quality hybrid
retrieval, especially for Ukrainian/mixed-language queries. `ollama + hashed-tf`
remains a viable fallback when running the ~2.3 GB ONNX model is not practical.

*Note: 8 queries is a regression/health benchmark, not a scientific corpus
evaluation. Treat results as directional signals, not absolute rankings.*

## Interpreting results

- **Recall@1 < 100%** on the default provider but **Recall@1 = 100%** on ONNX suggests
  ONNX sparse vectors genuinely improve retrieval for this content type.
- **MRR drop after a code change** is a regression signal — investigate before merging.
- **Latency spike** after switching providers is expected for ONNX (first run downloads
  the model; subsequent runs use the cache in `./models/`).

## Collection

The benchmark uses a dedicated `bench-retrieval` Qdrant collection. It is created
automatically and does not interfere with production collections.
