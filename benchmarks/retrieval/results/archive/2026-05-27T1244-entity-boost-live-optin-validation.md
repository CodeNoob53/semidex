# Entity Boost Live Opt-In Validation

**Date:** 2026-05-27T1244  
**Verdict:** `ENTITY_BOOST_LIVE_ACCEPT_TECHNICAL`

## Setup

| Field | Value |
|-------|-------|
| Collection | `semidex-docs` |
| Points | 331 |
| Dense provider | bge-m3-onnx |
| Sparse provider | bge-m3-onnx |
| Schema version | 2 |
| Backfill needed | yes — entity payload absent before this run |
| Backfill applied | `APPLY=1 COLLECTION=semidex-docs npm run backfill:entities` (331/331 points updated) |
| `npm run sync` | run after backfill — entity indexes confirmed |
| `ENTITY_BOOST_WEIGHT` | 0.0015 |
| `ENTITY_BOOST_PREFETCH` | 20 |
| top-K | 5 |

## Query Set

16 queries: 8 source-navigation (`nav`), 8 semantic (`sem`).

## Per-Query Results

| id | type | tokens | overlap | rank↑ | base top-1 | boost top-1 | note |
|----|------|--------|---------|-------|------------|-------------|------|
| n01 | nav | 1 | 1 | ✓ | en/ce-rerank-design.md#1 | en/ce-rerank-design.md#1 | rank changed (positions 3–5) |
| n02 | nav | 1 | 0 | – | en/ce-rerank-design.md#34 | en/ce-rerank-design.md#34 | no overlap — boost skipped |
| n03 | nav | 0 | 0 | – | en/retrieval.md#1 | en/retrieval.md#1 | no tokens — boost skipped |
| n04 | nav | 0 | 0 | – | en/retrieval.md#7 | en/retrieval.md#7 | no tokens — boost skipped |
| n05 | nav | 0 | 0 | – | en/configuration.md#19 | en/configuration.md#19 | no tokens — boost skipped |
| n06 | nav | 1 | 1 | – | en/configuration.md#5 | en/configuration.md#5 | top-5 stable |
| n07 | nav | 1 | 1 | ✓ | en/operations.md#22 | en/operations.md#22 | rank changed (position 5 only) |
| n08 | nav | 1 | 1 | ✓ | en/ce-rerank-design.md#34 | ua/README.md#20 | top-1 improvement — see detail |
| s01 | sem | 0 | 0 | – | en/operations.md#11 | en/operations.md#11 | stable |
| s02 | sem | 0 | 0 | – | en/retrieval.md#0 | en/retrieval.md#0 | stable |
| s03 | sem | 0 | 0 | – | ua/README.md#14 | ua/README.md#14 | stable |
| s04 | sem | 0 | 0 | – | en/chunking-quality.md#11 | en/chunking-quality.md#11 | stable |
| s05 | sem | 0 | 0 | – | en/operations.md#5 | en/operations.md#5 | stable |
| s06 | sem | 0 | 0 | – | en/configuration.md#5 | en/configuration.md#5 | stable |
| s07 | sem | 0 | 0 | – | en/retrieval.md#4 | en/retrieval.md#4 | stable |
| s08 | sem | 0 | 0 | – | en/operations.md#23 | en/operations.md#23 | stable |

## Source-Navigation Top-5 Detail

### n01: where is hybridSearch implemented
tokens: [`hybridSearch`]  overlap: 1

| rank | baseline | boosted |
|------|----------|---------|
| 1 | en/ce-rerank-design.md#1 | en/ce-rerank-design.md#1 |
| 2 | en/benchmarking.md#39 | en/benchmarking.md#39 |
| 3 | en/mcp-tools.md#6 | en/ce-rerank-design.md#3 ← |
| 4 | ua/README.md#40 | en/mcp-tools.md#6 ← |
| 5 | en/ce-rerank-design.md#3 | ua/README.md#40 ← |

