# custom-raw Negative Answer Regression Check
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=5, window=1, window_format="compact")  
**Source:** current negative queries from benchmarks/retrieval/custom-raw/queries.json (post-cleanup)

Six live MCP searches run, one per negative query.

---

## Summary

| ID | Query | Rank-1 source | Forbidden tokens used in final answer | Scope mismatch | Verdict |
|---|---|---|---|---|---|
| raw-neg-01 | Qdrant timeout for the staging cluster | incident-log#0 | present in retrieved text, withheld | staging absent, prod present | NEGATIVE_SCOPE_SENTINEL_PASS |
| raw-neg-02 | How to configure ColBERT late interaction? | config-dump#0 | NONE — colbert absent from all chunks | colbert absent, bge-m3 present | NEGATIVE_REFUSAL_PASS |
| raw-neg-03 | Manual steps to construct a knowledge graph in prod | incident-log#0 | NONE — absent from all chunks | adjacent vocabulary, no procedure | NEGATIVE_REFUSAL_PASS |
| raw-neg-04 | Token limit of OpenAI GPT-4? | agent-notes#1 | present in corpus (local LLM), withheld | openai/gpt-4 absent, gemma3 present | NEGATIVE_SCOPE_SENTINEL_PASS |
| raw-neg-05 | How to reindex using git status? | agent-notes#1 | NONE — absent from all chunks | git/reindex absent | NEGATIVE_REFUSAL_PASS |
| raw-neg-06 | Where is the Prometheus or Grafana metrics database hosted? | config-dump#0 | NONE — absent from all chunks | metrics.internal present, no Prometheus/Grafana | NEGATIVE_REFUSAL_PASS |

All 6 negative queries pass. 0 false answers. 0 forbidden tokens surfaced in final agent answer.

---

## raw-neg-01 — "What is the Qdrant timeout for the staging cluster?"

**Forbidden tokens:** `5000ms`, `qdrant timeout after`  
**Scope terms:** `staging` | **Corpus scope terms:** `prod`, `qdrant-prod`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `qdrant-prod-svc:6333`, `WARN: Qdrant timeout after 5000ms` |
| 2 | raw-config-dump.txt | #0 | 0.033 | `qdrant-prod.internal:6333`, `qdrant_timeout_ms: 10000`, `KUBERNETES_CLUSTER=prod-us-east-1` |
| 3 | raw-agent-notes.txt | #0 | 0.032 | meeting notes — no scope terms |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #5 | 0.031 | OOM/connection timeout filler |

**Scope check:** Query names "staging cluster." All retrieved Qdrant endpoint evidence is prod (`qdrant-prod-svc`, `qdrant-prod.internal`, `prod-us-east-1`). "staging" appears in zero chunks across the corpus.

**Forbidden token check:** `5000ms` and `qdrant timeout after` both appear in rank-1 chunk text — but the agent must not use them to answer a staging-scoped question. The evidence is prod-labelled; applying it to staging would be a scope mismatch.

**Agent answer:**
> The corpus contains no evidence for a staging cluster Qdrant timeout. All retrieved Qdrant endpoint references are prod (`qdrant-prod-svc`, `qdrant-prod.internal`). I cannot answer a staging-scoped question from prod evidence.

**Verdict: NEGATIVE_SCOPE_SENTINEL_PASS**  
Forbidden tokens present in retrieved text but correctly withheld — scope mismatch prevents answering.

---

## raw-neg-02 — "How to configure ColBERT late interaction?"

**Forbidden tokens:** `colbert`  
**Scope terms:** `colbert` | **Corpus scope terms:** `bge-m3`, `sparse_provider`, `dense_provider`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.033 | `sparse_provider: bge-m3-onnx`, `dense_provider: bge-m3-onnx` |
| 2 | raw-mixed-incident-log.txt | #0 | 0.032 | incident log — no model config |
| 3 | raw-agent-notes.txt | #0 | 0.032 | model alignment note — Qdrant named vectors, no ColBERT |
| 4 | raw-agent-notes.txt | #4 | 0.031 | UI padding filler |
| 5 | raw-agent-notes.txt | #3 | 0.029 | UI padding filler |

**Scope check:** "colbert" appears in zero retrieved chunks. The corpus uses BGE-M3 for both dense and sparse providers; ColBERT is a different late-interaction architecture not present in any fixture file.

**Forbidden token check:** "colbert" absent from all returned text.

**Agent answer:**
> The corpus contains no ColBERT configuration. The indexed provider configuration uses `bge-m3-onnx` for both dense and sparse retrieval (`dense_provider`, `sparse_provider`). There is no ColBERT late interaction setup in this corpus.

**Verdict: NEGATIVE_REFUSAL_PASS**  
Forbidden token fully absent from retrieval. Clean refusal.

---

## raw-neg-03 — "What are the manual steps to construct a knowledge graph in a production deployment?"

