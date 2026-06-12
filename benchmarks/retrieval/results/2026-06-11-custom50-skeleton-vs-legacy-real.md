# custom-50 Skeleton vs Legacy Retrieval Benchmark

**Date:** 2026-06-11
**Provider:** bge-m3-onnx/bge-m3-onnx (ONNX_EMBED=1)
**TOP_K:** 10   **BENCH_WINDOW:** 1
**Fixture files:** 10   **Queries:** 50 (49 positive, 1 negative)
**Search mode:** hybrid (RRF), sequential — no interleaving

---

## 1. Chunk Counts per File

| File | Legacy | Skeleton | Delta |
|------|--------|----------|-------|
| `providers.md` | 6 | 6 | +0 |
| `qdrant.md` | 8 | 11 | +3 |
| `chunking.md` | 9 | 10 | +1 |
| `sync.md` | 6 | 6 | +0 |
| `mcp-workflow.md` | 9 | 10 | +1 |
| `obsidian.md` | 10 | 9 | -1 |
| `project-structure.md` | 9 | 8 | -1 |
| `benchmarking.md` | 21 | 17 | -4 |
| `config-env.md` | 10 | 16 | +6 |
| `multilingual.md` | 9 | 9 | +0 |
| **TOTAL** | **97** | **102** | **+5** |

## 2. Indexing Wall Time

| Candidate | Wall time |
|-----------|-----------|
| Legacy    | 22520ms |
| Skeleton  | 22595ms |
| **Delta** | **+75ms** |

## 3. Qrel Migration Summary

| Type | Count |
|------|-------|
| Total qrels | 85 |
| exact (>50% overlap) | 79 |
| window (20-50% or adjacent combined) | 0 |
| missing (<20% overlap) | 0 |
| ambiguous (multiple strong matches) | 6 |

### Ambiguous qrels

| Query | Legacy chunkId | Rel | Skeleton candidates | Best score |
|-------|---------------|-----|---------------------|-----------|
| c03 | `providers.md#2` | 3 | providers.md#2, providers.md#1 | 1.00 |
| c37 | `project-structure.md#8` | 3 | project-structure.md#7, project-structure.md#1 | 1.00 |
| c40 | `benchmarking.md#5` | 3 | benchmarking.md#5, benchmarking.md#6 | 0.58 |
| c45 | `config-env.md#2` | 2 | config-env.md#3, config-env.md#2 | 0.64 |
| c47 | `multilingual.md#2` | 3 | multilingual.md#2, multilingual.md#8 | 1.00 |
| c49 | `multilingual.md#2` | 2 | multilingual.md#2, multilingual.md#8 | 1.00 |

## 4. Aggregate Metrics

| Metric | Legacy | Skeleton | Delta |
|--------|--------|----------|-------|
| chunkRecall@3 | 79.6% | 89.8% | +10.2% |
| chunkRecall@5 | 85.7% | 89.8% | +4.1% |
| chunkRecall@10 | 93.9% | 93.9% | +0.0% |
| windowRecall@5 (±1) | 93.9% | 91.8% | -2.0% |
| windowRecall@10 (±1) | 98.0% | 95.9% | -2.0% |
| supportRecall@10 | 95.9% | 95.9% | +0.0% |
| nDCG@10 | 0.717 | 0.765 | +0.047 |
| MRR@10 | 0.694 | 0.751 | +0.057 |
| negativePass | 100.0% | 100.0% | +0.0% |
| p50 latency | 87ms | 86ms | -1ms |
| p95 latency | 96ms | 99ms | +3ms |

## 5. Per-Query Delta Table

