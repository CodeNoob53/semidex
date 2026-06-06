# Configuration and Environment Variables

semidex is configured through `.env` file variables and per-collection metadata
in `config.json`. Most variables have sensible defaults; only `QDRANT_URL` and
`QDRANT_KEY` are required.

## Required

| Variable | Description |
|----------|-------------|
| `QDRANT_URL` | Qdrant instance URL (e.g. `http://localhost:6333`) |
| `QDRANT_KEY` | Qdrant API key (can be any string for local instances) |

## Embedding Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_EMBED` | `0` | Shorthand to enable `bge-m3-onnx` for both dense and sparse |
| `DENSE_PROVIDER` | unset | Explicit override: `ollama` or `bge-m3-onnx` |
| `SPARSE_PROVIDER` | unset | Explicit override: `hashed-tf` or `bge-m3-onnx` |
| `DENSE_MODEL` | unset | Dense model for Ollama (`bge-m3` is default if Ollama selected) |

Valid provider combinations:
- `ollama + hashed-tf` (default, no ONNX required)
- `bge-m3-onnx + bge-m3-onnx` (requires ~2.3 GB ONNX model download)

Mixed combinations (`ollama + bge-m3-onnx` or `bge-m3-onnx + hashed-tf`) are
rejected at runtime with an `Invalid provider combination` error.

## Ollama Models

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `EMBED_MODEL` | `bge-m3` | Dense embedding model |
| `CONTEXT_MODEL` | `gemma3:4b` | Model for LLM chunk contextualization |
| `TAG_MODEL` | `gemma3:4b` | Model for LLM tag generation |

## Indexing (per-run, passed on CLI not .env)

| Variable | Description |
|----------|-------------|
| `COLLECTION` | Target Qdrant collection name |
| `SOURCE_ROOT` | Root path used to compute stable `source_file` IDs |

`SOURCE_ROOT` should be set to the root of the documents directory so that
`source_file` values are stable across machines and across runs from different
working directories.

## Chunking

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `MAX_CHUNK_TOKENS` | `400` | 1–100000 | Maximum tokens per chunk |
| `MIN_CHUNK_TOKENS` | `30` | 0–100000 | Minimum tokens; smaller sections may be skipped |
| `OVERLAP_SENTENCES` | `2` | 0–100 | Sentence overlap between consecutive chunks |
| `LLM_BATCH_SIZE` | `3` | — | Chunks per LLM call for context/tag phases |

All chunking vars are validated on startup with `envInt()`. Invalid values produce
a warning and fall back to the default.

## Hybrid Search

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `RRF_K` | `60` | 1–10000 | RRF smoothing constant |
| `HYBRID_PREFETCH_LIMIT` | `2` | 1–100 | Prefetch multiplier per dense/sparse RRF leg |

`HYBRID_PREFETCH_LIMIT` controls how many candidates each leg fetches before RRF fusion.
The actual prefetch count is `max(limit * HYBRID_PREFETCH_LIMIT, limit + 1)`.

## Reranking (experimental)

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANK_ENABLED` | `0` | Enable local BM25 reranker |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier before reranking |
| `RERANK_DEBUG` | `0` | Print per-result scoring details |
| `RERANK_BOOST_SOURCE_FILE` | `0.08` | Score boost per token hit in source filename |
| `RERANK_BOOST_SECTION` | `0.06` | Score boost per token hit in section heading |
| `RERANK_BOOST_TAGS` | `0.05` | Score boost per token hit in tags |
| `RERANK_BOOST_TEXT` | `0.01` | Score boost per token hit in body text |
| `RERANK_PROTECT_TOP1_DELTA` | `0.05` | Minimum advantage required to displace RRF rank-0 |

## Benchmark Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCH_TOP_K` | `5` | Search depth (top-K results) |
| `BENCH_PROVIDER` | env | Force provider: `onnx` or use env defaults |
| `BENCH_SKIP_INDEX` | unset | Reuse existing bench collection; skip reindexing |
| `BENCH_JSON` | unset | Emit JSON summary on stdout |
| `BENCH_SEARCH_MODE` | `hybrid` | `hybrid` or `dense-mmr` |
| `MMR_DIVERSITY` | `0.5` | Dense MMR diversity balance (0–1) |
| `MMR_CANDIDATES_LIMIT` | `100` | Dense MMR preselect candidate count |
| `MMR_DIVERSITIES` | `0.3,0.5,0.7` | Comma-separated diversity values for mmr-matrix |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier for rerank phase in benchmark |

## config.json

`config.json` is written by `npm run sync` and updated by `npm run index` when
a new collection is created. It is git-ignored.

Example structure:

```json
{
  "collections": {
    "my-notes": {
      "denseProvider": "bge-m3-onnx",
      "denseModel": "aapot/bge-m3-onnx",
      "sparseProvider": "bge-m3-onnx",
      "embeddingSchemaVersion": 2,
      "vectorSize": 1024,
      "description": "Personal knowledge base"
    }
  }
}
```

The six reindex discriminators stored in `config.json` per collection are:
`denseProvider`, `denseModel`, `sparseProvider`, `embeddingSchemaVersion`,
`vectorSize`, and implicitly `file_hash` (stored per-point in Qdrant, not config).
Changing any of these triggers a full reindex of all files in that collection.
