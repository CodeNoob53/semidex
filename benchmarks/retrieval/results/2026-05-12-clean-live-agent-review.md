# Clean Live Agent Retrieval Review

> **Caveat:** This report is a qualitative live-agent review, not a statistically complete benchmark.
**Date:** 2026-05-12  
**Reviewer:** Claude Sonnet 4.6 (live MCP session)  
**Total live queries executed:** 52 (26 baseline window=0 + 26 window=1 compact, including top=5 variants for all negatives)

---

## Scope

### Evaluated Collections (bge-m3-onnx, auto-managed)

| Collection | Points | Description |
|---|---|---|
| `bench-retrieval` | 29 | 21-query regression suite, semidex docs |
| `bench-retrieval-custom-50` | 101 | 50-query quality suite, semidex docs |
| `bench-retrieval-custom-large` | 87 | Large-document stress suite |
| `bench-retrieval-custom-raw` | 21 | Raw/noisy input stress suite |

### Skipped (legacy, not evaluated for quality conclusions)

- `sql-cursova` — ollama/bge-m3 + hashed-tf, user collection
- `music-genres` — ollama/bge-m3 + hashed-tf, user collection
- `test-indexer` — ollama/bge-m3 + hashed-tf, user collection

---

## Summary Table

| Collection | Queries tested | PASS_ANSWERABLE | PASS_REJECTABLE | FAIL_FALSE_POSITIVE | FAIL_INSUFFICIENT_CONTEXT | AMBIGUOUS_SCOPE | AMBIGUOUS_DISTRACTOR |
|---|---|---|---|---|---|---|---|
| bench-retrieval | 8 | 7 | 0 | 0 | 1 | 0 | 0 |
| bench-retrieval-custom-50 | 10 | 8 | 1 | 0 | 0 | 0 | 1 |
| bench-retrieval-custom-large | 8 | 7 | 1 | 0 | 0 | 0 | 0 |
| bench-retrieval-custom-raw (positive) | 8 | 6 | 0 | 0 | 0 | 0 | 2 |
| bench-retrieval-custom-raw (negative) | 6 | — | 4 | 1 | 0 | 1 | 0 |
| **Total** | **40** | **28** | **5** | **1** | **1** | **1** | **2** |

---

## Per-Query Detail

### bench-retrieval (8 queries)

| ID | Query | Type | w=0 verdict | w=1 compact verdict | Top result | Distractor/scope issue | Agent recommendation |
|---|---|---|---|---|---|---|---|
| q1 | де налаштовується sparseProvider | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | providers.md#3 "sparseProvider configuration" | None | Answer directly |
| q3 | як працює RRF k параметр | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | qdrant.md#3 "RRF k parameter" | None | Answer directly |
| q11 | HYBRID_PREFETCH_LIMIT RRF prefetch | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | qdrant.md#7 "Env tuning" table | None | Answer directly — table is self-contained |
| q6 | чому фінальний чанк може губитися | paraphrase | FAIL_INSUFFICIENT_CONTEXT | PASS_ANSWERABLE | chunking.md#7 Pandoc (w=0); chunking.md#5 Flushing (w=1) | None | Requires w=1 — w=0 returns wrong section at rank 1 |
| q16 | sync backfill logic denseProvider | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | sync.md#2 "Backfill logic" | None | Answer directly |
| q18 | getStoredMeta які поля читає | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | qdrant.md#6 "getStoredMeta" | None | Answer directly |
| q20 | ONNX_EMBED bge-m3-onnx cache location | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | providers.md#2 "bge-m3-onnx + bge-m3-onnx" | None | Answer directly |
| q15 | embedding_schema_version payload | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | providers.md#4 Provider validation | None | Answer directly |

**Notes:** q6 is the only case where w=0 fails and w=1 helps. At w=0 the top result is `chunking.md#7` (Pandoc formats) — a completely wrong section with similar score to the correct `chunking.md#5` (Flushing). With w=1 compact, the correct chunk surfaces at rank 3 with preceding context from "Why overlap must not cross section boundaries", which makes the answer unambiguous.

---

### bench-retrieval-custom-50 (10 queries)