| ID | Legacy MRR | Skel MRR | Legacy cR@5 | Skel cR@5 | Delta class | Query |
|----|-----------|---------|------------|----------|-------------|-------|
| c01 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | де налаштовується sparseProvider |
| c02 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED | які є валідні комбінації провайдерів embeddings |
| c03 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | як увімкнути bge-m3-onnx без Ollama |
| c04 | 0.333 | 0.500 | ✓ | ✓ | IMPR | embedding_schema_version reindex discriminator payload field |
| c05 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR | що станеться якщо змінити denseModel у config.json |
| c06 | 0.500 | 0.333 | ✓ | ✓ | SOFT_REGR | resolveEnvProviders single source of truth provider mapping |
| c07 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | Invalid provider combination error mixed ollama onnx |
| c08 | 1.000 | 0.333 | ✓ | ✓ | SOFT_REGR | як працює RRF k параметр у гібридному пошуку |
| c09 | 0.250 | 0.167 | ✓ | ✗ | HARD_REGR | HYBRID_PREFETCH_LIMIT prefetch per RRF leg |
| c10 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | чому hybridSearch падає коли нема sparse векторів |
| c11 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR | getStoredMeta які поля читає з Qdrant payload |
| c12 | 0.167 | 1.000 | ✗ | ✓ | IMPR | як Qdrant зберігає named vectors dense sparse |
| c13 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | source_file payload index efficient filtering deleteBySource |
| c14 | 0.500 | 1.000 | ✓ | ✓ | IMPR | Qdrant Query API body shape for RRF fusion with prefetch |
| c15 | 0.250 | 0.143 | ✓ | ✗ | HARD_REGR | OVERLAP_SENTENCES default value sentence overlap chunking |
| c16 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | чому фінальний чанк може губитись при малій кількості речень |
| c17 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | чому overlap не переноситься між markdown секціями |
| c18 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | splitSentences regex trailing text without period |
| c19 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | як pandoc конвертує docx epub rtf у markdown |
| c20 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | MAX_CHUNK_TOKENS MIN_CHUNK_TOKENS chunking parameters range |
| c21 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | що робить npm run sync з config.json |
| c22 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | sync backfill logic for missing denseProvider field |
| c23 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | коли потрібно запускати sync після апгрейду semidex |
| c24 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | sync записує поточний провайдер а не той що був при індексац |
| c25 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | відмінність між sync та indexer стосовно config.json |
| c26 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | як зареєструвати MCP сервер semidex у Claude Code |
| c27 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | qdrant_get_chunk window parameter context neighbors |
| c28 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | qdrant_find_by_tag groups results by source_file tags filter |
| c29 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED | як агент повинен починати сесію з semidex MCP |
| c30 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | qdrant_list_files qdrant_list_directories corpus navigation  |
| c31 | 0.200 | 1.000 | ✓ | ✓ | IMPR | qdrant_list_directories recommended first step corpus layout |
| c32 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | qdrant_list_files directory prefix alphabetical source_file  |
| c33 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | які payload-поля доступні для навігації по колекції chunk_in |
| c34 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | use cases for listing indexed files verifying coverage tag a |
| c35 | 0.143 | 1.000 | ✗ | ✓ | IMPR | де знаходиться src/core/qdrant.js і що він експортує |
| c36 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | chunkFile splitSentences parseMarkdown location in source |
| c37 | 0.167 | 1.000 | ✗ | ✓ | IMPR | npm run bench:custom50 entry point run-v3.js |
| c38 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | SCHEMA_VERSION constant embeddings.js reindex discriminator |
| c39 | 0.500 | 0.333 | ✓ | ✓ | SOFT_REGR | chunkRecall nDCG graded relevance benchmark v3 schema |
| c40 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | relevantChunks chunkId format source_file#chunk_index |
| c41 | 0.167 | 0.500 | ✗ | ✓ | IMPR | яка різниця між 21-query regression і custom-50 quality benc |
| c42 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | BENCH_SKIP_INDEX validates stored provider matches current e |
| c43 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR | QDRANT_URL QDRANT_KEY required environment variables |
| c44 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED | RERANK_PROTECT_TOP1_DELTA minimum advantage to displace rank |
| c45 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED | config.json six reindex discriminators denseProvider denseMo |
| c46 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | що таке SOURCE_ROOT і навіщо він потрібен при індексації |
| c47 | 0.500 | 1.000 | ✓ | ✓ | IMPR | bge-m3-onnx neural sparse weights for rare Ukrainian terms |
| c48 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED | cross-lingual retrieval Ukrainian query English document BGE |
| c49 | 0.333 | 1.000 | ✓ | ✓ | IMPR | ONNX_EMBED=1 recommended provider for multilingual Ukrainian |

