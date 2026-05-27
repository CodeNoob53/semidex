# ADR 0005: Entity Boost — Opt-In Production Rollout

Status: Accepted

Date: 2026-05-27

## Context

Custom-50 source-navigation queries (c35, c36, c37) consistently sit at the
cr@5 rank-5/6 boundary with score margins around ~0.001. Every combined-mode
and post-qrel-fix benchmark run confirmed at least one of the three fails
cr@5 per reindex, even after the stable-ordering fix eliminated search-ordering
noise. Root cause analysis (design report `2026-05-27T1600`) identified three
structural gaps:

1. No structured "this chunk defines symbol X" signal — the retriever cannot
   prefer chunks whose code-identifier set intersects the query.
2. No path-component signal — `section` is not embedded and not weighted.
3. No document-role signal — a reference doc (source tree, entry-point table)
   cannot be preferred over a concept doc for navigation queries.

The entity-aware MVP (`2026-05-27T1800-entity-aware-source-navigation-mvp.md`)
added:
- `entities.{paths, symbols, env_vars, commands, heading_path}` — regex-extracted
  payload fields added to every indexed point.
- `doc_role` — static per-file classifier (`reference`, `concept`, `workflow`,
  `multilingual`, `other`).
- Payload indexes for all entity fields (created for new collections on
  `createCollection`; added to existing collections via `npm run sync` or
  `APPLY=1 COLLECTION=<name> npm run backfill:entities`).

The bench-only entity boost script (`entity-boost-bench.js`) proved the concept
on custom-50 with verdict `ENTITY_BOOST_ACCEPT` (benchmark report
`2026-05-27T2000-entity-boost-benchmark.md`). Production MCP scoring was not
changed prior to this ADR.

## Decision

`ENTITY_BOOST_ENABLED` is opt-in. Default is disabled (false). When enabled:

- The boost runs as a post-RRF rerank stage inside `qdrant_search`, after
  `hybridSearch` returns its top candidates.
- Formula: `finalScore = rrfScore + ENTITY_BOOST_WEIGHT × |queryEntities ∩ chunkEntities|`
- Recommended weight: `0.0015`. Effective threshold: `≥ 0.001`.
- A stable score sort is applied after boost, before trimming to top-K.
- If `payload.entities` is absent (old collection, not yet backfilled) the
  overlap is 0 and the result list is unchanged — graceful no-op.
- Reranking (`RERANK_ENABLED=1`) and MMR (`BENCH_SEARCH_MODE=dense-mmr`) paths
  are not affected; entity boost applies only to the default hybrid path.

Default MCP scoring is unchanged until `ENTITY_BOOST_ENABLED=1` is explicitly
set.

## Rationale

1. **Benchmark evidence is sufficient for opt-in.** Three consecutive fresh
   reindexes at weight 0.0015 all produced c35 ✓, c36 ✓, c37 ✓ and zero new
   hard regressions across 49 positive queries. The boost is additive and has
   no effect on queries with entity overlap = 0 (24/49 queries in the sweep).

2. **Opt-in gate is required before default-on.** The evidence is from a
   single fixture corpus (custom-50, 10 fixture files). Generalization to
   production corpora with different file types, section structures, and entity
   densities is not yet validated. A live test on a production collection is
   required before promoting to default.

3. **Backwards compatibility is unconditional.** Collections indexed before
   the entity phase (pre-2026-05-27) have no `entities` field. The boost
   produces overlap = 0 for those points, leaving ranking unchanged. No backfill
   is required for the feature to be safely enabled; backfill is only needed to
   gain the quality benefit.

4. **Shared logic, not duplicated.** The overlap computation and boost formula
   must live in `src/core/entity-boost.js`, not inlined into `search.js` or
   copied from the bench script. This allows the bench script to import the
   same logic and prevents drift.

5. **No change to embedding input or SCHEMA_VERSION.** Entity fields are
   payload-only. Enabling entity boost does not require reindexing.

## Implementation Plan

### New file: `src/core/entity-boost.js`

Shared helper, imported by both `src/mcp/tools/search.js` and the bench
script `entity-boost-bench.js`.

```js
// Extract entity tokens from a query string for overlap comparison.
// Uses the same extractEntities() extractor as the indexer.
export function queryEntityTokens(queryText) { ... }

// Additive overlap count between query tokens and a chunk's entities payload.
// Returns 0 if payload.entities is absent (graceful no-op for old collections).
export function entityOverlap(queryTokens, chunkPayload) { ... }

// Apply entity boost to a candidate list and stable-sort.
// boostWeight defaults to ENTITY_BOOST_WEIGHT env var or 0.0015.
export function applyEntityBoost(candidates, queryTokens, boostWeight) { ... }
```

`queryEntityTokens` calls `extractEntities({ text: queryText, section: '', source_file: '' })`
and unions all entity token sets (paths, symbols, env_vars, commands). The
`doc_role` and `heading_path` fields are payload metadata, not query-matchable
tokens, and are excluded from overlap.

### Changes to `src/mcp/tools/search.js`

