# semidex

![semidex](assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/npm-2.0.0-blue?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**semidex is a local-first RAG system for AI agents.**

It turns your documents, notes, specs, and code knowledge into a searchable memory layer that an AI assistant can query through MCP. Instead of pasting huge files into chat or hoping the model remembers your project, semidex stores your knowledge in Qdrant, splits it into useful chunks, enriches it with summaries, tags, and links, and retrieves only the pieces that matter for the current task.

In simple terms: semidex helps an AI find the right paragraph, section, command, config option, or related document before it answers or edits code.

## Problems semidex solves

| Problem | How semidex addresses it |
|---------|--------------------------|
| Context windows are too small | Indexes and retrieves only relevant chunks — large docs never enter the window whole |
| AI agents guess when context is missing | MCP tools give the agent precise, on-demand access to the right fragment |
| Semantic search alone misses exact terms | Sparse lexical vectors catch `embedding_schema_version`, `ONNX_EMBED`, env vars, function names |
| Keyword search alone misses meaning | Dense neural vectors match paraphrased queries and cross-language synonyms |
| Chunks lose context | Every chunk stores an LLM-generated summary describing it in the context of the full document |
| Related docs are hard to discover | Semantic graph links every chunk to its nearest neighbors across collections |
| Re-indexing large corpora is expensive | SHA-256 hash-based skip — unchanged files are never reprocessed |
| Provider mismatch breaks search quality | Query and index always use the same provider; mismatches trigger automatic reindexing |
| Local/private documents must stay local | Ollama + ONNX + Qdrant — no text leaves your machine |

## Why this is more than semantic search

Most RAG systems run one embedding model and call it done. semidex stacks four retrieval layers:

1. **Dense vectors** — neural embeddings capture meaning; paraphrases and cross-language queries match.
2. **Sparse vectors** — lexical weights catch exact technical terms, identifiers, and rare tokens.
3. **RRF fusion** — Reciprocal Rank Fusion merges both rankings so neither dominates.
4. **Reranker** (optional) — a local deterministic post-processor boosts results where query tokens align with file name, section heading, or tags; applies a diversity pass; protects the top RRF hit from aggressive displacement.

Dense + sparse + RRF is the **default retrieval path** — not an option.

## Architecture

```
Documents (md, pdf, docx, epub, txt, …)
  │
  ├─ [1] Chunk          — structure-aware: headings → sentences → LLM boundary check
  ├─ [2] Contextualize  — LLM writes a 1–2 sentence summary per chunk in document context
  ├─ [3] Tag            — LLM generates 3–7 semantic tags per chunk (batched)
  ├─ [4] Embed + Upsert — dense vector + sparse vector → Qdrant named vectors + payload
  └─ [5] Link           — semantic graph: top-N cross-collection neighbors, bidirectional
         │
         ▼
    Qdrant collection
    (dense · sparse · text · section · tags · context · source_file · graph edges)
         │
         ▼
    MCP tools (search · get chunk · related · backlinks · find by tag · collections)
         │
         ▼
    AI agent retrieves precise context
```

At query time the MCP server embeds the query with the same provider used during indexing, runs a hybrid Qdrant search, optionally reranks, and returns the best chunks with full payload metadata.

## Quick Start

### 1. Prerequisites

- **Node.js 18+** — install via [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows)
- **Qdrant** — [Qdrant Cloud](https://cloud.qdrant.io) free tier, or `docker run -d --name qdrant -p 6333:6333 qdrant/qdrant`
- **Embedding provider** — Ollama (default) or ONNX (see Recommended Modes below)

### 2. Install

```bash
npm install
cp .env.example .env
# set QDRANT_URL and QDRANT_KEY at minimum
```

### 3. Start Qdrant and pull models

```bash
# Ollama (default mode)
ollama pull bge-m3        # dense embedding
ollama pull gemma3:4b     # context + tags LLM

# Or: ONNX mode — no Ollama needed for embedding
# set ONNX_EMBED=1 in .env — model downloads once (~2.3 GB) on first run
```

### 4. Sync and index

```bash
npm run sync                                    # initialise config.json
COLLECTION=my-docs npm run index ./docs/        # index your documents
```

### 5. Register MCP in Claude Code

**Linux / macOS**
```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

**Windows**
```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Then click **Reconnect** in `Claude Code → MCP servers → semidex`. Run `/mcp` in chat to verify — the server appears as `qdrant` with 6 tools available:

<table><tr>
<td><img src="assets/avif/mcp_connected.avif" alt="MCP connected"/></td>
<td><img src="assets/avif/mcp_status.avif" alt="MCP tools status"/></td>
</tr></table>

## Recommended Modes

| Mode | Config | Best for |
|------|--------|----------|
| **Default / light** | `DENSE_PROVIDER=ollama`, `SPARSE_PROVIDER=hashed-tf` | English-only, low memory, fastest setup |
| **Quality / multilingual** | `ONNX_EMBED=1` (`bge-m3-onnx + bge-m3-onnx`) | Ukrainian, mixed-language, best Recall@1 |
| **Rerank** | `RERANK_ENABLED=1` added to either above | Opt-in; neutral on current corpus — run `bench:retrieval:rerank` on your own data first |

Mixed combinations (e.g. `ollama` dense + `bge-m3-onnx` sparse) are rejected at runtime.

## MCP Tools

The agent workflow typically follows: **search → get chunk with window → follow related / backlinks → filter by tag**.

| Tool | Arguments | Description |
|------|-----------|-------------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?` | Hybrid search (dense + sparse + RRF); tag filter uses OR, combined with source_file via AND |
| `qdrant_collection_info` | — | List all collections with point counts, dense/sparse provider, description |
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Retrieve a specific chunk with optional surrounding context window |
| `qdrant_related` | `collection`, `source_file` | Outgoing semantic links for a file (from graph) |
| `qdrant_backlinks` | `collection`, `source_file` | Incoming links for a file (from graph) |
| `qdrant_find_by_tag` | `collection`, `tag`, `limit?` | All chunks matching a tag, grouped by file |

## Indexer Pipeline

When you run `npm run index`, each document goes through five phases:

**Phase 1 — Chunk**
Structure-aware splitting: headings and sections first; sentence splitting with LLM boundary check as fallback. Body text styled as a heading (Word/pandoc artefact) is detected and kept as content. Result: self-contained chunks, each covering one idea.

**Phase 2 — Contextualize** *(uses `gemma3:4b`)*
The local LLM writes a 1–2 sentence summary for each chunk describing it *in the context of the full document*. Stored in the `context` payload field. Turns *"It must not exceed 512 bytes"* into *"The session token in the auth module must not exceed 512 bytes."*

**Phase 3 — Tag** *(uses `gemma3:4b`)*
The same LLM generates 3–7 semantic tags per chunk, batched for speed. Tags enable precise filtered search across the entire collection.

**Phase 4 — Embed + Upsert** *(uses embedding provider)*
`context + text` is encoded into:
- a **dense** 1024-dim vector (neural meaning)
- a **sparse** variable-dim vector (lexical weights)

Both vectors, plus text, section, tags, context, source_file, and provider metadata, are stored as a single Qdrant point.

**Phase 5 — Link**
Semantic search across all collections finds the top-N most similar chunks to each newly indexed chunk. Bidirectional links and backlinks are written to Qdrant payload and `graph.<collection>.json`, forming a navigable knowledge graph.

### Why local models?

No text leaves your machine. Ollama and ONNX run entirely locally — relevant for proprietary codebases, internal specs, client documentation, or any content you can't share with a third-party API.

## Retrieval System

### Hybrid search (default)

Every `qdrant_search` call runs two parallel queries against Qdrant's Query API:

- **Dense leg** — cosine similarity over 1024-dim neural vectors
- **Sparse leg** — dot product over lexical weight vectors

Results are merged with **Reciprocal Rank Fusion (RRF)**. Dense captures paraphrases and semantic neighbors; sparse catches exact identifiers, env vars, function names, and rare technical terms. Together they reliably handle mixed natural-language + technical queries.

**Dense-only fallback:** collections indexed before sparse support was added continue to work. `npm run sync` backfills sparse vectors for existing collections.

### Embedding providers

| `denseProvider` | `sparseProvider` | Dense model | Notes |
|-----------------|-----------------|-------------|-------|
| `ollama` | `hashed-tf` | `bge-m3`, `snowflake-arctic-embed2`, … | Default. Requires Ollama running. `hashed-tf` is a hashed TF encoder (IDF=1) — not true BM25, but zero-dependency and fast. |
| `bge-m3-onnx` | `bge-m3-onnx` | `aapot/bge-m3-onnx` | Set `ONNX_EMBED=1`. Downloads ~2.3 GB once, cached in `./models/`. No Ollama needed for embedding. Neural sparse — not SPLADE vocabulary expansion, but multilingual. Best for Ukrainian / mixed-language. |

Provider is stored per-collection in `config.json` and in every point's payload. Changing a provider triggers automatic reindexing.

### RRF tuning

| Variable | Default | Effect |
|----------|---------|--------|
| `RRF_K` | `60` | RRF smoothing constant — higher values reduce rank-position sensitivity |
| `HYBRID_PREFETCH_LIMIT` | `20` | Candidate count per leg before fusion |

## Reranking (experimental)

When `RERANK_ENABLED=1`, the MCP server fetches `top × RERANK_PREFETCH_MULT` candidates from Qdrant, scores them locally, then returns the best `top` results. Off by default; adds no overhead when disabled.

### Scoring

Two-phase: base score `1 / (rank + 1)` from the original RRF rank, then deterministic boosts:

| Signal | Default boost | Notes |
|--------|--------------|-------|
| `source_file` token match | 0.08 | Query tokens in the chunk's file name |
| `section` token match | 0.06 | Query tokens in the section heading |
| `tags` token match | 0.05 | Query tokens in any tag |
| `text` token match | 0.01 | Query tokens in chunk body (noisy — kept low) |
| backlink count | 0.04/link | More incoming links = higher rank |

Technical tokens (`snake_case`, `ACRONYM`, `camelCase`, length ≥ 8) score **3× higher** than prose words. Common Ukrainian and English stopwords are excluded from all boosts.

A **greedy diversity pass** penalises any chunk from a file already selected (anywhere in the list). **Top-1 protection** (`RERANK_PROTECT_TOP1_DELTA=0.05`) prevents displacing the original RRF rank-0 result unless the challenger's score advantage exceeds the threshold.

### Benchmark results

Controlled same-index matrix (21 queries, 4 fixtures, Top-K 5):

| Provider | Recall@1 | Recall@5 | MRR |
|----------|----------|----------|-----|
| `ollama + hashed-tf` | 90% | 100% | 0.938 |
| `ollama + hashed-tf + rerank` | 90% | 100% | 0.938 |
| `bge-m3-onnx` | 95% | 100% | 0.975 |
| `bge-m3-onnx + rerank` | 95% | 100% | 0.975 |

Reranking is **opt-in and neutral** on this corpus. Run `npm run bench:retrieval:rerank` on your own data before enabling.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANK_ENABLED` | `0` | Set to `1` to enable reranking in the MCP search tool |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier: fetch `top × N` from Qdrant before reranking |
| `RERANK_DEBUG` | `0` | Set to `1` to print per-result scoring details to stderr |
| `RERANK_BOOST_SOURCE_FILE` | `0.08` | Boost per token hit in `source_file` |
| `RERANK_BOOST_SECTION` | `0.06` | Boost per token hit in `section` |
| `RERANK_BOOST_TAGS` | `0.05` | Boost per token hit in `tags` |
| `RERANK_BOOST_TEXT` | `0.01` | Boost per token hit in `text` |
| `RERANK_BOOST_BACKLINK` | `0.04` | Boost per incoming backlink |
| `RERANK_PROTECT_TOP1_DELTA` | `0.05` | Minimum score advantage required to displace original RRF rank-0 |

## Benchmark / Quality

semidex ships a regression benchmark with 21 queries across 4 fixture documents:

```bash
npm run smoke                     # fast offline tests — no Qdrant/Ollama needed
npm run bench:retrieval           # full retrieval benchmark against live Qdrant
npm run bench:retrieval:compare   # side-by-side: ollama vs onnx
npm run bench:retrieval:rerank    # 4-variant matrix: ollama±rerank vs onnx±rerank
```

Metrics reported: `fileRecall@1`, `fileRecall@K`, `MRR`, `nDCG@K`, `sectionHit@K`, `tokenHit@K`, `negativePassRate`, `dupSourceRate`, `sourceDiversity`, `p50`/`p95` latency.

`BENCH_TOP_K=10` changes search depth; `BENCH_PROVIDER=onnx` forces a provider regardless of `.env`.

Results are saved to `benchmarks/retrieval/results/`. MRR drop after a code change is a regression signal — investigate before merging.

## Supported Formats

| Format | Method |
|--------|--------|
| `.md` | Native parser (heading-aware, frontmatter, wikilinks) |
| `.txt` | Native parser |
| `.pdf` | pdf-parse (npm dependency, no system tools required) |
| `.docx` | pandoc |
| `.odt` | pandoc |
| `.rtf` | pandoc |
| `.epub` | pandoc |
| `.html` / `.htm` | pandoc |

> pandoc is required only for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`.
> Install: Linux — `apt install pandoc`, macOS — `brew install pandoc`, Windows — `winget install JohnMacFarlane.Pandoc`.

## Usage

### Indexing

```bash
# index a single file
COLLECTION=my-docs npm run index path/to/document.md

# index an entire folder
COLLECTION=my-docs npm run index path/to/docs/

# re-run — changed files reindexed, unchanged skipped
COLLECTION=my-docs npm run index path/to/docs/

# pin source paths relative to vault root for stable IDs across runs
SOURCE_ROOT=/path/to/vault COLLECTION=my-docs npm run index /path/to/vault/docs/
```

```
Found 31 file(s) to process

→ node_js/prisma-express.md
  [1/5] chunking...        18 chunks
  [2/5] contextualizing... 17 chunks after merge
  [3/5] tagging...
  [4/5] embedding + upserting... 17 points
  [5/5] linking...
  ✓ done

→ node_js/express-fundamentals.md
  ✓ unchanged, skipping

Done. 31 file(s): 30 indexed, 1 skipped.
```

### Sync

```bash
npm run sync
```

Generates/updates `config.json` from your actual Qdrant collections, ensures required payload indexes exist, and backfills `denseProvider`/`sparseProvider` fields for pre-existing collections. Safe to re-run at any time; idempotent.

After sync you can edit `config.json` to set a provider or add a description per collection. See `config.example.json` for all fields.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run index` | Index files: `COLLECTION=x npm run index <path>` |
| `npm run mcp` | Start MCP server (stdio, managed by Claude Code) |
| `npm run sync` | Sync config.json + ensure payload indexes on all collections |
| `npm run smoke` | Fast offline smoke tests (no Qdrant/Ollama needed) |
| `npm run bench:retrieval` | Retrieval benchmark against live Qdrant (requires `.env`) |
| `npm run bench:retrieval:compare` | Side-by-side provider comparison (ollama vs onnx) |
| `npm run bench:retrieval:rerank` | 4-variant rerank matrix: ollama±rerank vs onnx±rerank |

## Configuration Reference

### Qdrant

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | — | Qdrant instance URL |
| `QDRANT_KEY` | — | Qdrant API key |

### Models

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `EMBED_MODEL` | `bge-m3` | Dense model for Ollama provider |
| `CONTEXT_MODEL` | `gemma3:4b` | Model for chunk contextualization |
| `TAG_MODEL` | `gemma3:4b` | Model for tag generation |
| `VECTOR_SIZE` | `1024` | Must match embedding model output |

### Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_EMBED` | `0` | Set to `1` to use `bge-m3-onnx + bge-m3-onnx`. Downloads ~2.3 GB once, cached in `./models/`. No Ollama needed for embedding. |
| `DENSE_PROVIDER` | — | Explicit override: `ollama` or `bge-m3-onnx`. Takes precedence over `ONNX_EMBED`. |
| `SPARSE_PROVIDER` | — | Explicit sparse override. Must form a valid combination with `DENSE_PROVIDER`. |
| `DENSE_MODEL` | — | Override dense model name when `DENSE_PROVIDER=ollama`. Alias for `EMBED_MODEL`. |

### Chunking

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CHUNK_TOKENS` | `400` | Max tokens per chunk |
| `MIN_CHUNK_TOKENS` | `30` | Minimum tokens — smaller chunks are dropped |
| `OVERLAP_SENTENCES` | `2` | Sentence overlap between adjacent chunks |
| `LLM_BATCH_SIZE` | `3` | Chunks per LLM call (tagging + context) |

### Linking

| Variable | Default | Description |
|----------|---------|-------------|
| `LINK_TOP` | `5` | Top-N semantic neighbors to link |
| `LINK_MIN_SCORE` | `0.75` | Minimum cosine similarity to create a link |
| `LINK_COLLECTIONS` | *(all)* | Comma-separated allowlist of collections to search during linking |
| `CHUNKS_OUT_DIR` | `./chunks_out` | Output directory for Obsidian-compatible `.md` review files |
| `SOURCE_ROOT` | *(target path)* | Root for stable `source_file` IDs. Files outside this root cause an explicit error. |

### Hybrid search

| Variable | Default | Description |
|----------|---------|-------------|
| `RRF_K` | `60` | RRF smoothing constant |
| `HYBRID_PREFETCH_LIMIT` | `20` | Candidate count per leg before RRF fusion |

### Reranking

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANK_ENABLED` | `0` | Set to `1` to enable reranking |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier before reranking |
| `RERANK_DEBUG` | `0` | Print per-result scoring to stderr |
| `RERANK_BOOST_SOURCE_FILE` | `0.08` | Boost per token hit in `source_file` |
| `RERANK_BOOST_SECTION` | `0.06` | Boost per token hit in `section` |
| `RERANK_BOOST_TAGS` | `0.05` | Boost per token hit in `tags` |
| `RERANK_BOOST_TEXT` | `0.01` | Boost per token hit in `text` |
| `RERANK_BOOST_BACKLINK` | `0.04` | Boost per incoming backlink |
| `RERANK_PROTECT_TOP1_DELTA` | `0.05` | Min score advantage to displace RRF rank-0 |

### Benchmark

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCH_TOP_K` | `5` | Search depth for benchmark runs |
| `BENCH_PROVIDER` | — | Force provider: `onnx` or `ollama` |
| `BENCH_SKIP_INDEX` | — | Set to `1` to reuse an already-indexed `bench-retrieval` collection |
| `BENCH_JSON` | — | Set to `1` to emit JSON output instead of a table |
| `RERANK_PREFETCH_MULT` | `4` | Also controls rerank candidate count during benchmark |

## Required Qdrant Payload Indexes

| Field | Type | Used by |
|-------|------|---------|
| `source_file` | keyword | hash check, reindex, delete, `qdrant_search` filter |
| `tags` | keyword | `qdrant_search` tag filter, `qdrant_find_by_tag` |

`npm run index` creates these automatically for new collections. For existing collections run `npm run sync`.

## Project Structure

```
src/
  core/
    qdrant.js     — Qdrant REST client (upsert, search, scroll, filter, index)
    ollama.js     — Ollama REST client (embed + generate)
    sparse.js     — hashed sparse TF encoder (Qdrant-compatible, no external deps)
    graph.js      — per-collection graph.<collection>.json with full edge cleanup
    config.js     — config.json helpers + getDenseProvider/getDenseModel/getSparseProvider (per-collection)
    embeddings.js — unified provider layer: embedForIndex, embedForSearch, getEmbeddingConfig
    rerank.js     — local deterministic reranker: token boosts, diversity, top-1 protection
  indexer/
    index.js      — CLI entry point
    batch.js      — parallel batch runner
    phases/
      chunk.js    — structure-aware parser, pdf-parse + pandoc-backed formats
      context.js  — LLM contextualization + boundary merging
      tag.js      — batch tag generation with multi-format JSON parser
      link.js     — semantic linking across collections
  mcp/
    server.js     — MCP entry point
    tools/
      search.js, collections.js, getChunk.js, related.js, backlinks.js, findByTag.js
  sync.js         — sync config.json + ensure required indexes on all collections
config.json           — auto-generated by npm run sync, git-ignored
config.example.json   — template for config.json structure
graph.<collection>.json — generated semantic graph, git-ignored
graph.example.json    — template for graph file structure
```

## Known Limitations

- **BGE-M3 ONNX model size** — ~2.3 GB download on first use; not practical in all environments.
- **`hashed-tf` is not BM25** — IDF=1, no corpus statistics. Works well for rare technical tokens; may under-weight common terms compared to true BM25/SPLADE.
- **Reranker is off by default** — neutral on the current benchmark corpus; run your own matrix before enabling.
- **ColBERT not implemented** — late-interaction retrieval is not yet available.
- **Benchmark is a regression suite** — 21 queries over 4 fixture docs is a health check, not a scientific evaluation.
- **`chunks_out/` cleanup** — uses filename pattern matching (`base__chunk*.md`). Manually created directories matching that pattern will cause `rmSync` to fail; doesn't affect indexing or Qdrant.

## Troubleshooting

**`fetch failed` on search**
Ollama must be running when the MCP server handles queries — it embeds the query vector before hitting Qdrant. Start Ollama and reconnect the MCP server. With `ONNX_EMBED=1`, Ollama is not required for search.

## Acknowledgements

Built with AI assistance throughout development:

- **[OpenAI Codex](https://openai.com/blog/openai-codex)** — code review
- **[Claude](https://claude.ai) (Anthropic)** — code generation, documentation

Pipeline design, core mechanics, concept, and testing — by the author.