Top-1 unchanged. Positions 3–5 reordered; `ce-rerank-design.md#3` (contains `hybridSearch` call site) pulled forward.

### n02: where is ENTITY_BOOST_ENABLED documented
tokens: [`ENTITY_BOOST_ENABLED`]  overlap: 0

| rank | baseline | boosted |
|------|----------|---------|
| 1 | en/ce-rerank-design.md#34 | en/ce-rerank-design.md#34 |
| 2 | ua/README.md#41 | ua/README.md#41 |
| 3 | en/ce-rerank-design.md#4 | en/ce-rerank-design.md#4 |
| 4 | ua/README.md#20 | ua/README.md#20 |
| 5 | en/benchmarking.md#30 | en/benchmarking.md#30 |

Token `ENTITY_BOOST_ENABLED` extracted, but no candidate in the prefetch pool has it in payload
(the env var was added to docs after the current index was built). Overlap = 0 → boost skipped,
baseline returned unchanged. Correct behavior: content freshness issue, not a boost bug.
Top-5 does not surface `en/configuration.md` or `en/retrieval.md` entity-boost sections — a
pure retrieval quality gap for this query, independent of boost.

### n03: where is qdrant_search described
tokens: [] (none extracted)  overlap: 0

Baseline returned unchanged. `qdrant_search` contains an underscore — currently extracted by
the symbol regex only if it matches camelCase; the backtick-quoted form in the query text does
not yield a token. No overlap possible → boost skipped. Top-5 is correct (mcp-tools.md#2 at
rank 2 is the right chunk). Content reachable via hybrid sparse leg without boost.

### n04: where is backfill:entities described
tokens: [] (none extracted)  overlap: 0

`backfill:entities` not matched by any current extractor (it is an npm script name with colon
separator, not a `npm run X` command pattern). Boost skipped. Baseline top-5 includes
`en/retrieval.md#7` at rank 1, which describes the backfill command. Correct result.

### n05: where are payload indexes documented
tokens: [] (none extracted)  overlap: 0

No entity tokens in "where are payload indexes documented". Boost skipped. Baseline correct.

### n06: where is COMBINED_LLM documented
tokens: [`COMBINED_LLM`]  overlap: 1

| rank | baseline | boosted |
|------|----------|---------|
| 1 | en/configuration.md#5 | en/configuration.md#5 |
| 2 | en/configuration.md#4 | en/configuration.md#4 |
| 3 | ua/README.md#15 | ua/README.md#15 |
| 4 | en/architecture.md#5 | en/architecture.md#5 |
| 5 | ua/README.md#3 | ua/README.md#3 |

Top-5 fully stable — baseline already had the right chunk at rank 1 with high overlap. Boost
confirmed the ordering without disruption.

### n07: where is npm run doctor documented
tokens: [`npm run doctor`]  overlap: 1

| rank | baseline | boosted |
|------|----------|---------|
| 1 | en/operations.md#22 | en/operations.md#22 |
| 2 | ua/README.md#28 | ua/README.md#28 |
| 3 | ua/README.md#33 | ua/README.md#33 |
| 4 | ua/README.md#30 | ua/README.md#30 |
| 5 | en/operations.md#7 | ua/README.md#32 ← |

Top-4 stable. Position 5 swapped: `en/operations.md#7` (general operations intro) displaced by
`ua/README.md#32` (UA README section mentioning `npm run doctor`). Minor; top-1 correct.

### n08: where is RERANK_ENABLED documented
tokens: [`RERANK_ENABLED`]  overlap: 1

| rank | baseline | boosted |
|------|----------|---------|
| 1 | en/ce-rerank-design.md#34 | ua/README.md#20 ← |
| 2 | ua/README.md#20 | en/ce-rerank-design.md#34 ← |
| 3 | en/ce-rerank-design.md#4 | en/ce-rerank-design.md#4 |
| 4 | ua/README.md#41 | ua/README.md#41 |
| 5 | en/ce-rerank-design.md#7 | en/retrieval.md#8 ← |

