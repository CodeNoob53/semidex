# Semidex Roadmap

Status: canonical product roadmap. Updated 2026-08-13.

This document describes the current product state and the next engineering
priorities. Dated phase reports, implementation plans, and review notes under
`docs/` are historical records. When their status conflicts with this file or
with the current code, this roadmap and the code take precedence.

## Status legend

- **Shipped**: implemented and covered by the normal verification path.
- **Active**: current product or engineering priority.
- **Next**: intended after the active work; not a release promise.
- **Later**: useful direction without an assigned delivery window.
- **Research**: must earn implementation through evidence or benchmarks.

The roadmap is dependency-ordered, not calendar-ordered.

## Product direction

Semidex is a flexible retrieval and grounded-answering system for personal
research, education, developer tools, assistants, and business knowledge
workflows. It should make RAG useful without forcing every user to assemble a
parser, embedding pipeline, vector database integration, retrieval layer, and
agent interface from scratch.

Semidex has two product forms built from the same shared foundation:

- **Full Semidex** is local-first. It supports local Qdrant, local embedding and
  generation runtimes, hardware-aware execution, MCP, indexing, retrieval, and
  the admin application.
- **Semidex Lite** is the cloud-oriented npm package. It uses Qdrant Cloud
  Inference for embeddings and a cloud generation provider, and is intended to
  be embedded behind another application's backend as well as used through its
  CLI and dashboard.

Full Semidex may use cloud capabilities. Semidex Lite must not depend on or
ship local-only runtime code. Shared behavior belongs in shared modules;
edition-specific composition belongs in separate Full and Lite roots.

## Current snapshot

| Area | Current state |
|---|---|
| Editions | Full and Lite have separate composition roots and build closures |
| Ingestion | Markdown uses skeleton-first structural chunking; other formats still have format-specific limitations |
| Embeddings | Local BGE-M3 ONNX dense + learned sparse; Qdrant Cloud Inference profiles |
| Retrieval | Dense, sparse, and hybrid Qdrant retrieval with RRF fusion |
| Navigation | Skeleton maps, structural nodes, bounded section/file assembly, and MCP navigation tools |
| Ask | v1 stateless single-turn API; v2 caller-owned conversational context with bounded history |
| Generation | Ollama in Full; Gemini in Lite; provider seam exists for additional backends |
| Operations | Typed settings, collection embedding profiles, health probes, device-aware indexing, managed Windows CUDA installer |
| Distribution | `semidex-lite` is published on npm; Full does not yet have a supported public package |

## Shipped foundation

### 1. Edition architecture

- Shared, local, cloud, and composition-owned code are separated by ownership.
- Full and Lite resolve their own capabilities and runtime dependencies.
- Lite package builds verify that local ONNX, CUDA, DirectML, Ollama, and local
  model code are absent from the shipped closure.
- Runtime capabilities are instance-scoped instead of being selected through a
  process-wide mutable edition switch.
- Clean tarball installation and publication provenance are part of the Lite
  release path.

### 2. Indexing and document structure

- Deterministic file and point identity, content-hash skip, stale-file pruning,
  schema-aware reindex detection, and collection metadata.
- Skeleton-first Markdown parsing with stable document, section, and entity
  identity.
- Structural handling for prose, tables, code blocks, and checklists, including
  token-budget splitting for oversized entities while preserving canonical raw
  content.
- Skeleton navigation points and collection/file summaries.
- Bounded indexing stages with device-aware scheduling and explicit resource
  identities for generation, tagging, and embeddings.

Known limitation: non-Markdown ingestion does not yet provide the same quality
of native structural identity as Markdown. PDF, office/Pandoc, plain-text, OCR,
and image paths need a unified structure-and-provenance contract.

### 3. Retrieval and Qdrant integration

- Local BGE-M3 ONNX dense and learned-sparse vectors.
- Qdrant Cloud Inference with selectable supported dense models and BM25 sparse
  retrieval.
- Collection-native embedding profiles, compatibility checks, migration of
  legacy collections when identity can be inferred safely, and automatic
  profile resolution for search.
