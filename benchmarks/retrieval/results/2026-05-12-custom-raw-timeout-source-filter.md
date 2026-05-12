# custom-raw Timeout Source Filter Disambiguation Test
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")

---

## Summary

| Search | config-dump#0 | incident-log#0 | Agent value | Verdict |
|---|---|---|---|---|
| S1 — unfiltered | rank 2 — `10000` | rank 1 — `5000ms` | clarify | UNFILTERED_AMBIGUOUS |
| S2 — source_file=raw-config-dump.txt | rank 1 — `10000` | absent | **10000** | FILTER_CONFIG_CLEAR |
| S3 — source_file=raw-mixed-incident-log.txt | absent | rank 1 — `5000ms` | **5000ms** | FILTER_INCIDENT_CLEAR |

---

## S1 — Unfiltered: "What is the Qdrant timeout?"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |

- config-dump#0 present: **YES — rank 2**, supports `10000`
- incident-log#0 present: **YES — rank 1**, supports `5000ms`
- Agent value: **ask for clarification** — both values present at identical scores (0.033); no signal to prefer one
- Verdict: **UNFILTERED_AMBIGUOUS**

---

## S2 — Filtered: source_file="raw-config-dump.txt"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 2 | raw-config-dump.txt | #1 | 0.016 | ENV_VAR_MOCK filler |
| 3 | raw-config-dump.txt | #2 | 0.016 | ENV_VAR_MOCK filler |
| 4 | raw-config-dump.txt | #3 | 0.016 | JSON service list |
| 5 | raw-config-dump.txt | #5 | 0.016 | JSON service list |

- config-dump#0 present: **YES — rank 1**, supports `10000`
- incident-log#0 present: **ABSENT** — filter excluded it entirely
- Agent value: **10000** — rank 1 is the config dump with `"qdrant_timeout_ms": 10000` in the timeouts block; score gap to rank 2 (0.033 vs 0.016) is sharp and unambiguous
- Verdict: **FILTER_CONFIG_CLEAR**

The remaining chunks are ENV_VAR_MOCK filler with no timeout content. A reading agent has no reason to look past rank 1.

---

## S3 — Filtered: source_file="raw-mixed-incident-log.txt"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-mixed-incident-log.txt | #4 | 0.033 | OOM/connection timeout filler |
| 3 | raw-mixed-incident-log.txt | #5 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #3 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #2 | 0.031 | OOM/connection timeout filler |

- config-dump#0 present: **ABSENT** — filter excluded it entirely
- incident-log#0 present: **YES — rank 1**, supports `5000ms`
- Agent value: **5000ms** — rank 1 is the incident log with `WARN: Qdrant timeout after 5000ms` (BENCH_ANCHOR: QDRANT_TIMEOUT_LOG); no config values in any returned chunk
- Verdict: **FILTER_INCIDENT_CLEAR**

Note: ranks 2–5 are OOM/connection timeout filler chunks (Java heap space errors, database backend connection timeouts). They are from the same source file and contain "timeout" tokens but no Qdrant-specific timeout value. They do not introduce ambiguity.

---

## Recommendation

When a user names a document, file type, or context ("in the config", "in the incident log", "from the runbook"), agents should apply a `source_file` filter before answering. This converts an ambiguous rank-tied result into a single unambiguous top chunk — as shown by S2 and S3 above, where the cross-file competitor is fully excluded and the score gap to filler chunks becomes clearly visible.

When no document scope is given, agents must not rely on rank to break the tie. The bare query "What is the Qdrant timeout?" ranks both values at 0.033 with no retrievable signal to prefer either. The correct behavior is to surface both values with their source context and ask which the user intended.
