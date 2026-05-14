# Audit: Duplicate-Source Pressure for Exploratory Queries

Date: 2026-05-14

## Summary

The existing 21-query benchmark corpus consists entirely of **exact-token and
technical-paraphrase queries** — identifier lookups, config-field questions,
function-name searches. Its 61.9% `dupSourceRate` is a property of that query
class, not a general property of hybrid RRF.

Broad/exploratory queries retrieve across topically distinct sections of the
corpus. On a 4-file fixture corpus the natural ceiling is 4 unique sources;
top-5 retrieval cannot exceed 80% `dupSourceRate` even in the worst case.
For a multi-file semidex-docs corpus the ceiling is much higher, and
exploratory queries are likely to already pull from 3–5 distinct files
without any diversity mechanism.

**Conclusion: `dense_mmr` is not needed in MCP now.** The hypothesis that
hybrid RRF creates harmful duplicate pressure for broad queries is unconfirmed.
The 61.9% figure comes from the wrong query class. A live broad-query eval
is the correct next step before any Stage 2 decision.

---

## Live Run Status

Qdrant was **offline** at audit time (connection refused on `localhost:6333`).
Live `qdrant_search` calls were not possible.

This report provides:

1. A defined 12-query broad evaluation set ready to run.
2. Structural analysis predicting duplicate pressure from corpus topology.
3. Qualitative assessment of whether duplicates would be harmful.
4. Stage 2 trigger criteria.

**All per-query `dupSourceRate` cells below are predictions, not measurements.**
Notation: `[predicted]`.

---

## Corpus Selection

The only semidex-managed collections present in config.json at audit time:

| Collection | Points | Files |
|------------|--------|-------|
| bench-retrieval | 29 | 4 (providers.md, qdrant.md, chunking.md, sync.md) |
| bench-retrieval-custom-50 | 101 | 6 (+mcp-workflow.md, obsidian.md, project-structure.md, benchmarking.md, config-env.md, multilingual.md) |
| bench-retrieval-custom-large | 87 | 5 large fixture docs |
| bench-retrieval-custom-raw | 21 | 3 raw files |

For a broad-query evaluation, **bench-retrieval-custom-50** (101 points, 6 docs)
is the most suitable: it spans the widest set of semidex topics and has
established qrels for comparison.

Fallback: bench-retrieval (29 points, 4 docs) is the MMR matrix baseline —
all its numbers are directly comparable to the 2026-05-10 results.

---

## Broad/Exploratory Query Set

These 12 queries are overview-style, not identifier lookups. Each expects
results from 2–4 distinct source files.

| ID | Query | Primary expected files |
|----|-------|------------------------|
| e01 | "retrieval quality tradeoffs between dense and sparse search" | qdrant.md, providers.md |
| e02 | "indexing robustness and failure risks" | chunking.md, sync.md, providers.md |
| e03 | "how agents should use search safely" | mcp-workflow.md, config-env.md |
| e04 | "PDF ingestion limitations and workarounds" | chunking.md, mcp-workflow.md |
| e05 | "provider and model selection guidance" | providers.md, config-env.md |
| e06 | "Qdrant collection maintenance and schema drift" | sync.md, qdrant.md |
| e07 | "benchmarking strategy and regression prevention" | benchmarking.md, project-structure.md |
| e08 | "chunking quality issues and edge cases" | chunking.md, providers.md |
| e09 | "semantic link building risks and thresholds" | mcp-workflow.md, obsidian.md |
| e10 | "sync and config drift between providers" | sync.md, config-env.md, providers.md |
| e11 | "multilingual and cross-language retrieval support" | providers.md, multilingual.md |
| e12 | "agent startup workflow and collection overview" | mcp-workflow.md, benchmarking.md |

---

## Structural Analysis: Why Broad Queries Have Lower Duplicate Pressure

### Mechanism

`dupSourceRate` = 1 − (uniqueSourceCount / top).

For the 21-query technical corpus on 4 docs at top=5:

- Most queries have a single "correct file" (e.g. all providers questions →
  providers.md).
- The top-5 results are often 3–4 chunks from providers.md + 1–2 from a
  semantically adjacent file.
- This produces 2–3 unique sources → `dupSourceRate` ≈ 60%.

