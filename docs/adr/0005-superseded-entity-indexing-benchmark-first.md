# ADR 0005-DRAFT: Entity-Aware Indexing Benchmark-First

Status: Superseded

Date: 2026-05-20

Superseded by: [ADR 0005: Entity Boost Removed After Scope Validation](0005-entity-boost-opt-in.md)

This draft captured an earlier, heavier entity-indexing direction: extract
tables/code/entities, generate entity-specific context, and index those entities
as dedicated points. That direction remains a possible future architecture, but
it is not the accepted production plan.

The 2026-05-27 MVP was narrower and payload-only: extract lightweight entities
into chunk payloads and test post-RRF entity boost. That implementation path was
later removed after scope validation showed the extractor did not generalize
beyond semidex/code-style documentation.

## Context

semidex currently indexes documents as linear text chunks. Many documents contain
structured entities — fenced code blocks, markdown tables, function definitions,
class declarations, diagrams — that have retrieval semantics distinct from prose.

A user searching for "how to call embedForSearch" is looking for a specific code entity,
not a prose description of it. Current chunking embeds code alongside surrounding prose,
which may dilute the retrieval signal for exact API lookups.

Entity-aware indexing would extract these entities, generate query-hint context for them,
and index them as dedicated points — either alongside or instead of the prose chunks that
contain them.

## Decision

Entity-aware indexing is a promising direction but must start as benchmark-only. No
production entity pipeline will be added until a focused benchmark demonstrates a clear
retrieval benefit over the current chunk-based baseline on a representative corpus.

## Rationale

1. **The baseline is already strong for prose.** Hybrid RRF with ONNX embeddings achieves
   good recall on technical documentation queries. Adding entity indexing for its own sake
   risks adding complexity without measurable gain.

2. **Entity extraction increases LLM cost.** Each extracted entity needs context generation
   (query hints, summary) before embedding. This multiplies LLM calls and indexing time in
   proportion to entity density. Without a quality gate, the cost is unjustified.

3. **Architecture must be validated incrementally.** The right scope is: fenced code blocks
   and markdown tables first (high density, clear boundaries), then tree-sitter
   functions/classes, then diagrams and figures. Each tier needs its own benchmark.

4. **Entity payload vs. entity embedding.** The entity's raw text (code, table rows) should
   be stored as payload for exact answers, while the generated context/query-hints are
   embedded. Embedding raw code directly is likely to underperform embedding a natural
   language description of what the code does.

5. **Retrieval comparison is non-trivial.** Benchmarking entity retrieval requires queries
   that specifically target entities (not prose paraphrases), and a judgement set that
   marks entity-chunk hits differently from prose-chunk hits. This infrastructure does not
   yet exist.

## Consequences

- No entity extraction code is added to the production indexer until the benchmark gate is met.
- A benchmark plan should define: entity types in scope, corpus, query set, comparison
  baseline (current chunks vs entity-context points vs optional code-embedding baseline),
  and a minimum recall/MRR improvement threshold.
- LLM cost amplification must be measured and reported alongside quality metrics.
- If the benchmark shows entity indexing helps for code-heavy corpora but not prose-heavy
  ones, a corpus-type flag (e.g. `ENTITY_INDEX=1`) is the right opt-in surface.
- Revisit after custom-50/custom-150 benchmarks include code-specific queries, or when
  a codebase memory use case (incremental function indexing) becomes concrete.

## Evidence

- [`docs/en/roadmap.md`](../en/roadmap.md) — entity indexing roadmap section
- [`docs/en/architecture.md`](../en/architecture.md) — current chunking pipeline
- [`benchmarks/retrieval/results/2026-05-17-architecture-blockers-audit.md`](../../benchmarks/retrieval/results/2026-05-17-architecture-blockers-audit.md)
- [`benchmarks/retrieval/results/2026-05-14-self-docs-bootstrap-design.md`](../../benchmarks/retrieval/results/2026-05-14-self-docs-bootstrap-design.md)
