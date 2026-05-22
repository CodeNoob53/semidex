# Roadmap

semidex is not trying to become a general memory platform. The focus is narrower:
an agent-grade local RAG index for real project knowledge, codebase notes, specs,
and technical documentation.

This roadmap is intentionally benchmark-driven. New retrieval features should
prove that they improve chunk-level quality, agent usability, or operational
reliability before becoming defaults.

## Product Direction

The core direction is:

- local-first indexing and retrieval
- Qdrant as the retrieval database
- structure-aware chunking as a first-class feature
- dense + sparse hybrid search as the default path
- MCP workflows for AI agents
- Obsidian-compatible review output for human quality control
- reproducible benchmarks before ranking changes

semidex should stay useful as a small local tool, while growing into a rigorous
RAG layer for larger technical corpora.

## Roadmap Principles

| Principle | Meaning |
|-----------|---------|
| Improve existing strengths first | Prefer better chunking, retrieval diagnostics, and agent workflows over broad new product surfaces |
| Keep raw text authoritative | LLM summaries, tags, and graph links enrich chunks, but never replace source text |
| Benchmark before defaults | Rerank, MMR, trigger policies, and future ColBERT work must be measured before becoming default behavior |
| Make chunks inspectable | Users should be able to review and audit indexed knowledge through Obsidian-compatible Markdown output |
| Keep storage focused | Qdrant remains the storage and search engine; no Postgres/Chroma/backend rewrite is planned |
| Local-first by default | The primary path should not require external APIs for document content |

## Current Baseline

### Implemented and default

- structure-aware document indexing
- LLM context summaries and tags
- dense + sparse named vectors in Qdrant
- **hybrid dense+sparse RRF** — production default for `qdrant_search`; covers exact technical tokens, paraphrases, and multilingual queries
- BGE-M3 ONNX multilingual provider
- Ollama + hashed-TF fallback provider
- MCP reader tools
- MCP search context window (`window=1`)
- compact deduplicated window output
- semantic graph links and backlinks
- Obsidian-compatible `chunks_out/` review artifacts
- PDF structured chunking — `@opendocsg/pdf2md` Markdown conversion with heading-aware section splitting (H1–H6 recovered)
- 21-query regression benchmark
- custom-50 chunk-level quality benchmark
- diagnostics, failure analysis, candidate comparison, and threshold sweep tooling

### Implemented, opt-in, default off

- **Local reranker** (`RERANK_ENABLED=1`) — neutral on the 21-query benchmark; keep disabled unless it improves on your own data
- **MMR benchmark mode** (`BENCH_SEARCH_MODE=dense-mmr`, `npm run bench:retrieval:mmr`) — dense-only evaluation, not a production MCP mode
- **PRUNE_STALE=1** — opt-in stale-file cleanup after indexing

### Audited and deferred

- **MMR runtime opt-in (`search_mode="dense_mmr"`)** — deferred; see criteria below
- **Full-text / literal payload search** — deferred; see criteria below

## Phase 1 - Stabilize Retrieval Quality

Goal: make the existing retrieval system easier to measure, debug, and trust.

Planned work:

- document final conclusions from custom-50 diagnostics and threshold sweep
- extend custom-50 with large-document stress fixtures
- add explicit chunk-quality checks:
  - answer not split across unrelated chunks
  - chunk is self-contained enough for an agent
  - section boundaries do not leak unrelated context

Recent Results (`agent-window-eval` at `top=3`/`window=1`):
- `full` mode avg ~7.7k chars
- `compact` mode avg ~5.2k chars (~32% reduction)
- `compact` mode preserved expected hints 5/5
- Default remains `window=0`
- keep tuning policies out of production until they improve metrics across runs
- define clear pass/fail expectations for regression and quality benchmarks

Success signals:

- higher or stable `chunkRecall@5`
- stable `windowRecall@5`
- lower duplicate source rate where diversity matters
- no regression in multilingual and technical-token queries
- benchmark reports explain failures without manual guesswork

