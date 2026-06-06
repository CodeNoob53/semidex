# semidex Roadmap

> Status: canonical product roadmap, updated 2026-05-31.
>
> This document is ordered by architectural dependency, not by a speculative
> calendar. Presentation decks and grant materials should derive their stage
> order from this file.

semidex is a local-first RAG system for grounding AI agents in real document
collections. Its job is to make a knowledge base searchable, inspectable, and
usable by an agent without forcing the agent to read every source file or trust
an opaque generated summary.

semidex is currently an experimental retrieval MVP. Its benchmark suites are
development regression tools, not independent evidence of competitive
superiority. Before making quality claims against other systems, the project
needs a representative demo, selected external datasets, and direct workflow
comparisons.

The immediate product is a document retrieval layer. The longer-term direction
adds grounded assistant runtimes, codebase memory, richer ingestion, and
optional agent memory on top of the same structural foundation.

## Product Goal

semidex should help teams build accurate AI-assisted workflows over their own
knowledge:

- internal documentation assistants;
- customer-facing consultants grounded in approved material;
- research and project libraries;
- local personal knowledge collections;
- future codebase navigation and maintenance workflows.

The system remains useful as a small local tool while scaling toward larger
document collections and specialized project memory.

## Roadmap Model

The roadmap has three layers:

1. **Shipped baseline** - what works today.
2. **Core foundation sequence** - the next dependency-ordered work that improves
   the data model shared by every future product track.
3. **Product tracks and conditional research** - work that can proceed after the
   required foundation exists, but should not block unrelated capabilities.

This distinction matters. Retrieval experiments such as ColBERT or MMR are not
mandatory milestones. They are investigated only when measurements show a
specific retrieval weakness that the existing hybrid path does not solve.

## Product Principles

| Principle | Meaning |
|-----------|---------|
| Raw sources stay authoritative | LLM summaries, tags, links, OCR text, and vision descriptions enrich the index but never replace original source content. |
| Structure before ranking tricks | Improve what semidex indexes and how agents navigate it before adding more ranking complexity. |
| Local-first, not local-only | A complete local deployment remains possible. External providers may be added as optional adapters when users choose them. |
| Benchmark before defaults | New chunking, retrieval, generation, and ingestion behavior must pass relevant regression gates before becoming default. |
| Inspectable by humans | Generated chunks, skeleton artifacts, diagnostics, and provenance should remain auditable. |
| Qdrant remains the reference backend | Portability is a future adapter problem, not a reason to weaken the supported default path. |
| Keep future tracks modular | Assistant Runtime, Codebase Memory, image processing, and Agent Memory share a foundation but should not become one tightly coupled application. |

## Shipped Baseline

The current MVP is a working experimental local-first retrieval system.

### Indexing and ingestion

- Markdown-first document indexing. Markdown provides the highest structural
  fidelity.
- Best-effort ingestion for plain text, PDF, and pandoc-convertible formats.
- Heading-aware, tokenizer-aware chunking with section-boundary preservation.
- Real BGE-M3 token counting by default, with an explicit heuristic fallback.
- LLM-generated chunk context and optional tags.
- SHA-256 skip for unchanged files.
- Deterministic point IDs for idempotent reindexing.
- Opt-in stale-file cleanup with `PRUNE_STALE=1`.
- Obsidian-compatible `chunks_out/` review artifacts.

### Retrieval

- Qdrant named dense and sparse vectors.
- BGE-M3 ONNX multilingual dense and neural sparse provider.
- Ollama dense plus hashed-TF sparse fallback when ONNX is unavailable.
- Hybrid dense+sparse retrieval with Qdrant RRF fusion as the production
  `qdrant_search` path.
- Compact context windows for agent-facing results.
- Optional deterministic reranker, disabled by default because it is not a
  universal win across evaluated query classes.

### Agent and operator tooling

- Seven read-only MCP tools for collection inspection, directory navigation,
  file listing, tag discovery, search, and chunk retrieval.
- `npm run doctor` for redacted environment diagnostics.
- `npm run bootstrap:docs` for a managed `semidex-docs` self-documentation
  collection.
- Ollama preflight diagnostics before indexing work begins.
- Retrieval regression suites and focused benchmark tooling.

### Current limitations

- Chunking understands headings and token limits, but it does not yet model
  tables, code blocks, images, and other Markdown structures as first-class
  nodes.
- Agents can search and traverse files, but they do not yet have a hierarchical
  collection map.
- Markdown is the primary supported format. Conversion quality for other
  formats depends on third-party parsers and source document quality.
- There is no application-facing grounded answer API yet.
- Codebase Memory, OCR/vision processing, write-capable Agent Memory, and the
  Control Panel remain future work.

## Core Foundation Sequence

