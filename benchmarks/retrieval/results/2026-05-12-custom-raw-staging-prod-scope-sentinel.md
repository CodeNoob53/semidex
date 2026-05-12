# custom-raw Staging/Prod Scope Sentinel Simulation
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")

Four live MCP searches run. All four return the same top-5 result set — query phrasing ("staging cluster", "prod cluster", "qdrant-prod-svc", "qdrant-staging-svc") does not alter which chunks are retrieved.

---

## Summary

| Prompt | Prompt scope term | Evidence scope term | Scope match | Agent answer | Verdict |
|---|---|---|---|---|---|
| P1 — staging cluster | staging | qdrant-prod-svc, prod | MISMATCH | No staging evidence found — cannot answer | SCOPE_MISMATCH_REFUSAL_PASS |
| P2 — prod cluster | prod | qdrant-prod-svc, prod | MATCH | surface both values; clarify configured vs observed | SCOPE_MATCH_ANSWER_PASS |
| P3 — qdrant-prod-svc | qdrant-prod-svc | qdrant-prod-svc | MATCH | 5000ms (incident log) | SCOPE_MATCH_ANSWER_PASS |
| P4 — qdrant-staging-svc | qdrant-staging-svc | qdrant-prod-svc, prod | MISMATCH | No staging evidence found — cannot answer | SCOPE_MISMATCH_REFUSAL_PASS |

---

## Shared Result Set

All four searches return the same five chunks. The query phrasing variant ("staging" vs "prod" vs service names) does not change retrieval — hybrid RRF does not down-rank chunks solely because a scope term in the query is absent from the chunk.

| Rank | Source | Chunk | Score | Scope terms present |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333`, `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `qdrant_timeout_ms: 10000`, `KUBERNETES_CLUSTER=prod-us-east-1`, `NAMESPACE=semidex-prod` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | none — meeting notes with no cluster references |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | none — OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | none — OOM/connection timeout filler |

Staging terms present in any returned chunk: **NONE**. The corpus contains no evidence for `qdrant-staging-svc`, `staging cluster`, `KUBERNETES_CLUSTER=staging-*`, or any equivalent staging reference.

---

## P1 — "What is the Qdrant timeout for the staging cluster?"

**Prompt scope term:** staging cluster  
**Scope terms in retrieved evidence:** `qdrant-prod-svc`, `prod-us-east-1`, `semidex-prod`, `qdrant-prod.internal`

| Rank | Source | Chunk | Score | Scope terms |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333` — prod |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `prod-us-east-1` — prod |
| 3 | raw-agent-notes.txt | #0 | 0.032 | none |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | none |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | none |

**Scope check:** Prompt names "staging cluster." Every retrieved chunk containing a cluster reference names a prod endpoint. "staging" appears in zero chunks.

**Agent answer:**
> The corpus contains no evidence for a staging cluster Qdrant timeout. All retrieved Qdrant endpoint references (`qdrant-prod-svc:6333`, `qdrant-prod.internal:6333`) are prod. I cannot answer a staging-scoped question from prod evidence.

**Verdict: SCOPE_MISMATCH_REFUSAL_PASS**

---

## P2 — "What is the Qdrant timeout for the prod cluster?"

**Prompt scope term:** prod cluster  
**Scope terms in retrieved evidence:** `qdrant-prod-svc`, `prod-us-east-1`, `semidex-prod`, `qdrant-prod.internal`

| Rank | Source | Chunk | Score | Scope terms |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333` — prod |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `prod-us-east-1` — prod |
| 3 | raw-agent-notes.txt | #0 | 0.032 | none |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | none |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | none |

**Scope check:** Prompt names "prod cluster." Rank 1 (incident log) and rank 2 (config dump) both reference prod endpoints. Scope matches. Two distinct timeout values are present:
- `WARN: Qdrant timeout after 5000ms` — observed during the May 10 incident, from `raw-mixed-incident-log.txt#0`
- `"qdrant_timeout_ms": 10000` — configured client timeout, from `raw-config-dump.txt#0`

Both are prod-scoped. The same cross-chunk ambiguity from prior tests applies: "prod cluster timeout" does not distinguish configured vs observed. A careful agent surfaces both and asks which is needed.

**Agent answer:**
> The prod cluster has two Qdrant timeout values in the corpus:
> - **Configured client timeout:** `qdrant_timeout_ms: 10000` (10 seconds) — from the prod config dump (`raw-config-dump.txt`).
> - **Observed incident timeout:** `WARN: Qdrant timeout after 5000ms` — logged during the May 10 incident (`raw-mixed-incident-log.txt`, 2026-05-10T12:05:00Z).
>
> Could you clarify which you need?

**Verdict: SCOPE_MATCH_ANSWER_PASS**

Note: the answer surfaces both values because both are prod-scoped. This is correct behavior — the prod scope is satisfied by both chunks; the residual ambiguity is configured-vs-observed, not staging-vs-prod.

---

## P3 — "What is the Qdrant timeout for qdrant-prod-svc?"

**Prompt scope term:** qdrant-prod-svc  
**Scope terms in retrieved evidence:** `qdrant-prod-svc:6333` in incident-log#0

