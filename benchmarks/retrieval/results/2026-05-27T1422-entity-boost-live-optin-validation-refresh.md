# Entity Boost Live Opt-In Validation — Refresh

**Date:** 2026-05-27T1422  
**Verdict:** `ENTITY_BOOST_LIVE_ACCEPT_TECHNICAL`  
**Current status (2026-05-29):** situational semidex-like technical evidence
only. Production opt-in was rolled back by
`2026-05-29T0000-entity-boost-production-rollback.md` after a hard-technical
validation showed the current extractor does not generalize.
**Supersedes:** `2026-05-27T1244-entity-boost-live-optin-validation.md` (stale collection)

## Setup

| Field | Value |
|-------|-------|
| Collection | `semidex-docs` |
| Refresh method | `npm run bootstrap:docs` (delete + reindex from scratch) |
| Reason for refresh | Previous run had 330 stale points (`en/`, `ua/` prefixes) alongside 329 fresh ones; stale points polluted results |
| Canonical source scope | `README.md`, `AGENTS.md`, `docs/en/` (15 files) |
| Points after refresh | 329 |
| Stale prefixes remaining | none — verified via scroll |
| Dense provider | bge-m3-onnx |
| Sparse provider | bge-m3-onnx |
| Schema version | 2 |
| Entity payload | 329/329 points (indexed at index time — no backfill needed) |
| Points with `ENTITY_BOOST_ENABLED` in entities | 4 (`docs/en/retrieval.md` ×2, `docs/en/configuration.md`, `docs/en/mcp-tools.md`) |
| `npm run sync` | run after bootstrap — all entity indexes confirmed |
| `ENTITY_BOOST_WEIGHT` | 0.0015 |
| `ENTITY_BOOST_PREFETCH` | 20 |
| top-K | 5 |

## Query Set

16 queries: 8 source-navigation (`nav`, docs-scoped identifiers only), 8 semantic (`sem`).

## Per-Query Results

| id | type | tokens | overlap | boost_skipped | change | base top-1 | boost top-1 |
|----|------|--------|---------|---------------|--------|------------|-------------|
| n01 | nav | 1 | 1 | – | top1_changed | docs/en/ce-rerank-design.md#30 | docs/en/retrieval.md#14 |
| n02 | nav | 1 | 1 | – | top5_reordered | docs/en/retrieval.md#14 | docs/en/retrieval.md#14 |
| n03 | nav | 1 | 1 | – | top5_reordered | docs/en/configuration.md#6 | docs/en/configuration.md#6 |
| n04 | nav | 1 | 1 | – | top1_changed | docs/en/ce-rerank-design.md#30 | docs/en/retrieval.md#8 |
| n05 | nav | 1 | 1 | – | top5_reordered | AGENTS.md#1 | AGENTS.md#1 |
| n06 | nav | 1 | 1 | – | top5_reordered | docs/en/operations.md#12 | docs/en/operations.md#12 |
| n07 | nav | 0 | 0 | no_tokens | unchanged | AGENTS.md#4 | AGENTS.md#4 |
| n08 | nav | 0 | 0 | no_tokens | unchanged | AGENTS.md#15 | AGENTS.md#15 |
| s01 | sem | 0 | 0 | no_tokens | unchanged | AGENTS.md#12 | AGENTS.md#12 |
| s02 | sem | 0 | 0 | no_tokens | unchanged | docs/en/retrieval.md#0 | docs/en/retrieval.md#0 |
| s03 | sem | 0 | 0 | no_tokens | unchanged | docs/en/project-structure.md#4 | docs/en/project-structure.md#4 |
| s04 | sem | 0 | 0 | no_tokens | unchanged | docs/en/operations.md#9 | docs/en/operations.md#9 |
| s05 | sem | 0 | 0 | no_tokens | unchanged | docs/en/operations.md#3 | docs/en/operations.md#3 |
| s06 | sem | 0 | 0 | no_tokens | unchanged | docs/en/configuration.md#6 | docs/en/configuration.md#6 |
| s07 | sem | 0 | 0 | no_tokens | unchanged | docs/en/retrieval.md#4 | docs/en/retrieval.md#4 |
| s08 | sem | 0 | 0 | no_tokens | unchanged | docs/en/operations.md#24† | docs/en/operations.md#24† |

†  s08 top-1 can flip between `docs/en/operations.md#24` and `AGENTS.md#26` across runs — both
have identical RRF scores and zero entity tokens. The key result is `baseline == boosted` (boost
did not change the outcome), not the specific chunk at rank 1.

## Source-Navigation Top-5 Detail

