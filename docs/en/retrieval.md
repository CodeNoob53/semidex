# Retrieval

semidex retrieval is hybrid by default. It combines semantic similarity with exact lexical matching and exposes the result through MCP.

## Hybrid Search

Every `qdrant_search` call runs two parallel searches:

- **Dense leg** - semantic similarity over 1024-dimensional neural vectors.
- **Sparse leg** - lexical weight matching for exact terms, identifiers, and rare tokens.

Qdrant merges both result lists with **Reciprocal Rank Fusion (RRF)**.

Dense search helps with:

- paraphrases
- vague natural-language questions
- cross-language and mixed-language queries
- concept similarity

Sparse search helps with:

- function names
- env vars
- file names
- config keys
- technical identifiers like `embedding_schema_version`

## RRF

Dense and sparse scores live on different scales, so semidex does not add raw scores. RRF works by rank position:

```text
rrf(d) = 1 / (k + rank_dense(d)) + 1 / (k + rank_sparse(d))
```

Relevant environment variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `RRF_K` | `60` | RRF smoothing constant |
| `HYBRID_PREFETCH_LIMIT` | `20` | Candidate count per leg before fusion |

## Providers

| `denseProvider` | `sparseProvider` | Dense model | Notes |
|-----------------|------------------|-------------|-------|
| `ollama` | `hashed-tf` | `bge-m3`, `snowflake-arctic-embed2`, ... | Default. Requires Ollama. Sparse is zero-dependency hashed TF. |
| `bge-m3-onnx` | `bge-m3-onnx` | `aapot/bge-m3-onnx` | Set `ONNX_EMBED=1`. Downloads about 2.3 GB once. Best current option for Ukrainian and mixed-language text. |

Invalid mixed combinations are rejected at runtime.

## Provider Metadata

Provider config is stored in:

- `config.json`
- each Qdrant point payload

Changing provider, model, schema version, or vector size forces reindexing so query embeddings cannot silently mismatch indexed vectors.

## Dense-only Fallback

Old collections without sparse vectors still work. Hybrid search falls back to dense-only behavior when sparse support is missing.

Run:

```bash
npm run sync
```

to backfill collection config and ensure required indexes/sparse support where possible.

## Reranking

Reranking is optional and off by default.

When `RERANK_ENABLED=1`, semidex fetches more Qdrant candidates, scores them locally, then returns the best final results.

Signals:

| Signal | Default boost |
|--------|---------------|
| query token in `source_file` | `0.08` |
| query token in `section` | `0.06` |
| query token in `tags` | `0.05` |
| query token in `text` | `0.01` |
| incoming backlink | `0.04` |

Technical tokens such as `snake_case`, `ACRONYM`, `camelCase`, and long identifiers are weighted higher than prose words. Common Ukrainian and English stopwords are ignored.

The reranker also applies:

- source diversity penalty
- top-1 protection via `RERANK_PROTECT_TOP1_DELTA`

Current benchmark result: reranking is neutral on the bundled 21-query corpus. Keep it disabled unless it helps on your own data.

## Relevant Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_EMBED` | `0` | Shorthand for `bge-m3-onnx + bge-m3-onnx` |
| `DENSE_PROVIDER` | unset | Explicit dense provider |
| `SPARSE_PROVIDER` | unset | Explicit sparse provider |
| `DENSE_MODEL` | unset | Dense model override for Ollama |
| `RRF_K` | `60` | RRF smoothing |
| `HYBRID_PREFETCH_LIMIT` | `20` | Candidate count per vector leg |
| `RERANK_ENABLED` | `0` | Enable local reranker |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier before reranking |
| `RERANK_DEBUG` | `0` | Print reranker scoring details |

## Limitations

- `hashed-tf` is not BM25. It has no corpus statistics or IDF.
- BGE-M3 ONNX sparse output is neural lexical weighting, not SPLADE vocabulary expansion.
- ColBERT / late-interaction retrieval is not implemented yet.