## Phase 2 - Agent Workflow

Goal: make semidex easier for AI agents to use correctly.

Planned work:

- design an agent wake-up workflow:
  - collection overview
  - project architecture pointers
  - important docs
  - recent decisions if available
  - suggested follow-up searches
- design first-run documentation self-indexing:
  - create or update a reserved local docs collection such as `semidex-docs`
  - index `README.md`, `AGENTS.md`, and `docs/` so agents can query semidex usage, architecture, and troubleshooting through MCP
  - make first-run cost visible, especially provider setup and model downloads
  - mark the collection as internal/semidex-managed so it does not pollute user project link targets by default
- document recommended MCP search patterns:
  - search first
  - expand with `qdrant_get_chunk(window=1)`
  - follow related/backlinks when the task spans files
  - use tags and source filters for narrow tasks
- preserve and improve strengths found during real MCP dogfooding:
  - `qdrant_get_chunk` with `window` is high-value because agents can read a
    document section as a document, not as isolated snippets
  - `qdrant_search(window=1, window_format="compact")` is a strong default for
    implementation and explanation tasks, but compact output should make it
    easy to continue to the next/previous chunk when useful context is cut off
  - `qdrant_find_by_tag` is useful when the agent knows the exact tag, but it
    is underused without a way to discover available tags first
  - source-file filters are powerful after a likely file is known, but exact
    `source_file` paths are a friction point when the agent only knows a folder,
    partial filename, or approximate title
- evaluate MCP navigation helpers before adding broader write-capable memory:
  - `qdrant_list_files(collection, prefix?)` for "what exists under this folder?"
    navigation
  - `qdrant_list_tags(collection, prefix?, min_count?)` so agents can discover
    valid tags before calling `qdrant_find_by_tag`
  - source-file suggestion or fuzzy path recovery when `qdrant_get_chunk` returns
    "No chunks found" for a mistyped path
  - optional `path_format="short"` plus a lookup table to reduce token cost from
    long repeated `source_file` paths in agent-facing responses
  - a derived `confidence` signal above RRF rank scores, based on evidence such
    as dense similarity, score spread, exact-token overlap, source diversity, and
    context/section agreement
  - adaptive `top` guidance for ambiguous searches, exact-token lookups, and
    broad navigation tasks
  - an MCP self-test / sanity-check workflow that confirms collection health and
    a known-good search result before a long agent investigation
- explore **Synthetic Intuition** as a future cheap routing layer:
  - use lightweight signals before expensive LLM calls or retrieval expansion
  - suggest likely collection, source scope, search tactic, diagnostic path, or
    benchmark report to inspect
  - treat the output as directional guidance, not as evidence or an answer
  - rely on metadata and measurements such as provider config, phase timings,
    source diversity, exact-token overlap, section/tag hints, graph neighbors,
    and previous benchmark verdicts
  - keep it local, explainable, and benchmarked before any default behavior
- evaluate whether a controlled `agent-notes` collection is worth adding
- keep any write-capable MCP memory tool disabled by default unless it has a clear safety model

Success signals:

- agents need fewer blind file reads
- agents retrieve surrounding context more often
- agents choose a useful first search or diagnostic path more often
- fewer answers are based on a single isolated chunk when the task needs a section or file context
- agents can browse unfamiliar collections without already knowing exact
  filenames or tag names
- tag filtering becomes more useful because agents can discover the tag
  vocabulary first
- source path length and repeated provenance do not consume excessive context
  budget in typical top-3/top-5 results

## Phase 3 - Observability and Diagnostics

Goal: make local deployments easier to debug without exposing user content.

Planned work:

- add local search observability:
  - provider
  - collection
  - latency
  - top-K
  - RRF settings
  - source diversity
  - duplicate source rate
  - rerank/MMR mode
