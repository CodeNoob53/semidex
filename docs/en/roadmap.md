# semidex Roadmap

> Status: canonical product roadmap, updated 2026-06-10.
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

## At a Glance

| Layer | Scope | Status |
|-------|-------|--------|
| **Shipped baseline** | Hybrid retrieval MVP: indexing, hybrid search, MCP tools, diagnostics | ✅ Working today |
| **MVP scope** | Skeleton-first chunking (Stage 1) behind a feature flag | 🚧 Next implementation work |
| **Future — foundation** | Skeleton navigation (Stage 2), validation & performance baseline (Stage 3) | 🔭 Planned, dependency-ordered |
| **Future — product tracks** | Assistant Runtime, Codebase Memory, extended ingestion, Control Panel, Agent Memory | 🔭 Planned, post-foundation |
| **Conditional research** | MMR, ColBERT, query expansion, scoped global search, adapters | 🔬 Trigger-gated, not milestones |

Everything below the MVP line is **future work**: it is documented so that MVP
decisions do not close those paths, but none of it is a delivery commitment.

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

---

## Shipped Baseline

The current MVP foundation: a working experimental local-first retrieval
system.

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

### Known limitations of the baseline

- Chunking understands headings and token limits, but does not yet model
  tables, code blocks, images, and other Markdown structures as first-class
  nodes.
- Agents can search and traverse files, but they do not yet have a hierarchical
  collection map.
- Markdown is the primary supported format; conversion quality for other
  formats depends on third-party parsers and source document quality.
- There is no application-facing grounded answer API yet.

---

## MVP Scope — Skeleton-first Chunking (Stage 1)

**This is the only stage inside the MVP boundary.** Everything after it is
future work.

**Goal:** replace "text below a heading" as the only knowledge unit with a
typed structural model of the document.

The skeleton model is part of chunking, not a retrieval boost layered on top.
The parser first builds a document skeleton, then a policy decides what becomes
searchable content, what remains navigation metadata, what is preserved as raw
payload, and what waits for a future processor.

### In MVP

- parse Markdown through an AST (remark) rather than extending the legacy
  regex parser;
- recognize sections, paragraphs, lists, tables, code blocks, blockquotes,
  images, frontmatter, and unknown nodes with a safe fallback;
- preserve tables and code blocks as complete structural objects instead of
  splitting them as prose;
- keep `raw_content`, node type, and provenance separate from display text;
- extend the payload model (`point_kind`, `node_type`, `node_id`, `parent_id`,
  `heading_path`) with the required payload indexes and schema versioning;
- prevent heading-only and placeholder-only retrieval chunks by construction;
- generate inspectable file-skeleton JSON artifacts (inspect-only, never a
  source of truth);
- add the conditional `point_kind="retrieval_content"` search filter for
  skeleton-first collections while preserving legacy collection behavior;
- keep the legacy chunker fully intact behind the `SKELETON_CHUNKING=1`
  feature flag;
- add structural smoke tests and a dedicated benchmark fixture.

The implementation contract and task-by-task decomposition live in:

- [Skeleton-first design](../design/skeleton-first-chunking.md)
- [Skeleton-first MVP implementation spec](../design/skeleton-first-chunking-impl-spec.md)
  (§11 is the authoritative task order; this roadmap does not duplicate it)

### Explicitly NOT in MVP

- LLM-generated navigation summaries (file/section/collection) — Stage 2;
- `qdrant_get_skeleton` / `qdrant_get_content` MCP tools — Stage 2;
- separate `embedding_text` construction for tables/code — follows the LLM
  context work, after Stage 1;
- collection-level summaries, callouts/admonitions, math, footnotes, OCR;
- switching skeleton-first chunking on by default — requires the Stage 3
  benchmark gate.

### MVP exit gate

- smoke tests cover every supported AST mapping and safe fallback;
- tables and code blocks are not split incorrectly;
- empty and placeholder-only retrieval chunks cannot be emitted;
- legacy indexing remains byte-identical when skeleton-first mode is disabled;
- a dedicated structural benchmark fixture exists;
- skeleton-enabled reindex is detected correctly on previously indexed
  collections (no silent mixed legacy/skeleton state).