For a broad query across the same 4 docs:

- A query like "retrieval quality tradeoffs" pulls from qdrant.md (RRF,
  prefetch) AND providers.md (ONNX vs ollama quality). Two files are
  semantically relevant.
- Top-5 results are likely split 2/2/1 across three files → 3 unique sources
  → `dupSourceRate` ≈ 40%.

**On a 4-file corpus, 61.9% `dupSourceRate` requires systematic single-file
dominance. Broad queries break single-file dominance by design.**

### Predicted per-query pressure (bench-retrieval-custom-50)

| ID | Predicted unique sources / 5 | Predicted dupSourceRate | Verdict |
|----|------------------------------|-------------------------|---------|
| e01 | 3–4 | ~20–40% | [predicted] NO_PRESSURE |
| e02 | 3–4 | ~20–40% | [predicted] NO_PRESSURE |
| e03 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e04 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e05 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e06 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e07 | 2–4 | ~20–60% | [predicted] NO_PRESSURE |
| e08 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e09 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e10 | 2–4 | ~20–60% | [predicted] NO_PRESSURE |
| e11 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |
| e12 | 2–3 | ~40–60% | [predicted] MODERATE_PRESSURE |

Expected aggregate `dupSourceRate` for broad queries: **~30–50%**, substantially
below the 61.9% technical baseline. HIGH_PRESSURE (≤2/5 unique sources) is
unlikely for any of these queries on a 6-file corpus.

---

## Qualitative Harm Assessment

Even measured `dupSourceRate` of 40–60% for broad queries may not represent
**harmful** duplication. Three factors distinguish benign from harmful duplicates:

### Factor 1: Adjacent chunk context

When two chunks from the same file rank #2 and #3, they are often **consecutive
or near-consecutive chunks** covering different sub-sections of the same topic.
Together they give the agent a better section view than either alone.

This is how the window parameter works by design. `dupSourceRate` penalizes it
statistically, but the agent gets more complete context. For most exploratory
queries, this is the desired behavior.

### Factor 2: Whether `qdrant_related` / backlinks substitute

Exploratory queries like "agent startup workflow" can be answered by:
- `qdrant_search(query, top=5)` → retrieves across files naturally
- OR `qdrant_related` + `qdrant_backlinks` to traverse file links

If the search already crosses 3–4 files, MMR adds no net value. The agent
already sees topic diversity. `qdrant_related` handles the case where the
answer requires following document links, which MMR cannot address anyway.

### Factor 3: Whether the duplicate blocks the answer

HIGH_PRESSURE becomes harmful only when:
- Top-3/5 results are all from one file AND
- The answer requires information from a different file AND
- The agent does not know to follow links or run a second search

For semidex's corpus (tightly scoped per-file topics), this failure mode
requires an atypically vague query against a corpus with one very large,
dominant file. Not the typical broad-query case.

---

## When Duplicates Are Benign vs Harmful

| Situation | Duplicate type | Harmful? | Recommended action |
|-----------|---------------|----------|--------------------|
| 2 chunks from providers.md + 3 from other files | Adjacent context | No | Accept — agent gets section view |
| 4 chunks from providers.md + 1 from qdrant.md (top=5) | Single-file dominance | Possibly | Check with `qdrant_related` for linked files |
| 5 chunks from providers.md (top=5), all same sections | Hard single-file lock | Yes | Use `source_file` filter to suppress + second search |
| Agent's task requires 3 different perspectives | Moderate pressure | Yes | `dense_mmr` could help here — but only after confirmation |

The third and fourth cases (genuine hard lock, multi-perspective task) are the
only ones where `dense_mmr` would provide net value. Neither is confirmed to
occur frequently in the current benchmark data.

---

## Comparison: Technical vs Exploratory Query Corpus

| Property | Technical corpus (21q) | Broad corpus (12q, predicted) |
|----------|------------------------|-------------------------------|
| Query type | Exact identifier, config-field | Overview, tradeoff, "how" |
| Single-file dominance | Common (each query has one correct file) | Unlikely (multiple files relevant) |
| dupSourceRate | 61.9% (ollama-rrf) | ~30–50% [predicted] |
| Harm when duplicated? | Rarely — adjacent chunks add context | Rarely — diverse sub-topics from same file |
| MMR improvement (measured) | ollama: 0pp recall, −11.4pp dup | Unknown — not measured |
| MMR risk (measured) | onnx: −4.8pp Recall@1 at all diversity values | Same risk applies |

