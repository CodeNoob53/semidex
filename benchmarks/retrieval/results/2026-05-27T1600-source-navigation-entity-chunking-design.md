# Source-Navigation / Entity-Aware Chunking — Design Report

*Generated: 2026-05-27*

## Status

Design proposal. **No code changes are part of this report.**

## Purpose

After the combined-mode investigation closed (`2026-05-27T1430-combined-post-stable-ordering-verification.md`)
and the search-ordering noise fix (`2026-05-27T1200-custom50-stable-ordering.md`),
the remaining stable weakness on custom-50 is the **source-navigation class**:
c35, c36, c37. The relevant chunks sit at the cr@5 rank-5/6 boundary with score
margins around ~0.001; which specific query falls below depends on the reindex,
but the class is consistently cliff-edge across every combined run.

This report:

1. Explains *why* c35/c36/c37 are weak under the current dense + sparse RRF pipeline.
2. Maps the gap onto the current payload schema.
3. Proposes an entity-aware design (file/path entities, heading entities,
   symbol/config entities, document-role entities, simple relations).
4. Proposes a backwards-compatible MVP that does not rewrite the index.
5. Lists explicit benchmark criteria for accepting/rejecting the MVP.
6. Lists what *not* to do during the MVP.

---

## c35, c36, c37 — Query Analysis

All three are `type: source-navigation`. All three target
`project-structure.md`. The expected `relevantChunks` correspond to:

- `project-structure.md#1` — *Source Tree* (the full tree diagram with file paths and inline comments listing functions)
- `project-structure.md#5` — *src/core/qdrant.js* (per-module subsection)
- `project-structure.md#6` — *src/indexer/phases/chunk.js* (per-module subsection)
- `project-structure.md#8` — *Entry Points* (npm command → module table)
- `project-structure.md#2` — *Source Tree* continuation

### c35

| Field | Value |
|-------|-------|
| Query | `де знаходиться src/core/qdrant.js і що він експортує` |
| Type | source-navigation |
| Expected qrels | `project-structure.md#5` (rel=3), `project-structure.md#1` (rel=2) |
| Target section(s) | "src/core/qdrant.js" subsection (lists `hybridSearch`, `mmrSearch`, `scroll`, `getStoredMeta`, `createCollection`); plus the Source Tree |
| Key tokens in query | `src/core/qdrant.js`, `експортує` (UA: "exports") |
| Why source-navigation | The user is asking *where in the repo* a specific file lives and what it exports. They are not asking a semantic question — they want a file pointer plus a function list. |

### c36

| Field | Value |
|-------|-------|
| Query | `chunkFile splitSentences parseMarkdown location in source` |
| Type | source-navigation |
| Expected qrels | `project-structure.md#6` (rel=3), `project-structure.md#1` (rel=3) |
| Target section(s) | "src/indexer/phases/chunk.js" subsection (mentions `chunkFile`); plus the Source Tree where the inline comment `# chunkFile(), splitSentences(), parseMarkdown()` lists all three names together |
| Key tokens in query | `chunkFile`, `splitSentences`, `parseMarkdown`, `location` |
| Why source-navigation | User asks for the module that defines these three specific function symbols. The chunk that lists *all three at once* is the inline source-tree comment; the per-module subsection mentions one of them. |

### c37

| Field | Value |
|-------|-------|
| Query | `npm run bench:custom50 entry point run-v3.js` |
| Type | source-navigation |
| Expected qrels | `project-structure.md#8` (rel=3), `project-structure.md#2` (rel=2) |
| Target section(s) | "Entry Points" table (the row that maps `npm run bench:custom50` → `benchmarks/retrieval/custom-50/run-v3.js`); plus the Source Tree row that names `run-v3.js` |
| Key tokens in query | `npm run bench:custom50`, `bench:custom50`, `run-v3.js`, `entry point` |
| Why source-navigation | User asks for a command-to-module mapping. The Entry Points table is the canonical answer; the Source Tree contains the same mapping but spread across two lines. |

---

## Why These Queries Sit at the cr@5 Cliff

### Signals that currently help

