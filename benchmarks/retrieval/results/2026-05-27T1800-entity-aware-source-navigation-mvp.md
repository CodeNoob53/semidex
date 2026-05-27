# Entity-Aware Source-Navigation MVP — Implementation Record

*Generated: 2026-05-27*

## Status

**IMPLEMENTED — smoke green, not yet benchmarked.**

All code changes are in place. Production MCP scoring is unchanged.
Entity boost is bench-only. Benchmark run pending (requires Qdrant + ONNX
embed provider live).

## Purpose

Implement the entity-aware payload enrichment described in
`benchmarks/retrieval/results/2026-05-27T1600-source-navigation-entity-chunking-design.md`
as a minimal, backwards-compatible MVP. Target weakness: source-navigation
class (c35, c36, c37 in custom-50) sits at the cr@5 rank-5/6 boundary
across every reindex.

**No production MCP scoring was changed. No embedding input was changed.
No SCHEMA_VERSION was changed.**

---

## Files Created

### `src/indexer/phases/entities.js` (new)

Pure regex/heuristic entity extractor. No LLM, no external I/O.

```
extractEntities(chunk) → { entities: { paths, symbols, env_vars, commands, heading_path }, doc_role }
```

**Patterns:**

| Entity type | Pattern |
|-------------|---------|
| paths | `(?:src\|benchmarks\|docs)/[\w.\-/]+\.(?:js\|md\|json)` |
| symbols | camelCase: `[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+`; ALL_CAPS constants: `[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+` (non-env_var) |
| env_vars | same ALL_CAPS pattern, filtered to known semidex env-var prefixes |
| commands | `npm run [a-z][a-z0-9:._-]+` |
| heading_path | section string split on ` > ` separator; single element for flat headings |

**doc_role static map** (first-match wins, applied to source_file):

| Role | Files matched |
|------|--------------|
| `reference` | project-structure, config-env, benchmarking |
| `workflow` | mcp-workflow, sync |
| `multilingual` | multilingual |
| `concept` | providers, chunking, qdrant.md, obsidian |
| `other` | everything else |

All output arrays: deduped + sorted (deterministic).

### `src/scripts/backfill-entities.js` (new)

Path B payload-only backfill for existing collections. Scrolls collection,
runs extractor on stored `text`/`section`/`source_file`, issues
`set_payload` per point. Dry-run by default; `APPLY=1` to write.

```powershell
# Dry-run (read-only)
$env:COLLECTION = "my-collection"
node src/scripts/backfill-entities.js

# Apply
$env:APPLY = "1"
$env:COLLECTION = "my-collection"
node src/scripts/backfill-entities.js
```

Idempotent: skips points that already have `entities` and `doc_role` set.

### `benchmarks/retrieval/custom-50/entity-boost-bench.js` (new)

Bench-only post-RRF entity boost script. Uses a separate Qdrant collection
(`bench-retrieval-custom-50-entity`) so it does not interfere with the
standard `bench-retrieval-custom-50` collection.

Algorithm:
1. `hybridSearch(TOP_K)` → `trueBaseline` — identical limit to run-v3.js so
   `HYBRID_PREFETCH_LIMIT` (qdrant.js:66) applies the same way; no RRF pool
   difference between baseline and entity-boost comparison.
2. `hybridSearch(ENTITY_BOOST_PREFETCH)` → `wideCandidates` — wider pool used
   only for the boosted path; if `ENTITY_BOOST_PREFETCH <= TOP_K`, reuses
   `trueBaseline` (no extra Qdrant call).
3. `finalScore = rrfScore + ENTITY_BOOST_WEIGHT × |queryEntities ∩ chunkEntities|`
4. `stableSortResults(boosted).slice(0, TOP_K)` — stable tie-break as elsewhere.
5. "No new hard regressions" is checked against `trueBaseline`, not the wide pool.

Outputs a per-query table (baseline cr@5 vs entity-boost cr@5) and an
aggregate comparison table.

**Tunable env vars:**

| Var | Default | Meaning |
|-----|---------|---------|
| `ENTITY_BOOST_WEIGHT` | `0.0015` | Additive bonus per overlapping entity token |
| `ENTITY_BOOST_PREFETCH` | `20` | Candidate pool size before entity re-rank |
| `BENCH_TOP_K` | `10` | Final result set size |
| `BENCH_SKIP_INDEX` | unset | `1` = reuse existing collection |
| `BENCH_PROVIDER` | `env` | `onnx` = force ONNX embed |

