# Entity Boost Benchmark — custom-50

*Generated: 2026-05-27*

**Current status (2026-05-29):** situational benchmark evidence only. The
production opt-in decision was rolled back by
`2026-05-29T0000-entity-boost-production-rollback.md` after hard-technical
validation showed the extractor does not generalize beyond semidex/code-style
documents.

## Purpose

Verify the entity-aware source-navigation MVP (`2026-05-27T1800-entity-aware-source-navigation-mvp.md`):
measure whether bench-only post-RRF entity overlap boost lifts the
source-navigation cliff cases (c35, c36, c37) across a weight sweep and
across 3 fresh reindexes, without introducing new hard regressions.

## Environment

| Item | Value |
|------|-------|
| Embedding provider | bge-m3-onnx (ONNX_EMBED=1) |
| Search mode | hybrid (RRF) + post-RRF entity boost |
| Queries | 49 positive + 1 negative (custom-50 v3 schema) |
| Bench collection | bench-retrieval-custom-50-entity (separate from canonical bench-retrieval-custom-50) |
| TOP_K | 10 |
| ENTITY_BOOST_PREFETCH | 20 |
| Stable ordering | applied (sort-results.js) |
| True baseline | hybridSearch(TOP_K=10) — same RRF pool as run-v3.js; no pool-width confound |

## Commands

```powershell
# Fresh-index baseline (default weight 0.0015)
$env:ONNX_EMBED = "1"
$env:BENCH_PROVIDER = "onnx"
Remove-Item Env:BENCH_SKIP_INDEX -ErrorAction SilentlyContinue
Remove-Item Env:ENTITY_BOOST_WEIGHT -ErrorAction SilentlyContinue
Remove-Item Env:ENTITY_BOOST_PREFETCH -ErrorAction SilentlyContinue
npm run bench:custom50:entity-boost

# Weight sweep (BENCH_SKIP_INDEX=1 — same collection, no reindex)
$env:BENCH_SKIP_INDEX = "1"
foreach ($w in @("0","0.001","0.0015","0.002","0.003","0.005")) {
  $env:ENTITY_BOOST_WEIGHT = $w
  npm run bench:custom50:entity-boost
}

# Reindex stability at weight 0.0015 (3 fresh reindexes)
Remove-Item Env:BENCH_SKIP_INDEX -ErrorAction SilentlyContinue
$env:ENTITY_BOOST_WEIGHT = "0.0015"
npm run bench:custom50:entity-boost   # reindex 1
npm run bench:custom50:entity-boost   # reindex 2
npm run bench:custom50:entity-boost   # reindex 3
```

---

## Fresh-Index Baseline (weight = 0.0015)

| Metric | true baseline (hybridSearch@10) | entity-boost (Δ) |
|--------|--------------------------------|------------------|
| chunkRecall@5  | 89.8% | 91.8% (+2.0pp) |
| chunkRecall@10 | 93.9% | 93.9% (—) |
| nDCG@10        | 0.721 | 0.743 (+0.022) |
| MRR@10         | 0.675 | 0.695 (+0.020) |
| negativePass   | 100%  | 100% (—) |

Source-navigation: c35 ✓, c36 ✓, c37 ✓ (fixed) — **3/3**

New hard regressions: **0**

---

## Weight Sweep (BENCH_SKIP_INDEX=1, same collection)

| Weight | c35 | c36 | c37 | src-nav | new hard reg | chunkRecall@5 | chunkRecall@10 | nDCG@10 | MRR@10 |
|--------|-----|-----|-----|---------|-------------|---------------|----------------|---------|--------|
| 0 (no boost) | ✓ | ✓ | ✗ | 2/3 | 0 | 89.8% | 93.9% | 0.721 | 0.675 |
| 0.001 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.738 | 0.690 |
| 0.0015 (default) | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.743 | 0.695 |
| 0.002 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.743 | 0.695 |
| 0.003 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.745 | 0.699 |
| 0.005 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.752 | 0.709 |

**Threshold:** any weight ≥ 0.001 achieves 3/3 source-navigation. The
minimum effective boost for c37 is very small — c37's overlap=1
(one matching entity token), and its rank-5 score margin is ~0.001 (design
report diagnosis confirmed). Even the smallest boost clears the cliff.

**No new hard regressions at any tested weight.** The boost is additive and
entity overlap is 0 for queries with no entity tokens in the query; those
queries are unaffected.

---

## Reindex Stability at Weight 0.0015 (3 Fresh Reindexes)

| Run | c35 | c36 | c37 | src-nav | new hard reg | chunkRecall@5 | chunkRecall@10 | nDCG@10 | MRR@10 |
|-----|-----|-----|-----|---------|-------------|---------------|----------------|---------|--------|
| Reindex 1 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.743 | 0.695 |
| Reindex 2 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.743 | 0.695 |
| Reindex 3 | ✓ | ✓ | ✓ | 3/3 | 0 | 91.8% | 93.9% | 0.743 | 0.695 |