| Signal | How it helps c35/c36/c37 today |
|--------|---------------------------------|
| `text` (dense vector) | The per-module subsection text mentions the module path and the function names. BGE-M3 dense gets the topic right. |
| `text` (sparse vector) | Sparse leg catches exact tokens like `qdrant.js`, `chunkFile`, `bench:custom50`. This is what currently keeps these chunks in top-10. |
| `context` (prepended to text at embed time) | A 1–2 sentence LLM summary. Helps for *conceptual* queries; for source-navigation it often paraphrases the section purpose ("Describes the qdrant module") without preserving exact identifiers. |
| `section` (payload) | Stored but **not in the embedding input** and **not in default `qdrant_search`**. Only used by MCP for display and by `qdrant_find_by_tag` grouping (indirectly via source_file). |
| `tags` (payload) | Stored only, **not in embedding input** (`src/indexer/index.js:159,205`). Default `qdrant_search` does not filter by tags. |
| `source_file` (payload, indexed) | Filterable, but `qdrant_search` does not filter by it. Used for grouping, dedup, and `find_by_tag`. |
| `links` / `backlinks` (payload) | Used by `qdrant_related` and `qdrant_backlinks` — these are *separate tools*, not part of `qdrant_search` scoring. |

### Signals that are missing or weak

1. **No structured "this chunk defines/mentions symbol X" signal.** When the
   query is "chunkFile splitSentences parseMarkdown", the chunks that mention
   these names compete on the same dense+sparse vectors as any chunk that
   *talks about* chunking generally. There is no way to say "boost chunks
   whose code-identifier set intersects the query's code-identifier set".

2. **No path-component signal.** A query containing `src/core/qdrant.js`
   embeds the path as a sequence of subword tokens. The chunk whose section
   heading is literally `### src/core/qdrant.js` has that string in `text`
   *and* in `section`, but `section` is not embedded and not weighted.

3. **No document-role signal.** `project-structure.md` is a *reference document*
   (table of contents, source tree). It plays a structurally different role
   from `providers.md` (concept doc). The retriever cannot prefer reference
   docs for source-navigation queries vs concept docs for conceptual queries.

4. **No symbol → section index.** MCP has `qdrant_find_by_tag`, but tags are
   LLM-generated topical labels (e.g. `qdrant-client`, `hybrid-search`), not
   precise code symbols. There is no `qdrant_find_by_symbol("chunkFile")`.

5. **Source Tree is a single big chunk.** `project-structure.md#1` (Source
   Tree) contains the entire 60-line tree diagram including all file paths
   and all inline function comments. Anything inside it is diluted by 60
   lines of other paths. Sparse and dense both have to compete with much
   "off-topic-within-the-chunk" content.

6. **The Entry Points table is a single chunk.** Same dilution effect —
   `npm run bench:custom50 → run-v3.js` is one row among seven; the other
   six rows add noise to the embedding.

### Why this manifests as a cliff and not a recall=0 failure

The expected chunk is always present in top-10 (chunkRecall@10 = 95.9%
across all runs). The signal is *strong enough to retrieve* but *weak
enough to lose 1–2 ranks* against unrelated chunks from the same or
adjacent files. With a top-10 score spread of ~0.0037 and rank-5 → rank-6
margin of ~0.0007, any embedding drift (combined-prompt context, sparse
weights variation, even fresh-reindex UUIDs) flips the cliff.

---

## Current Payload Schema (Baseline)

Production payload, per `src/indexer/index.js:200–213`:

```json
{
  "text":                       "...",        // embedded (with prepended context)
  "context":                    "...",        // embedded (prepended to text)
  "section":                    "...",        // payload only
  "source_file":                "...",        // payload only, payload-indexed (keyword)
  "tags":                       ["..."],       // payload only, payload-indexed (keyword)
  "links":                      ["..."],       // payload only, used by related/backlinks tools
  "backlinks":                  ["..."],       // payload only
  "chunk_index":                <int>,         // payload only, payload-indexed (integer)
  "total_chunks":               <int>,         // payload only
  "file_hash":                  "...",        // reindex discriminator
  "vector_size":                <int>,         // reindex discriminator
  "embedding_schema_version":   <int>,         // reindex discriminator
  "dense_provider":             "...",        // reindex discriminator
  "sparse_provider":            "...",        // reindex discriminator
  "dense_model":                "..."         // reindex discriminator
}
```

What goes into the embedding: `context + "\n\n" + text`. Everything else is
payload-only.

---

## Proposed Entity-Aware Design

### Entity types worth extracting

