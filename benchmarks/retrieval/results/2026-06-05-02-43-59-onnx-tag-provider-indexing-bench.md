# ONNX Tag Provider Indexing Benchmark

**Date:** 2026-06-05 02:43:59  
**Fixture:** benchmarks/retrieval/fixtures/combined-live (20 points sampled)  
**ONNX tag model:** onnx-community/Qwen2.5-Coder-0.5B-Instruct  
**Both runs:** PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1

## Wall-Clock Comparison

| Provider | Wall time | Files | Indexed | Total chunks (logged) | Error |
|----------|----------:|------:|--------:|---------------------:|-------|
| ollama | 41.8s | 5 | 5 | 24 | -- |
| onnx | 47.4s | 5 | 5 | 24 | -- |

ONNX speedup vs ollama: **0.88x**

## Tag Quality (sampled from Qdrant, ~20 points each)

| Provider | Points sampled | With tags | Fill rate |
|----------|---------------:|----------:|----------:|
| ollama   | 20 | 20 | 100% |
| onnx     | 20 | 20 | 100% |

### Sample ONNX tags

- `01-technical-config.md`: `onnx-embed`, `bge-m3`, `ollama`
- `04-operations.md`: `onnx-embed`, `collection`, `npm`, `index`, `docs`
- `05-ukrainian.md`: `qdrant`, `ollama`, `nodejs`, `docker`
- `04-operations.md`: `prune-stale`, `onnx-embed`, `collection`, `npm`, `run`
- `01-technical-config.md`: `qdrant-url`, `qdrant-key`, `cloud`, `self-hosted`

### Sample Ollama tags

- `01-technical-config.md`: `onnx-embedding`, `bge-m3`, `multilingual-embeddings`, `text-embeddings`, `local-model-cache`, `hybrid-search`, `ollama`
- `02-architecture.md`: `qdrant`, `hybrid-search`, `chunk-retrieval`, `tag-filtering`, `graph-traversal`
- `05-ukrainian.md`: `qdrant-search`, `onnx`, `mcp-server`, `qdrant`, `document-search`, `ukrainian`, `query`
- `03-short-chunks.md`: `greeting`, `introduction`, `dialogue`, `simple`, `text`
- `01-technical-config.md`: `qdrant`, `connection`, `url`, `key`, `setup`

## Verdict

**ONNX_TAG_PROVIDER_ACCEPT**

Reason: fill rate 100%, speedup 0.88x

### Thresholds
- ACCEPT: no errors, fill rate >= 70%, ONNX wall >= 0.85x ollama wall
- NEEDS_TUNING: fill rate 50-70%, or ONNX slower than 0.85x ollama
- REJECT: indexer error, or fill rate < 50%

### Notes
- Both runs use throw-away collections (deleted after benchmark)
- TAG_ONNX_THREADS=1 (recommended initial budget per worker-budget benchmark)
- ONNX tag worker runs in parallel with Ollama context generation after merge
- Wall time includes model load/warm-up on first file
