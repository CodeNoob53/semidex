# Configuration Reference

This document describes the environment variables used by semidex.

## Embedding

Set `ONNX_EMBED=1` to use the local ONNX embedding model (`bge-m3-onnx`). This downloads approximately 2.3 GB on first use into `./models/`. Subsequent runs read from the local cache. The ONNX model supports multilingual text and produces both dense and sparse vectors for hybrid search.

Without `ONNX_EMBED=1`, the indexer uses Ollama with the `bge-m3` model for embeddings. This requires Ollama running locally with the model pulled.

## LLM Models

`CONTEXT_MODEL` controls which Ollama model generates chunk context summaries. Default: `gemma3:4b`.

`TAG_MODEL` controls which model generates tags. Default: `gemma3:4b`. When `COMBINED_LLM=1`, this variable is ignored — `CONTEXT_MODEL` is used for both context and tags.

`COMBINED_LLM=1` enables a single LLM call per chunk that returns both context and tags as a JSON object. Falls back to separate calls per chunk on parse failure.

## Qdrant

`QDRANT_URL` and `QDRANT_KEY` must be set to connect to Qdrant. The URL should not have a trailing slash. Cloud and self-hosted instances are both supported.

## Chunking

`MAX_CHUNK_TOKENS` defaults to 400. `MIN_CHUNK_TOKENS` defaults to 30. `OVERLAP_SENTENCES` defaults to 2. Chunks below `MIN_CHUNK_TOKENS` may not trigger LLM calls in combined mode.

`LLM_BATCH_SIZE` controls how many chunks are processed concurrently by `runBatched`. Default: 3.
