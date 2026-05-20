# Tag Model Benchmark — Separate Path: qwen2.5:3b-instruct vs gemma3:4b

Date: 2026-05-20
Corpus: README.md, AGENTS.md, docs/en/*.md (semidex self-docs)
Chunk sample: 40 chunks, batch size: 3
Ollama URL: http://localhost:11434

## Executive Summary

Three scenarios were measured on a 40-chunk sample from the semidex self-docs corpus.

- **Scenario A (baseline gemma)**: 2/14 batch fallbacks (14.3%), tag phase 25513 ms
- **Scenario B (same-model qwen)**: 6/14 batch fallbacks (42.9%), tag phase 87986 ms
- **Scenario C (split-model qwen-tags)**: 5/14 batch fallbacks (35.7%), tag phase 38747 ms

qwen2.5:3b fallback rate was **higher** than gemma3:4b on this sample.

**Important:** Default hybrid RRF retrieval is tag-agnostic. Tag quality differences affect
`qdrant_find_by_tag`, `qdrant_search(tags=[...])` filters, and deterministic reranker tag boosts only.
Context model differences (Scenario B vs A) would affect retrieval quality via the embedding
prefix — but this benchmark does not run a retrieval quality evaluation (custom-50 indexing
does not use context/tags). See recommendation section for guidance.

## Method

Each scenario:
1. Collects 40 chunks from the semidex self-docs corpus (chunking phase only)
2. Runs context generation per chunk using the scenario's CONTEXT_MODEL
3. Runs tag generation in batches of 3 using the scenario's TAG_MODEL
4. Counts batch parse failures (triggering per-chunk fallback)
5. Measures wall-clock time for context phase and tag phase separately

**What this does NOT measure:**
- Retrieval quality (custom-50 benchmark indexes without context/tags — embedding-only)
- Full production indexing (no Qdrant upsert, no embedding, no linking)
- Resource contention under concurrent load (single sequential Ollama calls)
- Model warm-up time (first Ollama call includes model load; subsequent calls do not)

## Scenario Matrix

| ID | Label | CONTEXT_MODEL | TAG_MODEL | Notes |
|----|-------|---------------|-----------|-------|
| A | baseline gemma | gemma3:4b | gemma3:4b | Current production default |
| B | same-model qwen | qwen2.5:3b-instruct | qwen2.5:3b-instruct | Both phases use qwen; context quality changes |
| C | split-model qwen-tags | gemma3:4b | qwen2.5:3b-instruct | Context unchanged; only tag model changes; resource-contention risk |

## Indexing Performance Results

Corpus: 40 chunks, LLM_BATCH_SIZE=3

| Scenario | Context model | Tag model | Context ms | Tag ms | Total ms | Chunks/s (tag) |
|----------|---------------|-----------|-----------|--------|----------|----------------|
| A: baseline gemma | gemma3:4b | gemma3:4b | 30967 | 25513 | 56480 | 1.57 |
| B: same-model qwen | qwen2.5:3b-instruct | qwen2.5:3b-instruct | 24868 | 87986 | 112854 | 0.45 |
| C: split-model qwen-tags | gemma3:4b | qwen2.5:3b-instruct | 30984 | 38747 | 69731 | 1.03 |

Note: Context ms includes model warm-up for the first scenario's first call.
Scenario B context ms includes qwen warm-up; Scenario C context ms may be lower if gemma is still warm.

## Tag Parse / Fallback Results

| Scenario | Tag model | Batches attempted | Fallbacks | Fallback rate | Individual calls (fallback) |
|----------|-----------|-------------------|-----------|---------------|-----------------------------|
| A: baseline gemma | gemma3:4b | 14 | 2 | 14.3% | ~6 |
| B: same-model qwen | qwen2.5:3b-instruct | 14 | 6 | 42.9% | ~18 |
| C: split-model qwen-tags | qwen2.5:3b-instruct | 14 | 5 | 35.7% | ~15 |

**Fallback definition:** The benchmark script mirrors `addTagsBatch` batch prompt/parser:
`generate()` with `format:"json"`, then `extractJsonArray(raw, n)`. A fallback occurs when
the parsed result is null — the batch response could not be decoded into an array of n tag
arrays. Each fallback triggers n individual per-chunk calls (one per chunk in the batch of 3).

**Caveat:** The script is an inline reimplementation, not a direct call to `addTagsBatch`.
The batch prompt matches production exactly. The per-chunk fallback prompt also matches
production `addTagsWithModel` (File/Section/Context/Text fields). Fallback *counts* are
therefore representative; fallback *tag content* for the per-chunk path is production-equivalent.

## Tag Quality Sample

Sample of 3 chunks per scenario — tags shown as generated.

### A: baseline gemma (TAG_MODEL=gemma3:4b)

Valid-format tags: 34/40 chunks
Empty tags: 1, Too few (<3): 5, Too many (>7): 1

| Source | Section | Tags |
|--------|---------|------|
| README.md | semidex | semidex, banner, logo, avif, assets |
| README.md | Contents | node.js, npm, shields, badge, brightgreen |
| README.md | Problems semidex solves | license, mit, ollama, local, llm |

### B: same-model qwen (TAG_MODEL=qwen2.5:3b-instruct)

Valid-format tags: 32/40 chunks
Empty tags: 2, Too few (<3): 18, Too many (>7): 11

**Note:** Scenario B samples show `chunk0a`, `chunk0b`, `tag4a`, `tag4b` — qwen2.5:3b-instruct
returned the example strings from the batch prompt verbatim instead of generating real tags.
This is a distinct failure mode beyond parse failures: the model follows the example format
but copies placeholder labels. These count as valid-format (hyphenated) but are semantically empty.

| Source | Section | Tags |
|--------|---------|------|
| README.md | semidex | chunk0a, chunk0b |
| README.md | Contents | tag4a, tag4b |
| README.md | Problems semidex solves | tag5a,tag5b, tag6a,tag6b |

### C: split-model qwen-tags (TAG_MODEL=qwen2.5:3b-instruct)

Valid-format tags: 36/40 chunks
Empty tags: 3, Too few (<3): 13, Too many (>7): 10

| Source | Section | Tags |
|--------|---------|------|
| README.md | Contents | problems-semidex-solves, quick-start, documentation, how-it-fits-together, recommended-modes, core-commands, supported-formats, roadmap |
| README.md | Problems semidex solves | acknowledgements |
| README.md | Quick Start | chunk0a |

## Retrieval Metrics

**Not measured in this benchmark.**

The custom-50 retrieval benchmark (`run-v3.js`) indexes fixture documents using
`embedForIndex` directly — it does not run the context or tag phases. This means
no retrieval quality difference can be attributed to TAG_MODEL changes in custom-50.

Context model differences (Scenario B: qwen context vs Scenario A: gemma context)
**would** affect retrieval quality in production indexing, because context is
prepended to the embedding text (`context\n\nchunk_text`). A retrieval quality
comparison between gemma and qwen as CONTEXT_MODEL would require:
1. Full production reindex of custom-50 with each CONTEXT_MODEL setting
2. Running `npm run bench:custom50 BENCH_SKIP_INDEX=1` against each indexed collection
3. Comparing MRR@10 / nDCG@10 / chunkRecall across collections

This is a separate task from tag model evaluation and is not covered here.

## Resource Contention Discussion

### Scenario C: split-model (gemma context + qwen tags)

When CONTEXT_MODEL ≠ TAG_MODEL, Ollama must serve two different models in the same
indexing run. The context and tag phases are sequential (not concurrent), so Ollama
does not run both simultaneously. However:

- **Model swap latency**: If Ollama cannot hold both models in VRAM/RAM simultaneously,
  it unloads gemma3:4b after the context phase and loads qwen2.5:3b-instruct for tagging.
  This swap adds a one-time load penalty at the start of the tag phase.
- **Memory pressure**: gemma3:4b (~3.3 GB) + qwen2.5:3b-instruct (~1.9 GB) = ~5.2 GB
  combined. Systems with ≤ 8 GB VRAM may not hold both in GPU memory simultaneously,
  forcing CPU inference for the second model or unload/reload cycles.
- **Context phase warm-up**: In Scenario C, the context phase uses gemma (already warm
  from baseline benchmarks). The tag phase must load qwen for the first time, adding
  model load latency to the first batch call — visible in total tag ms.
- **Consecutive-file indexing**: In a real multi-file run, the phase interleaving is:
  `[file1 context] → [file1 tags] → [file2 context] → [file2 tags] → ...`
  Each file alternates between gemma and qwen, potentially causing repeated swap cycles.

### Recommendation for split-model

Do not use split-model (C) unless:
- Both models fit simultaneously in VRAM with no swap penalty
- The tag fallback/latency improvement is clearly visible in the benchmark results above
- The total indexing time for Scenario C is not worse than Scenario A

The measured timing comparison in the table above provides the primary evidence.

## Recommendation

### Decision frame

| Criterion | A (gemma baseline) | B (qwen same-model) | C (qwen tag-only) |
|-----------|-------------------|---------------------|-------------------|
| Tag fallback rate | 14.3% | 42.9% | 35.7% |
| Tag phase ms | 25513 | 87986 | 38747 |
| Context unchanged from A | — | No (qwen context) | Yes (gemma context) |
| Resource contention risk | None | None | Model swap overhead |

**qwen2.5:3b-instruct as same-model (Scenario B): Not recommended based on this sample.**

Fallback rate did not improve (A: 14.3%, B: 42.9%). No tag-phase benefit observed.
Changing CONTEXT_MODEL carries retrieval quality risk without a measurable tagging gain.

**qwen2.5:3b-instruct as TAG_MODEL only (Scenario C): Not recommended based on this sample.**

Fallback rate did not improve (A: 14.3%, C: 35.7%). The resource-contention overhead
of loading two models is not justified without a parsing benefit.

### Current default recommendation

- Keep `gemma3:4b` as default for both CONTEXT_MODEL and TAG_MODEL.
- For large automated runs where tag filters are not needed: use `TAG_GEN=0`.
- For combined-mode (opt-in): `COMBINED_LLM=1 CONTEXT_MODEL=qwen2.5:3b-instruct`
  is supported by earlier combined-mode benchmarks (ADR 0004).
- A full retrieval quality benchmark (custom-50 reindex with qwen CONTEXT_MODEL)
  is required before changing the CONTEXT_MODEL default.

## Evidence

- `src/indexer/phases/tag.js` — `addTagsBatch`, `extractJsonArray`, fallback path
- `src/indexer/phases/context.js` — `addContext`, per-chunk context generation
- [`benchmarks/retrieval/results/2026-05-20-tag-usefulness-audit.md`](2026-05-20-tag-usefulness-audit.md)
- [ADR 0004: Combined LLM Context+Tags Mode Opt-In](../../../docs/adr/0004-combined-llm-opt-in.md)

*Generated: 2026-05-20 by benchmarks/retrieval/tag-model-bench.js*
