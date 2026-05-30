# BGE-M3 Tokenizer Audit Report

**Date:** 2026-05-29
**Script:** `benchmarks/retrieval/bge-tokenizer-audit.js`
**Model:** `aapot/bge-m3-onnx` (tokenizer only — no ONNX inference session)
**Heuristic:** `Math.ceil(text.length / 4)` (production baseline at audit time)

> Historical audit: the follow-up implementation promoted real BGE-M3 token counting
> to the production default. See `2026-05-30T1334-bge-m3-token-count-production-default.md`.

---

## Summary

**Verdict: TOKEN_HEURISTIC_CYRILLIC_RISK**

Mixed results: English corpora appear acceptable, but some mixed-language corpora show elevated ratios.

---

## Per-Corpus Results

### custom-50 fixtures (English + mixed)

- files analyzed: 6
- chunks analyzed: 67
- avg heuristicTokens: 89
- avg realBgeTokens: 121
- median ratio (real/heuristic): 1.35
- p90 ratio: 1.85
- max ratio: 2.50

**Oversized chunks (real BGE-M3 tokens):**

| Threshold | Count | % of chunks |
|-----------|-------|-------------|
| > 400 tokens | 1 | 1.5% |
| > 512 tokens | 1 | 1.5% |
| > 768 tokens | 0 | 0.0% |
| > 1024 tokens | 0 | 0.0% |

**Top 10 worst underestimates (highest ratio real/heuristic):**

| source_file | chunk | section | heuristic | real | ratio |
|-------------|-------|---------|-----------|------|-------|
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 10 | Running Benchmarks | 2 | 5 | 2.50 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 3 | v1 (minimal) | 21 | 46 | 2.19 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 17 | MMR diversity matrix | 7 | 14 | 2.00 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 4 | v2 (extended file-level) | 78 | 151 | 1.94 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 13 | Force ONNX provider | 11 | 21 | 1.91 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 9 | Latency | 45 | 84 | 1.87 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 15 | Dense MMR instead of hybrid RRF | 13 | 24 | 1.85 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 11 | Stable 21q regression benchmark | 6 | 11 | 1.83 |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | 12 | Quality 50q benchmark | 6 | 11 | 1.83 |
| `benchmarks/retrieval/custom-50/fixtures/docs/project-structure.md` | 8 | Entry Points | 129 | 236 | 1.83 |

### docs/en (English documentation)

- files analyzed: 13
- chunks analyzed: 293
- avg heuristicTokens: 192
- avg realBgeTokens: 242
- median ratio (real/heuristic): 1.24
- p90 ratio: 1.59
- max ratio: 5.00

**Oversized chunks (real BGE-M3 tokens):**

| Threshold | Count | % of chunks |
|-----------|-------|-------------|
| > 400 tokens | 66 | 22.5% |
| > 512 tokens | 29 | 9.9% |
| > 768 tokens | 0 | 0.0% |
| > 1024 tokens | 0 | 0.0% |

**Top 10 worst underestimates (highest ratio real/heuristic):**