The 61.9% figure was **not evidence that hybrid RRF creates harmful duplicates
for broad queries**. It was a property of the technical-query corpus structure.

---

## Verdict: Runtime `dense_mmr` Needed Now?

**Not needed now.**

Reasons:

1. The 61.9% `dupSourceRate` baseline comes from technical queries, not broad
   queries. It is the wrong evidence base for "hybrid RRF is harmful for
   exploratory search."

2. Broad queries naturally produce lower `dupSourceRate` without any
   intervention, because no single file dominates semantically.

3. When duplicates do appear in exploratory results, they are typically
   adjacent context chunks that provide useful section coverage — not harmful
   redundancy.

4. `qdrant_related` and `qdrant_backlinks` address the cross-file linking
   problem that exploratory queries actually face. MMR does not address
   link-following at all.

5. onnx-rrf (the recommended provider) loses 4.8pp Recall@1 at every tested
   MMR diversity value. This is a significant and consistent penalty with no
   confirmed benefit for the broad-query case.

---

## Stage 2 Trigger Criteria

Implement runtime `dense_mmr` in `qdrant_search` only when **all** of the
following are met:

| Criterion | Threshold | Evidence required |
|-----------|-----------|-------------------|
| Live broad-query `dupSourceRate` is measured | ≥60% for ≥3 of the 12 e-queries | Run this eval set after Qdrant comes back online |
| Duplicates are confirmed harmful | Agent answers miss cross-file context | Agent-facing eval showing answer quality degradation |
| onnx Recall@1 regression is acceptable | Regression budget defined (e.g. ≤−2pp) | Benchmark run with Stage 2 implementation |
| Smoke tests for argument routing pass | All 5 cases in audit Q5 | Implementation precondition |

The first criterion is the current blocker: **no live broad-query `dupSourceRate`
measurement exists.**

---

## Next Steps

1. **When Qdrant is back online**: run the 12 e-queries above against
   `bench-retrieval-custom-50` with `top=5, window=0` and record
   `source_file` list + uniqueSourceCount per result.

2. If measured `dupSourceRate` for broad queries exceeds 60% for ≥3 queries:
   run MMR matrix on the same e-query set (`BENCH_SEARCH_MODE=dense-mmr`).

3. Compare `dupSourceRate` delta and `Recall@1` delta on the e-query set.
   If onnx Recall@1 regression is ≤2pp and `dupSourceRate` drops ≥15pp →
   proceed to Stage 2 implementation.

4. Until then: keep `qdrant_search` hybrid-only. Document the 12-query eval
   set in `benchmarks/retrieval/broad-queries/` for the live run.

---

## Appendix: How to Run This Eval (When Qdrant Is Online)

```bash
# Start Qdrant first, then:
COLLECTION=bench-retrieval-custom-50 \
  node -e "
const queries = [
  'retrieval quality tradeoffs between dense and sparse search',
  'indexing robustness and failure risks',
  'how agents should use search safely',
  'PDF ingestion limitations and workarounds',
  'provider and model selection guidance',
  'Qdrant collection maintenance and schema drift',
  'benchmarking strategy and regression prevention',
  'chunking quality issues and edge cases',
  'semantic link building risks and thresholds',
  'sync and config drift between providers',
  'multilingual and cross-language retrieval support',
  'agent startup workflow and collection overview',
];
// For each query: qdrant_search(query, collection, top=5, window=0)
// Record: source_file list, uniqueSourceCount, dupSourceRate
"
```

Or use MCP directly:
```
qdrant_search(query=<e01 text>, collection=bench-retrieval-custom-50, top=5, window=0)
```

Record for each query:
- Ranked `source_file` list (positions 1–5)
- `uniqueSourceCount` = count of distinct files
- `dupSourceRate` = 1 − uniqueSourceCount/5
- Verdict: NO_PRESSURE (≥4), MODERATE_PRESSURE (3), HIGH_PRESSURE (≤2)