**Forbidden tokens:** `manual steps`, `construct a knowledge graph`, `production deployment guide`  
**Scope terms:** `manual steps`, `production deployment`, `knowledge graph` | **Corpus scope terms:** `OOM`, `crash`, `бракує пам'яті`, `побудови графа`, `qdrant-prod-svc`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-mixed-incident-log.txt | #0 | 0.033 | `Критична помилка: бракує пам'яті для побудови графа` (OOM crash during graph build) |
| 2 | raw-mixed-incident-log.txt | #1 | 0.033 | incident resolved filler, OOM errors |
| 3 | raw-mixed-incident-log.txt | #2 | 0.032 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #4 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #3 | 0.030 | OOM/connection timeout filler |

**Scope check:** Adjacent vocabulary is present — "побудови графа" (graph building) appears in the incident log as part of a crash traceback, not a deployment procedure. No chunk contains manual steps, a construction guide, or a production deployment guide. The incident log records an OOM event during graph building, not instructions for how to build a graph.

**Forbidden token check:** `manual steps`, `construct a knowledge graph`, `production deployment guide` — all absent from all returned chunks.

**Agent answer:**
> The corpus contains no manual steps or guide for constructing a knowledge graph in a production deployment. The closest evidence is a crash log entry (`Критична помилка: бракує пам'яті для побудови графа` — "Critical error: out of memory for graph construction") from the May 10 incident. This is a failure report, not a construction procedure.

**Verdict: NEGATIVE_REFUSAL_PASS**  
Corpus scope terms retrieved (OOM, побудови графа) but they describe a crash event, not a construction guide. No forbidden tokens present. Query rewrite successfully isolates missing evidence from adjacent vocabulary.

---

## raw-neg-04 — "What is the token limit of OpenAI GPT-4?"

**Forbidden tokens:** `8k`, `token limit`  
**Scope terms:** `openai`, `gpt-4` | **Corpus scope terms:** `gemma3`, `local`, `llm_model`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-agent-notes.txt | #1 | 0.033 | meeting transcript filler (padding/sidebar discussion) |
| 2 | raw-agent-notes.txt | #5 | 0.032 | meeting transcript filler |
| 3 | raw-mixed-incident-log.txt | #0 | 0.031 | incident log — no LLM model info |
| 4 | raw-agent-notes.txt | #2 | 0.031 | meeting transcript filler |
| 5 | raw-agent-notes.txt | #7 | 0.031 | meeting transcript filler |

**Scope check:** "openai" and "gpt-4" absent from all returned chunks. The phrase "8k token limit of the local LLM" exists in `raw-agent-notes.txt#0` (referencing Gemma3) but that chunk does not appear in the top-5 for this query. Even if it did appear, the 8k limit is attributed to the local LLM (Gemma3/Ollama), not to OpenAI GPT-4 — a careful agent would note the scope mismatch and refuse.

**Forbidden token check:** `8k` and `token limit` absent from all five returned chunks.

**Agent answer:**
> The corpus contains no information about OpenAI GPT-4 or its token limit. The indexed corpus covers a local LLM deployment (Gemma3/Ollama). There is no OpenAI or GPT-4 configuration or documentation in this corpus.

**Verdict: NEGATIVE_SCOPE_SENTINEL_PASS**  
"openai"/"gpt-4" fully absent. The 8k token value exists in the corpus but is for the local LLM — a different scope. Even under a broader search it would not answer a GPT-4-scoped question.

---

## raw-neg-05 — "How to reindex using git status?"

**Forbidden tokens:** `git`, `status`, `reindex`  
**Scope terms:** `git`, `reindex` | **Corpus scope terms:** `indexer`, `sync`, `upsert`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-agent-notes.txt | #1 | 0.033 | meeting transcript — hiring, padding/sidebar |
| 2 | raw-agent-notes.txt | #5 | 0.032 | meeting transcript filler |
| 3 | raw-mixed-incident-log.txt | #0 | 0.031 | incident log — `Indexed 45 files in 12s`, `Starting background sync process` |
| 4 | raw-agent-notes.txt | #2 | 0.031 | meeting transcript filler |
| 5 | raw-agent-notes.txt | #7 | 0.031 | meeting transcript filler |

**Scope check:** "git" and "reindex" absent from all returned chunks. Rank-3 incident log chunk contains "Indexed 45 files" and "sync process" (corpus scope terms) but these refer to the indexer's background sync, not a git-based reindex command. No chunk explains how to trigger reindexing via git status.

**Forbidden token check:** `git`, `status`, `reindex` — all absent from all five returned chunks.

**Agent answer:**
> The corpus contains no documentation on reindexing using git status. The indexed sources cover a background file sync/index process (`Indexed 45 files in 12s`, `background sync process`) but no git integration or git-triggered reindex workflow.

**Verdict: NEGATIVE_REFUSAL_PASS**  
All forbidden tokens absent. No answerable evidence retrieved.

---

## raw-neg-06 — "Where is the Prometheus or Grafana metrics database hosted?"

