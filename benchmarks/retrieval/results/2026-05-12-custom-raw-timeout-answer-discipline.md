# custom-raw Timeout Answer Discipline Simulation
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")  
**Note:** Evidence is based on the live MCP timeout ambiguity run from the same session.

---

## Summary

| Query | config-dump#0 | incident-log#0 | Expected behavior | Agent answer | Pass/Fail |
|---|---|---|---|---|---|
| Q1 — configured qdrant_timeout_ms in prod config | rank 1 — `10000` | rank 2 — `5000ms` | ANSWER_CONFIG_VALUE | 10000 (configured client timeout) | **PASS** |
| Q2 — timeout in incident log | rank 2 — `10000` | rank 1 — `5000ms` | ANSWER_INCIDENT_VALUE | 5000ms (observed WARN during incident) | **PASS** |
| Q3 — What is the Qdrant timeout? | rank 2 — `10000` | rank 1 — `5000ms` | ASK_CLARIFICATION | Ask for clarification | **PASS** |

---

## Per-Query Detail

### Q1 — "What is the configured qdrant_timeout_ms value in the prod config?"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` in JSON timeouts block |
| 2 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #1 | 0.031 | incident resolved log |

**config-dump#0:** present at rank 1 — supports `10000`  
**incident-log#0:** present at rank 2 — contains `5000ms` but as a runtime WARN, not a config setting

**Final agent answer:**
> The configured `qdrant_timeout_ms` in the prod config is **10000** (10 seconds). Source: `raw-config-dump.txt`, timeouts block: `"qdrant_timeout_ms": 10000`. Note: a separate incident log entry records a `WARN: Qdrant timeout after 5000ms` during the May 10 outage — that is an observed runtime event, not the configured value.

**Behavior:** ANSWER_CONFIG_VALUE — **PASS**  
Query phrasing (`qdrant_timeout_ms`, "prod config") unambiguously targets the config chunk. The incident-log value at rank 2 is correctly set aside.

---

### Q2 — "What Qdrant timeout happened in the incident log?"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | OOM/connection timeout filler |

**config-dump#0:** present at rank 2 — supports `10000` but from a config block, not a log event  
**incident-log#0:** present at rank 1 — supports `5000ms` as a WARN log entry during the May 10 incident

**Final agent answer:**
> During the May 10 incident, the log recorded: `WARN: Qdrant timeout after 5000ms`. Source: `raw-mixed-incident-log.txt`, 2026-05-10T12:05:00Z. The configured client timeout (`qdrant_timeout_ms: 10000`) is a separate config value and should not be conflated with this incident log observation.

**Behavior:** ANSWER_INCIDENT_VALUE — **PASS**  
"Incident log" in the query anchors the answer to rank 1. The config value at rank 2 is contextually excluded.

---

### Q3 — "What is the Qdrant timeout?"

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `"qdrant_timeout_ms": 10000` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | unrelated meeting notes |
| 4 | raw-mixed-incident-log.txt | #4 | 0.032 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #3 | 0.031 | OOM/connection timeout filler |

**config-dump#0:** present at rank 2 — supports `10000` (configured client timeout)  
**incident-log#0:** present at rank 1 — supports `5000ms` (observed timeout during incident)

**Final agent answer:**
> The corpus contains two different Qdrant timeout values that apply in different contexts:
> - **Configured client timeout:** `qdrant_timeout_ms: 10000` (10 seconds) — from the prod config dump.
> - **Observed incident timeout:** `5000ms` — logged as `WARN: Qdrant timeout after 5000ms` during the May 10 outage.
>
> Could you clarify what you are looking for? If you want the configured setting, the answer is 10000ms. If you want what was observed during the incident, the answer is 5000ms.

**Behavior:** ASK_CLARIFICATION — **PASS**  
Neither chunk can be excluded without query scope. Both values are factually correct answers to different interpretations of the bare question.

---

## Finding

**Retrieval score cannot resolve Q3.** Both `raw-mixed-incident-log.txt#0` and `raw-config-dump.txt#0` score identically (0.033) for the bare query "What is the Qdrant timeout?" — RRF fusion has no mechanism to distinguish a runtime observation from a configured setting when the query names neither. The values (`5000ms` and `10000`) are not contradictory; they describe different things. An agent that picks rank 1 without reading context will answer `5000ms` and be wrong for any user asking about the configured timeout. An agent that picks rank 2 will answer `10000` and be wrong for any user asking about the incident. Score gaps, source diversity, and exact-token signals all fail here because both chunks are equally specific to "Qdrant" and "timeout." The only correct behavior is to surface both values, explain the distinction, and ask which context the user meant.