| source_file | chunk | section | heuristic | real | ratio |
|-------------|-------|---------|-----------|------|-------|
| `docs/en/benchmarking.md` | 49 | Current Role | 1 | 5 | 5.00 |
| `docs/en/obsidian.md` | 3 | context: "This chunk explains how ONN... | 1 | 4 | 4.00 |
| `docs/en/operations.md` | 19 | ^^^^^^^^ include current collection f... | 1 | 4 | 4.00 |
| `docs/en/retrieval.md` | 14 | MMR Diversity Evaluation | 3 | 10 | 3.33 |
| `docs/en/retrieval.md` | 20 | BGE q4 gate summary | 72 | 144 | 2.00 |
| `docs/en/benchmarking.md` | 27 | Watched queries | 36 | 71 | 1.97 |
| `docs/en/configuration.md` | 13 | Skipped with warning: target is a sub... | 21 | 41 | 1.95 |
| `docs/en/benchmarking.md` | 6 | CPU baseline | 15 | 29 | 1.93 |
| `docs/en/configuration.md` | 19 | Supported Formats | 92 | 177 | 1.92 |
| `docs/en/obsidian.md` | 2 | ```yaml | 37 | 69 | 1.86 |

### docs/design (mixed — design docs)

- files analyzed: 4
- chunks analyzed: 92
- avg heuristicTokens: 192
- avg realBgeTokens: 262
- median ratio (real/heuristic): 1.34
- p90 ratio: 1.54
- max ratio: 1.89

**Oversized chunks (real BGE-M3 tokens):**

| Threshold | Count | % of chunks |
|-----------|-------|-------------|
| > 400 tokens | 23 | 25.0% |
| > 512 tokens | 11 | 12.0% |
| > 768 tokens | 0 | 0.0% |
| > 1024 tokens | 0 | 0.0% |

**Top 10 worst underestimates (highest ratio real/heuristic):**

| source_file | chunk | section | heuristic | real | ratio |
|-------------|-------|---------|-----------|------|-------|
| `docs/design/skeleton-first-chunking-impl-spec.md` | 3 | 2. Нові / змінені файли | 305 | 575 | 1.89 |
| `docs/design/skeleton-first-chunking.md` | 12 | 7.2 Policy enum + матриця | 400 | 675 | 1.69 |
| `docs/design/bge-m3-token-aware-chunking-plan.md` | 27 | 12. Files affected (no changes yet) | 140 | 229 | 1.64 |
| `docs/design/skeleton-first-chunking.md` | 20 | 12. Контекст по рівнях | 86 | 140 | 1.63 |
| `docs/design/skeleton-first-chunking-impl-spec.md` | 4 | 3. Сигнатури функцій | 18 | 29 | 1.61 |
| `docs/design/skeleton-first-chunking-impl-spec.md` | 21 | 12. Відкриті дрібниці (підтвердити пе... | 74 | 117 | 1.58 |
| `docs/design/skeleton-first-chunking-impl-spec.md` | 13 | 4. Payload-схема (skeleton-v1) | 352 | 552 | 1.57 |
| `docs/design/skeleton-first-chunking.md` | 6 | 5.1 Розпізнавання вузлів (mapping + f... | 403 | 626 | 1.55 |
| `docs/design/bge-m3-token-aware-chunking-plan.md` | 19 | 8.1 What to measure | 140 | 216 | 1.54 |
| `docs/design/skeleton-first-chunking-impl-spec.md` | 14 | 5. Qdrant-індекси | 117 | 180 | 1.54 |

### Ukrainian synthetic fixture

- files analyzed: 1
- chunks analyzed: 12
- avg heuristicTokens: 121
- avg realBgeTokens: 143
- median ratio (real/heuristic): 1.17
- p90 ratio: 1.60
- max ratio: 1.74

**Oversized chunks (real BGE-M3 tokens):**

| Threshold | Count | % of chunks |
|-----------|-------|-------------|
| > 400 tokens | 0 | 0.0% |
| > 512 tokens | 0 | 0.0% |
| > 768 tokens | 0 | 0.0% |
| > 1024 tokens | 0 | 0.0% |

**Top 10 worst underestimates (highest ratio real/heuristic):**

| source_file | chunk | section | heuristic | real | ratio |
|-------------|-------|---------|-----------|------|-------|
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 8 | Таблиця: порівняння провайдерів | 76 | 132 | 1.74 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 9 | Приклад коду: завантаження токенізатора | 111 | 178 | 1.60 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 10 | Короткий прозовий розділ для тесту меж | 7 | 9 | 1.29 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 7 | Налаштування середовища | 114 | 138 | 1.21 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 3 | Практичні наслідки для чанкінгу | 87 | 104 | 1.20 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 6 | Порівняння провайдерів ембедингу | 148 | 174 | 1.18 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 2 | Токенізація кириличного тексту | 129 | 149 | 1.16 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 1 | Принципи гібридного пошуку | 123 | 135 | 1.10 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 11 | Довгий прозовий розділ для перевірки ... | 336 | 364 | 1.08 |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | 4 | Архітектура індексатора | 134 | 141 | 1.05 |

---

## Interpretation

### Is `length/4` acceptable for English-heavy docs?
Partially. On the docs/en corpus, median ratio is 1.24 and 9.9% of chunks exceed 512 real tokens.
Overruns are concentrated in code blocks and Markdown tables, where tokens-per-char is lower than ASCII prose.
Pure prose English sections are unlikely to overflow, but mixed-content docs (code + prose) frequently do.

### Is it unsafe for Ukrainian/Cyrillic?
On the synthetic Ukrainian corpus: median ratio = 1.17,
p90 ratio = 1.60, max ratio = 1.74.
0.0% of chunks exceed 512 real tokens.
The heuristic underestimates Cyrillic tokens moderately. Real-world impact depends on corpus composition.

### Would switching to real tokenizer likely increase chunk count?
Likely marginal increase for English-heavy corpora. Significant increase expected if Cyrillic corpus is substantial.

### Is the issue large enough to justify implementing `TOKEN_COUNT=bge-m3`?
**Yes.** The follow-up implementation made the real tokenizer the production default.
`TOKEN_COUNT=heuristic` remains available only as an explicit compatibility/offline opt-out.

---

## Notes

- Real token counts include CLS and SEP special tokens (as BGE-M3 includes them in its sequence).
- Heuristic is `Math.ceil(text.length / 4)` — production code in `src/indexer/phases/chunk.js:27`.
- No production code was changed. This is a measurement-only audit.
- Extreme max-ratio values (e.g., ratio 5.0) arise from micro-chunks of 1–3 heuristic tokens
  (stray heading residuals, single-word stubs). These are artifacts of the current sentence splitter,
  not evidence of systematic overruns. Verdict logic excludes chunks with heuristic ≤ 10 from the
  max-ratio gate to prevent micro-chunk noise from dominating the verdict.
- `docs/design` corpus contains significant Ukrainian text (design docs are written in Ukrainian),
  so its elevated ratios reflect Cyrillic token density, not English-specific issues.
- Synthetic Ukrainian fixture: `benchmarks/retrieval/fixtures/ua-prose-synthetic.md`.
- Design plan: `docs/design/bge-m3-token-aware-chunking-plan.md`.
