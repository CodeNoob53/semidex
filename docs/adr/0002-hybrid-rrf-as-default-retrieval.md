# ADR 0002: Hybrid Dense+Sparse RRF as Default Retrieval

Status: Accepted

Date: 2026-05-20

## Context

semidex stores both dense (semantic) and sparse (exact-token) vectors per chunk. At query
time, several retrieval strategies are possible: dense-only, sparse-only, hybrid RRF,
MMR, or literal full-text search. The MCP `qdrant_search` tool must commit to a default
that works well across the widest query range without per-query tuning.

## Decision

`qdrant_search` always uses hybrid dense+sparse RRF (Reciprocal Rank Fusion). No other
retrieval mode is exposed as a default or MCP parameter. Dense-only fallback and dense MMR
remain internal / benchmark paths. Sparse-only and literal full-text search are not exposed.

## Rationale

1. **Complementary signal.** Dense vectors handle semantic paraphrases ("how do I prune
   stale points" → retrieves docs about `PRUNE_STALE=1`). Sparse vectors handle exact
   technical tokens (env var names, function names, error strings, CLI flags) that a
   dense model may embed into a neighbourhood rather than rank first.

2. **RRF avoids score scale mixing.** Dense cosine similarity and sparse dot product
   operate on incompatible numerical scales. RRF combines rank positions, not raw scores,
   so the fusion is stable without per-collection calibration.

3. **Absolute RRF scores are not confidence.** The typical score range of `0.016–0.033`
   is an artifact of the RRF formula (`1 / (k + rank)`). Users and agents must compare
   rank order and source context, not treat scores as probabilities.

4. **MMR is opt-in, not default.** MMR improves diversity for broad surveys but can demote
   the best single answer for precise technical queries. Audit confirmed it is better as
   an explicit user choice (see evidence).

5. **Literal / full-text search is deferred.** Exact-token lookups are handled by the
   BGE-M3 sparse vectors within the hybrid path. A separate literal search mode has not
   been implemented; exact-string cases that the sparse signal misses are a known gap.

## Consequences

- `qdrant_search` always sends both dense and sparse vectors to Qdrant's hybrid endpoint.
- Agents and users must not interpret low RRF scores as retrieval failure.
- Extending MCP to expose `search_mode` as a user parameter is possible but not currently
  planned — the current default covers the majority of use cases.
- Collections indexed with `ollama` / `hashed-tf` use hashed sparse, which is weaker on
  exact tokens; hybrid RRF still applies but the sparse signal is less reliable.

## Evidence

- [`docs/en/retrieval.md`](../en/retrieval.md) — hybrid search mechanics, RRF score interpretation
- [`benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`](../../benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md)
- [`benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md`](../../benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md)
- [`benchmarks/retrieval/results/2026-05-10-mmr-matrix.txt`](../../benchmarks/retrieval/results/2026-05-10-mmr-matrix.txt)
- [`benchmarks/retrieval/results/2026-05-12-custom-raw-exact-token`](../../benchmarks/retrieval/results/) — exact-token diagnostic series