| Entity type | Examples in fixture corpus | Source of truth | Why it would help |
|-------------|---------------------------|-----------------|-------------------|
| **path** | `src/core/qdrant.js`, `benchmarks/retrieval/custom-50/run-v3.js` | regex over text + section headings | Direct match for source-navigation queries; supports a future "find chunk that documents this file" path |
| **symbol** | `chunkFile`, `splitSentences`, `resolveEnvProviders`, `hybridSearch`, `SCHEMA_VERSION` | regex (camelCase, ALL_CAPS, snake_case_with_parens) over text | Exact code-identifier match; query "chunkFile splitSentences parseMarkdown" matches the chunk whose symbol set is `{chunkFile, splitSentences, parseMarkdown}` |
| **env-var / config-key** | `MAX_CHUNK_TOKENS`, `ONNX_EMBED`, `HYBRID_PREFETCH_LIMIT`, `BENCH_SKIP_INDEX` | regex (ALL_CAPS_WITH_UNDERSCORES) over text | Same as symbol but cleaner subclass; helps config-env query class |
| **command** | `npm run bench:custom50`, `npm run sync`, `npm run mcp` | regex (`npm run [a-z0-9:-]+`) | Entry-point lookups (c37) |
| **heading-path** | `Project Structure > Key Modules > src/core/qdrant.js` | from the existing section + parent chain in `parseMarkdown` | Lets a query containing `src/core/qdrant.js` match against the heading itself, not just the body |
| **doc-role** | `reference` (project-structure, config-env), `concept` (providers, chunking), `workflow` (mcp-workflow, sync), `multilingual` | per-file annotation (manual or rules-based) | Source-navigation queries should prefer `reference` docs |
| **relations** (light) | `defines(symbol → chunk)`, `mentions(symbol → chunk)`, `entry_point(command → module)` | derived from path + symbol entities | Foundation for `qdrant_find_by_symbol` and a future graph navigator |

The relations `depends_on`, `supersedes`, `supports` from the task spec are
broader; for the MVP they are out of scope and would belong to a graph
rewrite, not an additive payload field.

### Where to store entities

Add new payload fields. No vector changes. No embedding-input changes.

```json
{
  // ... existing payload fields ...
  "entities": {
    "paths":      ["src/core/qdrant.js"],
    "symbols":    ["hybridSearch", "mmrSearch", "scroll", "getStoredMeta", "createCollection"],
    "env_vars":   [],
    "commands":   [],
    "heading_path": ["Project Structure", "Key Modules", "src/core/qdrant.js"]
  },
  "doc_role": "reference"
}
```

`entities.symbols` and `entities.paths` can be added as Qdrant keyword
payload indexes (same mechanism as `tags` today — see
`src/core/qdrant.js:248` `createPayloadIndex(name, 'tags', 'keyword')`).

### How each entity helps each MCP tool

| Tool | Benefit |
|------|---------|
| `qdrant_search` | Two distinct mechanisms, must not be confused: **(a) Filter-only** — a Qdrant `should` clause is an OR-filter (per Qdrant filtering docs: "the clause becomes true if at least one condition listed inside `should` is satisfied … equivalent to the operator `OR`"). It can *narrow* the candidate set but does **not** modify scores. Useful for `qdrant_find_by_symbol`-style strict lookups; risky for `qdrant_search` because narrowing can drop recall. **(b) Score boosting** — must be a separate rerank stage *after* RRF retrieval. Either client-side post-RRF additive bonus (the MVP path) or a server-side Qdrant 1.14+ Score-Boosting Reranker (`formula` query after a `prefetch` stage). The MVP uses client-side post-RRF rerank only; no `should` clause is added to `qdrant_search`. |
| `qdrant_get_chunk` | Return `entities` alongside the chunk so the agent sees what the chunk "is about". No scoring change. |
| `qdrant_related` | Use entity overlap as an additional similarity signal alongside the existing link graph. |
| `qdrant_backlinks` | Unchanged — backlinks already operate on the link graph. Optionally surface "co-mentioning chunks" via shared symbols. |
| `qdrant_find_by_tag` | New sibling: `qdrant_find_by_symbol`, `qdrant_find_by_path`. Same shape as find_by_tag, but filtered on `entities.symbols` / `entities.paths`. |
| `list_files` / `list_tags` | New sibling: `list_symbols`, `list_paths`. Cheap and useful for agent autocomplete. |

---

## MVP — Minimal, Backwards-Compatible

### Scope

**One indexer phase + one payload-index migration + one optional rerank pass.**
No embedding-input change. No collection recreate. No production MCP scoring
change in the default code path.

### Steps (design, not implementation)

1. **Entity extractor phase** (`src/indexer/phases/entities.js`, new). Runs
   after `chunk.js`. Pure regex / heuristic, no LLM:
   - paths: `(?:src|benchmarks|docs)/[\w./-]+\.(?:js|md|json)`
   - symbols: `\b[a-z][a-zA-Z0-9]*(?=\()`, `\b[A-Z][A-Z0-9_]{2,}\b`,
     `\b[a-z]+[A-Z][a-zA-Z0-9]*\b` (camelCase)
   - env-vars: `\b[A-Z][A-Z0-9_]{4,}\b` filtered to known prefixes
   - commands: `npm run [a-z0-9:-]+`
   - heading_path: built from the section chain that `parseMarkdown` already
     produces (already a TODO; `parseMarkdown` keeps only the immediate heading
     today)