- Hybrid retrieval through Qdrant with RRF fusion.
- Skeleton and content tools for orientation, bounded evidence assembly, and
  retrieval of authoritative structural entities.

Benchmark work includes BEIR SciFact, MIRACL-derived studies, Slavic-language
Belebele evaluation, fusion sweeps, and production-path comparisons. These
results support the claim that Semidex has a working hybrid retrieval pipeline;
they do not by themselves prove superiority over other RAG products.

### 4. Agent and API surfaces

- MCP server for collection discovery, search, navigation, tags, chunks,
  original entities, and bounded coherent context.
- Ask API v1 for stateless single-turn grounded answers.
- Ask API v2 for caller-supplied conversation history and rolling summary,
  bounded context, follow-up query rewriting, and optional summary compaction.
- The caller owns chat persistence, users, authorization, and conversation
  identifiers. Semidex v2 does not store server-side chat history.
- Lite README includes backend integration examples; the dashboard is a
  reference and debugging surface, not the only Ask client.

### 5. Runtime and operator tooling

- Read-only doctor checks, typed settings registry, admin API, and settings UI.
- Provider/model discovery and collection availability reporting.
- CPU, DirectML, and managed/custom CUDA configuration for local ONNX workloads.
- Reproducible managed Windows CUDA runtime installation with trust gates,
  manifests, verification, and admin selection.
- Device-aware indexing overlap: independent resources may run concurrently;
  workloads sharing a constrained resource remain bounded.

## Active priorities

### P0. Public demo and one complete use case

Build a deployable assistant that demonstrates Semidex as the retrieval and
grounding core rather than as an isolated admin console. The preferred first
case is a retail/knowledge assistant suitable for both the Silpo AI Factory
application and a Qdrant-facing technical demonstration.

Required outcome:

- a real corpus with documented provenance and update flow;
- Qdrant-backed indexing and retrieval;
- an external application/backend calling the Ask API with an explicit
  collection;
- visible citations or evidence links;
- a small evaluation set covering answer quality, refusal, and negative cases;
- documented latency and operating cost;
- a reproducible deployment and reset procedure.

### P0. Public-facing hardening

Before presenting Semidex Lite as a reusable assistant backend:

- define authentication and remote-exposure guidance;
- add rate-limit, timeout, cancellation, and retry behavior at public API
  boundaries;
- document secret handling and safe deployment defaults;
- keep clean-install and release acceptance tests representative of the
  published tarball;
- provide concise JavaScript/TypeScript examples for indexing, search, Ask v1,
  and Ask v2;
- make errors actionable without exposing provider secrets or internal paths.

### P1. Ingestion, OCR, and vision

Create one provenance-preserving ingestion contract for text and visual
content:

1. represent images and extracted regions as first-class source entities;
2. add deterministic OCR with page, bounding-box, and source references;
3. add an optional vision-language interpretation capability;
4. preserve original assets and connect derived text to them;
5. evaluate scanned PDFs, screenshots, diagrams, and mixed documents;
6. bring non-Markdown formats closer to skeleton-level navigation quality.

This work must not silently replace authoritative source content with generated
descriptions.

### P1. Retrieval and answer evaluation

- Build or adopt a Ukrainian retrieval and grounded-answer evaluation set.
- Separate embedding, sparse retrieval, fusion, reranking, and generation
  effects in reports.
- Add answer-level groundedness, citation correctness, negative-answer, and
  weak-model tests.
- Compare complete workflows with relevant open RAG systems using the same
  corpus and questions.
- Measure indexing throughput, peak RAM/VRAM, search latency, generation
  latency, and cloud cost on realistic small and medium corpora.
- Publish limitations by language and provider instead of generalizing from an
  English benchmark.

### P1. Generation providers

Keep one provider-neutral generation contract and add backends only through
that seam. Priority order:

1. OpenAI-compatible APIs, including OpenRouter-compatible configuration;
2. Anthropic;
3. additional Gemini modes beyond the current Lite path;
4. cloud Ollama-compatible services when their contract is verified;
5. local ONNX generation only after a real implementation and runtime/resource
   model exist, not as a renamed embedding capability.

