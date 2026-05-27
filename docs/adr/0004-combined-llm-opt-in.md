# ADR 0004: Combined LLM Context+Tags Mode Opt-In

Status: Accepted

Date: 2026-05-20

## Context

semidex enriches each chunk with two LLM-generated fields before embedding:

- **Context** — a brief situational summary prepended to the chunk text at embed time
- **Tags** — topic labels stored as payload metadata for filter-based retrieval

By default these are generated in two separate Ollama calls per chunk. A combined mode
was designed to handle both in a single call, reducing latency and Ollama API traffic.
The question is whether combined mode is ready to replace the default separate-phase path.

## Decision

`COMBINED_LLM=1` remains opt-in. When enabled, `CONTEXT_MODEL` is used for both context
and tags in a single prompt; `TAG_MODEL` is ignored. The default separate-phase path
(context model + tag model, two calls) remains the conservative production default.

## Rationale

1. **Separate phases are more robust.** The context and tag prompts are structurally
   different. Separate calls allow each to be tuned and retried independently. A combined
   call that partially fails requires more complex recovery logic.

2. **Batch combined mode was unreliable with gemma3:4b.** Multi-chunk combined batching
   produced inconsistent JSON structure with `gemma3:4b`, requiring per-chunk fallback
   which eliminated the latency gain. Per-chunk combined mode is more reliable.

3. **qwen2.5:3b-instruct shows promise.** Benchmarks on custom-50 showed `qwen2.5:3b`
   in combined mode produced well-structured output with better fallback behavior than
   `gemma3:4b`. However, the quality evidence needs more repeated runs across both
   custom-50 and custom-150 before a default change is justified.

4. **Tags are payload metadata, not embedding signal.** Tags are stored as filterable
   payload fields. They are not injected into the embedding prefix. A combined LLM can
   generate both in one pass without changing the embedding semantics.

5. **Parse failure fallback is mandatory.** When the combined LLM output cannot be parsed,
   semidex falls back to the separate path — `addContext` then `addTagsWithModel`, both
   using `CONTEXT_MODEL` (not `TAG_MODEL`). This is implemented in `combined.js` and
   verified, but adds a recovery path that the default separate mode does not need.

## Consequences

- Production indexing: use separate phases (default) unless `COMBINED_LLM=1` is explicitly set.
- When `COMBINED_LLM=1`: set `CONTEXT_MODEL` to the desired model; `TAG_MODEL` is ignored — doctor/indexer warn when it is explicitly set differently from `CONTEXT_MODEL`.
- The combined mode is a valid path for environments with limited Ollama call budget.
- Upgrading combined mode to default requires: repeated quality benchmarks on both custom-50
  and custom-150, and a model recommendation (`qwen2.5:3b-instruct` is the current candidate).
- `BENCH_CONTEXT_POLICY` is a benchmark-only variable; do not use in production.

## Evidence

- [`benchmarks/retrieval/results/2026-05-17-combined-context-tags-feasibility.md`](../../benchmarks/retrieval/results/2026-05-17-combined-context-tags-feasibility.md)
- [`benchmarks/retrieval/results/2026-05-17T2248-combined-llm-live-verification.md`](../../benchmarks/retrieval/results/2026-05-17T2248-combined-llm-live-verification.md)
- [`benchmarks/retrieval/results/2026-05-17T2333-combined-llm-custom50-quality.md`](../../benchmarks/retrieval/results/2026-05-17T2333-combined-llm-custom50-quality.md)
- [`benchmarks/retrieval/results/2026-05-18T0804-combined-llm-custom50-quality.md`](../../benchmarks/retrieval/results/2026-05-18T0804-combined-llm-custom50-quality.md)
- [`benchmarks/retrieval/results/2026-05-18T1010-qwen25-3b-combined-llm-custom50-quality.md`](../../benchmarks/retrieval/results/2026-05-18T1010-qwen25-3b-combined-llm-custom50-quality.md)
- [`benchmarks/retrieval/results/2026-05-18T-custom150-qwen25-combined-quality.md`](../../benchmarks/retrieval/results/2026-05-18T-custom150-qwen25-combined-quality.md)
- [`benchmarks/retrieval/results/2026-05-18-section-window-context-policy.md`](../../benchmarks/retrieval/results/2026-05-18-section-window-context-policy.md)

---

## 2026-05-27 Post-Qrel-Fix Update