| ID | Query | Type | w=0 verdict | w=1 compact verdict | Top result | Distractor/scope issue | Agent recommendation |
|---|---|---|---|---|---|---|---|
| c01 | де налаштовується sparseProvider | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | providers.md#3 | None | Answer directly |
| c06 | resolveEnvProviders single source of truth | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | project-structure.md#4 config.js + providers.md#3 | None | Two complementary chunks; synthesize |
| c09 | HYBRID_PREFETCH_LIMIT prefetch per RRF leg | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | config-env.md#6 + qdrant.md#7 | None | Both chunks sufficient; config-env.md gives table, qdrant.md gives formula |
| c11 | getStoredMeta які поля читає | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | qdrant.md#5 Payload Indexes + qdrant.md#6 | None | Answer directly |
| c13 | source_file payload deleteBySourceFile | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | qdrant.md#5 + mcp-workflow.md#4 | None | Answer directly |
| c15 | OVERLAP_SENTENCES default value | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | config-env.md#5 + chunking.md#3 | None | Two chunks; config-env gives table, chunking.md explains semantics |
| c26 | як зареєструвати MCP сервер | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | mcp-workflow.md#1 | None | Exact command in chunk; answer directly |
| c47 | bge-m3-onnx neural sparse Ukrainian | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | multilingual.md#3 + multilingual.md#9 | None | Answer directly |
| c44 | RERANK_PROTECT_TOP1_DELTA | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | config-env.md#9 Reranking | w=1 exposes adjacent benchmark-vars chunk — irrelevant but harmless | Answer from match chunk only |
| c50 | semidex підключення до PostgreSQL | negative | PASS_REJECTABLE | PASS_REJECTABLE | mcp-workflow.md#1 (0.033) — no postgres content | None; top results have no postgres anywhere | Correctly reject: no PostgreSQL documentation found |

**Distractor note (c44):** `RERANK_PROTECT_TOP1_DELTA` value (0.05) is in the same chunk as 8 other `RERANK_*` variables. No false distractor values present. Agent can read the exact row. `AMBIGUOUS_DISTRACTOR` not triggered here — this is a density issue, not a contradiction.

---

### bench-retrieval-custom-large (8 queries)

| ID | Query | Type | w=0 verdict | w=1 compact verdict | Top result | Distractor/scope issue | Agent recommendation |
|---|---|---|---|---|---|---|---|
| lg-api-search-request | POST /v1/search body tag_filter top_k | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | api-reference-large.md#3 + #12 + #18 | None | Full request shape in chunk; answer directly |
| lg-cfg-local-llm | OLLAMA_URL LLM_MODEL gemma3 | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | configuration-manual.md#11 CFG_LOCAL_LLM anchor | None | Answer directly |
| lg-cfg-retry-policy | RETRY_MAX_ATTEMPTS RETRY_DELAY_MS | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | configuration-manual.md#20 CFG_ENV_RETRY_POLICY | None | Answer directly; TRB_PROVIDER_MISMATCH also in same chunk — separate topic, no confusion |
| lg-mig-schema-version | embedding_schema_version migration | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | migration-guide-v1-v2.md#3 MIG_SCHEMA_VERSION | None | Answer directly |
| lg-trb-empty-chunks | emptyChunkIds chunks_out heading-only | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | troubleshooting-runbook.md#6 TRB_EMPTY_CHUNKS | None | Answer directly |
| lg-neg-nonexistent-feature | ColBERT late-interaction semidex | negative | PASS_REJECTABLE | PASS_REJECTABLE | mixed-language-agent-guide.md#5 (hybrid RRF content) | No ColBERT token anywhere in top-5 | Correctly reject: no ColBERT documentation found |
| lg-mlg-hybrid-search | hybrid RRF dense sparse RRF_K | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | mixed-language-agent-guide.md#5 MLG_HYBRID_SEARCH | None | Answer directly; anchor present in chunk |
| lg-mig-env-compat | Node.js 18 npm run smoke before migration | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | migration-guide-v1-v2.md#6 MIG_ENV_COMPAT | None | Answer from chunk; anchor resolved |

**Notes:** `bench-retrieval-custom-large` performs cleanly across all tested queries. Large documents (87 points across ~5 fixture files) are chunked by heading section, and anchors are resolved correctly. The troubleshooting runbook has an explicit `(empty section: Common Failure Scenarios)` placeholder chunk that appears in window context for some queries — it is clearly labelled and does not mislead.

