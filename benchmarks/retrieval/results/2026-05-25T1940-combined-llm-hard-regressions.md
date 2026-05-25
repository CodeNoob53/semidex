# COMBINED_LLM=1 Hard Regression Diagnostic — 2026-05-25

## Context

Source report: `benchmarks/retrieval/results/2026-05-17T2333-combined-llm-custom50-quality.md`

Hard regressions (lost chunkRecall@5) identified in custom-50 run:
- `c48`

This report compares the exact top-10 results and expected chunk payloads between
baseline (context+tags) and combined (COMBINED_LLM=1) to identify the root cause.

## Indexing

| Run | Wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-----------|-------------------|---------------------|
| Baseline | 174901 ms | n/a | 3 |
| Combined | 142714 ms | 0 | n/a |

## Query `c48` — cross-lingual-ua-en — *hard regression NOT reproduced — likely variance*

**Query:** cross-lingual retrieval Ukrainian query English document BGE-M3

**Note:** cross-lingual retrieval with BGE-M3; #4 is the direct Ukrainian-query-to-English-document chunk

**qrels:**
- `multilingual.md#4` — relevance 3
- `multilingual.md#0` — relevance 2
- `multilingual.md#3` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `multilingual.md#4` | 1 | 1 | ✓ | ✓ |

> **Note:** hard regression did not reproduce in this run — both baseline and combined
> retrieved the expected chunk within top-5. Payload comparison and cause classification
> are shown for reference only; do not use to draw conclusions about regression cause.

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0333 | multilingual.md#4 | **3** | Query Language vs Document Lan… | This section describes semidex's ability to perform cross-lingual retrieval, hig… | cross-lingual-retrieval, semidex, bge-m3, unicode-aware |
| 2 | 0.0328 | multilingual.md#0 | 2 | Multilingual Support | This section details semidex's capability to handle Ukrainian, English, and mixe… | semidex-language-support, bge-m3-model, cross-lingual-retrieval, embeddings-generation |
| 3 | 0.0323 | multilingual.md#6 | — | Mixed-Language Documents | This chunk describes the processing of mixed Ukrainian-English documents, specif… | mixed-language, documentation, technical-documentation, code-blocks |
| 4 | 0.0313 | multilingual.md#7 | — | Benchmark Coverage | This section details the custom-50 benchmark, which is designed to assess query … | benchmark-evaluation, custom-50, query-language, sparse-provider |
| 5 | 0.0310 | multilingual.md#9 | — | Recommended Provider for Multi… | This chunk details the recommended command for indexing Ukrainian or mixed-langu… | bge-m3-onnx, onnx-encoder, sparse-weight, rare-terms |
| 6 | 0.0310 | multilingual.md#2 | — | ollama + hashed-tf (default) | This section details the creation of dense and sparse embeddings, specifically h… | dense-embeddings, bge-m3, ollama, multilingual-model |
| 7 | 0.0299 | multilingual.md#3 | 2 | bge-m3-onnx + bge-m3-onnx | This section details the production of sparse embeddings using the BGE-M3 ONNX m… | sparse-embeddings, neural-sparse, token-importance, frequency-weighting |
| 8 | 0.0286 | multilingual.md#8 | — | LLM Phases and Language | This section details the model configuration used for LLM phases, specifically r… | llm-context, tag-model, gemma3-model, english-processing |
| 9 | 0.0282 | project-structure.md#2 | — | Source Tree | This section details the source tree for the project, outlining the location of … | benchmark, v3, schema, qrels |
| 10 | 0.0276 | benchmarking.md#6 | — | v2 (extended file-level) | This chunk defines a query targeting a specific file and section within the benc… | section-heading, file.md, exact-token |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0333 | multilingual.md#4 | **3** | Query Language vs Document Lan… | This section discusses semidex's ability to perform cross-lingual retrieval, hig… | cross-lingual-retrieval, semidex, bge-m3, query-language |
| 2 | 0.0328 | multilingual.md#0 | 2 | Multilingual Support | This section discusses the multilingual capabilities of Semidex and the BGE-M3 m… | semidex, multilingual, bge-m3, embeddings |
| 3 | 0.0323 | multilingual.md#6 | — | Mixed-Language Documents | This chunk describes how documents containing mixed Ukrainian and English text a… | mixed-language, ukrainian-english, embedding, bge-m3 |
| 4 | 0.0315 | multilingual.md#2 | — | ollama + hashed-tf (default) | This section discusses the use of dense and sparse embeddings for multilingual c… | ollama, embeddings, bge-m3, hashed-tf |
| 5 | 0.0310 | multilingual.md#9 | — | Recommended Provider for Multi… | This chunk provides the command to index notes for Ukrainian or mixed-language c… | bge-m3-onnx, onnx, indexing, ukrainian |
| 6 | 0.0303 | multilingual.md#3 | 2 | bge-m3-onnx + bge-m3-onnx | This section discusses the creation of sparse embeddings using the BGE-M3 ONNX m… | bge-m3-onnx, onnx, embeddings, sparse-embeddings |
| 7 | 0.0292 | mcp-workflow.md#2 | — | Tool Reference | This section details Qdrant tools for interacting with the document collection, … | qdrant-search, qdrant-hybrid-search, qdrant-collection-info, qdrant-get-chunk |
| 8 | 0.0290 | multilingual.md#7 | — | Benchmark Coverage | This section details the different types of queries used in the custom-50 benchm… | benchmark, custom-50, query-testing, language-support |
| 9 | 0.0285 | multilingual.md#8 | — | LLM Phases and Language | This section details the LLM phases, specifically focusing on the models used fo… | llm-phases, context-model, tag-model, multilingual |
| 10 | 0.0274 | benchmarking.md#6 | — | v2 (extended file-level) | This chunk represents a query configuration object used in the benchmarking proc… | query-config, exact-token, benchmarking |

