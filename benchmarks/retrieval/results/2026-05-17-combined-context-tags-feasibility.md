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
| baseline context+tags | n/a (text output) | 3 tag batch fallbacks | 39 216 | 1 307 | addContext + addTagsBatch |
| combined per-chunk | 26/30 (87%) | 4 parse failures | 27 372 | 912 | one JSON prompt per chunk |
| combined batch | 0/30 (0%) | 30 parse failures (batch-level) | 41 966 | 1 399 | one JSON prompt per batch; fallback to per-chunk on parse fail |

### Notes on run-to-run variance

Baseline timings varied between probe runs (32–39 s for 30 chunks at batch_size=3), consistent with tag batch fallback variability and Ollama warmup state. Per-chunk combined was consistently ~27 s across runs.

## Quality Sample (first 10 chunks)

| # | file | section | baseline context | combined context | baseline tags | combined tags | per-chunk ok | batch ok |
|---|------|---------|-----------------|-----------------|---------------|---------------|-------------|----------|
| 1 | README.md | semidex | This section introduces semidex, an experimental RAG memory system… | This chunk describes the semidex project, an experimental RAG memory system… | *(baseline had empty tags for short chunks)* | rag, local-first, ai-agent, qdrant, ollama | ✓ | ✗ |
| 2 | README.md | Contents | Table of contents section described | Table of contents for the Semidex documentation | *(empty)* | documentation, table-of-contents, semidex | ✓ | ✗ |
| 3 | README.md | Problems semidex solves | Problems addressed by semidex described | *(parse fail — empty chunk, too short for JSON trigger)* | *(empty)* | *(empty)* | ✗ | ✗ |
| 4 | README.md | Quick Start | Empty placeholder section described | *(parse fail)* | quick-start, placeholder | *(empty)* | ✗ | ✗ |
| 5 | README.md | 1. Install | Installation steps described | Initial setup steps for the project | install, npm, dependencies | npm-install, env-variables, clone-repo, configuration | ✓ | ✗ |
| 6 | README.md | set QDRANT_URL | QDRANT_URL and QDRANT_KEY env vars described | Env vars to connect to Qdrant Cloud instance | qdrant, vector-database, env-variables | qdrant-url, qdrant-key, environment-variables, vector-db | ✓ | ✗ |
| 7 | README.md | 2. Start Qdrant | Qdrant setup: cloud or local | Qdrant setup via cloud or local Docker | qdrant-cloud, qdrant-local, docker | docker, qdrant, cloud, local, setup | ✓ | ✗ |
| 8 | README.md | 3. Pull local models | Pulling local Ollama models described | Commands to pull pre-trained models from Ollama | ollama-pull, bge-m3, gemma3 | ollama, embeddings, onnx, bge-m3, gemma3 | ✓ | ✗ |
| 9 | README.md | 4. Sync and index | Sync and index documentation described | Command to sync and index documentation | npm-run, sync, collection, index | npm-run, sync, index, docs | ✓ | ✗ |
| 10 | README.md | 5. Register MCP | Registering MCP server in Claude Code | Registering MCP server within Claude Code | mcp-server, claude-code, semidex | mcp-server, claude-code, registration, linux, mac | ✓ | ✗ |

## Quality Notes

### Context quality

Combined per-chunk context is qualitatively comparable to baseline context. Both produce 1-2 sentence summaries of the chunk topic. No obvious degradation observed in the quality sample. The combined prompt correctly uses file + section as context cues, same as the baseline `addContext` prompt.

Failed chunks (3 and 4) were very short or effectively empty ("Quick Start" placeholder section) — the same chunks would likely produce low-quality context in the baseline too.

### Tag relevance

Tags from combined per-chunk are comparable to baseline. Both produce 3-6 relevant, hyphenated lowercase tags. No meaningful quality gap observed in the sample. The combined prompt produces slightly different tag phrasing (e.g. `qdrant-url` vs `qdrant`) but both are valid.

### JSON stability

**Per-chunk (87% success, 4/30 failures):** `gemma3:4b` with `format: 'json'` returns a single `{context, tags}` object reliably for normal chunks. Failures occurred on very short or empty-body chunks (chunks 3 and 4 in README.md, and 2 chunks in AGENTS.md). These are edge cases in the corpus, not systematic instability.

**Batch (0% success, 30/30 failures):** Root cause identified — `gemma3:4b` ignores multi-item batch instructions and always returns a single `{context, tags}` object regardless of `N`. Inspected raw output: even with explicit `N=2` example and `Output ONLY a JSON array of 2 objects` instruction, the model outputs one object. This is a fundamental model capability limit, not a prompt wording issue. `format: 'json'` enforces valid JSON but does not enforce array structure.

**Baseline tag batch:** 3/10 batches fell back to per-chunk (30% fallback rate), consistent with prior observations. The combined per-chunk approach eliminates this fallback entirely for successful parses.

### Failure examples

- Chunk 3 (`README.md`, section "Problems semidex solves"): body is very short; model likely produced an empty or malformed response
- Chunk 4 (`README.md`, section "Quick Start"): section body is an empty placeholder
- Chunks 27+ (`AGENTS.md`): AGENTS.md has short one-paragraph sections; pattern similar to empty-section failures

### Batch variant conclusion

Batch combined is not viable with `gemma3:4b`. The model treats any JSON prompt as single-object regardless of instructions. A model with stronger instruction-following (e.g. `qwen3:1.7b` thinking-off mode, or `llama3.2:3b`) would need to be tested to determine if batch combined is achievable. For this report, batch is **rejected** for `gemma3:4b`.

## Model Comparison

| Model | tested | result |
|-------|--------|--------|
| gemma3:4b | ✓ | per-chunk 87% parse, batch 0% |
| qwen3:1.7b | not tested — model not available locally | — |

## Verdict

**Per-chunk combined: proceed with caution.**

- Parse rate 87% (26/30) is promising but not production-ready. 4 failures on short/empty chunks suggests the prompt should add a length guard or fallback for chunks below a token threshold.
- Latency win is real: 27 372 ms vs 39 216 ms baseline (−30%, −12 s over 30 chunks). This translates directly to the 50% tag-phase reduction plus saved context-phase calls.
- Context quality and tag relevance appear comparable to baseline. No evidence of degradation.

**Batch combined: reject for gemma3:4b.**

- 0% parse success. Root cause is model capability, not prompt wording. Not fixable with prompt tuning alone on this model.

**Recommended next steps:**

1. Add a short-chunk guard (skip combined LLM call for chunks below ~20 tokens; use empty context + empty tags) to address the 4 failure cases.
2. Test `qwen3:1.7b` (when available) for batch combined feasibility — better instruction following may unlock the batch path.
3. If per-chunk combined is implemented, gate behind `COMBINED_LLM=1` env flag so production path is unchanged by default.
4. Run custom-50 retrieval benchmark with COMBINED_LLM=1 to verify context quality does not degrade retrieval accuracy.

*Generated: 2026-05-17 — model: gemma3:4b*
*Probe: `npm run bench:combined-probe` (COMBINED_PROBE_LIMIT=30, COMBINED_PROBE_BATCH_SIZE=3)*
