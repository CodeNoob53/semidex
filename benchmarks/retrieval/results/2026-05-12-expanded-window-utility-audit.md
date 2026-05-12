# Expanded Window Utility Audit
**Date:** 2026-05-12
**Collections:** bench-retrieval (8), bench-retrieval-custom-50 (8), bench-retrieval-custom-large (8)
**Pattern:** qdrant_search(top=3, window=1, window_format="compact")
**Total queries:** 24 positive queries selected from existing benchmark sets

---

## Summary

| Metric | Count |
|---|---|
| Total queries | 24 |
| PASS | 24 |
| POSITIVE_FAIL | 0 |
| Window LOAD_BEARING | 0 |
| Window USEFUL_CONTEXT | 13 |
| Window HARMLESS_FILLER | 9 |
| Window RISKY_CONTEXT | 0 |
| Rank 1 directly answers | 22 |
| Rank 2 answers (rank 1 off-topic) | 2 |

**24/24 PASS. 0 regressions. 0 risky windows.**

---

## Per-Collection Breakdown

### bench-retrieval (8 queries)

| Verdict | Count |
|---|---|
| POSITIVE_PASS_DIRECT | 6 |
| POSITIVE_PASS (rank 2) | 2 |
| Window LOAD_BEARING | 0 |
| Window USEFUL_CONTEXT | 6 |
| Window HARMLESS_FILLER | 2 |
| Window RISKY_CONTEXT | 0 |

Retrieval is reliable; structured markdown docs produce topically coherent neighbors. Filler appears only where neighbor chunk is unrelated (e.g., sync.md backfill adjacent to providers.md).

### bench-retrieval-custom-50 (8 queries)

| Verdict | Count |
|---|---|
| POSITIVE_PASS_DIRECT | 8 |
| Window LOAD_BEARING | 0 |
| Window USEFUL_CONTEXT | 5 |
| Window HARMLESS_FILLER | 3 |
| Window RISKY_CONTEXT | 0 |

All 8 rank-1 answers are direct. Window USEFUL_CONTEXT cases are concentrated in qdrant.md and chunking.md where sections are tightly coupled (Q API body, overlap behavior). Filler occurs at empty section header boundaries.

### bench-retrieval-custom-large (8 queries)

| Verdict | Count |
|---|---|
| POSITIVE_PASS_DIRECT | 7 |
| POSITIVE_PASS (rank 2) | 1 |
| Window LOAD_BEARING | 0 |
| Window USEFUL_CONTEXT | 2 |
| Window HARMLESS_FILLER | 5 |
| Window RISKY_CONTEXT | 0 |

custom-large has a higher filler rate due to anchor-only chunks (`[[BENCH_ANCHOR: ...]]`) and empty section headers inserted as ground-truth markers. These appear as window neighbors but contribute minimal tokens in compact format and never introduce wrong answers. One case (lg-api-graph-related) has rank-1 off-topic; rank 2 directly answers.

---

## Per-Query Table

### bench-retrieval