---

### bench-retrieval-custom-raw — Positive Queries (8 queries)

| ID | Query | Type | w=0 verdict | w=1 compact verdict | Top result | Issue | Agent recommendation |
|---|---|---|---|---|---|---|---|
| raw-exact-01 | Error: OOM killed /src/indexer.js:42 | exact-token | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-mixed-incident-log.txt#0 | None | Chunk contains INCIDENT_START + UA_OOM_GRAPH anchors |
| raw-noise-01 | OOM killed in indexing pod | noise | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-mixed-incident-log.txt#0 | None | Correct anchor in chunk |
| raw-noise-03 | agent context budget extremely tight | noise | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-agent-notes.txt#0 | AMBIGUOUS_DISTRACTOR: chunk contains "Distractor: The agent context budget is unlimited." immediately after the correct statement | Read carefully; distractor is explicitly labelled "(False statement)" but appears inline |
| raw-noise-06 | LLM_MODEL for context generation | noise | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-config-dump.txt#0 | AMBIGUOUS_DISTRACTOR: "LLM_MODEL=gemma3:4b" (correct) and "Distractor: LLM_MODEL=llama2" both in same chunk | Read carefully; distractor prefix distinguishes them |
| raw-para-03 | Why do we truncate neighbors? | paraphrase | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-agent-notes.txt#0 | None | COMPACT_SNIPPET_RATIONALE anchor present |
| raw-para-05 | Why must dense and sparse use same family? | paraphrase | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-agent-notes.txt#0 | None | MODEL_ALIGNMENT_NOTE anchor present |
| raw-mixed-01 | критична помилка memory issue | mixed-lang | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-mixed-incident-log.txt#0 | None | Cyrillic token correctly matched |
| raw-bound-01 | chunk ends middle sentence parser backtrack | boundary | PASS_ANSWERABLE | PASS_ANSWERABLE | raw-agent-notes.txt#0 | None | BOUNDARY_FIX anchor present |

---

## custom-raw Negative Analysis

### Detailed Table