- add duplicate point diagnostics:
  - detect repeated `source_file + chunk_index` hits with different point IDs,
    tags, context, or provider metadata
  - report likely causes such as reindexing with random point IDs, changed tag
    model output, interrupted indexing, or missing same-source cleanup
  - make clear that `PRUNE_STALE=1` removes absent source files but does not
    deduplicate multiple points that still share the same live `source_file`
  - provide a safe repair path, such as delete-and-reindex one affected
    `source_file` or run a future collection-level duplicate cleanup command
- design a diagnostic bundle command that collects:
  - smoke output
  - config metadata without secrets
  - Qdrant collection/schema info
  - benchmark summaries
  - latest diagnostics reports
  - environment hints
- exclude raw user document text from diagnostic bundles by default

Success signals:

- easier bug reports
- faster provider mismatch diagnosis
- easier comparison between local and CI benchmark results

## Phase 4 - Retrieval Experiments

Goal: test more advanced retrieval ideas without destabilizing the default path.

### Deferred: MMR runtime opt-in (`search_mode="dense_mmr"`)

Implementation plan: `benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`

Duplicate pressure audit: `benchmarks/retrieval/results/2026-05-14-duplicate-source-pressure-audit.md`

Stage 1 (docs-only guidance) is complete. Stage 2 (runtime `search_mode` parameter) is
deferred until **all** of the following criteria are met:

- Live broad-query `dupSourceRate` ≥ 60% for ≥ 3 of the 12 defined exploratory queries
  (see audit for query set)
- Agent answer quality is confirmed to degrade (not just a statistical metric)
- onnx Recall@1 regression budget is defined (e.g. ≤ −2pp acceptable)
- Smoke tests for argument routing pass (5 cases defined in the audit)

Background: the 61.9% `dupSourceRate` from the 21-query benchmark comes from
exact/technical queries with single-file dominance — not broad exploratory queries.
Broad queries naturally pull 3–4 distinct files. MMR penalises the ONNX provider
by 4.8pp Recall@1 at all tested diversity values; for ollama the tradeoff is neutral
at diversity=0.3. Until the broad-query duplicate pressure is measured live, the
hypothesis that hybrid RRF harms exploratory search is unconfirmed.

### Deferred: Full-text / literal payload search

Audit: `benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md`

The custom-raw benchmark (bge-m3-onnx, 2026-05-12) achieved 100% tokenHit@5 on all
7 exact-token queries including error strings, env var assignments, and log line
fragments. Hybrid sparse already covers the use cases attributed to literal search.

Deferred until **one** of the following:

- `tokenHit@5` < 90% on custom-raw exact-token queries after a provider or chunking change
- A reproducible user case where hybrid returns the wrong chunk despite the exact string
  being present in the corpus
- hashed-TF gap confirmed: exact-token recall < 70% on raw-log corpora with hashed-TF,
  confirming the problem is not just "use ONNX_EMBED=1"

Note: Qdrant `match: { text: "..." }` is still tokenized, not true verbatim substring
search. The claimed advantage over hybrid sparse (exact substring) does not exist in the
Qdrant filter API. The right lever for improving literal recall on raw-log corpora is
switching from hashed-TF to bge-m3-onnx, not adding a payload text index.

### Remaining experiments

- MMR policy evaluation beyond dense-only benchmark mode
- stronger lexical fallback than hashed-TF
- ColBERT / late-interaction rerank prototype
- query expansion only when diagnostics indicate a likely miss
- graph-aware retrieval expansion through existing file links and backlinks
- separate wide candidate retrieval from compact agent-facing output

ColBERT remains a roadmap item, not an immediate default. It should be tested
only after benchmarks show that the correct chunk is often present in a wider
candidate pool but ranked too low by hybrid RRF.

### Candidate pool vs output context

Hybrid-search examples commonly retrieve a wider dense/sparse candidate pool
before returning a much smaller final context to the language model. semidex
should keep this distinction explicit:

- retrieval may prefetch more candidates than are shown to the agent
- dense and sparse candidate limits can be tuned independently in benchmarks
- MCP output should stay compact, provenance-rich, and suitable for agent use
- `top=3`, `window=1`, and `window_format="compact"` remain agent-facing output
  policy candidates, not limits on internal retrieval