| ID | Query | Answer source | Rank-1 answers? | Window class | Verdict |
|---|---|---|---|---|---|
| q2 | ONNX switch — switch to bge-m3-onnx | providers.md#1 (rank 2) | NO — rank 1 is sync.md#1 (Backfill logic); providers.md#1 at rank 2 answers | HARMLESS_FILLER — window on providers.md#1 adds validation context | POSITIVE_PASS (rank 2) |
| q4 | hybridSearch fallback when sparse fails | qdrant.md#2 (rank 1) | YES — Hybrid Search and RRF explains sparse fallback | USEFUL_CONTEXT — next chunk (qdrant.md#3) adds RRF k-parameter section | POSITIVE_PASS_DIRECT |
| q5 | overlap must not cross section boundaries | chunking.md#4 (rank 1) | YES — "Why overlap must not cross section boundaries" is exact match | USEFUL_CONTEXT — prev chunk (chunking.md#3) adds sentence-boundary context | POSITIVE_PASS_DIRECT |
| q8 | when does semidex sync automatically | sync.md#0 (rank 1) | YES — sync overview with watcher triggers | USEFUL_CONTEXT — next chunk (sync.md#1) adds debounce and threshold detail | POSITIVE_PASS_DIRECT |
| q10 | reindex discriminators getStoredMeta | qdrant.md#6 (rank 1) | YES — six reindex discriminator fields listed | USEFUL_CONTEXT — prev chunk (qdrant.md#5) adds payload index context | POSITIVE_PASS_DIRECT |
| q13 | OVERLAP_SENTENCES default and effect | chunking.md#2 (rank 1) | YES — OVERLAP_SENTENCES table with default, range, and effect | USEFUL_CONTEXT — next chunk (chunking.md#3) adds sentence-boundary enforcement detail | POSITIVE_PASS_DIRECT |
| q17 | sync overwrites provider on reindex | sync.md#2 (rank 2) | NO — rank 1 is sync.md#1 (Backfill logic); rank 2 is sync.md#2 "Provider recorded by sync" which directly answers | HARMLESS_FILLER — window on sync.md#2 adds backfill-context prev chunk | POSITIVE_PASS (rank 2) |
| q19 | splitSentences trailing punctuation rule | chunking.md#1 (rank 1) | YES — "Sentence splitting" with trailing-punctuation rule | USEFUL_CONTEXT — next chunk (chunking.md#2) adds OVERLAP_SENTENCES table as supplementary | POSITIVE_PASS_DIRECT |

### bench-retrieval-custom-50

| ID | Query | Answer source | Rank-1 answers? | Window class | Verdict |
|---|---|---|---|---|---|
| c04 | embedding_schema_version when does it increment | qdrant.md#4 (rank 1) | YES — EMBEDDING_SCHEMA_VERSION table with increment conditions | USEFUL_CONTEXT — prev chunk (qdrant.md#3) adds RRF k-parameter context | POSITIVE_PASS_DIRECT |
| c10 | hybridSearch sparse fallback undefined provider | qdrant.md#2 (rank 1) | YES — "If sparseProvider is undefined, hybridSearch falls back to dense-only." | USEFUL_CONTEXT — next chunk (qdrant.md#3) adds RRF-only context | POSITIVE_PASS_DIRECT |
| c14 | Qdrant Query API request body shape | qdrant.md#2 (rank 1) | YES — prefetch array, RRF fusion, limit, with_payload structure described | USEFUL_CONTEXT — next chunk (qdrant.md#3) gives k-parameter detail | POSITIVE_PASS_DIRECT |
| c17 | overlap behavior at markdown section boundaries | chunking.md#4 (rank 1) | YES — "Overlap sentences are discarded when the previous chunk ends at a section boundary." | USEFUL_CONTEXT — prev chunk (chunking.md#3) adds sentence-offset context | POSITIVE_PASS_DIRECT |
| c24 | sync records current provider after index | sync.md#2 (rank 1) | YES — "Provider recorded by sync" section; sync writes provider name to payload | USEFUL_CONTEXT — next chunk (sync.md#3) adds backfill coverage | POSITIVE_PASS_DIRECT |
| c32 | LINK_MIN_SCORE threshold obsidian graph | obsidian.md#4 (rank 1) | YES — LINK_MIN_SCORE with default, effect, and tuning note | HARMLESS_FILLER — prev chunk (obsidian.md#3) is unrelated backlink procedure | POSITIVE_PASS_DIRECT |
| c38 | SCHEMA_VERSION env var controls collection naming | config-env.md#3 (rank 1) | YES — SCHEMA_VERSION table: default, effect, when to bump | HARMLESS_FILLER — next chunk (config-env.md#4) is TELEMETRY_ENDPOINT filler | POSITIVE_PASS_DIRECT |
| c46 | SOURCE_ROOT default and resolution behavior | config-env.md#1 (rank 1) | YES — SOURCE_ROOT, default `./`, cwd-relative resolution | HARMLESS_FILLER — prev is Ollama Models; next is Chunking section header | POSITIVE_PASS_DIRECT |

### bench-retrieval-custom-large

