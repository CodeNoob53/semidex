# semidex Roadmap

> Status: canonical product roadmap, updated 2026-07-18.
>
> This document is ordered by architectural dependency, not by a speculative
> calendar. Product plans and presentations should derive their stage order
> from this file.

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
| **Skeleton-first (main direction)** | Skeleton-first chunking active; structural carryover shipped; legacy chunking is compatibility/fallback | ✅ Active direction |
| **Future — foundation** | Skeleton navigation (Stage 2 — nav tools, summaries, content assembly backend/Local API, the stitched document reader UI, and bounded anchored content over MCP all shipped), validation & performance baseline (Stage 3) | 🚧 Stage 2 nearly complete; Stage 3 planned |
| **Product tracks** | Assistant Runtime (partial local core shipped), Codebase Memory, extended ingestion, Qdrant-native operations, Control Panel, Agent Memory | 🚧 Ask core active; integrations and other tracks planned |
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
- A partial grounded Ask backend exists (`POST /api/ask` with SSE, local
  generation, citations, and refusal behavior), but it is still an internal
  application-server contract. There is no stable public integration API,
  cloud generation adapter, SDK/widget, Telegram adapter, public auth, or
  multi-tenant runtime yet.

---

## Skeleton-first Chunking — Landed as the Production Invariant

**Skeleton-first indexing is now unconditional architecture for Markdown, not
an opt-in mode.** Every `.md` file always parses through the AST (remark)
skeleton pipeline; navigation-node generation and deterministic structural
context are always on. There is no `SKELETON_CHUNKING`/`SKELETON_NAV`/
`SKELETON_CONTEXT` flag — those were removed once skeleton-first cleared the
Stage 3 benchmark gate and became the only supported Markdown chunking path.
Existing legacy-indexed `.md` files are detected and reindexed into the
skeleton model automatically on the next indexing run; legacy Qdrant
collections remain fully readable in the meantime.

Non-Markdown formats (PDF, Pandoc-converted formats, plain text) are a
deliberate, still-open scope boundary: they continue to use the legacy
chunker directly, unaffected by this change. A synthetic-skeleton
representation for those formats has not been built.

**Goal (achieved for Markdown):** replace "text below a heading" as the only
knowledge unit with a typed structural model of the document.

The skeleton model is part of chunking, not a retrieval boost layered on top.
The parser first builds a document skeleton, then a policy decides what becomes
searchable content, what remains navigation metadata, what is preserved as raw
payload, and what waits for a future processor.

### Delivered

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
  skeleton collections while preserving legacy collection behavior;
- add structural smoke tests and a dedicated benchmark fixture;
- remove the legacy Markdown chunking branch from production indexing —
  `chunkFile`/`chunkFileAsync` remain as shared primitives for non-Markdown
  formats and benchmarks, but are no longer selectable for `.md` input.

The implementation contract and task-by-task decomposition live in:

- [Skeleton-first design](../design/skeleton-first-chunking.md)
- [Skeleton-first MVP implementation spec](../design/skeleton-first-chunking-impl-spec.md)
  (§11 is the authoritative task order; this roadmap does not duplicate it)

### Explicitly NOT in MVP

- advanced LLM-generated navigation summaries (file/section/collection) — Stage 2;
- `qdrant_get_content` and deeper skeleton traversal controls — Stage 2;
- separate `embedding_text` construction for tables/code — follows the LLM
  context work, after Stage 1;
- collection-level summaries, callouts/admonitions, math, footnotes, OCR.

Skeleton-first chunking for Markdown was made unconditional ahead of a full
Stage 3 benchmark validation pass — the decision was made directly rather
than waiting on the originally planned gate, because the legacy Markdown
branch was no longer meant to be a real production alternative. Stage 3's
broader benchmark/profile work (below) is still open and still matters, just
no longer as a precondition for skeleton-first itself.

### MVP exit gate (met)

