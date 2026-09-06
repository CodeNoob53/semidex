# Ремедіація аудиту retrieval — Етап B (2026-09-07)

**Мета Етапу B:** відновити ground truth і чесні метрики для custom-50 —
frozen corpus, семантично перевірені qrels, manifest, метрики з чесними
назвами. Це **«полагодили вимірювання»**, не прискорення й не покращення
релевантності.

## Ключове рішення

Corpus custom-50 (frozen snapshot аудиту, 98 chunks) був створений **старим
legacy chunker**. Поточний chunker для Markdown — **skeleton-first**
(`chunkFileFromPath` тепер повертає `{ chunks, navPoints, entityRawPoints }`,
inline chunk-loop у `run-v3.js` зламався). Re-index через skeleton chunker
дає інші межі чанків → **усі legacy qrels недійсні**.

Рішення (погоджено): **re-index через skeleton chunker + нові qrels з нуля**.
Старі audit цифри — invalid-for-quality проти нового corpus.

## Що зроблено

### 1. Frozen skeleton corpus (`build-corpus.mjs`)

Запускає **справжній indexer CLI** (`src/indexer/index.js`) над 10 фікстурами,
читає кожен content chunk назад через production `getFileChunks()`, заморожує
результат:

- `corpus.frozen.json` — 102 chunks, кожен: `nodeId`, `nodePath`, `parentId`,
  `nodeType`, `section`, `headingPath`, `text`, `rawContent` (лише для
  структурних вузлів), **per-chunk sha256 `contentHash`**.
- `corpus.manifest.json` — `corpusHash`, per-file hashes, fixture file hashes,
  embedding profile, deterministic index env (pinned), git HEAD + dirty paths,
  точна команда збірки.
- `corpus-hash.mjs` — **одна** канонічна hash-функція (whitespace-normalized
  retrieval body; `rawContent` лише для table/code_block/checklist), спільна
  для builder і validator, щоб вони не розійшлися.
- `--check` — rebuild + diff проти закомічених frozen файлів, exit 1 на drift.

Rebuild детермінований: два незалежні прогони дали ті самі 102 chunks і той
самий `corpusHash` `c1f29153…`.

### 2. Семантичний перегляд усіх 50 запитів (`qrels-review.mjs` + `review-table.md`)

Метод: **спочатку** визначити відповідь із тексту frozen corpus, **потім**
вибрати чанк(и) що її містять. Labels **не** ставилися за принципом «що
повернув retriever».

| Verdict | К-ть | Приклади |
|---|---|---|
| valid | 41 | intent правильний, chunk IDs пере-прив'язані до skeleton corpus |
| corrected | 8 | c09, c37, c38, c44 (audit-flagged) + c15, c35, c39, c40 (legacy-chunk drift) |
| valid-negative | 1 | c50 — жоден чанк не відповідає; retrieval-negative |

Підтверджено кожну знахідку аудиту за текстом corpus:
- **c44**: `RERANK_PROTECT_TOP1_DELTA` → legacy qrel вказував на
  `config-env.md#9` (config.json section); значення в таблиці
  `config-env.md#11` (Reranking).
- **c38**: `SCHEMA_VERSION`/`embeddings.js` → legacy `project-structure.md#4`
  (config.js section); зараз `project-structure.md#3` (embeddings.js section).
- **c37**: `bench:custom50`/`run-v3.js` → legacy `project-structure.md#8`
  (mcp/server.js); зараз `project-structure.md#7` (Entry Points table).
- **c09**: `HYBRID_PREFETCH_LIMIT` → legacy `qdrant.md#2`; зараз `qdrant.md#5`
  + `qdrant.md#9` (Env tuning table).

Жоден запит не видалено заради aggregate. Жоден ambiguous не викинуто.

### 3. qrels v4 (`queries.v4.json`, schemaVersion 4)

Для кожного relevant chunk: `chunkId` + `relevance` (1/2/3) + **`contentHash`**
(з frozen corpus) + `evidence` (цитата span). 11 запитів мають ≥2 валідних
rel-3 джерела (усі judged). 3 запити (c14, c41, c44) мають `requiredEvidence`
групи — multi-evidence coverage, окремо від Hit@K.

### 4. Метрики з чесними назвами (`metrics-v4.mjs` + 25 fixture тестів)

| v4 назва | Формула | v3 плутанина |
|---|---|---|
| `Hit@K` | ≥1 rel≥3 чанк у top K | v3 називав це `chunkRecall@K` |
| `Recall@K` | \|retrieved ∩ relevant\| / \|relevant\| (rel≥3) | не існувало окремо |
| `gradedNDCG@K` | gain(rel) = 2^rel − 1, discount 1/log2(rank+1) | конвенція не була вказана |
| `requiredEvidenceCoverage@K` | кожна група має члена в top K | не існувало |
| `negativeTokenAbsence@1` | rank-1 не містить expected token | v3 `negativePassRate` — **не** abstention quality |