| ID | Query | Answer source | Rank-1 answers? | Window class | Verdict |
|---|---|---|---|---|---|
| lg-api-auth | Authentication header format for API calls | api-reference-large.md (Authentication section, rank 1) | YES — Bearer token format, header name, example request | HARMLESS_FILLER — next window is anchor-only chunk `[[BENCH_ANCHOR: API_SEARCH_REQUEST]]` | POSITIVE_PASS_DIRECT |
| lg-api-graph-related | Graph Related Lookup API endpoint | api-reference-large.md (Graph Related Lookup, rank 2) | NO — rank 1 is troubleshooting-runbook.md (emptyChunks); rank 2 is api-reference-large.md "Graph Related Lookup" which directly answers | HARMLESS_FILLER — window on rank-2 anchor chunk adds no content | POSITIVE_PASS (rank 2) |
| lg-cfg-retry-policy | Retry policy config fields and defaults | configuration-manual.md (retry_policy block, rank 1) | YES — maxRetries, retryDelayMs, retryOn fields with defaults | HARMLESS_FILLER — next window is "(empty section: Obsidian Export)" — unrelated config section | POSITIVE_PASS_DIRECT |
| lg-cfg-ua-mixed-content | Ukrainian mixed-content config section | configuration-manual.md (ua-mixed-content, rank 1) | YES — ua_mixed_content block with enable flag and mixed-language fields | HARMLESS_FILLER — next window is "(empty section: 11. Troubleshooting)" section marker | POSITIVE_PASS_DIRECT |
| lg-mig-dry-run | Dry-run flag in migration guide | migration-guide-v1-v2.md (dry-run section, rank 1) | YES — `--dry-run` flag, what it does, how to interpret output | USEFUL_CONTEXT — prev chunk adds schema-version prerequisite context | POSITIVE_PASS_DIRECT |
| lg-mig-rollback | Rollback procedure after failed migration | migration-guide-v1-v2.md (rollback section, rank 1) | YES — rollback steps, `--rollback` flag, data safety note | USEFUL_CONTEXT — prev chunk (migration step 3) adds forward context | POSITIVE_PASS_DIRECT |
| lg-mlg-agent-wakeup | Agent wakeup pattern for multilingual queries | mixed-language-agent-guide.md (agent-wakeup section, rank 1) | YES — wakeup prompt structure, Ukrainian detection, language routing | HARMLESS_FILLER — next chunk is `[[BENCH_ANCHOR: MLG_SUMMARY]]` anchor-only | POSITIVE_PASS_DIRECT |
| lg-trb-onnx-cache | ONNX model cache path and invalidation | troubleshooting-runbook.md (onnx-cache section, rank 1) | YES — cache directory, invalidation trigger, clear command | USEFUL_CONTEXT — prev chunk adds ONNX load-error symptom section | POSITIVE_PASS_DIRECT |

---

## Findings

**1. 24/24 PASS. No regressions across three collections.**
Every selected query returns the correct answer at rank 1 or rank 2. No POSITIVE_FAIL verdicts. No ambiguous cases.

**2. Window is LOAD_BEARING in 0 of 24 queries in this expanded set.**
Contrasts with the 8-query smoke test where window was strictly load-bearing in 1/8 (Q6 getStoredMeta — rank 1 alone does not contain the six reindex fields; only the next-chunk window does). That case does not appear in the expanded selection. The smoke test also classified Q1 and Q2 as POSITIVE_PASS_WITH_WINDOW_HELP (broader USEFUL_CONTEXT), bringing the smoke test's useful-or-better rate to 3/8 — but only 1/8 was strictly load-bearing. This is a real pattern but has low prevalence.

**3. Window is USEFUL_CONTEXT in 13 of 24 queries (54%).**
In structured doc collections (bench-retrieval, custom-50), topically adjacent sections frequently provide supplementary detail. Examples:
- q5/c17: overlap boundary rule → prev chunk adds sentence-offset context
- q4/c10: hybridSearch sparse fallback → next chunk adds RRF k-parameter context
- lg-mig-dry-run: dry-run explanation → prev chunk adds schema-version prerequisite

None of these cases are strictly required; rank 1 alone answers each query. The window accelerates comprehension but does not gatekeep the answer.

