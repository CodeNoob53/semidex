# Combined LLM Live Verification — 2026-05-17

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | gemma3:4b |
| TAG_MODEL (baseline) | gemma3:4b |
| TAG_MODEL (combined run) | missing-model-for-combined-test (intentional) |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| LLM_BATCH_SIZE | 3 |
| Corpus | benchmarks/retrieval/fixtures/combined-live/ (5 files) |

## Sanity Checks

| Check | Result |
|-------|--------|
| Combined run exited 0 | ✓ pass |
| TAG_MODEL=missing-model not checked by preflight | ✓ pass |
| [combined] TAG_MODEL warning printed | ✓ pass |
| Baseline payload fields complete | ✓ pass |
| Combined payload fields complete | ✓ pass |
| Baseline point count > 0 | ✓ 27 points |
| Combined point count > 0 | ✓ 27 points |

## A/B Performance

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| Total wall time | 47857 ms | 43192 ms | -4665 ms (combined faster) |
| Phase [2] context ms (mean/file) | 3280 ms | 0 ms | — |
| Phase [3] tag ms (mean/file) | 2325 ms | 4493 ms | — |
| Phase [2]+[3] combined | 5605 ms | 4493 ms | — |
| Combined parse fallbacks | n/a | 0 | — |
| Tag batch fallbacks | 3 | n/a | — |
| Points upserted | 27 | 27 | — |

*Phase timings are mean ms per file from INDEX_PROFILE=1 output.*
*Combined path records context=0 ms (merge only, no addContext call) and all LLM time under tag.*

## Payload Shape

| Check | Baseline | Combined |
|-------|----------|----------|
| Points total | 27 | 27 |
| Points sampled | 27 | 27 |
| Empty context | 0 | 0 |
| Empty tags | 0 | 0 |
| Malformed tags (uppercase/spaces/numeric) | 0 | 0 |
| Missing required payload fields | none | none |

## Quality Sample (joined on source_file:chunk_index)

Rows are matched by `source_file` + `chunk_index` across both collections. Scroll order differs between separately indexed collections; index-based comparison would mix unrelated chunks.