2. **Payload additions** — `entities.{paths,symbols,env_vars,commands,
   heading_path}` and `doc_role`. Old payloads without these fields keep
   working; consumers must handle `undefined`.
3. **Payload indexes** — extend `src/core/qdrant.js` `ensurePayloadIndexes`
   (currently lines 247–249) to also index:
   - `entities.paths` (keyword)
   - `entities.symbols` (keyword)
   - `entities.env_vars` (keyword)
   - `doc_role` (keyword)
4. **doc_role classifier** — start as a static map keyed by source_file
   suffix or by a frontmatter field. No LLM. Five values: `reference`,
   `concept`, `workflow`, `multilingual`, `other`.
5. **Benchmark-only retrieval variant** — new bench script
   `benchmarks/retrieval/custom-50/entity-boost-bench.js` that, after
   `hybridSearch` returns top-K, computes an entity-overlap score and
   applies a small additive boost (e.g. `+0.0015 × |query_entities ∩
   chunk_entities|`). The boost size is tunable. This is the *only* MVP
   change that touches scoring, and it lives in the benchmark, not in
   production MCP.
6. **Migration** — add the entity phase to the indexer. **A plain reindex
   will not backfill existing collections**: the indexer skips unchanged
   files when `file_hash`, providers, `schemaVersion`, and `vectorSize`
   all match the stored payload (see `src/indexer/index.js:56–63`).
   Adding `entities.*` and `doc_role` to the payload schema does not
   change any of those discriminators, so unchanged files would remain
   without the new fields. Three explicit backfill paths, pick one:

   - **Path A — `FORCE_REINDEX=1`** (existing flag, see `src/indexer/index.js:56`).
     Re-embeds every file. Correct but expensive: full embedding cost
     for every chunk in every collection. Acceptable for small fixture
     collections (custom-50: ~96 points) but heavy for production
     corpora.
   - **Path B — payload-only backfill script** (new, `src/scripts/backfill-entities.js`).
     Scrolls each collection, runs the entity extractor on `text` /
     `section` already present in the payload, and issues a Qdrant
     `set_payload` call per point. No re-embedding. This is the
     recommended MVP migration: cheap, idempotent, and re-runnable
     when the extractor regex set changes.
   - **Path C — `entity_payload_version` discriminator** (new payload
     field + new skip-condition). Adds a sixth reindex discriminator
     parallel to `embedding_schema_version`, scoped to entity payload.
     When bumped, the indexer treats unchanged files as stale *for
     entity payload only* and re-runs the entity phase without
     re-embedding. Cleanest long-term, but requires a small change to
     the skip-unchanged guard in `index.js` to split "embedding stale"
     from "payload-only stale".

   For the MVP recommend **Path B** (payload-only backfill script).
   It is the smallest change, requires no production-code modification
   to the skip-unchanged logic, and runs against any existing
   collection in one pass. Old collections that have not yet been
   backfilled simply do not contribute entity overlap until the
   script runs (graceful degradation).

### What stays unchanged

- Embedding input (`context + "\n\n" + text`).
- Dense + sparse vectors, their providers, `SCHEMA_VERSION`.
- Production MCP `qdrant_search` ranking logic.
- All six existing MCP tools.
- Stable-ordering tie-break (`benchmarks/retrieval/custom-50/sort-results.js`).

### Why this is reversible

The MVP adds payload fields and payload indexes. If the benchmark shows
no improvement, the new fields cost ~100 bytes per point and a few payload
indexes (Qdrant keyword indexes are cheap). No data is lost; nothing
needs to be unindexed. The entity extractor can be removed without
touching vectors.

---

## Benchmark Criteria for MVP

Run on custom-50, ONNX, hybrid + stable ordering.

### Primary criteria — accept the MVP if all three hold

1. **Source-navigation cr@5**: c35, c36, c37 all ✓ across **three fresh
   reindexes**. Today: at least one of the three fails in each reindex.
2. **No new hard regressions**: no query that was ✓ cr@5 on baseline
   becomes ✗ cr@5 with entity boost. Verified across the same 3 reindexes.
3. **Aggregate stability**: `chunkRecall@5` ≥ baseline + 0pp,
   `chunkRecall@10` ≥ baseline. MRR@10 and nDCG@10 may move within their
   noise floors (±0.030, ±0.014).

### Secondary criteria — track but do not gate

- **c41 status**: c41 is a *conceptual* query about benchmark-tier
  comparison. Entity boost should not affect it; if c41 changes
  meaningfully, that is unexpected and worth investigating.