```powershell
# First run (indexes fixtures):
$env:ONNX_EMBED = "1"; $env:BENCH_PROVIDER = "onnx"
npm run bench:custom50:entity-boost

# Subsequent runs (reuse collection):
$env:BENCH_SKIP_INDEX = "1"
npm run bench:custom50:entity-boost

# Weight sweep:
$env:ENTITY_BOOST_WEIGHT = "0.003"; $env:BENCH_SKIP_INDEX = "1"
npm run bench:custom50:entity-boost
```

---

## Files Modified

### `src/indexer/index.js`

- Added import: `import { extractEntities } from './phases/entities.js'`
- In `pointsWithDense` map: calls `extractEntities(chunk)` and spreads
  `entities` + `doc_role` into the point payload. No other changes.

Embedding input is unchanged: `context + "\n\n" + text` (line 159).

### `src/core/qdrant.js`

Added 5 payload indexes in `createCollection` (lines 247–254):

```js
await createPayloadIndex(name, 'entities.paths',    'keyword');
await createPayloadIndex(name, 'entities.symbols',  'keyword');
await createPayloadIndex(name, 'entities.env_vars', 'keyword');
await createPayloadIndex(name, 'entities.commands', 'keyword');
await createPayloadIndex(name, 'doc_role',          'keyword');
```

These apply to newly created collections. Existing collections need
`npm run sync` or `APPLY=1 npm run backfill:entities` to ensure indexes;
no manual Qdrant dashboard/API step required.

### `package.json`

Added two npm scripts:

```json
"bench:custom50:entity-boost": "node benchmarks/retrieval/custom-50/entity-boost-bench.js",
"backfill:entities":            "node src/scripts/backfill-entities.js"
```

---

## What Was NOT Changed

| Item | Status |
|------|--------|
| `src/mcp/tools/search.js` | Not touched — production scoring unchanged |
| `SCHEMA_VERSION` | Not changed — entity fields are payload-only |
| Embedding input | Not changed — `context + "\n\n" + text` only |
| Chunk boundaries | Not changed — chunker output is identical |
| Combined LLM default | Not changed |
| Existing payload fields | Not changed — `entities` and `doc_role` are additive |
| Stable ordering (`sort-results.js`) | Not changed |

---

## Smoke Tests

```
Smoke tests: 650 passed, 0 failed
```

`git diff --check`: clean (only CRLF autocrlf note, not an error).

---

## Migration Notes for Existing Collections

The skip-unchanged guard (`src/indexer/index.js:56–63`) means existing
collections will NOT receive entity fields on a plain reindex — unchanged
files are skipped because `file_hash`, providers, `schemaVersion`, and
`vectorSize` have not changed.

**Payload indexes on existing collections:**
`npm run sync` now includes all entity indexes in `REQUIRED_INDEXES`
(`sync.js:11`), so running sync on an existing collection creates the
indexes automatically — no manual step needed. `backfill:entities` also
calls `createPayloadIndex` before writing payloads when `APPLY=1`.

To backfill:

**Recommended (Path B — payload-only, no re-embed):**
```powershell
$env:APPLY = "1"; $env:COLLECTION = "my-collection"
npm run backfill:entities
# Indexes are ensured automatically before payload writes.
# Run `npm run sync` afterwards to update config.json if needed.
```

**Alternative (Path A — full re-embed):**
```powershell
$env:FORCE_REINDEX = "1"
npm run index -- <corpus-path>
```

---

## Pending

1. **Run the benchmark** (`npm run bench:custom50:entity-boost`) to measure
   whether entity boost lifts c35/c36/c37 cr@5 above the cliff.
2. **Sweep `ENTITY_BOOST_WEIGHT`** in range 0.001–0.005 if initial run
   shows partial improvement but not 3/3 source-navigation pass.
3. **Check no new hard regressions** across all 50 queries (the bench script
   reports this automatically).
4. **Update results README** with benchmark results once run.

## Accept criteria (from design report)

1. c35, c36, c37 all ✓ cr@5 across 3 fresh reindexes.
2. No new hard regressions (any ✓ → ✗ for cr@5).
3. Aggregate `chunkRecall@5` ≥ baseline, `chunkRecall@10` ≥ baseline.
4. MRR@10 and nDCG@10 may move within ±0.030 / ±0.014 noise floors.