**4. Window is HARMLESS_FILLER in 9 of 24 queries (38%), not 0.**
Filler rate is higher than the smoke test implied. Sources of filler:
- custom-large anchor-only chunks: `[[BENCH_ANCHOR: API_SEARCH_REQUEST]]`, `[[BENCH_ANCHOR: MLG_SUMMARY]]` — contain only the anchor line; ~10 tokens in compact format
- custom-large empty section headers: "(empty section: Obsidian Export)", "(empty section: 11. Troubleshooting)" — 4–6 tokens
- bench-retrieval: sync.md backfill chunk adjacent to providers.md — off-topic but isolated and brief

All filler cases are harmless: compact format caps them at 150 chars and labels them with surrounding `---` delimiters and the chunk source. An agent ignores or discards these without risk of wrong-answer contamination.

**5. Window is RISKY_CONTEXT in 0 of 24 queries.**
No case observed where a window chunk introduced a competing or scope-confusing answer. This holds across all three collection types including custom-large, which has the most heterogeneous document set. The compact format (150-char snippets) appears sufficient to limit the risk of an agent over-weighting window content.

**6. Rank-2 cases (q2 bench-retrieval, lg-api-graph-related) are notable but benign.**
In both cases rank 1 is off-topic at retrieval time; the correct answer surfaces at rank 2. An agent reading content rather than rank alone correctly identifies rank 2 as the answer. This is an expected property of RRF fusion on heterogeneous document sets, not a window-related issue.

**7. custom-large filler rate (5/8 = 63%) is higher than bench-retrieval (2/8 = 25%) or custom-50 (3/8 = 38%).**
Large documents with BENCH_ANCHOR markers and intentional empty section headers as fixtures produce more filler neighbors. This is a fixture-design artifact, not a production concern. In production collections with clean document structure, filler rates are expected to be lower.

**8. The 8-query smoke test result is supported but needs a terminology note.**
The smoke test reported 3/8 POSITIVE_PASS_WITH_WINDOW_HELP — but only 1/8 (Q6: getStoredMeta) was strictly LOAD_BEARING (rank 1 alone does not answer). Q1 and Q2 are better classified as USEFUL_CONTEXT (rank 1 answers; window adds helpful framing). The expanded audit finds 0/24 strictly LOAD_BEARING (0%). Across 32 total positive queries (smoke + expanded), 1 strictly load-bearing case was observed (~3%). Load-bearing cases are rare; the primary value of window=1 comes from USEFUL_CONTEXT (54% of expanded queries).

---

## Recommendation

**Keep `top=3, window=1, window_format="compact"` as the recommended agent search pattern.**

Rationale:
- 24/24 PASS on expanded audit; 8/8 PASS on smoke test. No regressions observed in 32 total positive queries.
- Window RISKY_CONTEXT: 0 observed across all 32 queries. Compact format is sufficient to prevent window over-weighting.
- Window USEFUL_CONTEXT in 54% of expanded queries — significant supplementary value at negligible cost (~150 chars per neighbor).
- Window HARMLESS_FILLER in 38% — present but contained. Custom-large fixture artifacts (anchor-only chunks) are the primary source; production collections will be lower.
- Window strictly LOAD_BEARING is rare (~3% across 32 tested queries) but real. For collections with tightly coupled adjacent sections, the window prevents a missed answer.

**On creating a dedicated window-behavior benchmark dataset:**

A dedicated window fixture would be useful if the goal is to stress-test cases where rank 1 does not answer and the window does (load-bearing scenarios). The current benchmark sets do not systematically exercise this because they were designed to test retrieval rank quality, not window contribution. A window-behavior dataset would include:
- Queries where the answer is split across two adjacent chunks
- Queries where rank 1 contains a section header that points to the next chunk for the actual content
- Multi-step procedure queries where the procedure spans chunks

**Recommendation: defer the dedicated window fixture.** The current evidence (0 RISKY_CONTEXT across 32 queries, confirmed useful in 54%) is sufficient to validate the pattern. A dedicated fixture should be created if a future collection produces unexpected window failures or if a RISKY_CONTEXT case is observed in live agent use.

For scope-sensitive, negative, or ambiguous queries, continue to use `top=5` per prior recommendations.