- **Other source-navigation-shaped queries**: c11 (`getStoredMeta`), c13
  (`source_file payload index`), c18 (`splitSentences`), c40 (chunkId
  format) all contain code identifiers. None are class `source-navigation`
  in queries.json, but their MRR with entity boost is informative.
- **Config-env class**: c15, c20, c43, c45 contain env-var entities. The
  same entity-overlap logic should help; if it doesn't, the boost
  formulation is wrong.

### Failure modes to watch

- **Boost too large**: dominates RRF score, pushes semantically relevant
  chunks below entity-matching but topically wrong chunks. Symptom:
  conceptual queries (c02, c17, c21, c23) regress.
- **Entity extraction over-fires**: ALL_CAPS regex picks up `RRF`, `MMR`,
  `BM25`, etc., everywhere. Symptom: too many chunks get the same
  `env_vars` entry, dilution returns. Fix: maintain a stoplist or require
  prefix (e.g. `BENCH_*`, `RERANK_*`).
- **Source Tree dominates everything**: a single chunk that lists every
  file in the project will match many path-bearing queries. Symptom: c35
  improves but c08/c09/c10 (which target `qdrant.md`, not
  `project-structure.md`) regress because Source Tree starts beating
  topical chunks. Fix: cap entity-overlap contribution per chunk, or
  weight by entity rarity (TF-IDF-ish over the entity set, not the text).

---

## What NOT To Do During the MVP

1. **Do not enable `COMBINED_LLM=1` by default.** ADR 0004 and the
   2026-05-27 post-stable-ordering verification keep combined opt-in.
   The c41 gemma3 regression is real and tied to a different problem
   (context identifier loss), not source-navigation.

2. **Do not change `src/mcp/tools/search.js` scoring.** All MVP scoring
   experiments live in the benchmark harness
   (`benchmarks/retrieval/custom-50/entity-boost-bench.js`). Production
   MCP changes wait for the benchmark verdict.

3. **Do not rewrite the link/graph subsystem.** The MVP is *additive
   payload + payload indexes + bench-only rerank*. Relations like
   `defines`, `mentions`, `depends_on`, `supersedes` are listed in the
   design for context but are explicitly out of MVP scope.

4. **Do not introduce an LLM step into the entity extractor.** Keep it
   regex-only for the MVP. An LLM-assisted extractor is a separate
   investigation and would re-introduce combined-mode-style variance.

5. **Do not change the embedding input.** `context + "\n\n" + text` stays.
   Adding entities into the embedding string would invalidate the
   stored vectors and force a global reindex.

6. **Do not change chunk boundaries yet.** Splitting the Source Tree
   into one chunk per top-level directory, or splitting Entry Points
   into one chunk per row, would help these queries directly — but it
   changes `chunk_index` for every chunk after the split point, which
   invalidates all qrels in queries.json and every backlink. Chunk
   boundary changes belong to a separate, larger task with its own qrel
   migration.

7. **Do not move tags into the embedding input.** That was already
   explored under combined-mode and rejected. Tags stay payload-only.

---

## Open Questions

These are worth answering during MVP implementation but do not block the
design:

1. Should the boost be additive on RRF scores, or applied as a re-rank
   stage after RRF top-K? (Suggest: re-rank top-20 → top-10. Cheaper,
   does not perturb the underlying dense/sparse fusion.)
2. Should heading_path be a single string ("> "-joined) or an array?
   Qdrant keyword payload index works on arrays; an array gives free
   "match any ancestor heading" filtering.
3. Should `qdrant_find_by_symbol` accept multiple symbols (AND vs OR)?
   queries.json c36 suggests OR with a "more matches → higher score"
   ranking.
4. Should the Source Tree chunk be flagged with a `doc_role:
   reference-tree` subtype so the entity boost can downweight it when
   a more specific per-module chunk is also a candidate?

---

## Raw Evidence

- `benchmarks/retrieval/results/2026-05-27T1430-combined-post-stable-ordering-verification.md` — confirms source-navigation as the remaining real weakness
- `benchmarks/retrieval/results/2026-05-27T1200-custom50-stable-ordering.md` — proves search-ordering is no longer a confound
- `benchmarks/retrieval/results/2026-05-27T0430-c41-combined-regression-diagnostic.md` — diagnostic style reference; also confirms tags are not in embedding input
- `benchmarks/retrieval/custom-50/queries.json` — c35/c36/c37 source
- `benchmarks/retrieval/custom-50/fixtures/docs/project-structure.md` — target document

No private absolute paths, no private corpus content.
