# Architecture Decision Records

ADRs document the core architecture decisions for semidex. They are written after
a decision is backed by benchmarks or implementation experience — not as speculation.

## Statuses

| Status | Meaning |
|--------|---------|
| **Proposed** | Decision drafted; not yet validated by benchmarks or production use |
| **Accepted** | Decision is active and governs current implementation |
| **Deferred** | Considered but postponed; revisit when blockers are resolved |
| **Superseded** | Replaced by a later ADR |

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-bge-m3-onnx-as-recommended-provider.md) | BGE-M3 ONNX as recommended embedding provider | Accepted |
| [0002](0002-hybrid-rrf-as-default-retrieval.md) | Hybrid dense+sparse RRF as default retrieval | Accepted |
| [0003](0003-rerankers-default-off.md) | Rerankers default-off | Accepted |
| [0004](0004-combined-llm-opt-in.md) | Combined LLM context+tags mode opt-in | Accepted |
| [0005](0005-entity-boost-opt-in.md) | Entity boost removed after scope validation | Accepted |
| [0005-draft](0005-entity-indexing-benchmark-first.md) | Entity-aware indexing benchmark-first | Superseded |
