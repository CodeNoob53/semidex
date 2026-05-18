# COMBINED_LLM=1 Embedding-Input Ablation — custom-150 — 2026-05-18T1608

## Hypothesis

Prepending LLM-generated context to `chunk.text` for embeddings may blur exact-token and
source-navigation ranking. Ablation: keep qwen2.5 combined context/tags as payload, but embed
only `chunk.text` (no context prefix). If chunkRecall@5 improves without hurting MRR/nDCG,
embedding input should become configurable.

## Environment

| Item | Value |
|------|-------|
| CONTEXT_MODEL | qwen2.5:3b-instruct |
| COMBINED_LLM | 1 |
| ONNX_EMBED | 1 |
| BENCH_EMBED_INPUT (context+text) | unset (default) |
| BENCH_EMBED_INPUT (text-only) | text |
| Corpus | custom-150 fixture docs (10 files) |
| Queries | 75 (v3 schema) |
| Top-K | 10 |
| Window | 1 |

## Temp Collections

| Arm | Collection | Points | Wall time | Fallbacks |
|-----|-----------|--------|-----------|-----------|
| context+text | `bench-ablation-ctx-text-1779109312405` | 101 | 184868 ms | 0 |
| text-only | `bench-ablation-text-only-1779109312405` | 101 | 183910 ms | 0 |

## Aggregate Metrics

| Metric | context+text | text-only | Δ (text−ctx) | Historical ONNX ref |
|--------|-------------|-----------|--------------|---------------------|
| chunkRecall@3 | 56.9% | 56.9% | — | — |
| chunkRecall@5 | 63.9% | 63.9% | — | ~68.1% |
| chunkRecall@10 | 75.0% | 75.0% | — | ~76.4% |
| windowRecall@5 | 87.5% | 90.3% | +2.8 pp | — |
| windowRecall@10 | 95.8% | 98.6% | +2.8 pp | — |
| supportRecall@10 | 81.9% | 81.9% | — | — |
| nDCG@10 | 0.567 | 0.548 | -0.019 | ~0.566 |
| MRR@10 | 0.516 | 0.478 | -0.038 | ~0.517 |
| negativePass | 100.0% | 100.0% | — | — |

## Per-Type Breakdown

| Type | ctx+text cr@5 | text-only cr@5 | Δcr@5 | ctx+text MRR | text-only MRR | ΔMRR |
|------|--------------|---------------|-------|-------------|--------------|------|
| conceptual | 66.7% | 58.3% | -8.3 pp | 0.604 | 0.550 | -0.054 |
| config-env | 66.7% | 66.7% | — | 0.571 | 0.538 | -0.033 |
| cross-lingual-ua-en | 62.5% | 75.0% | +12.5 pp | 0.487 | 0.438 | -0.049 |
| english | 80.0% | 60.0% | -20.0 pp | 0.390 | 0.317 | -0.073 |
| exact-token | 66.7% | 66.7% | — | 0.579 | 0.528 | -0.051 |
| negative | n/a | n/a | — | n/a | n/a | — |
| provider-activation | 100.0% | 100.0% | — | 0.583 | 0.417 | -0.167 |
| source-navigation | 40.0% | 50.0% | +10.0 pp | 0.391 | 0.424 | +0.033 |
| troubleshooting | 55.6% | 55.6% | — | 0.444 | 0.448 | +0.003 |

## Per-Query Diff (text-only vs context+text, positive queries)

23 queries changed (2 recall gained, 2 recall lost).