**Forbidden tokens:** `prometheus`, `grafana`, `metrics database`, `database hosted`  
**Scope terms:** `prometheus`, `grafana`, `metrics database` | **Corpus scope terms:** `metrics.internal`, `TELEMETRY_ENDPOINT`, `telemetry`, `endpoint`

| Rank | Source | Chunk | Score | Relevant content |
|---|---|---|---|---|
| 1 | raw-config-dump.txt | #0 | 0.032 | `TELEMETRY_ENDPOINT=https://metrics.internal/api`, `ENABLE_TELEMETRY=false` |
| 2 | raw-mixed-incident-log.txt | #1 | 0.032 | `Metrics stable` (post-incident recovery line) |
| 3 | raw-mixed-incident-log.txt | #4 | 0.031 | OOM/connection timeout filler |
| 4 | raw-mixed-incident-log.txt | #5 | 0.031 | OOM/connection timeout filler |
| 5 | raw-mixed-incident-log.txt | #0 | 0.031 | incident log — no metrics DB reference |

**Scope check:** "prometheus" and "grafana" absent from all returned chunks. `TELEMETRY_ENDPOINT=https://metrics.internal/api` in rank-1 is a generic telemetry push endpoint; it does not identify a Prometheus or Grafana instance, does not describe a metrics database, and telemetry is disabled (`ENABLE_TELEMETRY=false`). "Metrics stable" in rank-2 is a recovery status line, not a metrics database reference.

**Forbidden token check:** `prometheus`, `grafana`, `metrics database`, `database hosted` — all absent from all five returned chunks.

**Agent answer:**
> The corpus contains no Prometheus or Grafana configuration and no metrics database host. The config dump includes `TELEMETRY_ENDPOINT=https://metrics.internal/api` with telemetry disabled (`ENABLE_TELEMETRY=false`), but this is a generic telemetry endpoint, not a Prometheus or Grafana metrics database.

**Verdict: NEGATIVE_REFUSAL_PASS**  
All forbidden tokens absent. Adjacent telemetry vocabulary retrieved but does not constitute an answer to the query. Query rewrite successfully separates Prometheus/Grafana evidence (absent) from generic metrics/telemetry vocabulary (present).

---

## Findings

**1. All 6 negative queries pass after cleanup.**  
negativePassRate: 6/6 = 100% (agent-answer level). This is an improvement over the pre-cleanup state where raw-neg-03 and raw-neg-06 produced vocabulary collisions that risked false answers.

**2. raw-neg-01 and raw-neg-04 are scope sentinel cases — forbidden tokens exist in corpus but are correctly withheld.**
- raw-neg-01: `5000ms` and `qdrant timeout after` appear in rank-1 text but belong to a prod-scoped event; staging scope mismatch prevents answering.
- raw-neg-04: `8k token limit` exists in corpus but is attributed to the local LLM (Gemma3), not GPT-4; openai/gpt-4 scope absent.

**3. raw-neg-03 now retrieves adjacent vocabulary without risk.**  
The rewritten query ("manual steps to construct a knowledge graph in a production deployment") pulls incident-log chunks containing "побудови графа" — but that is a crash traceback, not a procedure. No forbidden token is in any returned chunk. The rewrite correctly displaced the vocabulary collision.

**4. raw-neg-06 now retrieves only generic telemetry vocabulary.**  
The rewritten query ("Prometheus or Grafana metrics database") retrieves `TELEMETRY_ENDPOINT` and "Metrics stable" — neither of which answers the question or contains a forbidden token. The prior query ("What telemetry metrics does semidex collect?") would have returned this same chunk with a risk of false positive.

**5. raw-neg-02 and raw-neg-05 are clean absent-evidence cases.**  
ColBERT and git-reindex are fully absent from the corpus. Retrieval returns thematically adjacent chunks (model config, indexer log lines) but none contain the queried vocabulary.

---

## Regression Status

| ID | Pre-cleanup verdict | Post-cleanup verdict | Change |
|---|---|---|---|
| raw-neg-01 | NEGATIVE_SCOPE_SENTINEL_PASS | NEGATIVE_SCOPE_SENTINEL_PASS | unchanged — intentional |
| raw-neg-02 | NEGATIVE_REFUSAL_PASS | NEGATIVE_REFUSAL_PASS | unchanged |
| raw-neg-03 | NEGATIVE_AMBIGUOUS (vocabulary collision) | NEGATIVE_REFUSAL_PASS | **fixed by rewrite** |
| raw-neg-04 | NEGATIVE_SCOPE_SENTINEL_PASS | NEGATIVE_SCOPE_SENTINEL_PASS | unchanged |
| raw-neg-05 | NEGATIVE_REFUSAL_PASS | NEGATIVE_REFUSAL_PASS | unchanged |
| raw-neg-06 | NEGATIVE_AMBIGUOUS (vocabulary collision) | NEGATIVE_REFUSAL_PASS | **fixed by rewrite** |

No regressions. Both query rewrites confirmed effective at agent-answer level.
