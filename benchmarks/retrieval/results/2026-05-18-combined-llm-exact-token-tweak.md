# COMBINED_LLM=1 Exact-Token Preservation Tweak — 2026-05-18

## Change

Added explicit tag rules to `buildPrompt()` in `src/indexer/phases/combined.js`:

```
Tag rules:
- PREFER exact technical identifiers from the text: env vars, function names,
  config keys, CLI commands, payload fields, schema fields, file names
  (e.g. "embedding-schema-version", "dense-provider", "npm-run-index",
  "file-hash", "config-json")
- Do NOT replace exact terms with generic paraphrases
  (e.g. keep "reindex" not just "indexing", keep "discriminators" not just "detection")
- Include technical identifiers even if they seem verbose
```

Default pipeline (separate context + tags) unchanged. `COMBINED_LLM=1` remains opt-in.

## Motivation

`c04` (`embedding_schema_version reindex discriminator payload field`) was a confirmed
hard regression in the canonical quality run (`2026-05-17T2333`). Diagnostic
(`2026-05-18T0045`) showed combined tags for `providers.md#5` drifted from
`reindex, npm-run-index, discriminators, file-hash, provider` to `reindex, collection, config-json`,
losing `discriminators` which is an exact query token.

## Results

### Smoke tests

442 passed, 0 failed. Parser and guard behaviour unchanged.

### bench:custom50:combined (`2026-05-18T0804`)

| Metric | Baseline | Combined (tweaked) | Δ | Pre-tweak combined (T2333) Δ |
|--------|----------|--------------------|---|------------------------------|
| MRR@10 | 0.746 | 0.705 | **-0.041** | -0.010 |
| nDCG@10 | 0.772 | 0.755 | -0.018 | -0.009 |
| chunkRecall@5 | 93.9% | 89.8% | -4.1pp | -2.1pp |
| chunkRecall@10 | 95.9% | 98.0% | +2.1pp | -2.1pp |
| negativePass | 100% | 100% | — | — |
| Hard regressions | — | 2 (c04, c41) | — | 2 (c04, c41) |
| Soft regressions | — | 10 | — | 5 |
| Combined fallbacks | — | 1 | — | 1 |

The tweaked run is significantly worse in soft regressions (10 vs 5) and MRR Δ (-0.041 vs -0.010).
c04 remains a hard regression. The aggregate deterioration relative to T2333 is likely LLM
variance in this particular baseline run (baseline MRR 0.746 vs 0.728 in T2333), amplified by
the new prompt changes affecting other queries.

### bench:custom50:diag (`2026-05-18T0812`) — c04 payload after tweak

| Field | Baseline | Combined (tweaked) |
|-------|----------|-------------------|
| tags | `reindex, npm-run-index, discriminators, file-hash, dense-provider, embedding-schema-version` | `reindex, npm-run-index, config-json, file-hash, dense-provider, dense-model, embedding-schema-version` |
| context | details critical config change: altering sparseProvider/denseProvider/… | describes triggers for reindexing collections… |

**Partial improvement:** the tweak successfully preserved `embedding-schema-version`, `dense-provider`,
and `file-hash`. However `discriminators` remains absent — replaced by `config-json` and `dense-model`.
Since `discriminator` is an exact query token with no BM25 equivalent among the combined tags,
`providers.md#5` still drops out of the combined top-10.

c41 was not reproduced as a hard regression in this run (rank 8 baseline, rank 7 combined) —
consistent with it being a borderline/variance case.

## Verdict: prompt-only failed

The model consistently omits `discriminators` from the combined tags despite the explicit instruction
to prefer exact technical identifiers. The word does not appear in the tags or context of any run.
This is a model vocabulary/attention limitation: `discriminators` is used in a technical semidex sense
(config change discriminators that trigger reindex) but the model interprets it generically and
paraphrases it away.

**Recommendation: needs heuristic post-processing.**

The structural fix is to extract exact technical tokens directly from the chunk text and inject them
into the combined tag set after the LLM call, bypassing the model's paraphrase tendency. Specifically:

- Scan chunk text for identifiers matching a pattern (camelCase, snake_case, kebab-case, `npm run *`
  CLI commands, known config key literals).
- Merge extracted tokens into the LLM-generated tag array (normalized to kebab-case), up to the
  TAG_MAX limit.
- This approach is deterministic, does not add an LLM call, and recovers exact-token sparse recall
  without changing the context field.

## Status

- `COMBINED_LLM=1` remains opt-in with caution.
- **Prompt tweak rejected — revert before merge.** It partially improved some individual identifiers
  (`embedding-schema-version`, `dense-provider`, `file-hash` now preserved) but failed to recover
  `discriminators`, did not fix c04, and worsened aggregate metrics (MRR Δ=-0.041 vs -0.010
  pre-tweak, soft regressions 10 vs 5). Net effect is negative.
- c04 regression is not resolved by prompt alone.
- Next step: implement heuristic identifier extraction in `addContextAndTags()` as a post-LLM pass.