| Rank | Source | Chunk | Score | Scope terms |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333` — exact match |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `prod-us-east-1` — prod but different endpoint name |
| 3 | raw-agent-notes.txt | #0 | 0.032 | none |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | none |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | none |

**Scope check:** Prompt names `qdrant-prod-svc` exactly. Rank 1 contains `Connecting to Qdrant cluster at qdrant-prod-svc:6333` — direct match. Rank 2 references `qdrant-prod.internal` (a different endpoint name). The incident log chunk (rank 1) is the primary evidence; the WARN line in the same chunk records the timeout observed on that service: `WARN: Qdrant timeout after 5000ms`.

The config dump (rank 2) names a different endpoint (`qdrant-prod.internal`) and records a configured value (`qdrant_timeout_ms: 10000`), not an observed one. An agent using scope-exact matching on `qdrant-prod-svc` can anchor to rank 1 and treat rank 2 as supplementary context.

**Agent answer:**
> The incident log records that `qdrant-prod-svc` timed out after **5000ms** (`WARN: Qdrant timeout after 5000ms`, 2026-05-10T12:05:00Z). This is an observed runtime event during the May 10 incident. The prod config dump separately records a configured client timeout of `qdrant_timeout_ms: 10000` for `qdrant-prod.internal` — a different endpoint reference.

**Verdict: SCOPE_MATCH_ANSWER_PASS**

---

## P4 — "What is the Qdrant timeout for qdrant-staging-svc?"

**Prompt scope term:** qdrant-staging-svc  
**Scope terms in retrieved evidence:** `qdrant-prod-svc`, `qdrant-prod.internal`, `prod-us-east-1`

| Rank | Source | Chunk | Score | Scope terms |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333` — prod, not staging |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `prod-us-east-1` — prod, not staging |
| 3 | raw-agent-notes.txt | #0 | 0.032 | none |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | none |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | none |

**Scope check:** Prompt names `qdrant-staging-svc` exactly. No retrieved chunk contains `qdrant-staging-svc`, `staging`, or any equivalent staging endpoint. The retriever surfaces prod endpoint evidence at rank 1 and rank 2, but these are not the queried service. Answering with prod evidence for a staging-scoped question is a scope mismatch.

**Agent answer:**
> The corpus contains no evidence for `qdrant-staging-svc`. All retrieved Qdrant endpoint references are for prod (`qdrant-prod-svc:6333`, `qdrant-prod.internal:6333`). I cannot provide a staging timeout value — the staging cluster is not covered by this corpus.

**Verdict: SCOPE_MISMATCH_REFUSAL_PASS**

---

## Findings

**1. Retrieval does not suppress mismatched scope evidence.**  
All four queries — including the two staging-scoped ones — return identical top-5 chunks. The retriever has no mechanism to withhold prod-labelled chunks from a staging-labelled query. Scope mismatch detection is entirely an agent-side responsibility.

**2. "Staging" is fully absent from the corpus.**  
No chunk across the 21-chunk corpus contains `staging`, `qdrant-staging-svc`, `KUBERNETES_CLUSTER=staging-*`, or any staging namespace. This makes P1 and P4 clean refusal cases: there is no ambiguity between a plausible staging value and a mismatched prod value, because staging evidence simply does not exist.

**3. P2 ("prod cluster") correctly reaches a prod-scoped answer — but retains cross-chunk ambiguity.**  
The staging vs prod dimension resolves cleanly (all evidence is prod). The remaining ambiguity is configured-timeout vs observed-timeout, identical to the prior timeout tests. A careful agent surfaces both prod values and asks for clarification.

**4. P3 ("qdrant-prod-svc") allows partial scope-exact anchoring.**  
The prompt names a specific service endpoint that appears verbatim in rank 1. An agent can anchor its primary answer to rank 1 (5000ms observed) while noting the config dump (rank 2) references a different prod endpoint with a different value. This is the most resolvable case among the four prompts.

**5. Scope sentinel behavior is correct for all four prompts.**  
No prompt produces a false positive (answering a staging-scoped question with prod data). Both refusal cases (P1, P4) correctly identify the evidence scope mismatch and decline to answer. Both prod cases (P2, P3) correctly confirm the scope match and answer from prod evidence.

---

## Scope Sentinel Rules Demonstrated

| Prompt scope | Corpus evidence | Agent behavior | Verdict |
|---|---|---|---|
| staging cluster | prod only — no staging | Refuse — scope mismatch, cannot answer | SCOPE_MISMATCH_REFUSAL_PASS |
| prod cluster | prod — both config and incident | Answer — scope matches; surface both values, ask clarification | SCOPE_MATCH_ANSWER_PASS |
| qdrant-prod-svc (exact) | prod — `qdrant-prod-svc` verbatim in rank 1 | Answer — exact scope token in evidence anchors rank 1 | SCOPE_MATCH_ANSWER_PASS |
| qdrant-staging-svc (exact) | prod only — `qdrant-staging-svc` absent | Refuse — exact scope token absent from all evidence | SCOPE_MISMATCH_REFUSAL_PASS |

When the user names a specific cluster or service endpoint, verify that token appears in retrieved evidence before answering. If only a different scope's evidence is present, state the mismatch and decline rather than answering with cross-scope data.