| ID | type | ctx MRR | text MRR | ΔMRR | ctx cr@5 | text cr@5 | change |
|----|------|---------|----------|------|----------|-----------|--------|
| c150-003 | exact-token | 0.111 | 0.000 | -0.111 | ✗ | ✗ | regressed |
| c150-006 | config-env | 0.100 | 0.125 | +0.025 | ✗ | ✗ | improved |
| c150-009 | provider-activation | 0.500 | 0.333 | -0.167 | ✓ | ✓ | regressed |
| c150-012 | source-navigation | 0.167 | 0.143 | -0.024 | ✗ | ✗ | regressed |
| c150-014 | source-navigation | 0.100 | 0.125 | +0.025 | ✗ | ✗ | improved |
| c150-015 | source-navigation | 0.000 | 0.125 | +0.125 | ✗ | ✗ | improved |
| c150-016 | conceptual | 0.000 | 0.100 | +0.100 | ✗ | ✗ | improved |
| c150-017 | conceptual | 0.250 | 0.000 | -0.250 | ✓ | ✗ | **recall lost** |
| c150-021 | troubleshooting | 0.000 | 0.111 | +0.111 | ✗ | ✗ | improved |
| c150-024 | cross-lingual-ua-en | 0.143 | 0.250 | +0.107 | ✗ | ✓ | **recall gained** |
| c150-029 | english | 0.250 | 0.333 | +0.083 | ✓ | ✓ | improved |
| c150-037 | exact-token | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c150-041 | config-env | 0.250 | 0.333 | +0.083 | ✓ | ✓ | improved |
| c150-046 | config-env | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c150-049 | source-navigation | 0.143 | 0.200 | +0.057 | ✗ | ✓ | **recall gained** |
| c150-050 | source-navigation | 0.167 | 0.143 | -0.024 | ✗ | ✗ | regressed |
| c150-051 | source-navigation | 0.333 | 0.500 | +0.167 | ✓ | ✓ | improved |
| c150-057 | troubleshooting | 0.333 | 0.250 | -0.083 | ✓ | ✓ | regressed |
| c150-058 | conceptual | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c150-065 | cross-lingual-ua-en | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c150-070 | provider-activation | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c150-071 | english | 0.500 | 0.000 | -0.500 | ✓ | ✗ | **recall lost** |
| c150-072 | english | 0.200 | 0.250 | +0.050 | ✓ | ✓ | improved |

### Missed by both arms (chunkRecall@5)

| ID | type | note |
|----|------|------|
| c150-001 | exact-token | getStoredMeta retrieves discriminator fields from collection; qdrant.md#4; not in custom-50 |
| c150-002 | exact-token | MIN_CHUNK_TOKENS in params table chunking.md#0; distinct from OVERLAP_SENTENCES (c15 in custom-50) |
| c150-003 | exact-token | exact MCP tool name in find_by_tag dedicated section |
| c150-004 | exact-token | qdrant_backlinks in mcp-workflow.md#5 related+backlinks section; distinct from CHUNKS_OUT_DIR (c31) |
| c150-005 | config-env | reranking config vars in config-env.md#8 Reranking section |
| c150-006 | config-env | TAG_MODEL variable in Ollama Models section config-env.md#2 |
| c150-007 | config-env | RRF_K appears in qdrant.md#5 (env tuning table) and config-env.md#5 (hybrid search) |
| c150-008 | config-env | config.json structure described in config-env.md#10; UA query |
| c150-011 | troubleshooting | invalid mixed-provider state error; troubleshooting not provider-activation — no activation intent, query is about failure mode |
| c150-012 | source-navigation | mcp/server.js described in Key Modules section project-structure.md#1; UA query |
| c150-013 | source-navigation | loadConfig/saveConfig in src/core/config.js; project-structure.md#1 Key Modules; distinct from chunkFile (c36) |
| c150-014 | source-navigation | qdrant.js implements hybridSearch, referenced in project-structure.md#1; UA query |
| c150-015 | source-navigation | Entry Points section project-structure.md#2 lists src/indexer/index.js |
| c150-016 | conceptual | overlap semantics explained in chunking.md#2 Overlap section |
| c150-018 | conceptual | wikilinks as semantic neighbor links in obsidian.md#2; UA conceptual query; distinct from sync/indexer topic |
| c150-019 | conceptual | RRF explained in qdrant.md#1 Hybrid Search section; English query |
| c150-020 | conceptual | fallback to dense-only in qdrant.md#2; UA query |
| c150-021 | troubleshooting | reindex triggers in providers.md#4; UA troubleshooting query |
| c150-022 | troubleshooting | BENCH_SKIP_INDEX validation described in benchmarking.md#6 |
| c150-023 | troubleshooting | section boundary overlap risk in chunking.md#2 Overlap section |
| c150-026 | cross-lingual-ua-en | UA query about hashed-tf Cyrillic support; multilingual.md#0 covers language support by provider |
| c150-027 | cross-lingual-ua-en | UA query; answer in multilingual.md#6 Recommended Provider section |
| c150-028 | english | Collection Discovery section mcp-workflow.md#7; English workflow query |
| c150-050 | source-navigation | UA; src/core/config.js reads/writes config.json; project-structure.md#4 |

## Verdict

**DEFER**

text-only causes material MRR or nDCG regression (ΔMRR=-0.038, ΔnDCG=-0.019). Recall gain does not justify the ranking loss.

| Signal | Value |
|--------|-------|
| chunkRecall@5 Δ (text−ctx) | — |
| MRR@10 Δ (text−ctx) | -0.038 |
| nDCG@10 Δ (text−ctx) | -0.019 |
| chunkRecall@10 Δ | — |
| Recall gained (queries) | 2 |
| Recall lost (queries) | 2 |

---

*Generated: 2026-05-18T1608 — stamp 1779109312405*