All metrics bit-identical across 3 fresh reindexes. The stable-ordering fix
(`sort-results.js`) eliminates within-collection variance; reindex variance
(different embedding context → different scores) is now the only source of
run-to-run noise, and at weight 0.0015 it does not affect binary cr@5 on
any query.

---

## Analysis

### Why entity boost works for c37 and not c35/c36 at weight=0

At weight=0 the true baseline is revealed: c35 ✓, c36 ✓, c37 ✗. This
means in this collection/reindex c35 and c36 already pass the baseline
cr@5 boundary; c37 is the sole cliff case. The entity boost lifts c37 by
matching the `npm run bench:custom50` command token (overlap=1) against the
chunk whose `entities.commands` contains it, pushing it from rank 6+ to
rank 5.

At sweep weight=0 (no boost), c35 and c36 happen to already sit at rank ≤5
in this particular reindex. This is consistent with the design report: the
class weakness is that one of the three always sits near the cliff; which
one falls below depends on the reindex. The entity boost adds a deterministic
structural signal that is independent of embedding noise, so it consistently
holds all three above the cliff across reindexes.

### c36 MRR drops at weight ≥ 0.001

c36's eMRR (0.333) is below its baseline bMRR (0.500) at all tested weights.
c36 has overlap=3 (three matching entity tokens: `chunkFile`, `splitSentences`,
`parseMarkdown`). The boost pulls a different chunk — the Source Tree chunk
with all three symbols — ahead of the Key Modules subsection. Both are
relevant (rel=3 in qrels); the reranking changes which one ranks first but
cr@5 remains ✓ because both are in top-5. This is an acceptable MRR trade:
both chunks are correct answers, and the Source Tree chunk (which lists all
three functions together) may be the more complete answer for this query.

### No regressions across entire query set

Entity overlap is 0 for 24 of 49 positive queries. For those queries the
boost is exactly 0 and results are identical to the true baseline. For the 25
queries with overlap ≥ 1, the boost consistently improves or preserves cr@5
— no query flipped from ✓ to ✗ at any tested weight.

---

## Verdict

**ENTITY_BOOST_ACCEPT**

Acceptance criteria from the design report, all met:

1. **Source-navigation cr@5 3/3 across 3 fresh reindexes** — ✓
   c35, c36, c37 all pass at weight 0.0015 in every reindex.

2. **No new hard regressions** — ✓
   Zero ✓→✗ flips at any tested weight (0 through 0.005).

3. **Aggregate stability** — ✓
   chunkRecall@5 ≥ baseline (+2.0pp); chunkRecall@10 unchanged.
   MRR@10 improves in the same-index comparison (+0.020); verdict is
   driven by cr@5 and zero hard regressions.

**Recommended weight: 0.0015 (default).** Works at ≥ 0.001; the default
is conservative and leaves headroom before higher weights could disturb
non-source-navigation queries (though none did through 0.005 in this run).

---

## Caveats

- This benchmark uses a separate collection (`bench-retrieval-custom-50-entity`)
  indexed with entity payload at index time. The production indexer now
  writes entity payload on all new/changed files; existing collections need
  `npm run backfill:entities` (Path B) to gain entity overlap.

- The boost is bench-only. `src/mcp/tools/search.js` is unchanged.
  Entity boost for production MCP requires a separate decision and ADR.

- c36 entity overlap (3 tokens) causes the Source Tree chunk to rank
  above the Key Modules subsection; the MRR difference (0.500 → 0.333)
  is a deterministic rerank tradeoff, not noise. It is an acceptable
  tradeoff because both chunks are rel=3 and cr@5 remains ✓; monitor
  if rank preference between these two chunks matters in a future
  production-scoring context.

- c02, c29, c33 remain ✗ cr@5 at all weights — these are not source-navigation
  queries and have entity overlap=0; the entity boost has no effect on them.
  These are pre-existing baseline misses, unchanged.

---

## Next Action

Entity boost is proven. Decide whether to:

1. **Wire entity boost into production MCP `qdrant_search`** — requires
   ADR update and a change to `src/mcp/tools/search.js`. The recommended
   weight is 0.0015; the boost is additive and zero for queries with no
   entity tokens. Low risk of regression based on this evidence.

2. **Keep as bench-only for now** — current decision boundary. Entity
   payload is already indexed and payload indexes are in place. Production
   scoring is unchanged.

Supporting evidence: `2026-05-27T1800-entity-aware-source-navigation-mvp.md`,
`2026-05-27T1600-source-navigation-entity-chunking-design.md`.