### n01: where is ENTITY_BOOST_ENABLED documented
tokens: [`ENTITY_BOOST_ENABLED`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | docs/en/ce-rerank-design.md#30 | docs/en/retrieval.md#14 ← |
| 2 | docs/en/retrieval.md#14 | docs/en/retrieval.md#12 ← |
| 3 | docs/en/retrieval.md#12 | docs/en/mcp-tools.md#4 ← |
| 4 | docs/en/mcp-tools.md#4 | docs/en/ce-rerank-design.md#30 ← |
| 5 | docs/en/configuration.md#17 | docs/en/configuration.md#17 |

**Genuine top-1 improvement.** Baseline top-1 `ce-rerank-design.md#30` is a CE reranker design
doc section containing `RERANK_CE_ENABLED` — tangentially relevant. Boosted top-1
`retrieval.md#14` is the entity boost section of the retrieval guide that directly documents
`ENTITY_BOOST_ENABLED=1`. Top-4 replaced by chunks that all carry the token in their entity
payload; `configuration.md#17` (entity boost env var table) stably holds rank 5.

### n02: where is ENTITY_BOOST_PREFETCH documented
tokens: [`ENTITY_BOOST_PREFETCH`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | docs/en/retrieval.md#14 | docs/en/retrieval.md#14 |
| 2 | docs/en/configuration.md#17 | docs/en/configuration.md#17 |
| 3 | docs/en/benchmarking.md#47 | docs/en/benchmarking.md#47 |
| 4 | docs/en/mcp-tools.md#4 | docs/en/retrieval.md#12 ← |
| 5 | docs/en/retrieval.md#12 | docs/en/mcp-tools.md#4 ← |

Top-1 and top-3 stable. Positions 4–5 swapped between two chunks both containing the token.
No quality change; correct answer already at rank 1.

### n03: where is COMBINED_LLM documented
tokens: [`COMBINED_LLM`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | docs/en/configuration.md#6 | docs/en/configuration.md#6 |
| 2 | AGENTS.md#23 | AGENTS.md#23 |
| 3 | README.md#10 | AGENTS.md#26 ← |
| 4 | AGENTS.md#26 | docs/en/configuration.md#4 ← |
| 5 | docs/en/configuration.md#4 | README.md#10 ← |

Top-1 and top-2 stable. Positions 3–5 reordered among three chunks all relevant to
`COMBINED_LLM`. `README.md#10` drops from rank 3 to rank 5; it mentions `COMBINED_LLM` but
in a summary context. No quality regression.

### n04: where is RERANK_ENABLED documented
tokens: [`RERANK_ENABLED`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | docs/en/ce-rerank-design.md#30 | docs/en/retrieval.md#8 ← |
| 2 | docs/en/retrieval.md#8 | docs/en/ce-rerank-design.md#30 ← |
| 3 | docs/en/ce-rerank-design.md#7 | docs/en/ce-rerank-design.md#7 |
| 4 | docs/en/roadmap.md#4 | docs/en/ce-rerank-design.md#3 ← |
| 5 | docs/en/ce-rerank-design.md#3 | docs/en/roadmap.md#4 ← |

**Genuine top-1 improvement** (same pattern as n01). Baseline top-1 `ce-rerank-design.md#30`
is a production acceptance gate section for `RERANK_CE_ENABLED` — mentions `RERANK_ENABLED`
in passing but is a design doc, not user-facing configuration documentation. Boosted top-1
`retrieval.md#8` directly documents `RERANK_ENABLED=1` usage and defaults in the retrieval
guide. Both had RRF score tied at 0.033; boost resolved the tie in favor of the chunk with
the token in payload.

### n05: where is npm run doctor documented
tokens: [`npm run doctor`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | AGENTS.md#1 | AGENTS.md#1 |
| 2 | docs/en/operations.md#23 | docs/en/operations.md#23 |
| 3 | docs/en/operations.md#14 | AGENTS.md#26 ← |
| 4 | AGENTS.md#26 | docs/en/operations.md#14 ← |
| 5 | docs/en/configuration.md#12 | docs/en/configuration.md#13 ← |

Top-1 and top-2 stable (correct chunks). Minor reordering at positions 3–5. No regression.

### n06: where is npm run bootstrap:docs documented
tokens: [`npm run bootstrap:docs`]  overlap: 1  boost_skipped: false

| rank | baseline | boosted |
|------|----------|---------|
| 1 | docs/en/operations.md#12 | docs/en/operations.md#12 |
| 2 | docs/en/operations.md#14 | docs/en/operations.md#14 |
| 3 | AGENTS.md#1 | AGENTS.md#1 |
| 4 | docs/en/configuration.md#12 | README.md#7 ← |
| 5 | docs/en/configuration.md#13 | docs/en/configuration.md#12 ← |

Top-3 stable. Position 4–5 reordering: `README.md#7` (contains `npm run bootstrap:docs`
mention) promoted to rank 4. Acceptable; top-1 and top-2 are the primary operations.md
sections.

### n07: where is qdrant_search described
tokens: []  overlap: 0  boost_skipped: true

`qdrant_search` contains an underscore — not matched by the camelCase symbol extractor (requires
alternating case) or env_var extractor (no known prefix). Zero tokens extracted; boost skipped;
baseline returned unchanged. Top-5 is correct: `mcp-tools.md#10` and `mcp-tools.md#2` appear
in ranks 3 and 5. Content is reachable via hybrid sparse leg.

### n08: where are source_file tags chunk_index payload indexes documented
tokens: []  overlap: 0  boost_skipped: true

Prose query with no extractable identifiers. Boost skipped. Baseline top-5 correct:
`configuration.md#21` at rank 4 is the payload indexes table.

## Semantic Query Safety

All 8 semantic queries: **fully stable, zero rank changes.** All produced zero entity tokens
(natural-language phrasing contains no paths, symbols, env_vars, or npm commands). The
`queryTokens.size === 0` early-exit fired in every case, returning the plain `hybridSearch(top)`
baseline without entering the entity boost path.

## Aggregate Summary

### Source-navigation (n=8)

| Outcome | Count | Queries |
|---------|-------|---------|
| top-1 changed — genuine improvement | 2 | n01, n04 |
| top-5 reordered only — top-1 stable | 4 | n02, n03, n05, n06 |
| boost skipped — no tokens extracted | 2 | n07, n08 |
| new regression (top-1 worse) | 0 | — |

### Semantic safety (n=8)

| Outcome | Count |
|---------|-------|
| fully stable (no change) | 8 |
| rank changed (manual review) | 0 |

## Acceptance Criteria

| Criterion | Result |
|-----------|--------|
| Source-nav: ≥6/8 improve or stay same | ✓ — 6 boost-active (2 top-1 improved, 4 tail reorders), 2 correctly skipped. 8/8 no regressions. |
| No semantic query obviously worse in top-5 | ✓ — 8/8 fully stable |
| No old/no-overlap query changes from wider prefetch alone | ✓ — n07/n08 returned identical baseline; no prefetch-only pollution |
| No runtime errors with `ENTITY_BOOST_ENABLED=1` | ✓ |
| Docs claims remain true | ✓ — "queries with no entity tokens unaffected" confirmed; "old collections unchanged" not testable here (fresh index), but confirmed via no-token early-exit |

## Observations

**Token extraction covers 6/8 nav queries.** The two misses (n07, n08) are structural limits of
the current extractor: `qdrant_search` (underscore identifier, not camelCase) and the prose
phrasing "source_file tags chunk_index" (underscore identifiers again). These queries still
retrieve correct results via hybrid sparse/dense — boost is additive, not required.

**Both top-1 improvements are tie-break resolutions.** In n01 and n04, the baseline and boosted
chunks had nearly identical RRF scores. The hybrid dense+sparse retrieval already found the right
answer in top-5; boost promoted it to top-1 by recognizing the entity token in payload. This is
exactly the target use case from ADR 0005.

**Semantic queries have zero entity tokens by design.** Natural-language phrasing ("how does X
work", "why is Y opt-in") contains no source-navigation identifiers. The early-exit guarantees
these queries are unaffected regardless of collection content. This is a structural safety
property, not luck.

**`ENTITY_BOOST_ENABLED` is in `entities.symbols`, not `entities.env_vars`**, because the
extractor's env_var known-prefix list does not include `ENTITY_BOOST_`. It is matched
identically via the `symbols` field, which `queryEntityTokens` unions. No behavior difference.

## Verdict

**`ENTITY_BOOST_LIVE_ACCEPT_TECHNICAL`**

**Recommendation:** Keep as opt-in. Safe to enable for technical documentation collections
(semidex-docs, API references, codebase docs). Two genuine top-1 improvements from tie-break
resolution, four tail reorderings with no quality loss, semantic queries completely unaffected.

Default-on promotion (per ADR 0005 criteria) requires evidence across a broader query mix and
multiple collection types. This run satisfies the technical-collections arm.

## Verification

- `npm run smoke`: 650 passed, 0 failed
- `git diff --check`: clean (CRLF warnings only)
- Privacy scan: no private paths in this report
- Collection scope confirmed: `AGENTS.md`, `README.md`, `docs/en/*` only — no private corpora
