# Custom-Raw Benchmark

This suite evaluates semidex's robustness against unstructured, messy, and noisy text. Unlike `custom-large` which relies on well-formatted markdown documents, `custom-raw` uses input that lacks clean paragraphs or headings.

**Characteristics of the fixtures:**
- Mixed languages (Ukrainian and English)
- Stack traces and incident logs
- Unformatted config dumps
- Unstructured agent notes
- Boundary neighbor issues (split sentences)
- Repeated distractors

**Evaluation Goal:**
Verify that semidex retrieval gracefully handles real-world noisy text while avoiding matches with distractors and accurately capturing exact-token queries, paraphrased concepts, and negative exclusions.

## Running

```sh
ONNX_EMBED=1 node benchmarks/retrieval/custom-raw/run.js
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `BENCH_TOP_K` | `5` | Number of results to evaluate |
| `BENCH_CONTEXT_WINDOW` | `1` | ±chunk window for context recall |
| `BENCH_SKIP_INDEX` | `0` | Skip re-indexing (use existing collection) |
| `BENCH_NEGATIVE_WINDOW` | `0` | Append a top-K diagnostic listing all negative queries with every retrieved result. Saves to a separate `-negative-window` file so the baseline is not overwritten. |

## Negative Query Design Principle

Negative queries should test missing evidence, not merely broad vocabulary overlap. If the corpus contains adjacent terms such as `metrics.internal` or `qdrant-prod-svc`, the query should name the missing scope precisely, e.g. `Prometheus metrics database` rather than `metrics`.

## Negative Query Schema

Negative queries (`shouldHaveNoStrongHit: true`) support the following optional fields for scope mismatch analysis:

```json
{
  "id": "raw-neg-01",
  "type": "negative",
  "query": "What is the Qdrant timeout for the staging cluster?",
  "shouldHaveNoStrongHit": true,
  "forbiddenTokens": ["5000ms", "qdrant timeout after"],
  "scopeTerms": ["staging"],
  "corpusScopeTerms": ["prod", "qdrant-prod"]
}
```

- **`forbiddenTokens`** — if any of these substrings appear in the top-K results, the query fails.
- **`scopeTerms`** — terms the query is asking about (e.g., the target environment). Used to detect when a query asks about X but the retrieved evidence is about Y.
- **`corpusScopeTerms`** — terms present in the corpus that are semantically adjacent but out of scope for this query. When `scopeTerms` are absent from top-K results but `corpusScopeTerms` are present, the failure is labelled a scope mismatch.

## Failed Negative Diagnostics

When a negative query fails, the report includes per-offending-result detail:

```
--- Failed Negative Queries ---
[raw-neg-01] What is the Qdrant timeout for the staging cluster?
  matched forbidden: 5000ms, qdrant timeout after
  offending result:
    rank: #1
    source_file: raw-mixed-incident-log.txt
    chunk_index: 2
    score: 0.8231
    snippet: "...WARN: Qdrant timeout after 5000ms. [[BENCH_ANCHOR: QDRANT_TIMEOUT_..."
    match_in_chunk: true
  interpretation: query asks staging, retrieved evidence contains prod, qdrant-prod
```

- **`match_in_chunk: true`** — the forbidden token was found in the chunk's own stored text. `false` would indicate the token was found in a neighbouring context chunk rather than the directly retrieved one (relevant once window-neighbour expansion is added).
- **`interpretation`** — emitted only when a scope mismatch is detected: the query targets a scope absent from the corpus but a semantically adjacent corpus-scope term was retrieved. Tells an AI agent reviewer the false positive is caused by vocabulary overlap, not genuine relevance.

## Negative Top-K Diagnostic (`BENCH_NEGATIVE_WINDOW=1`)

```sh
ONNX_EMBED=1 BENCH_NEGATIVE_WINDOW=1 node benchmarks/retrieval/custom-raw/run.js
```

Saves to `YYYY-MM-DD-custom-raw-k5-w1-negative-window.txt` (never overwrites the baseline). Appends a `--- Negative Top-K Diagnostic ---` section listing every negative query with all top-K results and their scores, files, chunk indices, and text previews. Useful for auditing what the retriever actually returns for negative queries before deciding whether `forbiddenTokens` need tightening or whether the failure is expected scope bleed.