- smoke tests cover every supported AST mapping and safe fallback;
- tables and code blocks are not split incorrectly;
- empty and placeholder-only retrieval chunks cannot be emitted;
- a dedicated structural benchmark fixture exists;
- skeleton-enabled reindex is detected correctly on previously indexed
  collections (no silent mixed legacy/skeleton state) — legacy-indexed `.md`
  files are reindexed into the skeleton model automatically, and already
  current skeleton collections are not rebuilt needlessly.

---

## Future Work

Everything in this section is **post-MVP**. It is ordered by dependency: the
foundation stages first, then product tracks that build on them.

### Stage 2 — Skeleton Navigation Layer (in progress)

**Goal:** let agents understand a large collection progressively, without
forcing navigation summaries into topical search results.

The skeleton has two distinct roles:

1. `retrieval_content` — searchable prose and structural content objects.
2. `skeleton_nav` — collection, file, and section map nodes used only for
   navigation.

Shipped foundation:

- upsert navigation nodes after the search filter is active;
- expose read-only skeleton MCP tools:
  `qdrant_get_skeleton`, `qdrant_get_skeleton_node`,
  `qdrant_get_skeleton_children`;
- keep navigation summaries out of default `qdrant_search`;
- structural entity references (`entity_refs` payload metadata linking prose
  placeholders to their table/code/checklist entities, with a payload-only
  backfill for existing collections);
- the content assembly backend: a storage-independent core service
  (`src/core/assembly/`) plus the admin Local API endpoint
  `GET /api/collections/:name/assembly?scope=file|section`, preserving
  authoritative raw tables/code blocks/checklists in original order, with
  explicit fallback for un-backfilled collections and clean legacy
  degradation;
- the stitched document reader in the admin UI: file/section opens render
  the assembled continuous document by default (prose as one document,
  entities at their original positions through the shared structural
  renderer), with the chunk-card view kept as an alternate reader mode;
- bounded anchored content assembly over MCP:
  `qdrant_get_content(collection, anchor_node_id, scope="section"|"file",
  max_tokens?, cursor?, format?)` — resolves a search-hit `node_id` through
  StorageAdapter, assembles via the same `core/assembly/` service the Local
  API and admin reader use, and returns a token-bounded, anchor-centered,
  cursor-paginated slice (never the whole document, never silently over
  budget; an oversized single table/code/checklist becomes a bounded
  descriptor pointing at `qdrant_get_node` instead of being truncated).
  `qdrant_search` hits and window chunks now expose `node_id`/`node_path`/
  `node_type` (omitted, never fabricated, on legacy collections).

Remaining work:

- generate summaries at useful navigation levels: file, major section, table,
  code block, and later collection;
- add pagination/depth controls for very large skeleton reads and file/
  section assembly responses (the MCP path already has bounded pagination
  via `qdrant_get_content`; the Local API's unbounded `/assembly` endpoint
  does not yet).

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
  payload/storage growth (skeleton stores `text` + `raw_content` + future
  `embedding_text` — expect 2–3× payload vs legacy), MCP list-tool latency
  (scroll-based aggregations grow with point count), and per-phase wall time;
- profile expensive phases before optimizing them;
- add external retrieval evaluation as a release and positioning gate:
  BEIR for established English retrieval tasks, MIRACL (its own supported
  languages — MIRACL does not include Ukrainian; a Russian/Cyrillic run is
  multilingual evidence only, not a Ukrainian-quality claim) for multilingual
  evidence, and MLDR for long-document retrieval. Ukrainian quality still
  requires a separate, dedicated Ukrainian dataset;
- compare semidex Local (BGE-M3 ONNX dense + learned sparse) against the
  semidex Lite candidate (Qdrant Cloud Inference) on the same corpora, qrels,
  metrics, and query set; measure nDCG/Recall alongside indexing latency,
  query latency, and provider cost;
- add grounded-answer evaluation for Ask: citation precision/recall, factual
  claim coverage, refusal correctness, end-to-end latency, and cost.

**Exit gate:** structural retrieval improves or preserves established
regression metrics; improvements reproduce across multiple document shapes; no
profile becomes a hidden requirement for acceptable baseline quality; indexing
cost and quality tradeoffs are documented honestly; the neutral profile
remains a usable default. (Skeleton-first chunking for Markdown is already
the unconditional default, decided ahead of this gate — see the MVP section
above; this gate now governs broader benchmark/profile validation, not
whether skeleton-first ships.)

