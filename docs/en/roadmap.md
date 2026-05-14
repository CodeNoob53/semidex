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
- PDF fallback chunking — `pdf-parse` plain-text extraction with recursive paragraph → sentence → word splitting (Stage 1)
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
- document recommended MCP search patterns:
  - search first
  - expand with `qdrant_get_chunk(window=1)`
  - follow related/backlinks when the task spans files
  - use tags and source filters for narrow tasks
- evaluate whether a controlled `agent-notes` collection is worth adding
- keep any write-capable MCP memory tool disabled by default unless it has a clear safety model

Success signals:

- agents need fewer blind file reads
- agents retrieve surrounding context more often
- fewer answers are based on a single isolated chunk when the task needs a section or file context

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

**Current status (Stage 1 — implemented):** `pdf-parse` extracts plain text. Chunking uses recursive paragraph → sentence → word splitting. All chunks have `section: ""` or `"intro"`. Navigate PDF content via `source_file + chunk_index`, not section headings. Pandoc cannot read PDFs as an input format.

Remaining work (Stage 2+): heading/section recovery from PDF structure.

Possible approaches (not yet evaluated):

- integrate a Markdown-aware PDF extractor (e.g. `pdf2md`, `pymupdf`-based tooling, or a document layout model)
- OCR pipeline for scanned PDFs
- accept a companion `.md` sidecar file that provides the structure, with the PDF used only for page-marker alignment
- structured extraction using an LLM with vision input (e.g. page-image → heading detection)

Any approach must be benchmarked against the existing plain-text path before becoming a default, since extraction errors could degrade chunk quality compared to the current clean paragraph-based fallback.

Success signals:

- PDF chunks have correct `section` values matching document headings
- no regression in retrieval quality on clean-text PDFs
- external tool dependency is clearly documented and optional

## Not Planned Right Now

These may be useful later, but they are not the current priority:

- replacing Qdrant with another backend
- building a full web dashboard
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
- PDF chunking Stage 1 documented — structured heading recovery is future Phase 7 work.

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
7. Summarize custom-50 diagnostics conclusions in the benchmarking docs.
8. Draft the agent wake-up workflow before implementing any new MCP tool.
9. Design a diagnostic bundle command with redaction rules.
10. Revisit MMR Stage 2 only after broad-query duplicate pressure is measured live.
11. Revisit full-text search only after a confirmed hybrid exact-token regression.
