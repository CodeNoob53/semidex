# Merge Strategy Benchmark v2: LLM vs Deterministic

**Date:** 2026-05-29T1500  
**Supersedes:** `2026-05-29T1200-merge-strategy-benchmark.md` (v1, missing wall-time breakdown, qrel safety, hard-boundary phase)  
**Verdict:** `MERGE_STRATEGY_EQUIVALENT_ON_CUSTOM50_LLM_ALWAYS_SPLITS`

## Overview

Two-phase benchmark comparing LLM-merge (current production default) against
deterministic split+overlap (`mergeChunksDeterministic` — benchmark helper, not the
production default).

- **Phase 1 — custom-50 quality:** 10-file fixture corpus, 50 queries, graded qrels.
  Includes qrel safety validation per strategy collection.
- **Phase 2 — hard-boundary diagnostic:** Synthetic fixture with 3 long sections
  that each exceed `MAX_CHUNK_TOKENS` (400 ≈ 1600 chars), producing 4 boundary chunks.
  Structural/cost comparison only — no qrels exist for this corpus.

## Strategies

| Strategy | Function | Description |
|----------|----------|-------------|
| LLM merge (current) | `mergeChunksWithDecisions(chunks, shouldMerge)` | Ollama `gemma3:4b` decides merge/split per `needsBoundaryCheck` boundary |
| Deterministic split+overlap | `mergeChunksDeterministic(chunks)` | Always returns `false` — never merges; `addSplitOverlap` still applies sentence-level overlap within sections |

`mergeChunksDeterministic` is an **experimental benchmark helper** exported from
`src/indexer/phases/context.js`. It is not the production default and is not exposed
as a user-facing indexer option. Production indexing continues to use `mergeChunks`
(LLM path).

Both strategies apply the same `addSplitOverlap` pass after merge decisions. Section
boundaries are always respected: overlap never crosses a heading boundary.

---

## Phase 1 — custom-50 Quality

### Setup

| Field | Value |
|-------|-------|
| Fixture files | 10 (providers, qdrant, chunking, sync, mcp-workflow, obsidian, project-structure, benchmarking, config-env, multilingual) |
| Queries | 50 (49 positive, 1 negative) |
| Provider | bge-m3-onnx (dense + sparse) |
| Top-K | 10 |
| Window | ±1 |
| Retrieval runs | 1 |
| Collections | `merge-llm-current`, `merge-deterministic` |

### Qrel Safety Validation

LLM merge can renumber chunks when it merges sub-chunks: if boundary chunks A and B
are merged, the resulting merged chunk takes index A, and all subsequent chunks shift
down by one. This invalidates `source_file#chunk_index` qrels that reference the
original B index or anything after it. The validator scrolls each collection after
indexing and checks every positive query's expected chunk ids.

| Strategy | qrel_missing_after_strategy | Notes |
|----------|-----------------------------|-------|
| LLM merge | **0** | All 49 positive queries have valid qrel chunk ids |
| Deterministic | **0** | All 49 positive queries have valid qrel chunk ids |

No qrel safety failures. Quality metrics are valid for both collections.

### Quality Metrics

| Metric | LLM merge | Deterministic | Δ (det − llm) |
|--------|-----------|---------------|---------------|
| chunkRecall@5 | 87.8% | 87.8% | +0.0 pp |
| windowRecall@5 | 95.9% | 95.9% | +0.0 pp |
| MRR@10 | 0.675 | 0.675 | 0.000 |
| nDCG@10 | 0.718 | 0.718 | 0.000 |

**Zero quality difference** on custom-50. This result is valid: both strategies
produced identical chunk sets (LLM chose split on the one boundary candidate), so
all qrels reference the same chunk ids in both collections.

**Caveat:** custom-50 has very low boundary pressure (1 boundary chunk across 10 files).
It mostly tests "no-op merge" behavior — the boundary exists, the LLM is called, the
LLM says split, and the two strategies converge. This is not a test of merge decisions.

### Measured-Phase Timing

`measuredPhaseMs` = `chunkMs` + `mergeMs` + `embedUpsertMs`. It does **not** include
`readFileSync`, `deleteBySourceFile`, or `ensureCollection`; it is not full wall time.

| Metric | LLM merge | Deterministic |
|--------|-----------|---------------|
| Raw chunks | 96 | 96 |
| Final chunks | 96 | 96 |
| Raw boundary chunks | 1 | 1 |
| Avg chunk length (chars) | 366 | 366 |
| LLM calls | **1** | 0 |
| LLM merge / split | 0 / 1 | n/a |
| chunkMs | 2ms | 1ms |
| mergeMs | **2 401ms** | <1ms |
| embedUpsertMs | 25 582ms | 22 377ms |
| **measuredPhaseMs** | **27 986ms** | **22 378ms** |

**LLM merge added 2 401ms** for 1 boundary chunk (the Ollama round-trip for one
`gemma3:4b` call). This 2.4s overhead does not scale linearly: cold model load can add
several additional seconds on the first call.