Provider choice must remain independent from embedding choice. Cloud and local
workloads may overlap when their verified resource identities do not conflict.

### P1. Integration surface

- Publish a stable JS/TS client for search and Ask contracts.
- Provide a minimal website/backend integration example.
- Define a small embeddable chat/reference client after the API contract is
  stable.
- Add Telegram or similar channel adapters as examples, not as core retrieval
  logic.

## Next tracks

### Codebase Memory

Add code-aware ingestion and retrieval without creating a separate product:

- parser-derived symbol and reference metadata;
- symbol-aware chunks and exact symbol lookup;
- dependency and call-graph navigation;
- code-specific retrieval evaluation;
- repository change tracking and incremental reindexing.

### Durable conversation and agent memory

Ask v2 deliberately leaves persistence to the caller. A future stateful layer
may provide adapters and policies for:

- conversation/message storage;
- retrieval over compacted chat history after it leaves the active context
  window;
- optional memory shared across conversations;
- provenance, confidence, correction, expiry, deletion, and tenant isolation;
- user-controlled rules deciding what may become durable memory.

Semidex should provide the mechanism, not take ownership of user data. Storage
must remain in infrastructure selected and controlled by the deployer. This is
not planned for Ask v2 and should not be introduced as hidden persistence.

### Qdrant lifecycle operations

Continue the separate design track in
`docs/design/qdrant-native-operations-roadmap.md`:

- alias-based safe reindex and rollback;
- snapshots and restore workflows;
- payload-index management;
- optimizer and collection-health diagnostics;
- explicit destructive-operation safeguards.

### Deployment and multi-tenant operation

- explicit collection/tenant authorization boundaries;
- quotas and per-provider cost controls;
- background job persistence and recovery;
- observable indexing and Ask operations;
- deployment recipes for a small cloud server and managed Qdrant.

## Research backlog

These are not default features. Implement them only when a reproducible
evaluation shows a meaningful gain that justifies complexity and cost.

| Candidate | Trigger |
|---|---|
| Dynamic dense/sparse weighting or fusion | Stable language/provider-specific regression |
| MMR or diversity reranking | Repeated near-duplicate top results harming answer coverage |
| Cross-encoder reranking by default | Consistent answer-quality gain within latency budget |
| ColBERT/multi-vector retrieval | Material gain over hybrid retrieval on target corpora |
| Query expansion or decomposition | Ask failures attributable to retrieval formulation |
| Learned tag generation | Demonstrated filtering/navigation value beyond skeleton structure |
| Server-side conversation memory | Concrete product requiring it plus a reviewed privacy model |

## MVP/demo exit gates

The next public milestone is complete when:

- a new user can install and configure Semidex Lite from the published package;
- the demo indexes, retrieves, and answers from a real corpus end to end;
- API examples show collection selection and caller-owned conversation state;
- authentication and deployment boundaries are explicit;
- groundedness and negative cases have reproducible tests;
- benchmark claims link to reports and state their scope;
- failures are recoverable and do not corrupt or silently mix collection
  profiles;
- Full/Lite build-closure tests remain green.

## Non-goals

- Owning or centrally storing customer documents, chats, or user memory.
- Replacing Qdrant, MCP, or general-purpose agent orchestration frameworks.
- Treating generated summaries, tags, OCR, or visual descriptions as
  authoritative source evidence.
- Claiming medical, legal, or other high-stakes authority from retrieval alone.
- Supporting arbitrary vector databases before the Qdrant lifecycle and public
  API contracts are stable.
- Adding retrieval techniques because they are fashionable rather than because
  evaluation demonstrates a need.

## Document policy

- This file is the only canonical product roadmap.
- Dated files named `phase-*`, `*-report-*`, reviews, and implementation plans
  record decisions and verification at a point in time; they are not active
  status dashboards.
- Design documents may remain active for one bounded subsystem. Their scope and
  status must be stated at the top and linked from this roadmap when relevant.
- Completed design plans should be marked implemented or historical instead of
  being silently rewritten.
- Any roadmap claim about shipped behavior should have a code path, test, or
  implementation report that can verify it.