**Genuine top-1 improvement.** Both chunks had RRF score 0.033 (tie). Baseline promoted
`en/ce-rerank-design.md#34` (production acceptance gate for `RERANK_CE_ENABLED` — a design
doc section that mentions `RERANK_CE_ENABLED`, not `RERANK_ENABLED`). Boosted promoted
`ua/README.md#20` (directly explains `RERANK_ENABLED=1` behavior: candidate multiplier,
default-off rationale). The boosted top-1 is the correct answer for this query.

## Semantic Query Safety

All 8 semantic queries: **fully stable top-5**. Zero rank changes. All semantic queries produced
zero entity tokens from the extractor (natural-language phrasing yields no paths/symbols/env_vars/
commands), so the boost path was not entered — baseline returned as-is in every case.

This confirms the early-exit logic (`queryTokens.size === 0 → return baseline`) works correctly
in production conditions.

## Old-Collection No-Overlap Safety

n02 and n03/n04/n05 cover the two fallback paths:
- n02: query has tokens, no overlap in candidate pool → `hasOverlap = false` → baseline returned
- n03–n05: query has no tokens → early-exit → baseline returned

Both paths were exercised and produced identical output to plain `hybridSearch(top)`.

## Acceptance Criteria Assessment

| Criterion | Result |
|-----------|--------|
| Source-nav: ≥6/8 improve or stay same | ✓ — 3 rank changes (n01/n07 minor, n08 genuine improvement), 5 unchanged. 8/8 met (no regressions). |
| No semantic query obviously worse in top-5 | ✓ — 8/8 fully stable |
| No old/no-overlap query changes from wider prefetch | ✓ — n02/n03/n04/n05 returned identical baseline |
| No runtime errors with ENTITY_BOOST_ENABLED=1 | ✓ |
| Docs claims remain true | ✓ |

## Observations and Limitations

**Extractor coverage on natural-language nav queries is partial.** 5 of 8 nav queries yielded
0–1 tokens. Queries using quoted backtick identifiers in natural language ("where is `X`
documented") extract the identifier as an env_var or symbol; queries using prose ("where are
payload indexes documented") extract nothing. This is expected — the extractor is tuned for
source-navigation queries that contain the identifier verbatim, not paraphrases.

**Content freshness gap (n02).** `ENTITY_BOOST_ENABLED` appears in the docs but the indexed
payload does not contain it in the entity field of matching chunks — because the env var was
added to `en/configuration.md` and `en/retrieval.md` after `semidex-docs` was last fully
indexed. The backfill adds entities extracted from the *current indexed text*, so if that text
predates the env var, there is nothing to match. Resolution: re-index `semidex-docs` when docs
are updated. This is a standard indexing freshness issue unrelated to the boost mechanism.

**n08 improvement is a tie-break win.** Both swapped chunks had identical RRF score (0.033).
Boost used entity overlap to resolve the tie in favor of the directly relevant chunk. This is
the intended use case.

**Semantic queries produce zero entity tokens.** All 8 semantic queries used natural-language
phrasing with no identifiers. The boost was not entered for any of them. This is correct
behavior — pure semantic queries should not be affected by an entity-overlap mechanism.

## Verdict

**`ENTITY_BOOST_LIVE_ACCEPT_TECHNICAL`**

**Recommendation:** Keep as opt-in. Recommended for technical/source-navigation collections
(semidex-docs, codebase docs, API references). The mechanism is safe: semantic queries are
unaffected, old collections without entity payload fall back to true baseline unchanged, and
no new regressions were observed. One genuine top-1 improvement (n08) and two minor tail
reorderings (n01, n07) with no quality loss.

Default-on promotion criteria (from ADR 0005) require evidence across a broader query mix and
multiple collection types. This run satisfies the technical-collections arm; a second run on a
mixed/prose collection would be needed before considering default-on.

## Verification

- `npm run smoke`: 650 passed, 0 failed
- `git diff --check`: clean (CRLF warnings only)
- Privacy scan: no private paths in this report
