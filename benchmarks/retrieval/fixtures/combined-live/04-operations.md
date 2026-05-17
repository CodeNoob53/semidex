# Operations Guide

## Indexing

To index a folder of Markdown files:

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

To use combined LLM mode (faster, single call per chunk):

```bash
COMBINED_LLM=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Set `TAG_MODEL` only if you need a separate tagging model in default mode. When `COMBINED_LLM=1`, `TAG_MODEL` is ignored and `CONTEXT_MODEL` is used for both context and tags.

## Incremental Reindexing

Unchanged files are detected by SHA-256 hash and skipped automatically. Only files whose hash, provider, or schema version changed are reindexed. Skip-path overhead is approximately 67-73 ms per file for a 15-file corpus.

## Stale File Cleanup

Run with `PRUNE_STALE=1` against the full source root to remove Qdrant points for deleted or renamed files:

```bash
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Never use `PRUNE_STALE=1` against a subdirectory — it would incorrectly mark all other files as stale.

## Health Check

```bash
npm run doctor
```

Doctor checks Qdrant connectivity, Ollama reachability, model availability, schema version, and provider agreement. It also reports `COMBINED_LLM` status and warns if `TAG_MODEL` is set to a different model.

## Benchmarking

```bash
npm run bench:indexing          # Indexing phase timing benchmark
npm run bench:combined-probe    # Combined context+tags feasibility probe
npm run bench:custom50          # Custom-50 retrieval benchmark
```