| # | file | chunk | baseline context | combined context | baseline tags | combined tags |
|---|------|-------|-----------------|-----------------|---------------|---------------|
| 1 | 01-technical-config.md | 0 | This section details the configuration reference for semidex, specifically focus… | This section details the configuration of semidex, specifically focusing on the … | semidex, configuration, environment-variables, system-config, technical-config | semidex, configuration, environment-variables, setup, system-config |
| 2 | 01-technical-config.md | 1 | This section details configuring the ONNX embedding model (`bge-m3-onnx`) for us… | This chunk describes the configuration of using a local ONNX embedding model for… | onnx-embedding, bge-m3-onnx, embedding-model, multilingual-text, dense-vectors | onnx-embeddings, hybrid-search, bge-m3-onnx, embedding-models, onnx |
| 3 | 01-technical-config.md | 2 | This section defines variables controlling the LLMs used for generating context … | This section describes the configuration options for using Ollama models to gene… | llm-models, ollama, context-summarization, tagging, combined-llm | ollama, llm-models, context-generation, tag-generation, gemma3 |
| 4 | 01-technical-config.md | 3 | This section details the configuration required to connect to the Qdrant vector … | This section describes the configuration required to connect to a Qdrant databas… | qdrant-connection, qdrant-url, qdrant-key, cloud-instance, self-hosted | qdrant, configuration, url, key, cloud |
| 5 | 01-technical-config.md | 4 | This section details the default parameters for chunking, including maximum, min… | This chunk describes the default values for several parameters related to chunki… | chunk-tokens, max-tokens, min-tokens, overlap, llm-batch | chunking, llm, batch-size, token-limits, config |
| 6 | 02-architecture.md | 0 | This chunk introduces semidex, a local-first semantic indexing and retrieval sys… | This chunk introduces Semidex, a semantic indexing and retrieval system. It deta… | local-first-indexing, semantic-retrieval, semidex, architecture, indexer | semidex, semantic-indexing, local-first, indexer, mcp-server |
| 7 | 02-architecture.md | 1 | This section details the indexing pipeline, outlining the five phases—Chunking, … | This section describes the four phases of the document indexing pipeline, detail… | indexing-pipeline, chunking, contextualization, embedding, llm | indexing-pipeline, chunking, contextualization, tagging, embedding |
| 8 | 02-architecture.md | 2 | This chunk describes the MCP server's functionality, specifically detailing its … | This section describes the MCP server's capabilities and its interaction with Qd… | mcp-server, hybrid-search, chunk-retrieval, qdrant, graph-traversal | mcp-server, hybrid-search, qdrant, api, architecture |
| 9 | 02-architecture.md | 3 | This section details the configuration of embedding providers, specifying their … | This chunk describes the configuration and management of embedding providers wit… | embedding-providers, qdrant, onnx, dense-sparse-embeddings, reindexing | qdrant, embedding-providers, dense-sparse, onnx, cpu |
| 10 | 03-short-chunks.md | 0 | This section describes edge cases within the system, specifically focusing on an… | This section discusses edge cases, specifically an empty section labeled "Edge C… | edge-case, empty-section, placeholder | edge-cases, placeholder, documentation, empty-section, exception-handling |
| 11 | 03-short-chunks.md | 1 | This section contains introductory greetings and acknowledgements, serving as a … | This brief segment is a simple greeting, likely introducing a conversation or in… | greeting, introduction, hi | greeting, introduction, segment, brief, initial-contact |
| 12 | 03-short-chunks.md | 2 | This chunk is a placeholder section within the "Empty-ish Section," likely inten… | This section contains a placeholder, likely intended for content within the "Emp… | placeholder, empty, unknown | placeholder, section, empty-ish, content, placeholder-text |
| 13 | 03-short-chunks.md | 3 | This chunk describes the fallback mechanism used by the indexer when chunk lengt… | This chunk describes the fallback mechanism used by the indexer when a chunk's c… | fallback-mechanism, chunk-length, indexer, context-generation, tag-generation | combined-min-chars, fallback-path, context-model, addcontext, addtags |
| 14 | 03-short-chunks.md | 4 | This chunk details the embedding process used within the system, specifically th… | This chunk discusses the importance of context embedding and tag usage within th… | embedding, semantic-anchors, qdrant, tagging, ranking | embedding, qdrant, hybrid-search, context, tag-filter |
| 15 | 04-operations.md | 0 | This section is a placeholder indicating the beginning of the Operations Guide, … | This section is an empty placeholder within the Operations Guide, likely intende… | indexing, markdown, npm, onx-embed, collection | operations-guide, placeholder, empty-section, future-procedures, documentation |

## Quality Notes

- LLM phase (context+tag) reduced by 1112 ms/file mean — 20% improvement
- 0 combined parse fallbacks on normal chunks (verified live)
- Fallback path (parse failure → separate context+tag calls via CONTEXT_MODEL) covered by code review and smoke section 27; not live-exercised in this run because all chunks parsed successfully
- 3 baseline tag batch fallback(s) — combined mode eliminates this failure class
- context quality and tag relevance: see Quality Sample table above for human review
- tags normalized (lowercase, hyphenated): verified by payload shape check above

## Verdict

**proceed** — COMBINED_LLM=1 verified live. TAG_MODEL correctly ignored, payload shape correct, latency improvement confirmed.

**COMBINED_LLM=1 remains opt-in.** Default path unchanged. No action needed for existing collections.

**Before promoting to default:**
1. Run custom-50 retrieval benchmark on a combined-indexed collection to verify retrieval quality is not degraded.
2. Verify on the full 15-file benchmark corpus (not just 5 files).
3. Address the short-chunk context drift edge case if `COMBINED_MIN_CHARS` threshold needs tuning.

*Generated: 2026-05-17 — corpus: benchmarks/retrieval/fixtures/combined-live/*