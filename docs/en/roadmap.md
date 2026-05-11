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

Implemented and usable today:

- structure-aware document indexing
- LLM context summaries and tags
- dense + sparse named vectors in Qdrant
- hybrid search with RRF fusion
- BGE-M3 ONNX multilingual provider
- Ollama + hashed-TF fallback provider
- MCP reader tools
- MCP search context window (window=1)
- semantic graph links and backlinks
- Obsidian-compatible `chunks_out/` review artifacts
- deterministic optional reranker
- MMR benchmark mode
- 21-query regression benchmark
- custom-50 chunk-level quality benchmark
- diagnostics, failure analysis, candidate comparison, and threshold sweep tooling

## Phase 1 - Stabilize Retrieval Quality

Goal: make the existing retrieval system easier to measure, debug, and trust.

Planned work:

- document final conclusions from custom-50 diagnostics and threshold sweep
- extend custom-50 with large-document stress fixtures
- add explicit chunk-quality checks:
  - answer not split across unrelated chunks
  - chunk is self-contained enough for an agent
  - section boundaries do not leak unrelated context

Recent Results:
- `agent-window-eval`: 5/5 expected hints found for context window
- Avg output ~7.3k chars at `top=3`/`window=1`
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

Candidate experiments:

- MMR policy evaluation beyond dense-only benchmark mode
- full-text filtering over Qdrant payload fields
- stronger lexical fallback than hashed-TF
- ColBERT / late-interaction rerank prototype
- query expansion only when diagnostics indicate a likely miss

ColBERT remains a roadmap item, not an immediate default. It should be tested
only after benchmarks show that the correct chunk is often present in a wider
candidate pool but ranked too low by hybrid RRF.

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
is closer to an incremental project index than a one-shot document import:

- index a whole repository with stable include/exclude rules
- store a per-collection manifest of source files, hashes, provider metadata,
  chunking settings, and source root
- detect changed, new, deleted, and renamed files
- delete and reindex only affected `source_file` payloads in Qdrant
- force a full reindex only when provider, schema, vector size, or chunking
  settings change
- optionally use `git status --porcelain` as a fast change signal when the
  source root is a Git repository
- keep a scan-based fallback for non-Git folders

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

- large repositories can be refreshed without full reindexing
- changed files become searchable quickly
- deleted files disappear from search results
- agents search current codebase state instead of stale snapshots
- indexing cost scales with the size of the change, not the size of the repo

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

Recommended next tasks:

1. Compact/deduplicate window output before considering default window=1.
2. Add a chunking-quality design document and large-document stress fixture plan.
3. Summarize custom-50 diagnostics conclusions in the benchmarking docs.
4. Draft the agent wake-up workflow before implementing any new MCP tool.
5. Design a diagnostic bundle command with redaction rules.
6. Capture the incremental codebase memory concept as a future design note.
7. Revisit MMR and ColBERT only after chunk/window diagnostics are stable.