---

## Future Work

Everything in this section is **post-MVP**. It is ordered by dependency: the
foundation stages first, then product tracks that build on them.

### Stage 2 — Skeleton Navigation Layer (future)

**Goal:** let agents understand a large collection progressively, without
forcing navigation summaries into topical search results.

The skeleton has two distinct roles:

1. `retrieval_content` — searchable prose and structural content objects.
2. `skeleton_nav` — collection, file, and section map nodes used only for
   navigation.

Planned work (the payload model and search filter ship in the MVP; this stage
builds on them):

- upsert navigation nodes — only after the search filter is active;
- add paginated `qdrant_get_skeleton(collection, source_file?, node_id?, depth?)`;
- add anchored content assembly through
  `qdrant_get_content(collection, anchor_node_id, scope="section"|"file")`;
- generate summaries at useful navigation levels: file, major section, table,
  code block, and later collection;
- keep navigation summaries out of default `qdrant_search`.

Expected agent flow:

```text
show collection skeleton
  -> inspect file summaries
  -> open one file skeleton
  -> inspect section summaries
  -> retrieve or assemble the relevant raw content
```

**Exit gate:** navigation nodes never appear in normal search; a new agent can
orient in a large unfamiliar collection without blind file scanning; content
assembly preserves authoritative raw tables and code blocks; pagination keeps
skeleton reads compact on large collections.

### Stage 3 — Validation, Profiles, and Performance Baseline (future)

**Goal:** prove that the structural model improves real workflows without
overfitting one technical collection or creating unacceptable indexing cost.

Planned work:

- benchmark legacy chunking against skeleton-first chunking;
- compare representative workflows against direct alternatives before making
  competitive quality claims;
- add structural retrieval metrics (tables, code blocks, anchored assembly)
  alongside existing chunk-level metrics;
- test Markdown with tables, code, lists, quotes, images, and long sections
  across technical, business, and research-oriented corpora;
- evaluate a neutral document profile as the baseline; keep private corpora
  private;
- measure indexing throughput, token volume, LLM cost, Qdrant operations,
  payload/storage growth, MCP list-tool latency, and per-phase wall time;
- profile expensive phases before optimizing them;
- add selected external evaluation datasets when their metrics match
  semidex's purpose.

**Exit gate:** structural retrieval improves or preserves established
regression metrics; improvements reproduce across multiple document shapes; no
profile becomes a hidden requirement for acceptable baseline quality; indexing
cost and quality tradeoffs are documented honestly; the neutral profile
remains a usable default. Only after this gate may skeleton-first become the
default.

### Product tracks (future, post-foundation)

These tracks share Stages 1–3 but do not need to block each other. Their order
is chosen by user value, available hardware, and validation results.

#### Track A — Assistant Runtime

**Goal:** make indexed collections usable by grounded assistants in websites,
internal tools, and local workflows.

- application-facing HTTP answer API;
- configurable retrieval policy and grounded prompt assembly;
- streaming answers with citations back to files, sections, and structural
  nodes;
- local generation adapter (initially Ollama); optional external
  generation-provider adapters;
- evaluation of native on-device ONNX generation when the Node.js integration
  path matures.

Note: this track depends on the shipped baseline, not on the skeleton model —
it can be re-prioritized ahead of Stages 2–3 if product validation demands it.

#### Track B — Codebase Memory

**Goal:** specialize the skeleton model for large and legacy software
projects. Not a rewrite — an extension of the same structural principles to
source code.

- project map and file skeletons for repositories;
- language-aware structural nodes: symbols, functions, classes, exports,
  routes, configuration blocks, source positions;
- raw code retained alongside generated context;
- per-collection manifest with hashes, provider metadata, chunking settings,
  and source root;
- detection of new, changed, deleted, and renamed files; same-hash move/rename
  fast path; optional Git signals with a scan-based fallback;
- documentation generation for poorly documented projects.

Already shipped as a partial basis: hash-based skip, full-root `PRUNE_STALE=1`
cleanup, deterministic point IDs.

#### Track C — Extended Ingestion and Image Understanding