`chunkRecallAtK` лишено як явний compatibility alias `hitAtK` (з коментарем
«ніколи не подавати як recall»).

### 5. Typed negative fixtures (`negative-fixtures.json`)

10 фікстур: unknown-fact (n01, n02), scope-mismatch (n03, n04, n10),
version-mismatch (n05, n06), false-premise (n07, n08), source-conflict (n09).
Кожна **явно** каже яку поведінку перевіряє. n10 — answerable control
(перевіряє що negative-метрика не винагороджує off-topic retrieval).
Жодна не доводить abstention quality — для цього потрібен live-generation Ask eval.

### 6. Validation (`validate-qrels.mjs` + 15 тестів)

- Structural: кожен qrel `chunkId` існує у frozen corpus.
- **Content-integrity**: кожен qrel `contentHash` = frozen chunk `contentHash`.
  **Пошкодження content при збереженому chunk ID тепер не проходить** — те,
  що v3 «does this ID exist» перевірка не могла зловити (headline тест).
- `qrels.corpusHash == manifest.corpusHash`.
- Skip-index guard: live collection per-file content-hash sequence == frozen
  corpus, інакше **refuse** (audit: «Skip-index повинен відхиляти несумісний
  корпус»).

### 7. Runner (`run-v4.mjs`, `npm run bench:custom50`)

Компонує реальні embedding capabilities (Stage A `createBenchmarkQueryEmbedder`),
production `runHybridSearch()` path. Валідує qrels↔corpus статично і live
collection↔frozen corpus перед запуском. `--reindex` перебудовує колекцію з
фікстур детермінованим env. Query error → nonzero exit.

`run-v3.js` збережено як `npm run bench:custom50:v3-legacy` (archival).

### 8. Evaluation manifest (`evaluation.manifest.json` + `evaluation-manifest.mjs`)

Corpus/query/qrel hashes, chunker=skeleton-v1, embedding profile, deterministic
index env, runtime/code identity (git HEAD, node, platform), точні шляхи
виконання, scope note.

## Новий baseline

`node benchmarks/retrieval/custom-50/run-v4.mjs --reindex --json`
(`custom50-v4-baseline.json`, corpusHash `c1f29153…`, qrels v4):

| Metric | Value |
|---|---:|
| Hit@1 | 79.6% |
| Hit@3 / @5 / @10 | 98.0% |
| Recall@5 | 0.9490 |
| Recall@10 | 0.9592 |
| supportHit@10 (rel≥2) | 98.0% |
| gradedNDCG@10 | 0.8798 |
| MRR@10 | 0.8844 |
| requiredEvidenceCoverage@10 (n=3) | 100% |
| negativeTokenAbsence@1 (n=1) | 100% *(token-absence only)* |
| query errors | 0 |

**Ці цифри — новий baseline, не порівнянні з audit diagnostic matrix**
(інший chunker, інші qrels). Це **regression/tuning set, не незалежний
held-out доказ**. Зміна метрик через relabeling — це «полагодили
вимірювання», не «покращили ranking».

## Перевірки

| Suite | Результат |
|---|---|
| custom-50 offline (metrics-v4 + validate-qrels tests) | 40 pass, 0 fail |
| `benchmarks/**/*.test.mjs` | 860 pass, 0 fail |
| `qrels-review.mjs --check` | OK |
| `validate-qrels.mjs` | OK |
| live: `run-v4.mjs --reindex` | live collection matches frozen corpus; 0 query errors; exit 0 |
| corpus rebuild determinism | 2 незалежні прогони → однаковий corpusHash |

## Оновлені підтримувані команди

| Команда | Призначення |
|---|---|
| `npm run bench:custom50` | v4 runner (`run-v4.mjs`) |
| `npm run bench:custom50:build-corpus` | rebuild + freeze corpus (real indexer) |
| `npm run bench:custom50:review` | regenerate `queries.v4.json` + `review-table.md` |
| `npm run bench:custom50:validate` | qrel↔corpus validation |
| `npm run bench:custom50:v3-legacy` | старий `run-v3.js` (archival) |

## Залишкові проблеми

| # | Проблема | Етап |
|---|---|---|
| 1 | Аналітичні скрипти custom-50 (`:tune`, `:compare`, `:rank1`, `:failures`, …) досі спавнять `run-v3.js` і парсять його JSON — не оновлені на v4 | окремо, за потреби |
| 2 | 5 службових round trips перед кожним search | C |
| 3 | Evidence-level top=3/5/10 eval, evidence після compact window/token budget | D |
| 4 | Live-generation Ask eval для справжньої abstention/refusal quality | після D |
| 5 | Held-out set (не regression/tuning) на реальному довгому UA корпусі | після B–D |
| 6 | `qrels.skeleton-v1.json` (частковий legacy overlay, 2 override) — застарів, замінений повним v4 review; можна видалити | окремо |

**Етап B не робить задачу завершеною.** qrels перевірені й достовірний
baseline є, але hot-path overhead і evidence-level eval попереду.
