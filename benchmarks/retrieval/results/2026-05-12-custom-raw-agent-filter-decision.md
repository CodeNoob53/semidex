# custom-raw Agent Filter Decision Simulation
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")

P1 and P3 share the config-filtered search. P2 and P4 share the incident-filtered search. P5 is unfiltered. Three distinct live MCP calls made.

---

## Summary

| Prompt | Filter applied | source_file used | Answer | Verdict |
|---|---|---|---|---|
| P1 — In raw-config-dump.txt, what is the Qdrant timeout? | YES — explicit filename | raw-config-dump.txt | **10000** | FILTER_DECISION_CONFIG_PASS |
| P2 — In raw-mixed-incident-log.txt, what is the Qdrant timeout? | YES — explicit filename | raw-mixed-incident-log.txt | **5000ms** | FILTER_DECISION_INCIDENT_PASS |
| P3 — In the prod config, what is the Qdrant timeout? | YES — "prod config" → config dump | raw-config-dump.txt | **10000** | FILTER_DECISION_CONFIG_PASS |
| P4 — In the incident log, what is the Qdrant timeout? | YES — "incident log" → incident log | raw-mixed-incident-log.txt | **5000ms** | FILTER_DECISION_INCIDENT_PASS |
| P5 — What is the Qdrant timeout? | NO — no scope given | none | **ask for clarification** | NO_FILTER_CLARIFY_PASS |

---

## P1 — "In raw-config-dump.txt, what is the Qdrant timeout?"

**Filter decision:** Apply `source_file=raw-config-dump.txt` — filename stated explicitly.

| Rank | Source | Chunk | Score | Content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` in timeouts block |
| 2 | raw-config-dump.txt | #1 | 0.016 | ENV_VAR_MOCK filler |
| 3 | raw-config-dump.txt | #2 | 0.016 | ENV_VAR_MOCK filler |
| 4 | raw-config-dump.txt | #3 | 0.016 | JSON service list |
| 5 | raw-config-dump.txt | #5 | 0.016 | JSON service list |

**Answer:** The configured Qdrant timeout in `raw-config-dump.txt` is **10000ms** (`"qdrant_timeout_ms": 10000` in the timeouts block).  
**Verdict: FILTER_DECISION_CONFIG_PASS**

---

## P2 — "In raw-mixed-incident-log.txt, what is the Qdrant timeout?"

**Filter decision:** Apply `source_file=raw-mixed-incident-log.txt` — filename stated explicitly.

| Rank | Source | Chunk | Score | Content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-mixed-incident-log.txt | #4 | 0.033 | OOM/connection timeout filler |
| 3 | raw-mixed-incident-log.txt | #5 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #3 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #2 | 0.031 | OOM/connection timeout filler |

**Answer:** In `raw-mixed-incident-log.txt`, the Qdrant timeout recorded is **5000ms** (`WARN: Qdrant timeout after 5000ms`, 2026-05-10T12:05:00Z).  
**Verdict: FILTER_DECISION_INCIDENT_PASS**

---

## P3 — "In the prod config, what is the Qdrant timeout?"

**Filter decision:** Apply `source_file=raw-config-dump.txt` — "prod config" is unambiguous domain language for the config dump (header: "env dump from prod server"). Same search as P1.

| Rank | Source | Chunk | Score | Content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` in timeouts block |
| 2 | raw-config-dump.txt | #1 | 0.016 | ENV_VAR_MOCK filler |
| 3 | raw-config-dump.txt | #2 | 0.016 | ENV_VAR_MOCK filler |
| 4 | raw-config-dump.txt | #3 | 0.016 | JSON service list |
| 5 | raw-config-dump.txt | #5 | 0.016 | JSON service list |

**Answer:** The Qdrant timeout in the prod config is **10000ms** (`"qdrant_timeout_ms": 10000`).  
**Verdict: FILTER_DECISION_CONFIG_PASS**

---

## P4 — "In the incident log, what is the Qdrant timeout?"

**Filter decision:** Apply `source_file=raw-mixed-incident-log.txt` — "incident log" directly names the incident log file. Same search as P2.

| Rank | Source | Chunk | Score | Content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-mixed-incident-log.txt | #4 | 0.033 | OOM/connection timeout filler |
| 3 | raw-mixed-incident-log.txt | #5 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #3 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #2 | 0.031 | OOM/connection timeout filler |

**Answer:** The Qdrant timeout in the incident log is **5000ms** (`WARN: Qdrant timeout after 5000ms`, 2026-05-10T12:05:00Z).  
**Verdict: FILTER_DECISION_INCIDENT_PASS**

---

## P5 — "What is the Qdrant timeout?"

**Filter decision:** Do not apply a filter — no document scope given.

| Rank | Source | Chunk | Score | Content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |

**Answer:** The corpus contains two Qdrant timeout values in different contexts:
- **10000ms** — configured client timeout (`"qdrant_timeout_ms": 10000` in the prod config dump).
- **5000ms** — timeout observed during the May 10 incident (`WARN: Qdrant timeout after 5000ms` in the incident log).

Could you clarify which you need: the configured setting or the incident observation?  
**Verdict: NO_FILTER_CLARIFY_PASS**

---

## Filter Decision Rules Demonstrated

| Signal in user prompt | Filter applied | Confidence |
|---|---|---|
| Exact filename ("raw-config-dump.txt") | `source_file=<filename>` | Certain |
| Exact filename ("raw-mixed-incident-log.txt") | `source_file=<filename>` | Certain |
| Domain alias ("prod config") | `source_file=raw-config-dump.txt` | High — corpus has one config dump from prod |
| Domain alias ("incident log") | `source_file=raw-mixed-incident-log.txt` | High — corpus has one incident log |
| No scope | No filter; ask for clarification | Required — two valid values at equal rank |

When the user names a document by filename or unambiguous alias, apply `source_file` before searching. When no scope is given, do not invent a filter — surface both values and ask.