When `process.env.ENTITY_BOOST_ENABLED === '1'`:

1. Parse `ENTITY_BOOST_WEIGHT` (default `0.0015`) and `ENTITY_BOOST_PREFETCH`
   (default `20`; if `≤ top`, no extra Qdrant call).
2. Call `hybridSearch(collection, dense, sparse, prefetchLimit)` for the wide
   candidate pool.
3. Also call `hybridSearch(collection, dense, sparse, top)` for the true
   baseline (needed only if `prefetchLimit > top`; can be omitted if the
   boosted result list is the only output path).
4. Extract query entity tokens via `queryEntityTokens(queryText)`.
5. Call `applyEntityBoost(candidates, queryTokens, boostWeight)`.
6. Trim to `top` after boost.

When `ENTITY_BOOST_ENABLED` is unset or `!== '1'`: existing code path is
unchanged. No new branching is visible to the agent.

**Do not touch MMR or RERANK paths.** Entity boost applies only in the default
`hybridSearch` branch.

### `entity-boost-bench.js` update

After `src/core/entity-boost.js` is created, update `entity-boost-bench.js` to
import `queryEntityTokens`, `entityOverlap`, and `applyEntityBoost` from
`src/core/entity-boost.js` instead of defining them locally. Reduces drift risk.

### Env vars (production, to add to `.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENTITY_BOOST_ENABLED` | `0` | Set to `1` to enable post-RRF entity overlap boost in `qdrant_search` |
| `ENTITY_BOOST_WEIGHT` | `0.0015` | Additive score bonus per overlapping entity token |
| `ENTITY_BOOST_PREFETCH` | `20` | Candidate pool fetched from Qdrant before entity rerank; if `≤ top`, no extra call |

## Remaining Risks

1. **Source Tree overpromotion.** The Source Tree chunk in
   `project-structure.md` accumulates many entity tokens (all file paths, all
   inline function names). A query that mentions several symbols may boost the
   Source Tree chunk above more specific per-module subsections. Observed on
   c36 (Source Tree vs Key Modules — MRR 0.500 → 0.333). Both are rel=3 so
   cr@5 is unaffected, but rank preference matters for agents that rely on rank 1
   to select the answer chunk without follow-up.

2. **c36 MRR tradeoff.** The deterministic rerank from Source Tree overpromotion
   causes c36 eMRR < bMRR at weight ≥ 0.001. This is an acceptable tradeoff
   at opt-in stage (both chunks are correct answers) but must be revisited if
   rank-1 selection quality is a production requirement.

3. **Entity extraction false positives.** The regex extractor may tag
   non-entity camelCase words or ALL_CAPS tokens as symbols/env_vars. False
   positives produce non-zero overlap on semantically unrelated queries, adding
   a small spurious boost. The boost magnitude is small (0.0015 per overlapping
   token) and did not cause regressions across 0–0.005 weight sweep, but
   production corpora with different content may surface edge cases.

4. **Fixture-only validation.** All evidence is from 10 custom-50 fixture files.
   Production corpora with different file structures, entity densities, or
   doc_role distributions may produce different overlap patterns.

## Acceptance Criteria for Default-On

Promote `ENTITY_BOOST_ENABLED` to default (`=1`) when:

1. Live test on a production collection (not fixture data) shows no new hard
   regressions vs the un-boosted baseline.
2. Source-navigation queries on the production collection show stable cr@5
   improvement or no change (not degradation) across ≥ 2 reindexes.
3. Aggregate chunkRecall@5 does not decrease vs baseline.
4. The Source Tree overpromotion risk (risk 1) is either confirmed acceptable
   in practice or mitigated (e.g. by normalising overlap by chunk entity count
   to avoid high-density chunks dominating).

## Consequences

- Production indexer now writes `entities` and `doc_role` to every new/changed
  point. Old points in existing collections do not have these fields until
  `APPLY=1 COLLECTION=<name> npm run backfill:entities` is run.
- `npm run sync` creates entity payload indexes on all existing semidex
  collections. No manual Qdrant dashboard step required.
- `qdrant_search` behavior is unchanged until `ENTITY_BOOST_ENABLED=1`.
- The bench script `bench:custom50:entity-boost` imports boost logic from
  `src/core/entity-boost.js`, which is the shared reference implementation.

## Evidence

- [`benchmarks/retrieval/results/2026-05-27T2000-entity-boost-benchmark.md`](../../benchmarks/retrieval/results/2026-05-27T2000-entity-boost-benchmark.md) — benchmark sweep, reindex stability, verdict
- [`benchmarks/retrieval/results/2026-05-27T1800-entity-aware-source-navigation-mvp.md`](../../benchmarks/retrieval/results/2026-05-27T1800-entity-aware-source-navigation-mvp.md) — implementation record
- [`benchmarks/retrieval/results/2026-05-27T1600-source-navigation-entity-chunking-design.md`](../../benchmarks/retrieval/results/2026-05-27T1600-source-navigation-entity-chunking-design.md) — root cause and design
