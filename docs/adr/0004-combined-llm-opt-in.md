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
