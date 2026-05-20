# ADR 0003: Rerankers Default-Off

Status: Accepted

Date: 2026-05-20

## Context

After the hybrid RRF baseline was established, several reranking approaches were evaluated:

- Cross-encoder (CE) models via Ollama (`bge-reranker-v2-m3`, `mmarco-mMiniLMv2-L12-H384-v1`)
- CE routing: only rerank when the hybrid top-1 score is below a threshold
- BGE-M3 ColBERT-style late interaction using stored `colbert_vecs`
- ColBERT with no-EOS token policy to reduce tail-token dilution

The question is whether any of these should become the production default for `qdrant_search`.

## Decision

All reranking variants remain disabled by default and benchmark-only. `qdrant_search` does
not apply any reranker unless explicitly wired via a future opt-in flag. The CE pipeline
(`src/core/rerank.js`) exists in the codebase but is not active in the MCP default path.

## Rationale

1. **Ordering regressions.** CE v4 (mmarco-mMiniLMv2) improved aggregate MRR on custom-50
   but introduced ordering regressions on specific query classes. A reranker that improves
   the median while degrading the tail is not suitable as a universal default.

2. **Query-class sensitivity.** CE routing (threshold-gated reranking) showed that the
   right reranker depends on query type (navigational vs. factual vs. exact-token). A
   single routing threshold cannot cover all cases without per-collection tuning.

3. **ColBERT CPU latency.** BGE-M3 `colbert_vecs` are feasible quality-wise, but
   late-interaction MaxSim scoring at CPU inference speed adds significant latency per
   query, making it unsuitable as a default for interactive MCP use.

4. **No-EOS ColBERT showed marginal improvement** over the official token policy on
   custom-50 but still did not clear the acceptance gates with statistical confidence.
   A custom-150 no-EOS run has not been completed.

5. **Reranking as conditional behavior.** The most promising path is conditional / routed
   reranking — only apply when hybrid confidence is low or query type warrants it. This
   requires more benchmark infrastructure than currently exists.

## Consequences

- The hybrid RRF baseline (ADR 0002) remains the production retrieval path.
- `src/core/rerank.js` is maintained for benchmark use but not wired into `qdrant_search`.
- Revisit when: GPU inference becomes available (DML/CUDA), or a routed CE approach
  passes both corpus benchmarks without ordering regressions.
- A future `RERANK=1` opt-in flag is an acceptable extension path.

## Evidence

- [`benchmarks/retrieval/results/2026-05-16-bge-m3-colbert-head-probe.md`](../../benchmarks/retrieval/results/2026-05-16-bge-m3-colbert-head-probe.md)
- [`benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt`](../../benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt)
- [`benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt`](../../benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt)
- [`benchmarks/retrieval/results/2026-05-15-custom50-ce-bench-text.txt`](../../benchmarks/retrieval/results/2026-05-15-custom50-ce-bench-text.txt)
- [`benchmarks/retrieval/results/2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt`](../../benchmarks/retrieval/results/2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt)
- [`benchmarks/retrieval/results/2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt`](../../benchmarks/retrieval/results/2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt)
- [`benchmarks/retrieval/results/2026-05-10-rerank-matrix.txt`](../../benchmarks/retrieval/results/2026-05-10-rerank-matrix.txt)
