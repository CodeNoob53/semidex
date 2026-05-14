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

## MMR Diversity Evaluation

Qdrant MMR is available for nearest-neighbor queries and improves result
diversity when many candidates are redundant. In semidex it is currently exposed
as a benchmark search mode, not as an MCP retrieval option:

```bash
BENCH_SEARCH_MODE=dense-mmr npm run bench:retrieval
npm run bench:retrieval:mmr
```

**MMR is dense-only.** It uses Qdrant's `nearest + mmr` query on the `dense`
vector. There is no sparse leg and no RRF fusion. This is a fundamental property
of the Qdrant MMR query, not a configuration choice.

The production default remains hybrid dense+sparse RRF because the sparse leg is
critical for exact technical tokens — env vars, function names, config keys,
schema field names. Dense-only retrieval misses these when they are not
paraphrase-reachable.

**Benchmark conclusions (2026-05-10, 21 queries):**

| Variant | Recall@1 | dupSourceRate | Notes |
|---------|----------|---------------|-------|
| ollama-rrf | 90.5% | 61.9% | RRF baseline |
| ollama-mmr0.3 | 90.5% | 50.5% | Best tradeoff: same recall, −11.4pp duplicates |
| onnx-rrf | **95.2%** | — | RRF dominates |
| onnx-mmr0.3 | 90.5% | — | −4.8pp Recall@1 at all tested diversity values |

For ONNX, hybrid RRF wins at every tested diversity level. For ollama,
`diversity=0.3` preserves recall while reducing duplicate sources.

**When MMR is appropriate (exploratory/broad queries):**
- "Find me a variety of documents about topic X" — source diversity matters more
  than exact recall.
- Exploratory overview queries where results from the same file are redundant.

**When to stay on hybrid RRF (all other cases):**
- Any query involving exact identifiers: env vars, function names, field names,
  model names, provider strings.
- Config lookups, error message matching, code search.
- Any query where the answer is a specific value rather than a broad topic.

**Planned MCP opt-in (Stage 2, not yet implemented):**

```json
"search_mode": "hybrid"        // default — hybrid dense+sparse RRF
"search_mode": "dense_mmr"     // opt-in — dense-only MMR, diversity trading recall
"mmr_diversity": 0.3           // recommended starting value (0.0–1.0)
"mmr_candidates_limit": 100    // candidate pool size before MMR selection
```

The `"hybrid"` default is permanent. `"dense_mmr"` will require explicit
opt-in. Implementing it requires a live benchmark confirmation before merging
(see [benchmarking.md](benchmarking.md) and the audit report
`benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`).

Useful MMR knobs (benchmark mode only):

| Variable | Default | Description |
|----------|---------|-------------|
| `MMR_DIVERSITY` | `0.5` | Balance between relevance (`0.0`) and diversity (`1.0`) |
| `MMR_CANDIDATES_LIMIT` | `100` | Candidate pool size before MMR selection |
| `MMR_DIVERSITIES` | `0.3,0.5,0.7` | Matrix values for `bench:retrieval:mmr` |

Evaluate MMR by checking whether `dupSourceRate` decreases and
`sourceDiversity` increases without unacceptable drops in `Recall@1`, `MRR`, or
`nDCG@K`.

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
| `MMR_DIVERSITY` | `0.5` | Dense MMR diversity balance for benchmark mode |
| `MMR_CANDIDATES_LIMIT` | `100` | Dense MMR candidate pool size |

## Limitations

- `hashed-tf` is not BM25. It has no corpus statistics or IDF.
- BGE-M3 ONNX sparse output is neural lexical weighting, not SPLADE vocabulary expansion.
- ColBERT / late-interaction retrieval is not implemented yet.