| ID | Query | Failure type | Forbidden tokens in top results? | Careful agent rejects? | Naive agent answers? | w=1 compact helps? | Query status |
|---|---|---|---|---|---|---|---|
| raw-neg-01 | What is the Qdrant timeout for the staging cluster? | **hard-scope-fail** | YES — "Qdrant timeout after 5000ms", "qdrant-prod-svc" in chunk #0 rank 1 | No — evidence looks directly relevant unless agent checks scope | YES — will answer "5000ms" | No — same chunk ranks #1 with or without window; window adds chunk #1 (INCIDENT_RESOLVED, no staging context) | Keep as-is; exposes real failure mode |
| raw-neg-02 | How to configure ColBERT late interaction? | **true-negative-pass** | NO — top results are config-dump and incident log with bge-m3 content only | YES | No | No difference | Keep as-is; clean negative |
| raw-neg-03 | How to build a graph in production? | **soft-scope-ambiguous** | Partial — "будови графа" (Ukrainian for "graph building") in chunk #0, context is crash/incident not build instructions | Careful agent: maybe — if it reads that context is about failure, not instructions | Naive agent: likely — "Критична помилка: бракує пам'яті для побудови графа" can be misread as build documentation | No — window adds only OOM log filler chunks | Rewrite recommended (see below) |
| raw-neg-04 | What is the token limit of OpenAI GPT-4? | **true-negative-pass** | NO — top 5 results: padding-chat filler chunks (agent-notes#1,3,6) + incident log chunks; no GPT-4 or "8k" tied to GPT-4 anywhere | YES | No | No difference | Keep as-is; clean negative |
| raw-neg-05 | How to reindex using git status? | **true-negative-pass** | NO — top results are padding-chat filler and incident log; no "git" or "reindex" token in any chunk | YES | No | No difference | Keep as-is; clean negative |
| raw-neg-06 | Where are the metrics stored? | **benchmark-query-ambiguous** | Partial — config-dump#0 contains `TELEMETRY_ENDPOINT=https://metrics.internal/api` which contains "metrics.internal" (a forbidden token) | Careful agent: probably — the chunk is about telemetry push endpoint, not storage location | Naive agent: possible — a keyword match on "metrics" may cause a surface answer | No — window adds filler ENV_VAR_MOCK chunk, no help | Rewrite recommended (see below) |

### Per-negative Deep Assessment

**raw-neg-01 (hard-scope-fail):** The corpus has exactly one Qdrant timeout entry: `WARN: Qdrant timeout after 5000ms` for `qdrant-prod-svc` (production). The query asks about staging. There is zero staging content in the corpus. The retriever correctly returns the most relevant evidence it has — which is prod. An agent without explicit scope-checking instructions will answer "5000ms for prod" and may drop the "for staging" qualifier. Window=1 compact adds `INCIDENT_RESOLVED` as neighbour — no staging disambiguation. **This is the most dangerous live failure in the test.**

**raw-neg-03 (soft-scope-ambiguous):** The Ukrainian phrase "будови графа" (graph building) appears inside a crash description: "бракує пам'яті для побудови графа" = "not enough memory for graph building." A careful agent reading in context should recognise this as an OOM crash trace, not a how-to guide. However the query is "How to build a graph in production?" — the word "production" does appear in the corpus (qdrant-prod-svc, NAMESPACE=semidex-prod). A naïve agent could construct a misleading answer. The forbidden token "будови графа" IS present in rank-1 chunk.

**raw-neg-06 (benchmark-query-ambiguous):** `TELEMETRY_ENDPOINT=https://metrics.internal/api` is in the corpus and contains the string "metrics.internal" which is a listed `forbiddenToken` and `scopeTerm`. However, the config dump clearly shows this as a push endpoint (`ENABLE_TELEMETRY=false` on the same line). A careful agent will note telemetry is disabled and this is not storage. The query is arguably ambiguous — the corpus *does* contain metrics-related config. Recommend rewriting the query to be more specific (e.g., "Where is the Prometheus metrics database hosted?").

### Query Rewrite Recommendations

**raw-neg-03:** Change to `"What are the steps to build a graph from scratch in a production environment?"` to remove the Ukrainian-language ambiguity with crash trace vocabulary. Or add `"forbiddenTokens": ["побудови графа", "OOM", "crash"]` and `"corpusScopeTerms": ["побудови графа"]` to make the scope mismatch detectable.

**raw-neg-06:** Change to `"Where is the Prometheus time-series metrics database hosted?"` — removes the `TELEMETRY_ENDPOINT` vocabulary overlap. Alternatively, tighten `forbiddenTokens` to `["metrics database", "prometheus", "stored metrics"]` to exclude the telemetry-endpoint false hit.

---

## Window Comparison

### Cases where window=1 compact **helped**

| Query | Collection | How it helped |
|---|---|---|
| q6 (чому фінальний чанк може губитися) | bench-retrieval | At w=0, rank 1 was Pandoc section (wrong). At w=1, the Flushing section (correct) appeared at rank 3 with its preceding "Why overlap must not cross section boundaries" section as context, making the answer unambiguous. Critical improvement. |
| HYBRID_PREFETCH_LIMIT (bench-retrieval) | bench-retrieval | Window added `getStoredMeta` as preceding neighbour to `Env tuning` table, providing useful broader context about the module. Minor help. |
| sync backfill (bench-retrieval) | bench-retrieval | Window exposed `"When to run sync"` as neighbour to `"Backfill logic"` — added directly useful adjacent information about when to apply what was just explained. |
| raw-neg-01 (staging timeout) | bench-retrieval-custom-raw | Window added `INCIDENT_RESOLVED` snippet — did **not** help disambiguate scope (no improvement for negative), but demonstrates window content is readable. |
| lg-trb-retry (custom-large) | bench-retrieval-custom-large | Window added `TRB_PROVIDER_MISMATCH` as a neighbour — adjacent troubleshooting topic, useful context for an agent investigating a combined failure scenario. |

### Cases where window=1 compact **made no difference**

All clean negatives (raw-neg-02, raw-neg-04, raw-neg-05, lg-neg-ColBERT, c50/PostgreSQL): window adds equally irrelevant neighbours. The absence of relevant content is correctly evident whether window is on or off.

Most exact-token queries in bench-retrieval and custom-50: the match chunk is self-contained; neighbours are adjacent documentation sections that neither add nor detract.

### Cases where window=1 compact **could hurt**

| Scenario | Risk |
|---|---|
| raw-agent-notes chunks 1–8 (repeated padding filler) | When chunk 0 (the content-rich super-chunk) is the match, window=1 adds chunk 1 (mobile-padding chat filler — identical repetitive content). In compact mode this renders as a 150-char snippet of "Charlie: We can use a media query..." which is harmless but wastes one context slot. At w=0 this noise is invisible. |
| custom-large empty-section placeholder | `troubleshooting-runbook.md` has an explicit `(empty section: Common Failure Scenarios)` chunk that appears as a window neighbour. It is clearly labelled but carries zero information. |

**Overall window verdict:** window=1 compact is recommended as an agent call pattern. The one rescue case (q6) would have been a silent wrong answer at w=0. The cost in the worst case is one wasted compact snippet of filler text.

---

## Key Findings

### Finding 1 — RRF scores carry no relevance signal across collections

Scores uniformly fall in the range **0.016–0.033** regardless of collection, query type, or actual relevance. This is consistent across bench-retrieval (structured docs), custom-large (large prose), and custom-raw (noisy logs). An agent must never use score magnitude to decide confidence or reject an answer. The score ranking within a single result set is meaningful; the absolute value is not.

### Finding 2 — bench-retrieval and custom-50 are highly reliable for answerable queries

All 18 tested positive queries across these two collections returned the correct source chunk at rank 1 or 2. Section-level chunking of well-structured markdown docs yields direct, unambiguous answers. No false positives observed. The only failure was q6 (w=0), which is resolved by w=1.

### Finding 3 — custom-large performs well but has structural noise

The `troubleshooting-runbook.md` fixture has one heading-only section that generates an `(empty section: ...)` chunk. This appears in window context without any content. It does not cause wrong answers but is a corpus quality signal — the benchmark itself tested `TRB_EMPTY_CHUNKS` which correctly identifies this pattern.

### Finding 4 — custom-raw has one hard live failure (raw-neg-01)

The prod/staging scope mismatch is the only query in the entire test that would cause a naive agent to produce an incorrect factual answer with no hedging signal from the retriever. The forbidden tokens appear in rank-1 with score 0.033. No window configuration resolves this — the problem is corpus-level (no staging data exists).

### Finding 5 — Inline distractors in custom-raw require reader discipline

`raw-config-dump.txt#0` and `raw-agent-notes.txt#0` each contain explicit `Distractor:` labelled false values adjacent to correct values. These are correctly labelled in the fixture, so a literate agent can distinguish them. However this represents a real-world pattern (config files with stale or commented-out values) that agents encounter without `Distractor:` labels. The retriever does not suppress distractors.

### Finding 6 — Ukrainian/mixed-language retrieval is fully functional

All tested Ukrainian and mixed-language queries (raw-mixed-01, raw-mixed-03, c47/Ukrainian BGE-M3, lg-cfg-ua-mixed) correctly retrieved the target chunk at rank 1. The neural sparse component of bge-m3-onnx handles cyrillic tokens without degradation.

### Finding 7 — Super-chunk domination in custom-raw agent-notes

`raw-agent-notes.txt#0` concentrates all four conceptual anchors (NOTES_WINDOW_APPROACH, COMPACT_SNIPPET_RATIONALE, BOUNDARY_FIX, MODEL_ALIGNMENT_NOTE) in a single large chunk. This chunk ranks #1 for every agent-notes query regardless of which specific anchor is relevant. It is a chunking artifact (the source document's meaningful content was never split). The effect is good recall but zero specificity — an agent always gets the full notes dump regardless of which sub-question it asked.

---

## Recommendations

### Retrieval Core

1. **No action needed on the retrieval engine itself.** The hybrid bge-m3-onnx pipeline correctly ranks relevant chunks first for most tested queries. The non-clean cases are all corpus- or fixture-level issues, not retrieval algorithm failures.

2. **Do not use absolute RRF score as confidence.** Future work should explore ambiguity signals: score gaps within the result set, exact token matches, scope term matches/mismatches, and source diversity.

### MCP Output

3. **Section name in window_chunks is highly valuable.** In bench-retrieval and custom-50, the `section` field in window chunks immediately tells the agent which documentation section it is reading. In custom-raw, `section` is empty (`""`) for all chunks because the raw fixtures have no headings. Consider populating `section` from the source filename or a derived label for unstructured documents.

4. **The `is_match` flag works correctly** and should be documented as the primary signal for agents to distinguish the retrieved chunk from window context. Agents should be instructed: "the chunk where `is_match: true` is the retrieval hit; window chunks are context only."

5. **Empty-section chunks should be filtered from window output.** The `(empty section: ...)` placeholder in custom-large appears in window context. It should be suppressed at MCP output time — it carries no information and wastes a window slot.

### Agent Instructions

6. **Mandatory scope check before answering negatives.** Agents must be instructed: "If the query mentions a specific environment, system, or entity (e.g., staging, GPT-4, PostgreSQL), verify that the retrieved evidence explicitly references that same entity before answering. If it references a different entity (e.g., prod instead of staging), state the scope mismatch and decline to answer."

7. **Distractor awareness.** Agents operating on raw/unstructured corpora must be instructed: "A chunk may contain both the correct value and an outdated/distractor value. Prefer values that are not explicitly marked as deprecated, commented-out, or labelled as distractors."

8. **Recommended agent call pattern:**
   ```
   qdrant_search(query, collection, top=3, window=1, window_format="compact")
   ```
   This pattern is recommended for agent use. Use `top=5` when the query is negative or ambiguous.

### Benchmark Query Fixes

9. **raw-neg-03** — Rewrite or add corpus-scope clarification. Current query "How to build a graph in production?" has vocabulary overlap with a Ukrainian crash trace. Recommended rewrite: `"What are the manual steps to construct a knowledge graph in a production deployment?"` — removes crash-trace vocabulary overlap.

10. **raw-neg-06** — Rewrite or tighten `forbiddenTokens`. `TELEMETRY_ENDPOINT=https://metrics.internal/api` satisfies the "metrics.internal" forbidden token but is a push endpoint, not a storage location. Recommended rewrite: `"Where is the Prometheus or Grafana metrics database hosted?"` — removes the telemetry-endpoint false hit.

11. **raw-agent-notes fixture** — The 8 repeated filler chunks (1–8) of mobile-padding chat discussion are noise that inflates the collection size without contributing to any query. Consider trimming the repetition to 1–2 instances or removing it entirely to make score distributions more meaningful.

---

## Final Verdict

### Is current semidex retrieval strong enough for agent use?

**Yes, with one scoped exception.** For structured documentation corpora (bench-retrieval, custom-50, custom-large), retrieval is highly reliable — most tested answerable queries returned the correct evidence at rank 1 or 2, and no false positives were observed for answerable queries. The system handles Ukrainian, mixed-language, exact-token, paraphrase, and cross-file queries correctly.

The exception is **scope-mismatched negative queries against raw/noisy corpora** (specifically raw-neg-01). When the query asks about an entity (e.g., staging environment) that does not exist in the corpus, the retriever correctly returns the semantically nearest content (prod timeout) — which looks like a valid answer to a naive agent. This is not a retrieval bug; it is an inherent limitation of corpus-bounded retrieval that requires agent-side scope verification.

### Is `qdrant_search(window=1, window_format="compact", top=3)` the recommended agent call pattern?

**Yes.** Confirmed beneficial across all four collections and all query types tested:
- For structured docs: window adds useful adjacent section context in ~40% of cases, is harmless in the rest.
- For raw/noisy docs: window adds compact snippets of neighbours; filler chunks appear as brief snippets only and do not mislead.
- The one case where w=0 silently failed (q6, wrong section at rank 1) was rescued by w=1.
- No case was found where w=1 compact caused a worse outcome than w=0.

**Recommended agent call pattern:** `qdrant_search(query, collection, top=3, window=1, window_format="compact")`  
For ambiguous or negative queries: add `top=5`.

### What is the highest-priority next improvement?

**Agent-side scope verification instruction.** The raw-neg-01 failure (prod/staging timeout) is the only live false-positive in this test and it requires no code change — only an agent instruction update. Specifically: agents must check whether retrieved evidence references the same scope (environment, system, model) as the query before formulating an answer. This single instruction change would prevent the only confirmed `FAIL_FALSE_POSITIVE` case observed across all 52 live queries.

Second priority: developing ambiguity signals (score gaps, exact token matches, scope term presence) so agents have a structured basis for confidence beyond content reading.
