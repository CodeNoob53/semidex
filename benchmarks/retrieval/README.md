# Retrieval Benchmark

Measures whether semidex can retrieve the correct document for each query.
Runs against a live Qdrant instance; no mocking.

## Metrics

| Metric    | Meaning                                                  |
|-----------|----------------------------------------------------------|
| Recall@1  | Fraction of queries where the correct file is rank #1   |
| Recall@5  | Fraction of queries where the correct file is in top-5  |
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

## Interpreting results

- **Recall@1 < 100%** on the default provider but **Recall@1 = 100%** on ONNX suggests
  ONNX sparse vectors genuinely improve retrieval for this content type.
- **MRR drop after a code change** is a regression signal — investigate before merging.
- **Latency spike** after switching providers is expected for ONNX (first run downloads
  the model; subsequent runs use the cache in `./models/`).

## Collection

The benchmark uses a dedicated `bench-retrieval` Qdrant collection. It is created
automatically and does not interfere with production collections.
