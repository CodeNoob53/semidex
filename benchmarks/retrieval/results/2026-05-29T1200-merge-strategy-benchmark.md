# Merge Strategy Benchmark: LLM vs Deterministic

**Date:** 2026-05-29T1200  
**Verdict:** `MERGE_STRATEGY_EQUIVALENT`

## Setup

| Field | Value |
|-------|-------|
| Benchmark | custom-50 fixture corpus (10 files, 50 queries) |
| Provider | bge-m3-onnx (dense + sparse) |
| Top-K | 10 |
| Window | ±1 |
| Retrieval runs | 1 |
| Collections | `merge-llm-current`, `merge-deterministic` |

## Strategies

| Strategy | Description |
|----------|-------------|
| LLM merge (current) | `mergeChunksWithDecisions(chunks, shouldMerge)` — Ollama `gemma3:4b` decides per boundary |
| Deterministic split+overlap | `mergeChunksWithDecisions(chunks, async () => false)` — never merges; sentence-level overlap still applied via `addSplitOverlap` |

Both strategies use the same `addSplitOverlap` pass: adjacent same-section chunks get a
sentence-level prefix overlap after merge decisions. Section boundaries are always respected.
The only difference is whether `shouldMerge` (LLM) or `() => false` (no merge) is used for
`needsBoundaryCheck` chunks.

## Quality Metrics

| Metric | LLM merge | Deterministic | Δ (det − llm) |
|--------|-----------|---------------|---------------|
| chunkRecall@5 | 87.8% | 87.8% | +0.0 pp |
| windowRecall@5 | 95.9% | 95.9% | +0.0 pp |
| MRR@10 | 0.675 | 0.675 | 0.000 |
| nDCG@10 | 0.718 | 0.718 | 0.000 |

**Zero quality difference** across all four primary metrics.

## Cost Metrics

| Metric | LLM merge | Deterministic |
|--------|-----------|---------------|
| Chunk count | 96 | 96 |
| Avg chunk length (chars) | 366 | 366 |
| LLM calls | 1 | 0 |
| Merge phase time | ~588 ms | <1 ms |

### LLM call detail

Only 1 LLM call was made across all 10 fixture files. It occurred in
`project-structure.md`, which had 1 chunk with `needsBoundaryCheck: true` (a single
section that was split at the sentence level by the chunker). The LLM call returned
"split" (the boundary chunk was not merged), so both strategies produced identical
chunk sets: 96 chunks of identical text. The ~588 ms merge time for the LLM path is
entirely the Ollama round-trip for that one call (model was already warm from prior
runs; first cold load would be much higher).

## Per-query diff

**Changed queries (top-5 differs): 0 / 49**

No query produced a different top-5 result set between the two strategies. This
follows directly from identical chunk sets: when merge decisions produce the same
chunks, the embedding, indexing, and retrieval pipeline is identical.

## Structural analysis

The custom-50 fixture corpus is predominantly well-structured Markdown. Most
sections fit within `MAX_CHUNK_TOKENS` (400), so `chunkSections` emits them as
single chunks with `needsBoundaryCheck: false`. Sub-sentence splitting only occurs
when a section exceeds the token budget, producing `needsBoundaryCheck: true` on
subsequent sub-chunks. In this fixture set, only one such boundary existed
(`project-structure.md`), and the LLM chose not to merge it.

This means the benchmark result is corpus-dependent. On a corpus with more
oversized sections — dense prose, long code blocks — the LLM merge path would see
more boundary candidates and potentially produce fewer, larger chunks. The quality
gap between strategies could differ on such a corpus.

## Verdict

**`MERGE_STRATEGY_EQUIVALENT`** on the custom-50 fixture.

Deterministic split+overlap produces identical quality at essentially zero merge-phase
cost (< 1 ms vs ~588 ms) on this corpus. The LLM merge path is not harmful, but
provides no measurable benefit here because the fixture has very few boundary
candidates and the LLM chose not to merge the one that existed.

## Implications

1. **Production default unchanged.** The LLM merge path remains the production
   default. This benchmark does not provide evidence that deterministic is better —
   only that it is equivalent on this fixture.

2. **Corpus coverage gap.** The fixture is Markdown-heavy with short sections. A
   corpus with long prose sections, dense tabular content, or non-Markdown sources
   would generate more boundary candidates and would be needed to measure a
   meaningful quality difference.

3. **Cost argument for deterministic.** The 588 ms merge time represents 1 Ollama
   call. For a 10 000-chunk corpus with many boundary candidates, the LLM merge path
   could add minutes of indexing latency. This is not a retrieval-quality argument.

4. **`mergeChunksDeterministic` is available** as a production-ready export from
   `src/indexer/phases/context.js` for callers that want to skip LLM merge while
   retaining sentence-level overlap.

## Evidence files

- Collections: `merge-llm-current`, `merge-deterministic` (Qdrant, local)
- Script: `benchmarks/retrieval/merge-strategy-bench.js`
- `src/indexer/phases/context.js` — `mergeChunksDeterministic` added in this run