## 6. Hard Regression Detail

### c09: HYBRID_PREFETCH_LIMIT prefetch per RRF leg

**Legacy top-5:**
```
  qdrant.md#7 [rel=0] | Env tuning                     | | Variable               | Default | Range      | Effect                        
  config-env.md#6 [rel=0] | Hybrid Search                  | | Variable | Default | Range | Description | |----------|---------|-------|-----
  qdrant.md#3 [rel=0] | RRF k parameter                | The `k` parameter in RRF controls rank sensitivity. It is configured via the `RR
  qdrant.md#2 [rel=3] | Hybrid Search and RRF          | Hybrid search combines dense and sparse retrieval using Reciprocal Rank Fusion (
  config-env.md#7 [rel=0] | Reranking (experimental)       | | Variable | Default | Description | |----------|---------|-------------| | `RER
```

**Skeleton top-5:**
```
  qdrant.md#5 [rel=0] | RRF k parameter                | The prefetch limit for each leg is max(limit * HYBRID_PREFETCH_LIMIT, limit + 1)
  config-env.md#10 [rel=0] | Hybrid Search                  | [table node: config-env.md#configuration-and-environment-variables/hybrid-search
  config-env.md#9 [rel=0] | Hybrid Search                  | | Variable | Default | Range | Description | |----------|---------|-------|-----
  qdrant.md#9 [rel=0] | Env tuning                     | | Variable               | Default | Range      | Effect                        
  qdrant.md#4 [rel=0] | RRF k parameter                | ```json {   "prefetch": [     { "query": "<sparse_vector>", "using": "sparse", "
```

### c15: OVERLAP_SENTENCES default value sentence overlap chunking

**Legacy top-5:**
```
  config-env.md#5 [rel=0] | Chunking                       | | Variable | Default | Range | Description | |----------|---------|-------|-----
  chunking.md#3 [rel=2] | Overlap                        | `OVERLAP_SENTENCES` controls how many sentences from the end of chunk N are prep
  chunking.md#5 [rel=0] | Flushing the final chunk       | After all sentences have been processed, any remaining sentences are always flus
  chunking.md#1 [rel=3] | Parameters                     | | Variable           | Default | Range       | Meaning                          
  chunking.md#4 [rel=0] | Why overlap must not cross sec | Overlap carries semantic context from one chunk to the next. If overlap crosses 
```

**Skeleton top-5:**
```
  chunking.md#4 [rel=2] | Overlap                        | OVERLAP_SENTENCES controls how many sentences from the end of chunk N are prepen
  config-env.md#7 [rel=0] | Chunking                       | | Variable | Default | Range | Description | |----------|---------|-------|-----
  chunking.md#6 [rel=0] | Flushing the final chunk       | After all sentences have been processed, any remaining sentences are always flus
  chunking.md#5 [rel=0] | Why overlap must not cross sec | Overlap carries semantic context from one chunk to the next. If overlap crosses 
  config-env.md#8 [rel=0] | Chunking                       | [table node: config-env.md#configuration-and-environment-variables/chunking/tabl
```

## 7. Verdict

**SKELETON_REJECT_RETRIEVAL_REGRESSION**

2 hard regression(s) confirmed: queries where legacy cR@5=✓ but skeleton cR@5=✗. Soft regressions: 6. Improvements: 9. Qrel migration: 79 exact, 0 window, 0 missing, 6 ambiguous.