These stages are ordered. Each stage creates a stable contract needed by the
next one.

| Stage | Outcome | Depends on |
|-------|---------|------------|
| 1. Skeleton-first Chunking MVP | Typed document nodes and structurally correct content chunks | Shipped baseline |
| 2. Skeleton Navigation Layer | Hierarchical agent navigation without polluting normal search | Stage 1 |
| 3. Validation, Profiles, and Performance Baseline | Evidence that the structural model is useful, universal enough, and operationally affordable | Stages 1-2 |

### Stage 1 - Skeleton-first Chunking MVP

**Goal:** replace "text below a heading" as the only knowledge unit with a
typed structural model of the document.

The skeleton model is part of chunking, not a retrieval boost layered on top.
The parser first builds a document skeleton, then a policy decides what becomes
searchable content, what remains navigation metadata, what is preserved as raw
payload, and what waits for a future processor.

Initial scope:

- parse Markdown through an AST rather than extending the legacy regex parser;
- recognize sections, paragraphs, lists, tables, code blocks, blockquotes,
  images, frontmatter, and unknown nodes with a safe fallback;
- preserve tables and code blocks as complete structural objects instead of
  splitting them as prose;
- keep `raw_content`, generated `embedding_text`, provenance, and node type
  separate;
- keep image placeholders in the skeleton while excluding inline base64 bodies
  from retrieval content;
- prevent heading-only and placeholder-only retrieval chunks by construction;
- generate inspectable file-skeleton JSON artifacts;
- keep the legacy chunker available behind a feature flag during evaluation.

Implementation contract:

- [Skeleton-first design](../design/skeleton-first-chunking.md)
- [Skeleton-first MVP implementation spec](../design/skeleton-first-chunking-impl-spec.md)

**Exit gate:**

- smoke tests cover every supported AST mapping and safe fallback;
- tables and code blocks are not split incorrectly;
- empty and placeholder-only retrieval chunks cannot be emitted;
- legacy indexing remains intact when skeleton-first mode is disabled;
- a dedicated structural benchmark fixture is available.

### Stage 2 - Skeleton Navigation Layer

**Goal:** let agents understand a large collection progressively, without
forcing navigation summaries into topical search results.

The skeleton has two distinct roles:

1. `retrieval_content` - searchable prose and structural content objects.
2. `skeleton_nav` - collection, file, and section map nodes used only for
   navigation.

Planned work:

- add `point_kind`, `node_type`, `node_id`, `parent_id`, `heading_path`, and
  structural provenance fields to the Qdrant payload model;
- add the required payload indexes;
- make default search conditionally filter to `point_kind="retrieval_content"`
  for skeleton-first collections while preserving legacy collection behavior;
- upsert navigation nodes only after that search filter is active;
- add paginated `qdrant_get_skeleton(collection, source_file?, node_id?, depth?)`;
- add anchored content assembly through
  `qdrant_get_content(collection, anchor_node_id, scope="section"|"file")`;
- generate summaries at useful navigation levels: file, major section,
  table, code block, and later collection;
- keep navigation summaries out of default `qdrant_search`.

Expected agent flow:

```text
show collection skeleton
  -> inspect file summaries
  -> open one file skeleton
  -> inspect section summaries
  -> retrieve or assemble the relevant raw content
```

**Exit gate:**

- navigation nodes never appear in normal search;
- a new agent can orient in a large unfamiliar collection without blind file
  scanning;
- content assembly preserves authoritative raw tables and code blocks;
- pagination keeps skeleton reads compact on large collections.

### Stage 3 - Validation, Profiles, and Performance Baseline

**Goal:** prove that the new structural model improves real workflows without
overfitting one technical collection or creating unacceptable indexing cost.

Validation must cover different document shapes and domains. The parser policy
should be driven by document structure, not by collection-specific keywords.

Planned work:

- benchmark legacy chunking against skeleton-first chunking;
- compare representative workflows against direct alternatives before making
  competitive quality claims;
- add structural retrieval metrics for tables, code blocks, and anchored
  content assembly alongside existing chunk-level metrics;
- test Markdown with tables, code, lists, quotes, images, and long sections;
- evaluate a neutral document profile as the baseline;
- test representative technical, business, and research-oriented corpora;
- keep private corpora private: reports record generalized findings, not source
  paths or content;
- measure indexing throughput, chunks per second, token volume, LLM cost, Qdrant
  operations, and per-phase wall time;
- profile expensive phases before optimizing them;
- define recommendations for optional document profiles only if measurements
  justify them;
- add selected external evaluation datasets when their metrics match semidex's
  purpose.

**Exit gate:**

