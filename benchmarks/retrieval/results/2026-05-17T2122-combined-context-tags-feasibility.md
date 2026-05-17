# Combined Context+Tags Feasibility — 2026-05-17

## Current Pipeline

- **context phase:** `processChunks` → `addContext` per chunk via `runBatched(BATCH_SIZE)` using `CONTEXT_MODEL`
- **tag phase:** `addTagsBatch` per batch using `TAG_MODEL`; falls back to `Promise.all(chunks.map(addTags))` on JSON parse failure
- **fallback behavior:** tag batch JSON parse fails → silent `console.warn` + per-chunk fallback; no signal in profiler output
- **why this matters:** context+tag combined = ~73% of CPU indexing wall time; tag alone = ~50%; tags not included in embed text; batch parse unstable

## Probe Setup

- model: `gemma3:4b`
- sample count: 30 chunks (limit: 30)
- batch size: 3
- corpus: README.md, AGENTS.md, docs/en/*.md
- env: COMBINED_PROBE_MODEL=gemma3:4b, COMBINED_PROBE_LIMIT=30, COMBINED_PROBE_BATCH_SIZE=3

## Results

| Variant | parse success | fallback/failures | total ms | ms/chunk | notes |
|---------|---------------|-------------------|----------|----------|-------|
| baseline context+tags | n/a (text output) | 3 tag batch fallbacks | 36554 | 1218 | addContext + addTagsBatch |
| combined per-chunk | 27/30 | 3 parse failures | 27330 | 911 | one JSON prompt per chunk |
| combined batch | 0/30 | 30 parse failures (batch-level) | 41898 | 1397 | one JSON prompt per batch; fallback to per-chunk on parse fail |

## Quality Sample (first 10 chunks)

| # | file | section | baseline context | combined context | baseline tags | combined tags | per-chunk ok | batch ok |
|---|------|---------|-----------------|-----------------|---------------|---------------|-------------|----------|
| 1 | README.md | semidex | This section introduces semidex, an experimental RAG memory system designed for… | This chunk introduces semidex, a local-first RAG memory system designed for AI … | rag-memory-system, ai-agents, local-llm, qdrant, … | rag, local-first, memory-system, ai-agent, qdrant… | ✓ | ✗ |
| 2 | README.md | Contents | This section provides an overview of the Semidex project’s structure and key ar… | This chunk presents a table of contents for the Semidex documentation, outlinin… | semidex, documentation, project-overview, usage-g… | documentation, toc, semidex, navigation, markdown | ✓ | ✗ |
| 3 | README.md | Problems semidex solves | This section outlines the problems semidex addresses, focusing on limitations o… | This section outlines the problems that semidex addresses, focusing on limitati… | semantic-search, vectorization, indexing, ai-agen… | indexing, knowledge-graph, embedding, search, sem… | ✓ | ✗ |
| 4 | README.md | Quick Start | This section, labeled "Quick Start," is intentionally empty, indicating that th… | This section describes the quick start process for the application. It's an emp… | placeholder-section, empty-start, documentation-p… | quick-start, empty, placeholder, documentation | ✓ | ✗ |
| 5 | README.md | 1. Install | This section details the initial setup process, specifically outlining the comm… | This section details the initial setup steps for the project, instructing the u… | npm-install, dependency-management, dotenv, .env-… | npm-install, environment-setup, configuration, .e… | ✓ | ✗ |
| 6 | README.md | set QDRANT_URL and QDRANT_KEY | This section describes the necessary environment variables, `QDRANT_URL` and `Q… | This section details the necessary environment variables required for the appli… | qdrant, vector-database, environment-variables, s… | qdrant-url, qdrant-key, environment-variables, ve… | ✓ | ✗ |
| 7 | README.md | 2. Start Qdrant | This section describes how to set up Qdrant, either using the cloud service or … | This section introduces the user to setting up Qdrant, either through the cloud… | qdrant-cloud, qdrant-local, docker-qdrant, qdrant… | qdrant, docker, local-setup, cloud-setup, qdrant-… | ✓ | ✗ |
| 8 | README.md | 3. Pull local models | This section details how to pull local models for use in the application, speci… | This section details the process of pulling local models using Ollama. It descr… | ollama-pull, bge-m3, gemma3, ollama-embeddings, o… | ollama, embeddings, onnx, bge-m3, gemma3, context… | ✓ | ✗ |
| 9 | README.md | 4. Sync and index | This section describes the process of synchronizing and indexing the documentat… | This section describes the process of synchronizing and indexing the documentat… | onnx-embeddings, env-vars, npm-sync, collection-n… | npm-run, sync, index, docs | ✓ | ✗ |
| 10 | README.md | 5. Register MCP in Claude Code | This section details the command-line instructions for registering the MCP serv… | This section details how to register the MCP server within Claude Code for Linu… | mcp-server, claude-code, qdrant, semidex, registr… | mcp, claude-code, server-setup, linux, macos, win… | ✓ | ✗ |

## Quality Notes

- combined per-chunk parse rate: 90% (27/30)
- combined batch parse rate: 0% (0/30)
- baseline empty tags: 0/30; combined per-chunk empty tags: 3/30
- latency vs baseline: per-chunk -9224 ms (faster), batch +5344 ms (slower)
- per-chunk failures (sample): chunk 11 (README.md), chunk 15 (README.md), chunk 20 (AGENTS.md)
- batch failures (sample): chunk 1 (README.md), chunk 2 (README.md), chunk 3 (README.md)
- context quality and tag relevance: see Quality Sample table above for human review
- JSON stability: see parse rates above; format:"json" used for all combined calls

## Verdict

**Per-chunk combined:**
proceed with caution — parse rate acceptable (≥80%), latency improvement observed. Add short-chunk guard for remaining failures.

**Batch combined:**
reject for this model — 0% parse success. Model does not follow multi-item array instructions.

**Recommended next steps:**
- Add short-chunk guard (skip combined call for chunks below ~20 tokens) to address edge-case parse failures.
- Implement per-chunk combined phase, gate behind `COMBINED_LLM=1` env flag so production path is unchanged by default.
- Run custom-50 retrieval benchmark with `COMBINED_LLM=1` to verify context quality does not degrade.
- Test batch combined with a model that has stronger instruction following (e.g. qwen3:1.7b, llama3.2:3b).

*Generated: 2026-05-17 — model: gemma3:4b*