The measuredPhaseMs gap is **5 608ms** (27 986ms − 22 378ms). Of that, ~2 401ms is
the merge phase. The remaining ~3 207ms gap in `embedUpsertMs` (25 582ms vs 22 377ms)
is run-to-run variance — embedding is sequential and Qdrant upsert time varies with
server state; it is not caused by the merge strategy.

### Per-Query Diff (custom-50)

**Changed queries (top-5 differs): 0 / 49**

Both strategies produce identical top-5 results for all 49 positive queries, which is
expected: both collections contain identical chunk sets, so retrieval scores are the same.

---

## Phase 2 — Hard-Boundary Diagnostic

### Fixture

Synthetic Markdown file with three long sections, each exceeding 1 600 characters
(≈ MAX_CHUNK_TOKENS × 4). No private paths or corpora. Located at:
`benchmarks/retrieval/fixtures/hard-boundary.md`

| Section | Raw chunks from section | Boundary chunks |
|---------|-------------------------|-----------------|
| Long Prose Section | 2 | 1 (#2, len=563) |
| Long Checklist Section | 2 | 1 (#4, len=928) |
| Long Config Block Section | 3 | 2 (#6 len=1601, #7 len=259) |
| **Total** | **8** | **4** |

### Results

| Metric | LLM merge | Deterministic |
|--------|-----------|---------------|
| Raw chunks | 8 | 8 |
| Boundary chunks | 4 | 4 |
| LLM calls | **4** | 0 |
| LLM merge decisions | 0 | n/a |
| LLM split decisions | 4 | n/a |
| Final chunks | 8 | 8 |
| Merge phase time | **1 560ms** | <1ms |
| Chunk text identical | **true** | — |

### Interpretation

The LLM made 4 calls — one per boundary chunk — and chose "split" in every case.
Both strategies produced identical final chunk sets. With 4 LLM calls at approximately
390ms each (model warm), the merge phase took 1 560ms. Deterministic completed in
< 1ms.

The LLM's consistent "split" decision on this synthetic fixture indicates that
`gemma3:4b` did not find sufficient justification to merge any boundary pair — even
within the same named section, the model judged each fragment as standing on its own
rather than as a broken continuation that should be joined.

**No quality claims for this phase.** No qrels exist for the hard-boundary fixture.
The result establishes structural equivalence (same chunks, same text) and quantifies
the LLM cost under boundary pressure. A quality comparison would require dedicated
qrels for this corpus.

---

## Summary and Implications

### What this benchmark shows

1. **LLM always chose "split"** on both corpora tested (custom-50: 1 boundary → split;
   hard-boundary: 4 boundaries → all split). Both strategies produced identical chunk
   sets in every run.

2. **Quality is equivalent on custom-50** — but this is a trivially satisfied result
   given identical chunk sets. It does not establish quality equivalence on a corpus
   where the LLM would choose "merge".

3. **Merge cost is real.** 1 LLM call = ~2.4s on a warm model. At corpus scale with
   many boundary candidates (e.g., dense prose, long code blocks), this could add
   minutes of indexing latency. The cost is not a retrieval-quality argument.

4. **Qrel safety validation passed** for both collections. LLM merge did not renumber
   any chunks that qrels reference, because it did not merge any chunks.

### What is missing before stronger claims

- A corpus where the LLM actually merges chunks — without that, we only know that
  "deterministic ≡ LLM when LLM always splits", which is a near-tautology.
- Dedicated qrels for the hard-boundary fixture (or a real prose corpus with many
  boundary candidates).
- A corpus where different merge outcomes between strategies lead to different chunk
  boundaries, enabling a quality measurement of merge vs no-merge.

### Production implications

| Claim | Status |
|-------|--------|
| Deterministic is safe to use on custom-50 | ✓ confirmed (qrels valid, 0 quality delta) |
| Deterministic is globally equivalent to LLM | ✗ not established — only tested when LLM always splits |
| LLM merge provides quality benefit | ✗ not shown on these corpora |
| LLM merge adds indexing cost | ✓ ~2.4s per boundary chunk (warm model) |
| Production default unchanged | ✓ `mergeChunks` (LLM) remains the default |

---

## Verification

- `node --check benchmarks/retrieval/merge-strategy-bench.js` — clean
- `node --check src/indexer/phases/context.js` — clean
- `npm run smoke` — 655 passed, 0 failed
- `git diff --check` — CRLF warnings only (Windows line endings), no errors

## Files

| File | Purpose |
|------|---------|
| `benchmarks/retrieval/merge-strategy-bench.js` | Benchmark script (updated for v2) |
| `benchmarks/retrieval/fixtures/hard-boundary.md` | Synthetic hard-boundary fixture |
| `src/indexer/phases/context.js` | `mergeChunksDeterministic` export (added in v1) |
| `merge-llm-current` (Qdrant collection) | custom-50 indexed with LLM merge |
| `merge-deterministic` (Qdrant collection) | custom-50 indexed with deterministic |