- structural retrieval improves or preserves established regression metrics;
- improvements reproduce across multiple document shapes;
- no profile becomes a hidden requirement for acceptable baseline quality;
- indexing cost and quality tradeoffs are documented honestly;
- the neutral profile remains a usable default.

## Product Tracks After the Foundation

These tracks share Stages 1-3 but do not need to block each other. Their order is
chosen by user value, available hardware, and validation results.

### Track A - Assistant Runtime

**Goal:** make indexed collections usable by grounded assistants in websites,
internal tools, and local workflows.

Planned capabilities:

- application-facing HTTP answer API;
- configurable retrieval policy;
- grounded prompt assembly from semidex results;
- streaming answers;
- citations back to files, sections, and structural nodes;
- local generation adapter, initially through Ollama;
- optional external generation-provider adapters;
- evaluation of native on-device ONNX generation when the Node.js integration
  path is mature enough.

This track is the bridge from "retrieval MCP for agents" to reusable assistants
for users who do not operate an MCP client directly.

### Track B - Codebase Memory

**Goal:** specialize the skeleton model for large and legacy software projects.

Codebase Memory is not a separate rewrite. It extends the same structural
principles from documents to source code.

Planned capabilities:

- project map and file skeletons for repositories;
- language-aware structural nodes such as symbols, functions, classes, exports,
  routes, configuration blocks, and source positions;
- raw code retained alongside generated context;
- coding-oriented context models selected by benchmark, not hard-coded by
  preference;
- per-collection manifest with hashes, provider metadata, chunking settings,
  and source root;
- detection of new, changed, deleted, and renamed files;
- same-hash move/rename fast path;
- optional Git signals with a scan-based fallback;
- fast refresh workflows suitable for hooks or watchers;
- documentation generation and upkeep for poorly documented projects.

Already shipped as a partial basis:

- unchanged files are skipped by hash and provider metadata;
- deleted files and old rename paths can be removed with full-root
  `PRUNE_STALE=1`;
- deterministic point IDs make repeated indexing safer.

### Track C - Extended Ingestion and Image Understanding

**Goal:** improve fidelity for non-Markdown sources without weakening the
Markdown-first contract.

Current position:

- Markdown remains the primary format;
- plain text is supported without heading structure;
- PDF and pandoc-convertible formats are best-effort conversion paths;
- parser quality for those formats depends on third-party tools.

Planned staged pipeline:

1. Preserve image nodes and provenance in the skeleton.
2. Exclude inline base64 bodies from prose embeddings.
3. Add OCR for text-heavy images and scanned pages.
4. Add a vision-language stage for diagrams, charts, UI screenshots, and
   illustrations.
5. Store original image, OCR text, vision summary, and derived retrieval
   context separately.
6. Benchmark every processor against the clean fallback path before enabling it
   by default.

OCR and vision are complementary. Neither generated output becomes the source
of truth.

### Track D - Control Panel and Deployment Profiles

**Goal:** make setup and operation approachable without changing retrieval
semantics.

Control Panel scope:

- local setup for Qdrant, Ollama, ONNX, and provider configuration;
- collection management and safe indexing actions;
- `doctor` results shown as actionable diagnostics;
- indexing progress by pipeline phase;
- manual search and chunk inspection;
- file-level graph visualization;
- copyable CLI equivalents for UI-triggered actions.

Deployment profiles:

- **semidex Local** - the current primary profile. Fully local or mixed
  deployment with ONNX, Ollama, and Qdrant.
- **semidex Light** - planned resource-conserving profile using optional
  external embeddings, context generation, inference, or storage where data
  policy allows it.
- **semidex Codebase** - planned specialization built through Track B.

### Track E - Agent Memory Overlay

**Goal:** allow agents to record useful working knowledge without contaminating
the authoritative document index.

Planned constraints:

- opt-in and disabled by default;
- separate from source-derived knowledge;
- global, user-scoped, and collection-scoped notes;
- per-library search guidance and working rules;
- candidate-knowledge inbox for externally discovered facts;
- provenance, review state, and change log;
- explicit promotion workflow before any fact joins an authoritative source.

## Conditional Retrieval Research

These experiments are intentionally outside the required delivery sequence.
They should start only when a measured miss class justifies them.

| Candidate | Current position | Trigger for renewed work |
|-----------|------------------|--------------------------|
| Deterministic reranker | Implemented, opt-in, default off | A validated collection or query-class routing policy where it improves quality without unacceptable regressions |
| Dense MMR runtime mode | Benchmark-only, deferred | Reproducible broad-query duplicate pressure that harms agent answer quality |
| Literal payload search | Deferred | Exact-token regressions not solved by BGE-M3 sparse retrieval |
| Stronger Node-only sparse fallback | Research item | A requirement for better fallback quality where ONNX BGE-M3 cannot be used |
| ColBERT / late interaction | Benchmark-only prototype direction, deferred | Correct chunks frequently exist in a wider candidate pool but hybrid RRF ranks them too low |
| Scoped global search | Planned — see design note below | Cross-collection discovery needed without precomputed link graphs |
| Query expansion | Research item | Diagnostics show systematic misses that cannot be solved by better structure or lexical retrieval |

