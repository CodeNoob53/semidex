# ONNX Tag Provider Indexing Benchmark

**Date:** 2026-06-05 02:39:44  
**Fixture:** benchmarks/retrieval/fixtures/combined-live (20 points sampled)  
**Both runs:** PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1

## Wall-Clock Comparison

| Provider | Wall time | Files | Indexed | Total chunks (logged) | Error |
|----------|----------:|------:|--------:|---------------------:|-------|
| ollama | 88.0s | 5 | 5 | 24 | -- |
| onnx | 48.9s | 5 | 5 | 24 | -- |

ONNX speedup vs ollama: **1.80x**

## Tag Quality (sampled from Qdrant, ~20 points each)

| Provider | Points sampled | With tags | Fill rate |
|----------|---------------:|----------:|----------:|
| ollama   | 20 | 20 | 100% |
| onnx     | 20 | 20 | 100% |

### Sample ONNX tags

- `05-ukrainian.md`: `bash`, `shell-scripting`, `command-line-tools`
- `05-ukrainian.md`: `qdrant-search`, `onnx`, `my-docs`
- `02-architecture.md`: `dense`, `sparse`, `embedding`, `provider`, `provider-metadata`, `execution-provider`
- `05-ukrainian.md`: `semidex`, `ollama`, `onnx`
- `01-technical-config.md`: `onnx-embed`, `bge-m3`, `ollama`

### Sample Ollama tags

- `02-architecture.md`: `chunking`, `recursive-splitter`, `text-splitter`, `markdown-headings`, `chunk-metadata`
- `02-architecture.md`: `qdrant`, `embedding-providers`, `provider-configuration`, `reindexing`, `onnx-execution`, `dense-embeddings`, `sparse-embeddings`
- `05-ukrainian.md`: `semidex-indexing`, `ai-agent`, `semantic-search`, `ollama-integration`, `qdrant-database`
- `05-ukrainian.md`: `command-line`, `retrieval-bench`, `npm`
- `01-technical-config.md`: `chunk-tokens`, `max-tokens`, `min-tokens`, `overlap-sentences`, `llm-batching`

## Verdict

**ONNX_TAG_PROVIDER_ACCEPT**

Reason: fill rate 100%, speedup 1.80x

### Thresholds
- ACCEPT: no errors, fill rate >= 70%, ONNX wall >= 0.85x ollama wall
- NEEDS_TUNING: fill rate 50-70%, or ONNX slower than 0.85x ollama
- REJECT: indexer error, or fill rate < 50%

### Notes
- Both runs use throw-away collections (deleted after benchmark)
- TAG_ONNX_THREADS=1 (recommended initial budget per worker-budget benchmark)
- ONNX tag worker runs in parallel with Ollama context generation after merge
- Wall time includes model load/warm-up on first file
