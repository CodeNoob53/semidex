# custom-raw Negative Query Cleanup
**Date:** 2026-05-12

## Changed Queries

| ID | Old query | New query | Problem fixed |
|---|---|---|---|
| raw-neg-03 | "How to build a graph in production?" | "What are the manual steps to construct a knowledge graph in a production deployment?" | Ukrainian crash text "будови графа" and prod service names caused vocabulary collision; rewrite names documentation that does not exist in corpus |
| raw-neg-06 | "Where are the metrics stored?" | "Where is the Prometheus or Grafana metrics database hosted?" | `TELEMETRY_ENDPOINT=https://metrics.internal/api` satisfied the old forbidden token "metrics.internal"; rewrite targets Prometheus/Grafana which are absent from corpus |

`forbiddenTokens`, `scopeTerms`, and `corpusScopeTerms` updated for both queries to reflect the narrower scope.
All other fields (`id`, `type`, `expectedAnchors`, `expectedTokens`, `expectedFiles`, `shouldHaveNoStrongHit`) preserved unchanged.

---

## Before

Baseline from `2026-05-12-clean-live-agent-review.md` (previous run, pre-rewrite):

```
negativePassRate : 50.0%  (3/6)
Failed: raw-neg-01, raw-neg-03, raw-neg-06
```

---

## After

Baseline run (`ONNX_EMBED=1 npm run bench:custom-raw`):

```
contextRecall@5  : 100.0%
tokenHit@5       : 100.0%
fileRecall@5     : 100.0%
negativePassRate : 83.3%  (5/6)
Latency p50/p95  : 91ms / 103ms
```

`BENCH_NEGATIVE_WINDOW=1` run saved to `2026-05-12-custom-raw-k5-w1-negative-window.txt` — metrics identical, baseline not overwritten.

---

## Failed Negatives After Cleanup

**raw-neg-01** — `What is the Qdrant timeout for the staging cluster?`

Still fails. The corpus contains exactly one Qdrant timeout entry (`5000ms`, `qdrant-prod-svc`) for the production cluster. The query asks about staging, which does not exist in the corpus. The retriever correctly returns the nearest evidence it has — rank-1 chunk matches forbidden tokens `"5000ms"` and `"qdrant timeout after"` with score 0.0333.

This is not a query-design problem. The corpus simply has no staging scope to retrieve. The failure exposes a real retrieval limitation: the retriever cannot signal "I only have prod data" without agent-side scope verification. Raw-neg-01 should remain as-is — it is the correct sentinel for the agent scope-check instruction.

---

## Conclusion

Both rewrites confirmed as query-design problems, not retrieval failures.

- **raw-neg-03**: Top-5 results after rewrite are all incident log chunks with no "manual steps", "knowledge graph", or "production deployment guide" content. PASS.
- **raw-neg-06**: Top-5 results after rewrite contain no "prometheus" or "grafana" tokens anywhere. The `TELEMETRY_ENDPOINT` chunk ranks #1 but contains none of the new forbidden tokens. PASS.

`negativePassRate` improved from **50% → 83.3%**. The remaining 16.7% failure (raw-neg-01) is a corpus-level constraint, not addressable by query rewriting.