### Expected Chunk Payload Comparison

**Expected chunk: `multilingual.md#4`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Query Language vs Document Language | Query Language vs Document Language |
| context | This section describes semidex's ability to perform cross-lingual retrieval, highlighting its use of BGE-M3 to map langu… | This section discusses semidex's ability to perform cross-lingual retrieval, highlighting how BGE-M3's semantic mapping … |
| tags | cross-lingual-retrieval, semidex, bge-m3, unicode-aware, sentence-splitting | cross-lingual-retrieval, semidex, bge-m3, query-language, document-language, translation, ukrainian-english |
| text snippet | semidex supports cross-lingual retrieval: a Ukrainian query can match an English document and vice v… | semidex supports cross-lingual retrieval: a Ukrainian query can match an English document and vice v… |
| text length (chars) | 433 | 433 |

**Expected chunk: `multilingual.md#0`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Multilingual Support | Multilingual Support |
| context | This section details semidex's capability to handle Ukrainian, English, and mixed-language content, focusing on its desi… | This section discusses the multilingual capabilities of Semidex and the BGE-M3 model. It highlights their support for va… |
| tags | semidex-language-support, bge-m3-model, cross-lingual-retrieval, embeddings-generation, onnx-variants | semidex, multilingual, bge-m3, embeddings, cross-lingual, olllama, onnx |
| text snippet | semidex is designed to work with Ukrainian, English, and mixed-language content. The BGE-M3 model (b… | semidex is designed to work with Ukrainian, English, and mixed-language content. The BGE-M3 model (b… |
| text length (chars) | 223 | 223 |

**Expected chunk: `multilingual.md#3`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | bge-m3-onnx + bge-m3-onnx | bge-m3-onnx + bge-m3-onnx |
| context | This section details the production of sparse embeddings using the BGE-M3 ONNX model, highlighting its ability to captur… | This section discusses the creation of sparse embeddings using the BGE-M3 ONNX model, highlighting its effectiveness wit… |
| tags | sparse-embeddings, neural-sparse, token-importance, frequency-weighting, ukrainian-language | bge-m3-onnx, onnx, embeddings, sparse-embeddings, neural-sparse, ukrainian, mixed-language |
| text snippet | Both dense and sparse embeddings are produced by the BGE-M3 ONNX model. The sparse embeddings are ne… | Both dense and sparse embeddings are produced by the BGE-M3 ONNX model. The sparse embeddings are ne… |
| text length (chars) | 316 | 316 |

### Cause Classification

*Not reproduced — classification is indicative only.*

- combined context changed semantic focus (no direct term loss detected)
- combined context gained terms not in query: ukrainian, english, document
- combined tags added noisy off-topic terms: translation

## Overall Recommendation

**Not reproduced in this run:** `c48` — regression did not appear; likely LLM output variance. Rerun `bench:custom50:combined` 2-3 times to check consistency.

**All target regressions not reproduced in this run** — no hard failures observed.

**Recommendation:** rerun `bench:custom50:combined` 2-3 times to determine whether
the regressions are consistent or purely LLM variance.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-25*