# custom-raw Timeout Ambiguity Test
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")

---

## Results

### Q1 — "What is the configured qdrant_timeout_ms value in the prod config?"

| Rank | Source | Chunk | Score | Contains |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` in JSON config block |
| 2 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #1 | 0.031 | incident resolved log |

- config-dump.txt#0 present: **YES — rank 1**
- incident-log.txt#0 present: **YES — rank 2**
- Careful agent should answer: **10000** (query explicitly names `qdrant_timeout_ms` and "prod config"; rank-1 chunk is the config dump with that exact key)
- Verdict: **CONFIG_CLEAR** — the query's specificity (`qdrant_timeout_ms`, "prod config") is enough to anchor the answer to rank 1. The incident-log chunk at rank 2 contains `5000ms` but a careful agent reading the query should not conflate a WARN log value with a configured setting.

---

### Q2 — "What Qdrant timeout happened in the incident log?"

| Rank | Source | Chunk | Score | Contains |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | OOM/connection timeout filler |

- config-dump.txt#0 present: **YES — rank 2**
- incident-log.txt#0 present: **YES — rank 1**
- Careful agent should answer: **5000ms** (query explicitly names "incident log"; rank-1 chunk is the incident log with the WARN line bearing that value)
- Verdict: **INCIDENT_CLEAR** — "incident log" in the query anchors the answer to rank 1 unambiguously. The config chunk at rank 2 is irrelevant given the stated context.

---

### Q3 — "What is the Qdrant timeout?"

| Rank | Source | Chunk | Score | Contains |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |

- config-dump.txt#0 present: **YES — rank 2**
- incident-log.txt#0 present: **YES — rank 1**
- Careful agent should answer: **ask for clarification**
- Verdict: **AMBIGUOUS** — both chunks rank equally (0.033). The query names no scope (config vs incident, configured vs observed). Rank 1 contains `5000ms` (observed timeout during an OOM incident); rank 2 contains `10000` (configured client timeout). Both are valid answers to the bare question. A careful agent must ask: "do you mean the configured client timeout (10000ms from config) or the timeout observed during the May 10 incident (5000ms from the incident log)?"

---

## Summary

| Query | config-dump#0 | incident-log#0 | Answer | Verdict |
|---|---|---|---|---|
| Q1 — configured qdrant_timeout_ms in prod config | rank 1 | rank 2 | **10000** | CONFIG_CLEAR |
| Q2 — timeout in incident log | rank 2 | rank 1 | **5000ms** | INCIDENT_CLEAR |
| Q3 — What is the Qdrant timeout? | rank 2 | rank 1 | **clarify** | AMBIGUOUS |

---

## Finding

The retriever correctly surfaces both values in all three queries — it has no basis to suppress either, since both are genuinely Qdrant-timeout-related. The disambiguation is entirely query-phrasing dependent:

- Specific queries (Q1, Q2) that name the source context ("prod config", "incident log") are answerable correctly from rank 1 alone.
- The bare query (Q3) produces a tie at rank 1/2 between two different values that mean different things: a runtime failure observation vs a configured client setting. No score signal distinguishes them (both 0.033). An agent that answers without clarifying will be wrong for at least one interpretation.

This confirms that `qdrant_timeout_ms: 10000` and `Qdrant timeout after 5000ms` are a genuine cross-chunk context ambiguity in this corpus — not a distractor pattern. The fixture does not mislabel either value. The ambiguity is inherent to the data and is only resolvable by query scope, not by retriever ranking.