- negative/distractor diagnostics should evaluate whether the final compact
  context contains enough evidence for an agent to refuse unsupported answers

### Graph-aware retrieval expansion

Qdrant GraphRAG examples show a useful pattern: run vector search first, then
use stable IDs from the vector results to retrieve related graph context. semidex
should explore the same idea with its existing lightweight file graph before
introducing external graph databases.

Possible shape:

- use `source_file` and `chunk_index` as stable cross-reference IDs
- after top results are found, optionally show related files and backlinks near
  the result
- prefer file-level graph metadata, tags, and provenance before LLM-generated
  ontology extraction
- evaluate multi-hop agent tasks where one search result points to supporting
  context in a linked file
- avoid Neo4j or full Knowledge Graph dependencies until benchmarks show a clear
  need

Success criteria:

- graph expansion improves multi-hop task success without hurting direct lookup
- agents can explain why related context was included
- added graph context remains compact enough for MCP use
- raw text and Qdrant payloads remain the source of truth

Success signals:

- improvement in `MRR@10` or `nDCG@10` without hurting `chunkRecall@5`
- measurable recovery of known miss classes
- acceptable latency overhead
- clear trigger rules for when expensive paths run

## Phase 5 - External Evaluation

Goal: compare semidex quality with broader retrieval and memory benchmarks while
keeping claims honest.

Planned work:

- keep custom-50 as the internal quality benchmark
- add held-out or generated large-doc benchmarks before publishing broad claims
- evaluate selected external datasets only when their metric matches semidex's purpose
- clearly separate:
  - retrieval recall
  - chunk-level recall
  - answer-generation accuracy
  - agent task success

Possible references:

- BEIR-style retrieval metrics
- MTEB retrieval/reranking tasks
- LongMemEval-style memory retrieval, if adapted carefully
- synthetic project-doc benchmarks with exact chunk qrels

Success signals:

- reproducible reports committed under `benchmarks/retrieval/results/`
- clear caveats for every published number
- no comparison between incompatible metrics

## Phase 6 - Incremental Codebase Memory

Goal: make semidex useful as a live memory layer for large software projects,
where the index follows source changes without requiring a full reindex after
every edit.

This is a future concept, not immediate implementation work. The intended shape
is closer to an incremental project index than a one-shot document import.

### Git-like incremental indexing

Stage 1 — partial incremental sync (implemented):

- deleted-file cleanup: implemented via `PRUNE_STALE=1`; after the indexing loop,
  points whose `source_file` is absent from the current directory scan are removed
  from Qdrant (opt-in, directory-scope only — see configuration docs)
- changed-file skip: implemented via hash/provider metadata; files already indexed
  with the same content hash and provider are skipped without re-embedding
- rename behavior: documented — the old `source_file` persists in Qdrant until
  `PRUNE_STALE=1` is run over the full source root; the new path is indexed as a
  fresh file

Stage 2 — full incremental sync (planned):

- index a whole repository with stable include/exclude rules and `SOURCE_ROOT`
- store a per-collection manifest of source files, hashes, provider metadata, chunking settings, and source root
- detect changed, new, deleted, and renamed files (e.g. optionally use `git status --porcelain` as a fast change signal, with a scan-based fallback)
- add a same-hash move/rename fast path: when a file's content hash is unchanged
  but `source_file` changed, reuse existing chunks/vectors and update only
  path-dependent payload or point IDs instead of rerunning chunk/context/tag/embed
- use stable point IDs for deterministic upsert
- use Qdrant batch update/delete operations
- force a full reindex only when provider, schema, vector size, or chunking settings change
- goal: large codebase/project indexing without full rebuild

This should not try to replace Git. Git can provide useful change information,
but semidex's responsibility is keeping the retrieval index aligned with the
current working tree.

Possible command shape:

