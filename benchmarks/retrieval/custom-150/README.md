# custom-150 — Tier B In-Domain Validation Benchmark

## Purpose

**Tier B** broader in-domain validation. Sits between the fast dev-regression
loop of `custom-50` (Tier A) and the sealed blind holdout `holdout-50` (Tier C).

This dataset is not blind — it can be inspected, its per-class metrics used for
diagnostics, and fixture docs may be extended to improve corpus coverage.
It is intentionally **not** the primary tuning target. Parameter changes and
guard rules should be validated on `custom-50` first, then confirmed here to
check for class-level generalization.

## Constraints

- **No query-id hardcoding.** Guard rules and retrieval heuristics must not
  reference specific `c150-NNN` IDs. Rules must generalize by query class or
  semantic pattern.
- **Per-query fixes must generalize.** If a fix improves `c150-007` and nothing
  else, it is not a valid fix — it is an overfit. Fixes should be motivated by
  class-level or structural reasoning.
- **No custom-50 verbatim copies.** Queries must not be copied word-for-word
  from `custom-50/queries.json`. Near-paraphrases of custom-50 queries are
  discouraged; prefer structurally distinct queries covering the same class.
- **Qrel quality over quantity.** If a qrel assignment is uncertain, mark it
  with a `note` explaining the uncertainty rather than guessing. Uncertain qrels
  are preferable to confidently wrong ones.

## Size

| State    | Count |
|----------|-------|
| Target   | 150   |
| Initial seed | 30  |

New queries should be added in batches with complete qrel assignments. Do not
add queries with `relevantChunks: []` except for `negative` type queries.

## Fixtures

Reuses shared fixture docs from:
- `benchmarks/retrieval/fixtures/docs/` (shared regression corpus)
- `benchmarks/retrieval/custom-50/fixtures/docs/` (custom-50 own fixtures)

Additional fixtures may be added to `benchmarks/retrieval/custom-150/fixtures/docs/`
as coverage gaps are identified.

## Query Type Taxonomy

| Type | Description |
|------|-------------|
| `exact-token` | Query contains an exact symbol, env-var, or field name that should appear verbatim in the answer chunk |
| `config-env` | About environment variables, config.json fields, or runtime configuration |
| `provider-activation` | How to enable, switch, or configure an embedding provider |
| `source-navigation` | Where is X defined / which file implements Y |
| `conceptual` | What does X do / how does X work (paraphrase-style, no exact token) |
| `troubleshooting` | Error message, failure mode, or debugging scenario |
| `cross-lingual-ua-en` | Ukrainian-language query expected to retrieve English or mixed-language content |
| `english` | English-language query in a primarily Ukrainian benchmark corpus |
| `negative` | Query that should NOT have a strong hit — tests false-positive suppression |
| `window-dependent` | Answer requires reading a neighbor chunk via `qdrant_get_chunk(window=N)` |
| `multi-hop` | Answer requires combining information from two or more distinct chunks |

Priority for class-level diagnosis (highest generalization risk first):
`provider-activation > source-navigation > config-env > troubleshooting > exact-token > cross-lingual-ua-en > conceptual/english`

## Metrics

Same as `custom-50`:
- MRR@10 (primary)
- chunkRecall@5 (gate: ≥ target value defined per run)
- negativePass (gate: 100%)
- nDCG@10, chunkRecall@3, chunkRecall@10 (secondary)
- Per-class breakdown for all types with ≥ 2 queries

## Running

```bash
npm run bench:custom150
BENCH_SKIP_INDEX=1 npm run bench:custom150
BENCH_PROVIDER=onnx npm run bench:custom150
RERANK_ENABLED=1 npm run bench:custom150
```

## Relevance Scale

| Score | Meaning |
|-------|---------|
| 3 | Exact answer — the chunk directly answers the query |
| 2 | Supporting — chunk provides relevant context or partial answer |
| 1 | Same topic — chunk is on-topic but not directly useful |
| 0 | Absent / distractor — not in qrels means rel=0 by default |