The combined-mode decision is confirmed unchanged after the post-qrel-fix benchmark series.

### What changed

Custom-50 qrel `c48` was corrected: the old qrel pointed to the wrong chunk. After
correction, `c48` retrieval is healthy for all combined variants — it was never a
real combined-mode regression. All pre-2026-05-26T1200 combined reports (including
the May-22 alignment reports and May-18 quality runs used in the original Evidence
section above) are now archival; they reflect the stale qrel and must not be used
as current quality evidence.

Empty-section chunks were also removed from fixtures during this period. Corrected
collection point count is 96 (down from 98/101 earlier snapshots).

### Current status (post-qrel-fix)

**COMBINED_LLM remains opt-in only.** `current-minimal` remains the default combined
prompt policy. No production default was changed.

**Remaining hard regressions** (post-qrel-fix baseline, custom-50, ONNX hybrid):

| Model | Hard regressions | chunkRecall@5 Δ | Verdict |
|-------|-----------------|-----------------|---------|
| gemma3:4b | 2 — c35 (source-navigation), c41 (conceptual) | −4.1pp | DEFER |
| qwen2.5:3b-instruct | 1 — c36 (source-navigation) | −2.0pp | DEFER |

**c41 root cause:** context identifier loss in the combined embedding input. The
combined prompt paraphrases away exact tokens (`21`, `stable`, `pre-merge`) that
appear in the chunk's context sentence. The embedding input is `context + "\n\n" +
text`; losing these tokens from context weakens the dense and sparse scores for
`benchmarking.md#1` by ~0.001, which is enough to drop it from rank 5 to rank 6 at
the compressed score boundary. This is a genuine but highly marginal weakness: the
chunk sits at the cr@5 cliff even in baseline. Tags are not the cause — they are
payload-only and not in the embedding input (`src/indexer/index.js:159,205`).

**c35 / c36 (source-navigation):** these are known class weaknesses. Source-navigation
queries rely on exact file-path tokens; combined-mode context tends to paraphrase
these away. Not specific to any one query.

### identifier-preserving policy test

`BENCH_COMBINED_CONTEXT_POLICY=identifier-preserving` was tested across all 50 queries
(post-qrel-fix). The policy instructs the model to preserve exact identifiers
verbatim (env vars, counts, names, paths).

Results: model-specific effect — not safe as a combined default.

| Model | Hard regressions | chunkRecall@5 Δ | c41 outcome |
|-------|-----------------|-----------------|-------------|
| gemma3:4b | 1 (c35 only, c41 recovered) | −2.0pp | ✓ recovered |
| qwen2.5:3b-instruct | 3 (c35, c33 new, c41 worse) | −6.1pp | ✗ not recovered |

**Do not promote `identifier-preserving` as the combined default.** It is harmful for
`qwen2.5:3b-instruct` (hard regressions increase from 1 to 3). It is viable for
`gemma3:4b` only, and only if gemma is eventually promoted as the combined default model.

### Metric interpretation note

MRR@10 and nDCG@10 deltas for combined vs baseline must be read against the documented
noise floor: ±0.030 for MRR and ±0.014 for nDCG (same-index, ONNX, RRF tie-breaking
variance). Deltas within the noise floor are not reliable signal. Use hard regression
count (binary chunkRecall@5 change) as the primary decision criterion.

### Post-qrel-fix canonical reports

- [`benchmarks/retrieval/results/2026-05-27T0000-combined-post-qrel-fix-verification.md`](../../benchmarks/retrieval/results/2026-05-27T0000-combined-post-qrel-fix-verification.md) — post-fix quality matrix + ablation verdict (gemma and qwen)
- [`benchmarks/retrieval/results/2026-05-27T0430-c41-combined-regression-diagnostic.md`](../../benchmarks/retrieval/results/2026-05-27T0430-c41-combined-regression-diagnostic.md) — c41 root cause: context identifier loss confirmed
- [`benchmarks/retrieval/results/2026-05-27T0900-combined-identifier-preserving-policy.md`](../../benchmarks/retrieval/results/2026-05-27T0900-combined-identifier-preserving-policy.md) — identifier-preserving policy test: model-specific, not promoted
- [`benchmarks/retrieval/results/2026-05-27T0802-combined-llm-quality-matrix.md`](../../benchmarks/retrieval/results/2026-05-27T0802-combined-llm-quality-matrix.md) — raw matrix evidence for identifier-preserving run