```bash
COLLECTION=my-project SOURCE_ROOT=. npm run index:project
COLLECTION=my-project SOURCE_ROOT=. npm run sync:project
COLLECTION=my-project SOURCE_ROOT=. npm run watch:project
```

Later extensions:

- code-aware chunking for JavaScript, TypeScript, Python, and backend service
  files
- chunking by functions, classes, exports, route handlers, config blocks, and
  module boundaries instead of sentence-only splitting
- branch or commit metadata for agent awareness
- MCP guidance that tells agents whether the index is fresh or stale relative
  to the working tree

Success signals:

- deleted files disappear from search results (opt-in via `PRUNE_STALE=1` — implemented)
- unchanged files are skipped during re-index runs (implemented via hash/provider metadata)
- large repositories can be refreshed without full reindexing
- changed files become searchable quickly
- agents search current codebase state instead of stale snapshots
- indexing cost scales with the size of the change, not the size of the repo

## Phase 7 - Structured PDF Ingestion

Goal: recover heading structure and section metadata from PDF files without requiring external pre-processing steps.

**Current status (Stage 1 — implemented):** `@opendocsg/pdf2md` converts PDF to Markdown; chunking uses the same heading-aware `parseMarkdown` path as `.md` files. H1–H6 headings are recovered as `section` values. Scanned/image-only PDFs with fewer than 3 detected headings fall back to `pdf-parse` plain-text extraction with `section: ""`. Pandoc cannot read PDFs as an input format.

Remaining work (Stage 2+): improve structure recovery for edge cases (scanned PDFs, complex layouts, tables).

Possible approaches (not yet evaluated):

- OCR pipeline for scanned PDFs (e.g. `pymupdf`-based tooling or a document layout model)
- companion `.md` sidecar file that provides structure, with the PDF used only for page-marker alignment
- structured extraction using an LLM with vision input (e.g. page-image → heading detection)

Any approach must be benchmarked against the existing plain-text path before becoming a default, since extraction errors could degrade chunk quality compared to the current clean paragraph-based fallback.

Success signals:

- PDF chunks have correct `section` values matching document headings
- no regression in retrieval quality on clean-text PDFs
- external tool dependency is clearly documented and optional

## Phase 8 - Semidex Control Panel

Goal: provide a local user-facing control panel for setup, collection management,
indexing, diagnostics, manual search, and graph inspection without requiring users
to edit `.env`, inspect `config.json`, or compose CLI commands by hand.

This is a future product surface, not part of the current benchmark and retrieval
stabilization work. It should wrap the existing CLI/core/MCP capabilities rather
than introduce new retrieval behavior.

Possible scope:

- first-run setup for `QDRANT_URL`, `QDRANT_KEY`, provider mode, and local model checks
- `npm run doctor` results shown as PASS/WARN/FAIL cards with repair commands
- collection list with point counts, provider metadata, schema compatibility, and descriptions
- create benchmark/test collections and edit collection descriptions with safety checks
- file/folder picker for indexing into a selected collection
- indexing options such as `SOURCE_ROOT`, `PRUNE_STALE`, `MAX_CHUNK_TOKENS`, provider mode, and ONNX execution provider
- live indexing progress by phase: chunking, context, tags, embedding/upsert, links, and review output
- copyable CLI equivalent for every UI-triggered indexing operation
- manual semantic search UI with `top`, `window`, `source_file`, and tag filters
- chunk inspector showing raw text, context, section, tags, score, and provider metadata
- file-level semantic graph view similar to Obsidian graph: nodes are source files, edges are links/backlinks
- graph filters by collection, folder/source prefix, tag, and link direction

Stage 1 concept:

- local-only web UI or desktop wrapper
- no hosted service, no accounts, no multi-user mode
- read-only diagnostics and manual search first
- use existing `doctor`, config, Qdrant, and MCP/search helpers where possible
- secrets must be redacted in logs and diagnostics output

Stage 2 concept:

- collection creation and indexing actions with explicit confirmations
- live indexing progress and failure handling
- graph visualization and chunk drill-down
- guided setup for Claude Desktop / MCP config