### Product tracks (future, post-foundation)

These tracks share Stages 1–3 but do not need to block each other. Their order
is chosen by user value, available hardware, and validation results.

#### Track A — Assistant Runtime

**Goal:** make indexed collections usable by grounded assistants in websites,
internal tools, Telegram bots, custom applications, and local workflows.

**Partially shipped:** the local application server already exposes
`POST /api/ask` with hybrid retrieval, bounded evidence assembly, Ollama
generation, SSE streaming, citations, and cite-or-refuse behavior. The admin
Ask screen is a reference client and operator playground; it is not the public
product boundary.

**Next demo slice:**

- stabilize and version the application-facing HTTP/SSE contract;
- deploy a stateless single-collection reference assistant on a small CPU
  server;
- use Qdrant Cloud for storage and server-side embedding/retrieval and Gemini
  for answer generation, with secrets held only on the server;
- ship one simple web client that demonstrates grounded answers, citations,
  refusal, and source inspection;
- benchmark Qdrant Cloud inference against the local BGE-M3 path before making
  quality or equivalence claims.

**Later integrations:**

- provider-neutral `GenerationProvider` adapters for OpenAI-compatible APIs,
  OpenRouter, Anthropic, Gemini, and local runtimes;
- a small JavaScript/TypeScript client, embeddable website widget, and Telegram
  adapter built on the same public Ask contract;
- authentication, rate limits, abuse controls, sessions, observability,
  collection authorization, and multi-tenant isolation;
- configurable retrieval policy and evaluation of native on-device ONNX
  generation when the Node.js integration path matures.

Detailed product and API boundary:
[Ask application runtime](../design/ask-application-runtime.md).

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

Later opt-in enrichment may add external context for public/non-sensitive
images, for example Wikipedia or web lookup after OCR/VLM identification. This
must remain a separate derived layer with `source_kind=external`, source URL,
retrieval date, confidence/provenance, and privacy controls. It must never be
merged into local document evidence without explicit labeling.

#### Track D — Control Panel and Deployment Profiles

**Goal:** make setup and operation approachable without changing retrieval
semantics.

- local setup for Qdrant, Ollama, ONNX, and provider configuration;
- collection management and safe indexing actions;
- `doctor` results as actionable diagnostics; indexing progress by phase;
- manual search and chunk inspection; file-level graph visualization;
- copyable CLI equivalents for UI-triggered actions.

Deployment profiles: **semidex Local** (current primary), **semidex Lite**
(planned low-infrastructure profile: a small CPU application server, Qdrant
Cloud storage/inference, and a cloud generation provider),
**semidex Codebase** (planned specialization via Track B).

#### Track E — Qdrant-native Operations

**Goal:** use Qdrant's native control-plane capabilities for safe MVP/demo
operations instead of managing collections through ad hoc scripts or the Web UI.

- ✅ official JavaScript client integration — done: the entire Qdrant access
  layer (`src/core/qdrant.js`) now runs on `@qdrant/js-client-rest` with lazy
  client initialization; aliases/snapshots below can build on it directly;
- collection aliases for safe reindex and rollback;
- snapshots before prune, schema migration, destructive cleanup, and Qdrant
  upgrades;
- collection health checks: version, vector schema, payload indexes, optimizer
  status, point counts, alias target, and snapshot inventory;
- future evaluation of native Qdrant Query API features after the operational
  layer is stable.

This track is important for the first public demo: semidex should show a safe
operational story around Qdrant, not only a search demo. Detailed plan:
[Qdrant native operations roadmap](../design/qdrant-native-operations-roadmap.md).

#### Track F — Agent Memory Overlay

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
| ColBERT / late interaction | Benchmark-only, deferred. Standalone rerank failed the 2026-05-17 gate (ordering losses, ~11 s/query CPU); guarded/blended/trigger variants implemented in `bench:custom50:colbert` (2026-06-10), pending measurement | Correct chunks frequently exist in a wider candidate pool but hybrid RRF ranks them too low |
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