### Scoped Global Search Design Note

Cross-collection discovery is handled at query time, not indexing time. The design constraints are:

- search happens on demand; no precomputed link graph is required or maintained;
- the agent or user passes explicit collection names or a collection prefix;
- by default, only semidex-managed collections are eligible;
- agent memory collections are excluded unless explicitly requested;
- results are grouped by collection → source file → chunks;
- collection markers or scopes are required before searching across a large number of collections.

Planned future API shape:

```js
qdrant_search_global({
  query,
  collections?: string[],       // explicit list, overrides default
  collection_prefix?: string,   // filter by collection name prefix
  scope?: string,               // named scope registered in config
  top_per_collection?: number,  // max results per collection before final merge
  final_top?: number,           // total results returned
  window?: number,
})
```

This is the mechanism for cross-collection discovery. Implementation is deferred until the Skeleton Navigation Layer (Stage 2) is ready.

Relevant retrieval decisions and benchmark evidence remain documented in:

- [Retrieval documentation](retrieval.md)
- [Benchmarking guide](benchmarking.md)
- [`benchmarks/retrieval/results/README.md`](../../benchmarks/retrieval/results/README.md)

## Provider and Storage Adapter Research

These adapters broaden deployment options but do not replace the reference
architecture.

### Provider adapters

- optional external embedding APIs;
- optional external context-generation APIs;
- optional external answer-generation APIs for Assistant Runtime;
- evaluation of Qdrant Cloud Inference where its API surface fits the Node.js
  runtime;
- local ONNX and Ollama paths remain supported defaults.

### Storage adapters

- Qdrant remains the reference backend and the supported default;
- adapters for other vector databases are future research;
- any adapter must pass a parity check for named vectors, hybrid retrieval,
  payload filtering, schema migration, and operational safety.

## Cross-cutting Work

These concerns apply across all stages and tracks.

### Evaluation

- preserve internal regression suites;
- add held-out fixtures before publishing broad claims;
- separate retrieval recall, structural-node recall, answer accuracy, latency,
  and agent task success;
- publish caveats with every metric;
- avoid comparisons between incompatible metrics.

### Observability and operations

- keep diagnostics redacted by default;
- expose provider, collection, latency, schema, and source-diversity metadata;
- preserve safe repair paths for stale and duplicate points;
- make destructive operations explicit and scoped;
- keep collection migrations inspectable.

### Platform support

- Windows 10/11 remains the verified end-to-end target;
- Linux and macOS remain experimental until validated on physical hardware;
- hardware execution providers affect performance, not retrieval semantics;
- do not promise platform support based only on theoretical dependency
  compatibility.

### Documentation quality

- keep the English deep-dive documentation accurate and implementation-facing;
- maintain a Ukrainian product-facing documentation path;
- keep README claims narrower than the evidence;
- clearly distinguish shipped behavior, opt-in behavior, planned work, and
  research hypotheses.

## Near-term Execution Queue

The next implementation work should follow the approved skeleton-first MVP spec.

1. Add the AST parser, node policy, skeleton warnings, and deterministic node ID
   helper behind `SKELETON_CHUNKING=1`.
2. Add `chunkFromSkeleton()` with safe fallback behavior and no placeholder-only
   retrieval chunks.
3. Extend payload metadata for skeleton-first content nodes and add schema
   versioning.
4. Generate file-skeleton JSON artifacts for inspection only.
5. Add the conditional `point_kind="retrieval_content"` search filter for
   skeleton-first collections while preserving legacy collection behavior.
6. Upsert `skeleton_nav` nodes only after the search filter is active.
7. Add structural smoke tests and a dedicated benchmark fixture.
8. Add paginated `qdrant_get_skeleton` and anchored `qdrant_get_content`.
9. Add file and section summaries, then evaluate collection-level summaries.
10. Run Stage 3 validation before enabling skeleton-first behavior by default.

## Explicit Non-goals

Not planned as immediate work:

- replacing Qdrant as the reference backend;
- enabling write-capable Agent Memory by default;
- treating LLM-generated summaries, OCR text, or vision descriptions as source
  truth;
- building a hosted multi-user dashboard before the local Control Panel;
- making ColBERT, MMR, reranking, or graph expansion default without benchmark
  evidence;
- building a Git replacement;
- claiming full-fidelity ingestion for formats whose third-party conversion
  paths remain partial.