**Goal:** improve fidelity for non-Markdown sources without weakening the
Markdown-first contract.

Staged pipeline: preserve image nodes and provenance in the skeleton → exclude
inline base64 from prose embeddings → OCR for text-heavy images and scans →
vision-language stage for diagrams and screenshots → store original, OCR text,
vision summary, and derived context separately → benchmark every processor
against the clean fallback before enabling it by default.

OCR and vision are complementary; neither output becomes the source of truth.

#### Track D — Control Panel and Deployment Profiles

**Goal:** make setup and operation approachable without changing retrieval
semantics.

- local setup for Qdrant, Ollama, ONNX, and provider configuration;
- collection management and safe indexing actions;
- `doctor` results as actionable diagnostics; indexing progress by phase;
- manual search and chunk inspection; file-level graph visualization;
- copyable CLI equivalents for UI-triggered actions.

Deployment profiles: **semidex Local** (current primary), **semidex Light**
(planned resource-conserving profile with optional external providers),
**semidex Codebase** (planned specialization via Track B).

#### Track E — Agent Memory Overlay

**Goal:** allow agents to record useful working knowledge without
contaminating the authoritative document index.

Constraints: opt-in and disabled by default; separate from source-derived
knowledge; global, user-scoped, and collection-scoped notes; candidate
knowledge inbox with provenance, review state, and change log; explicit
promotion workflow before any fact joins an authoritative source.

### Conditional retrieval research (future, trigger-gated)

These experiments are intentionally outside the delivery sequence. They start
only when a measured miss class justifies them.

| Candidate | Current position | Trigger for renewed work |
|-----------|------------------|--------------------------|
| Deterministic reranker | Implemented, opt-in, default off | A validated collection or query-class routing policy where it improves quality without unacceptable regressions |
| Dense MMR runtime mode | Benchmark-only, deferred | Reproducible broad-query duplicate pressure that harms agent answer quality |
| Literal payload search / grep boost over `raw_content` | Deferred (same idea as the design doc's "grep boost") | Exact-token regressions not solved by BGE-M3 sparse retrieval |
| Stronger Node-only sparse fallback | Research item | A requirement for better fallback quality where ONNX BGE-M3 cannot be used |
| ColBERT / late interaction | Benchmark-only prototype, deferred | Correct chunks frequently exist in a wider candidate pool but hybrid RRF ranks them too low |
| Scoped global search | Planned — see design note below | Cross-collection discovery needed without precomputed link graphs |
| Query expansion | Research item | Systematic misses not solvable by better structure or lexical retrieval |

#### Scoped global search design note

Cross-collection discovery is handled at query time, not indexing time:

- search happens on demand; no precomputed link graph is required;
- the agent or user passes explicit collection names or a collection prefix;
- by default, only semidex-managed collections are eligible; agent memory
  collections are excluded unless explicitly requested;
- results are grouped by collection → source file → chunks;
- collection markers or scopes are required before searching across a large
  number of collections.

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

Implementation is deferred until the Skeleton Navigation Layer (Stage 2) is
ready. Relevant retrieval decisions and benchmark evidence:
[retrieval.md](retrieval.md), [benchmarking.md](benchmarking.md),
[`benchmarks/retrieval/results/README.md`](../../benchmarks/retrieval/results/README.md).

### Provider and storage adapter research (future)

These adapters broaden deployment options but do not replace the reference
architecture.

- optional external embedding / context-generation / answer-generation APIs;
- evaluation of Qdrant Cloud Inference where its API surface fits the Node.js
  runtime; local ONNX and Ollama remain supported defaults;
- Qdrant remains the reference backend; adapters for other vector databases
  are future research and must pass a parity check for named vectors, hybrid
  retrieval, payload filtering, schema migration, and operational safety.

---

## Cross-cutting Work

These concerns apply across the MVP and all future tracks.

### Evaluation

- preserve internal regression suites;
- add held-out fixtures before publishing broad claims;
- separate retrieval recall, structural-node recall, answer accuracy, latency,
  and agent task success;
- publish caveats with every metric; avoid comparisons between incompatible
  metrics.

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
