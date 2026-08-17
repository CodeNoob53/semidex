# semidex Documentation (English)

This directory contains the detailed English documentation for semidex. The root `README.md` is the short entry point; these files hold the implementation details, operating notes, and quality workflows.

Other languages: [Українська](../ua/README.md)

| Document | Purpose |
|----------|---------|
| [installation.md](installation.md) | Lite and Full installation, provider setup, indexing, and verification |
| [architecture.md](architecture.md) | How the indexer pipeline works and what is stored |
| [retrieval.md](retrieval.md) | Hybrid search, providers, RRF, and reranking |
| [mcp-tools.md](mcp-tools.md) | MCP tool reference and agent workflows |
| [configuration.md](configuration.md) | Environment variables, formats, provider config, indexes |
| [windows-cuda-onnxruntime-install.md](windows-cuda-onnxruntime-install.md) | Reproducible managed CUDA `onnxruntime-node` installer for Windows |
| [chunking-quality.md](chunking-quality.md) | Chunking guarantees, failure modes, quality metrics, large-doc benchmark plan |
| [testing.md](testing.md) | Unit tests (node:test), conventions, smoke→unit migration plan |
| [benchmarking.md](benchmarking.md) | Smoke tests, retrieval benchmark, metrics, regression workflow |
| [benchmark-dataset-plan.md](benchmark-dataset-plan.md) | Three-tier benchmark strategy: custom-50 dev loop, custom-150 validation, holdout-50 blind test |
| [roadmap.md](roadmap.md) | Product direction, near-term priorities, and non-goals |
| [project-structure.md](project-structure.md) | Source tree, runtime entry points, generated files |
| [operations.md](operations.md) | Usage examples, limitations, troubleshooting |

Product and architecture designs:

| Document | Purpose |
|----------|---------|
| [Ask application runtime](../design/ask-application-runtime.md) | Public Ask boundary, demo scope, website/bot integrations, provider separation, and evaluation gates |
| [Ask dashboard reference client](../design/ask-chat.md) | Admin Ask UI behavior built on the application runtime |
