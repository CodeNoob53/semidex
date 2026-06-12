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

| Phase | Legacy | Skeleton | Delta |
|-------|--------|----------|-------|
| LLM | 95391ms | 83699ms | -11692ms |
| Embed | 32352ms | 22885ms | -9467ms |
| Upsert | 3202ms | 3119ms | -83ms |
| **Total** | 130957ms | 109780ms | -21177ms |

## 3. Qrel Migration Summary

| Type | Count |
|------|-------|
| Total qrels | 85 |
| exact (>50% overlap) | 77 |
| window (20-50% or adjacent combined) | 0 |
| missing (<20% overlap) | 0 |
| ambiguous (multiple strong matches) | 6 |
| manual overlay (qrels.skeleton-v1.json) | 2 / 2 |

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
| chunkRecall@3 | 87.8% | 93.9% | +6.1% |
| chunkRecall@5 | 91.8% | 93.9% | +2.0% |
| chunkRecall@10 | 93.9% | 93.9% | +0.0% |
| windowRecall@5 (±1) | 98.0% | 95.9% | -2.0% |
| windowRecall@10 (±1) | 98.0% | 95.9% | -2.0% |
| supportRecall@10 | 95.9% | 95.9% | +0.0% |
| nDCG@10 | 0.772 | 0.789 | +0.017 |
| MRR@10 | 0.759 | 0.793 | +0.034 |
| negativePass | 100.0% | 100.0% | +0.0% |
| p50 latency | 89ms | 88ms | -1ms |
| p95 latency | 101ms | 100ms | -1ms |

## 5. Per-Query Delta Table

| ID | Legacy MRR | Skel MRR | Legacy cR@5 | Skel cR@5 | Delta class | Overlay | Query |
|----|-----------|---------|------------|----------|-------------|---------|-------|
| c09 | 0.250 | 1.000 | ✓ | ✓ | QREL_DRIFT_FIXED | yes | HYBRID_PREFETCH_LIMIT prefetch per RRF leg |
| c15 | 1.000 | 1.000 | ✓ | ✓ | QREL_DRIFT_FIXED | yes | OVERLAP_SENTENCES default value sentence overlap chunking |
| c08 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR |  | як працює RRF k параметр у гібридному пошуку |
| c20 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR |  | MAX_CHUNK_TOKENS MIN_CHUNK_TOKENS chunking parameters range |
| c39 | 0.500 | 0.333 | ✓ | ✓ | SOFT_REGR |  | chunkRecall nDCG graded relevance benchmark v3 schema |
| c43 | 1.000 | 0.500 | ✓ | ✓ | SOFT_REGR |  | QDRANT_URL QDRANT_KEY required environment variables |
| c03 | 0.333 | 0.500 | ✓ | ✓ | IMPR |  | як увімкнути bge-m3-onnx без Ollama |
| c05 | 0.333 | 0.500 | ✓ | ✓ | IMPR |  | що станеться якщо змінити denseModel у config.json |
| c31 | 0.250 | 1.000 | ✓ | ✓ | IMPR |  | qdrant_list_directories recommended first step corpus layout |
| c36 | 0.333 | 0.500 | ✓ | ✓ | IMPR |  | chunkFile splitSentences parseMarkdown location in source |
| c37 | 0.500 | 1.000 | ✓ | ✓ | IMPR |  | npm run bench:custom50 entry point run-v3.js |
| c41 | 0.167 | 0.500 | ✗ | ✓ | IMPR |  | яка різниця між 21-query regression і custom-50 quality benc |
| c47 | 0.500 | 1.000 | ✓ | ✓ | IMPR |  | bge-m3-onnx neural sparse weights for rare Ukrainian terms |
| c01 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | де налаштовується sparseProvider |
| c02 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED |  | які є валідні комбінації провайдерів embeddings |
| c04 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | embedding_schema_version reindex discriminator payload field |
| c06 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | resolveEnvProviders single source of truth provider mapping |
| c07 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | Invalid provider combination error mixed ollama onnx |
| c10 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | чому hybridSearch падає коли нема sparse векторів |
| c11 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | getStoredMeta які поля читає з Qdrant payload |
| c12 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | як Qdrant зберігає named vectors dense sparse |
| c13 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | source_file payload index efficient filtering deleteBySource |
| c14 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | Qdrant Query API body shape for RRF fusion with prefetch |
| c16 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | чому фінальний чанк може губитись при малій кількості речень |
| c17 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | чому overlap не переноситься між markdown секціями |
| c18 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | splitSentences regex trailing text without period |
| c19 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | як pandoc конвертує docx epub rtf у markdown |
| c21 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | що робить npm run sync з config.json |
| c22 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | sync backfill logic for missing denseProvider field |
| c23 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | коли потрібно запускати sync після апгрейду semidex |
| c24 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | sync записує поточний провайдер а не той що був при індексац |
| c25 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | відмінність між sync та indexer стосовно config.json |
| c26 | 0.500 | 0.500 | ✓ | ✓ | UNCHANGED |  | як зареєструвати MCP сервер semidex у Claude Code |
| c27 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | qdrant_get_chunk window parameter context neighbors |
| c28 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | qdrant_find_by_tag groups results by source_file tags filter |
| c29 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED |  | як агент повинен починати сесію з semidex MCP |
| c30 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | qdrant_list_files qdrant_list_directories corpus navigation  |
| c32 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | qdrant_list_files directory prefix alphabetical source_file  |
| c33 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | які payload-поля доступні для навігації по колекції chunk_in |
| c34 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | use cases for listing indexed files verifying coverage tag a |
| c35 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | де знаходиться src/core/qdrant.js і що він експортує |
| c38 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | SCHEMA_VERSION constant embeddings.js reindex discriminator |
| c40 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | relevantChunks chunkId format source_file#chunk_index |
| c42 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | BENCH_SKIP_INDEX validates stored provider matches current e |
| c44 | 0.000 | 0.000 | ✗ | ✗ | UNCHANGED |  | RERANK_PROTECT_TOP1_DELTA minimum advantage to displace rank |
| c45 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | config.json six reindex discriminators denseProvider denseMo |
| c46 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | що таке SOURCE_ROOT і навіщо він потрібен при індексації |
| c48 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | cross-lingual retrieval Ukrainian query English document BGE |
| c49 | 1.000 | 1.000 | ✓ | ✓ | UNCHANGED |  | ONNX_EMBED=1 recommended provider for multilingual Ukrainian |

## 6. Regression / Overlay Detail

### Overlay-fixed (QREL_DRIFT_FIXED)

These queries were previously classified as hard regressions due to qrel drift; the overlay corrected the skeleton qrel and skeleton now hits.

**c09:** HYBRID_PREFETCH_LIMIT prefetch per RRF leg
- Legacy MRR: 0.250 → Skeleton MRR: 1.000
- Legacy cR@5: ✓ → Skeleton cR@5: ✓

**c15:** OVERLAP_SENTENCES default value sentence overlap chunking
- Legacy MRR: 1.000 → Skeleton MRR: 1.000
- Legacy cR@5: ✓ → Skeleton cR@5: ✓

## 7. Verdict

**SKELETON_ACCEPT_WITH_QREL_MIGRATION**

No hard regressions. Qrel drift resolved: 77 exact, 0 window, 0 missing, 6 ambiguous, 2 manual overlay out of 85 total. QREL_DRIFT_FIXED (overlay corrected): 2. Soft regressions (MRR worse by >0.1): 4. Improvements: 7.
