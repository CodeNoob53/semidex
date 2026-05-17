# Architecture Overview

semidex is a local-first semantic indexing and retrieval system. It has two runtime entry points: the indexer and the MCP server.

## Indexing Pipeline

The indexer processes documents in five phases:

**Phase 1: Chunking.** Documents are split into overlapping chunks using a recursive text splitter. Markdown headings become section boundaries. Each chunk carries `source_file`, `section`, `chunkIndex`, and `totalChunks`.

**Phase 2: Contextualization.** Each chunk receives a 1-2 sentence LLM summary describing what it is about. Adjacent chunks flagged with `needsBoundaryCheck` may be merged via a merge/split LLM call before contextualization. In combined mode (`COMBINED_LLM=1`), this phase is merged with Phase 3.

**Phase 3: Tagging.** Each chunk receives 3-7 lowercase hyphenated tags describing its topic. Tags are generated in batches. In combined mode, this phase is skipped and tags are returned by the same call that generates context.

**Phase 4: Embedding and upsert.** The concatenated `context + "\n\n" + text` string is embedded using either ONNX (`bge-m3-onnx`) or Ollama (`bge-m3`). Both dense and sparse vectors are produced. Points are upserted to Qdrant with full payload metadata.

**Phase 5: Linking.** Each chunk is linked to semantically similar chunks across all configured collections using cosine similarity. Links and backlinks are stored in both Qdrant payload and a local graph file.

## MCP Server

The MCP server exposes hybrid search, chunk retrieval, tag filtering, and graph traversal as tools for AI agents. It does not write to Qdrant. All reads go through the Qdrant REST API.

## Provider System

Dense and sparse embedding providers are stored per collection in `config.json` and in the Qdrant payload. Changing providers requires reindexing. The ONNX execution provider (`cpu`, `dml`, `cuda`) is performance-only and does not affect provider metadata.
