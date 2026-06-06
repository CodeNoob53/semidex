# semidex Runtime Configuration Manual

## 1. Overview

This document details the configuration parameters for the semidex runtime. Proper configuration is essential for data integrity and optimal retrieval performance.

## 2. Environment Variables

The runtime relies on environment variables for initial setup.

### 2.1 Core Environment Settings

| Variable Name | Description | Default Value |
| :--- | :--- | :--- |
| `QDRANT_URL` | Qdrant instance URL. | `http://localhost:6333` |
| `QDRANT_KEY` | Qdrant API key (required for cloud). | — |
| `ONNX_EMBED` | Set to `1` to enable the BGE-M3 ONNX embedding provider. | — |
| `LOG_LEVEL` | Logging verbosity (DEBUG, INFO, WARN, ERROR). | INFO |

## 3. Provider Configuration and Mismatch Warnings

This section covers how the runtime connects to embedding backends and vector storage.

### 3.1 Provider Selection

The system supports multiple embedding providers. Ensure the selected provider matches the one used when the collection was originally indexed.

[[BENCH_ANCHOR: CFG_PROVIDER_MISMATCH]]
**Warning:** If the configured provider does not match the provider stored in the collection metadata, semidex raises a provider mismatch error and aborts the operation. This is a critical configuration error requiring reindexing.

### 3.2 Provider-Specific Settings

For dense vector storage, configure `DENSE_PROVIDER`. For sparse indexing, configure `SPARSE_PROVIDER`. Mixed provider combinations are rejected at runtime.

## 4. Chunk Boundary Settings

Controlling how source documents are split is essential for retrieval quality.

### 4.1 Chunking Strategy

The `MIN_CHUNK_TOKENS`, `MAX_CHUNK_TOKENS`, and `OVERLAP_SENTENCES` parameters govern the chunking mechanism.

[[BENCH_ANCHOR: CFG_CHUNK_BOUNDARY]]
The chunking strategy respects Markdown heading boundaries. A section shorter than `MIN_CHUNK_TOKENS` is preserved as its own chunk rather than merged. `MAX_CHUNK_TOKENS` controls when a large flat section is split into sub-chunks. Adjust these parameters to control the granularity of the index.

## 5. Model Cache and Local LLM Settings

Managing local models and their caches is critical for offline operation.

### 5.1 Model Caching

The location for downloaded and processed model weights must be explicitly configured.

[[BENCH_ANCHOR: CFG_MODEL_CACHE]]
Set `MODEL_CACHE_DIR` to the directory where ONNX model weights are stored. On first use with `ONNX_EMBED=1`, the BGE-M3 model downloads automatically to this path.

### 5.2 Local LLM Initialization

When running entirely offline, the local LLM must be correctly pointed to.

[[BENCH_ANCHOR: CFG_LOCAL_LLM]]
Semidex uses Ollama for context summaries and tag generation. Set `OLLAMA_URL` when the Ollama instance is not on the default `http://localhost:11434`. The `LLM_MODEL` variable selects the generation model (default: `gemma3:4b`).

## 6. Vector and Sparse Storage

Defining where embeddings and metadata are persisted.

### 6.1 Vector Store Configuration

[[BENCH_ANCHOR: CFG_VECTOR_STORAGE]]
The primary vector database connection string is provided through `QDRANT_URL`. All collections are stored in this Qdrant instance. `QDRANT_KEY` is required for Qdrant Cloud deployments.

### 6.2 Sparse Indexing Configuration

[[BENCH_ANCHOR: CFG_SPARSE_PROVIDER]]
`SPARSE_PROVIDER` determines the backend for sparse vector representations. Supported values: `hashed-tf` (zero-dependency, default) and `bge-m3-onnx` (high-quality, requires `ONNX_EMBED=1`). Mixing sparse providers across indexing and querying is not supported.

## 7. Sync, Backfill, and Reindex Triggers

Managing the state synchronization of the index.

### 7.1 Initial Synchronization

[[BENCH_ANCHOR: CFG_BACKFILL_SYNC]]
To perform initial synchronization of `config.json` with Qdrant payload indexes, run `npm run sync`. This command writes collection metadata and ensures payload field indexes are up to date.

### 7.2 Reindexing Triggers

[[BENCH_ANCHOR: CFG_REINDEX_TRIGGER]]
If the embedding provider changes, manual reindexing is required. semidex detects provider mismatches at startup and exits with an error rather than silently writing incompatible vectors. Set the new provider in `.env` and re-run `COLLECTION=<name> npm run index <path>` to reindex the affected collection.

## 8. Rate Limits and Retry Policy

Controlling API interaction frequency and failure handling.

### 8.1 Rate Limiting

[[BENCH_ANCHOR: CFG_RATE_LIMIT]]
`RATE_LIMIT_RPS` controls the maximum number of embedding API requests per second when using Ollama. The default is no rate limiting. Set this when the local Ollama instance is shared across multiple processes.

### 8.2 Retry Mechanism

[[BENCH_ANCHOR: CFG_ENV_RETRY_POLICY]]
Transient embedding or Qdrant errors trigger a configurable retry policy. `RETRY_MAX_ATTEMPTS` (default: 3) and `RETRY_DELAY_MS` (default: 500) control the retry behavior. Set `RETRY_POLICY=none` to disable retries during benchmarking.

## 9. Index Inspection

Inspecting indexed content via MCP tools.

[[BENCH_ANCHOR: CFG_INDEX_INSPECTION]]
To inspect indexed chunk content, use `qdrant_get_chunk(collection, source_file, chunk_index)`. Setting `window=1` returns the target chunk plus its immediate neighbors, which is useful for verifying section boundaries and overlap behavior before benchmark runs. Use `qdrant_list_files` to enumerate all indexed files in a collection.

## 10. Mixed-Language Notes

Технічні налаштування для багатомовних репозиторіїв вимагають уваги.

[[BENCH_ANCHOR: CFG_UA_MIXED_CONTENT]]
При роботі з контентом, що містить українську та англійську технічну термінологію (наприклад, `QDRANT_URL` та `параметри`), переконайтеся, що кодування встановлено як UTF-8. BGE-M3 ONNX підтримує мультимовні запити без додаткового налаштування.

## 11. Troubleshooting

### 11.1 Common Errors

If you encounter issues, check the following:

1. **Cache Issues:** Delete `MODEL_CACHE_DIR` contents if model weights appear corrupted and let semidex re-download on next run.
2. **Provider Mismatch:** Review Section 3.1. Reindex the collection with the correct provider.
3. **Boundary Issues:** Adjust `MIN_CHUNK_TOKENS` and `MAX_CHUNK_TOKENS` in Section 4.1.

### 11.2 Advanced Debugging

For deep debugging, set `LOG_LEVEL=DEBUG` and examine the output for detailed tokenization and chunking traces.