Non-goals for this phase:

- hosted SaaS dashboard
- replacing the MCP server
- changing retrieval ranking or indexing defaults
- automatic destructive operations without confirmation
- multi-user access control

Success signals:

- new users can configure and test semidex without manually editing files
- indexing commands generated by the UI match documented CLI behavior
- users can inspect collections, chunks, and graph links before involving an agent
- diagnostics failures are understandable without reading stack traces

## Not Planned Right Now

These may be useful later, but they are not the current priority:

- replacing Qdrant with another backend
- building a hosted or multi-user web dashboard
- becoming a general conversational memory platform
- adding many MCP tools before the current ones are fully polished
- making LLM extraction the source of truth
- enabling write-capable agent memory by default
- making ColBERT a default path before benchmark evidence supports it
- building a full Git replacement or source-control workflow

## Near-Term Task Queue

Retrieval and chunking decision closure (done):

- Hybrid dense+sparse RRF confirmed as production default — no change needed.
- Reranker confirmed neutral on benchmark — stays off by default.
- MMR runtime opt-in deferred — criteria documented, broad-query live eval pending.
- Full-text literal search deferred — hybrid sparse covers all confirmed use cases.
- PDF chunking Stage 1 implemented — `@opendocsg/pdf2md` Markdown conversion with H1–H6 heading recovery; scanned PDFs fall back to plain-text.

**Next planned block: indexing/chunking performance baseline.**

Before any optimization work (faster indexing, incremental sync, code-aware chunking),
establish a baseline:

1. Measure indexing throughput on a realistic corpus (tokens/sec, chunks/sec, wall time).
2. Profile per-phase cost: pandoc conversion, chunking, LLM context/tag generation, embedding, Qdrant upsert.
3. Identify the dominant cost phase before choosing where to optimize.
4. Run `js-modern-book` benchmark to assess retrieval quality on a large real-world document.

Remaining general tasks:

5. Evaluate whether to change the programmatic tool default from `window=0` to `window=1, window_format="compact"` — the recommended agent pattern is already documented in AGENTS.md, but the code default has not changed.
6. Add a chunking-quality design document and large-document stress fixture plan.
7. ~~Summarize custom-50 diagnostics conclusions in the benchmarking docs~~ — **done**: `## Retrieval Diagnostics Conclusions` section added to `docs/en/benchmarking.md`; covers RRF score interpretation, agent defaults, trigger signals, MMR/full-text deferral, scope handling, and window utility.
8. ~~Design first-run semidex documentation self-indexing (`semidex-docs`) for agent onboarding~~ — **done**: `npm run bootstrap:docs` implemented; indexes semidex docs into `semidex-docs` collection with ONNX provider; managed-collection guard prevents accidental overwrite.
9. Draft the agent wake-up workflow before implementing any new MCP tool.
10. ~~Design a diagnostic bundle command with redaction rules~~ — **done**: `npm run doctor` implemented (`src/doctor.js`, `src/core/doctor-checks.js`); covers Node version, QDRANT_URL/KEY, Ollama reachability and model presence, collection schema, payload indexes, provider agreement, schema version, ONNX cache; full redaction of URL credentials and API key literals; writes timestamped report to `diagnostics/`.
11. Revisit MMR Stage 2 only after broad-query duplicate pressure is measured live.
12. Revisit full-text search only after a confirmed hybrid exact-token regression.
13. Update `SKILL.md` MCP setup instructions for npm package install path (`npx semidex` or `semidex mcp`) once the package is published — current instructions assume a cloned repo.
14. ~~Add pre-flight Ollama diagnostics~~ — **implemented** (`src/indexer/preflight.js`): reachability check + exact model validation before indexing loop; fail-fast with actionable error including Windows `127.0.0.1` hint.
15. Investigate persistent `[tag] batch parse failed` on PDF chunks despite `format:json` fix — Gemma3 may ignore `format:json` for certain prompt lengths or chunk content patterns. Consider logging the raw response on failure to diagnose.
