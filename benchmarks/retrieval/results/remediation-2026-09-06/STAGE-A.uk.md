# Ремедіація аудиту retrieval — Етап A (2026-09-06)

**Мета Етапу A:** полагодити benchmark runtime і статус завершення, щоб
підтримувані entry points працювали на поточному runtime, а INCOMPLETE
run більше не виглядав успішним. Це **«полагодили вимірювання»** —
не прискорення і не покращення релевантності.

## Обсяг і межі

- Робоча копія над HEAD `e0f1d79`, зі сторонніми незакоміченими змінами
  інших задач (admin UI / jobs). Змін у `src/` **не робилося** — усі
  правки в `benchmarks/`.
- Вихідні audit results (`benchmarks/retrieval/results/audit-2026-09-06/`)
  не змінювалися.
- Node v25.2.1, Windows; cached BGE-M3 ONNX (2.2 GB, `models/bge-m3-onnx/`),
  CPU; Qdrant Cloud доступний.
- Етапи B–D (semantic qrel review, hot-path refactor, evidence-level eval)
  **не входять** у цей етап.

## Що зроблено

### 1. Benchmark-owned capability factory

Новий `benchmarks/lib/embedding-capabilities.mjs`:
`createBenchmarkQueryEmbedder()` повертає свіжий екземпляр на виклик із:

- `embedQuery(profile, text)` — для передачі в `runHybridSearch({ embedQuery })`.
  Диспетчеризує за dense provider розв'язаного профілю: `bge-m3-onnx` →
  власна ONNX-capability цього екземпляра (будується **лениво**, лише на
  першому bge-m3 запиті, тому cloud-only run не чіпає onnxruntime-node);
  `ollama`/`hashed-tf` → module default `embedForSearch`.
- `getClientCapabilities(profile)` — `{ onnxEmbed }` для ONNX-профілю, `{}`
  інакше — для `embedForIndex()` в бенчмарках, що індексують in-process.
- `cloudEmbed` — справжня `CloudEmbeddingCapability` (stateless).
- `shutdown()` — звільняє ONNX InferenceSession, якщо створювався;
  ідемпотентно; після нього `embedQuery` кидає, а не респавнить сесію.

**Не** використано process-wide singleton `applyEmbeddingCapabilities()`.
Жодного model download / generation при import.

### 2. Production-path suite — capabilities + shutdown

- `core/run-suite.mjs` — `runSuiteAcrossProfiles()` будує один
  `queryEmbedder` на весь run (через `queryEmbedderFactory`, default =
  `createBenchmarkQueryEmbedder`), передає `embedQuery`/`cloudEmbed` у
  кожен `queryOne()`, викликає `queryEmbedder.shutdown()` у власному
  `finally` (loop тепер загорнуто в try/finally).
- `core/query-via-search.mjs` — `queryOne()` приймає й пробрасує
  `embedQuery` **і** `cloudEmbed` у `runHybridSearch()`.
- Offline-тести інжектять власний `queryOne`, який ігнорує ці аргументи;
  default factory дешевий (ONNX лениве), тому їх це не зачіпає.

### 3. CLI exit codes

Новий `core/cli-exit.mjs`: `exitCodeForSuiteState()` /
`exitCodeForManySuiteStates()`. Правило: run, що не завершився як
COMPLETE — це **FAILED run**, `process.exitCode = 1`. `--resume-check` —
read-only інспекція, завжди 0.

Підключено в `main()` усіх п'яти runner-ів: `run-structural-prodpath.mjs`,
`run-scifact-prodpath.mjs`, `run-miracl-ru-prodpath.mjs`,
`run-slavic-prodpath.mjs`, `run-all.mjs`.

### 4. Явні coverage/depth gates у `isCompletedProfileRun()`

Тепер COMPLETE вимагає **кожного** з:

- нуль errors / unmapped hits / query errors / indexing errors;
- підтверджений cleanup;
- **скінченний `ndcgAt10` І скінченний `mapAt100`** (обидві заявлені метрики
  мають бути реальними числами, не `null` від all-errored run);
- **`queriesWithInsufficientDepth === 0`** — і відхиляє повну відсутність
  цього поля (checkpoint, що передував gate, не проходить vacuously);
- для фінального verdict і resume-skip — **точний збіг `queryCount`**.

Фінальний verdict у `run-suite.mjs` тепер вимагає присутності **обох**
профілів і передає `{ queryCount: queries.size }`.

### 5. Resume/checkpoint

`validateResumeCheckpoint(previous, contract, { queryCount })` — runner
передає поточний `queries.size`. Stored «complete» профіль зі зміненим
query count більше не проходить resume-skip (раніше self-referential
`block.metrics.queryCount` завжди збігався сам із собою) — профіль
переганяється повністю. Contract fingerprint (`datasetFingerprint` +
`deterministicEnvHash`) уже покривав зміну corpus/profile/config.

### 6. custom-50 `run-v3.js`

- `main()` будує `createBenchmarkQueryEmbedder()`; `runQuery()` через
  `QUERY_EMBEDDER.embedQuery(PROFILE, …)`; `indexFixtures()` через
  `embedForIndex(PROFILE, text, { capabilities: getClientCapabilities(PROFILE) })`.
- `main().finally()` викликає `QUERY_EMBEDDER.shutdown()`.
- `validateQrels()` тепер `throw`, а не `process.exit(1)` — щоб `finally`
  встиг закрити ONNX-сесію на non-skip шляху.
- Помилка → `process.exitCode = 1` (було `process.exit(1)`).

### 7. Дотичні live-скрипти з тим самим gap

- `run-structural-smoke.mjs` — `runEntityRawAndRetrievabilityProbe()`
  (cloud-профіль) тепер компонує `queryEmbedder` і передає `cloudEmbed`;
  `result.error` → `throw` замість тихого empty-hits fail; `shutdown()` у
  finally.
- `benchmarks/spikes/qdrant-cloud-inference-accept.mjs` — той самий
  one-liner fix (історичний spike, не maintained benchmark, але live).

## Тести

Нові:

| Файл | Покриває |
|---|---|
| `benchmarks/lib/embedding-capabilities.test.mjs` | Реальна composition boundary: `embedQuery` фабрики → **справжній** `embedForSearch` → інжектована ONNX-capability; вектор фактично приходить із цієї capability (не fake `embedQuery`, що ховає відсутні deps). Лениве будування, ідемпотентний shutdown, throw-after-shutdown, `getClientCapabilities` per-provider, `cloudEmbed` shape. |
| `benchmarks/external/production-path/cli-exit.test.mjs` | Unit: `exitCodeForSuiteState` (COMPLETE→0, INCOMPLETE→1, null→1, no-verdict→1, resumeCheck→0). **Executable-level:** spawn `run-structural-prodpath.mjs` без QDRANT creds → exit 1 + `LIVE_BLOCKED`; `--resume-check` без checkpoint → exit 0. |

Розширено:

| Файл | Додано |
|---|---|
| `query-via-search.test.mjs` | `embedQuery` пробрасується (вектори реально з нього); `cloudEmbed` пробрасується (qdrant-cloud профіль більше не падає); без `cloudEmbed` — typed `{ok:false}` error, не тиха порожня видача. |
| `checkpoint.test.mjs` | `queriesWithInsufficientDepth != 0` → false; повна відсутність поля → false; `mapAt100` не скінченний → false; stored-complete зі зміненим `queryCount` не проходить як complete (runner переганяє). |
| `run-suite-orchestration.test.mjs` | resume-тест повертає реальний Chunk-shaped hit (щоб run був справжнім COMPLETE зі скінченними метриками й нульовою insufficient-depth). |

## Перевірки

| Suite | Результат |
|---|---|
| `benchmarks/**/*.test.mjs` (offline harness) | 825 pass, 0 fail |
| `tests/unit/core/retrieval/**`, `embeddings*`, `embedding-profile/**` | 204 pass, 0 fail |
| `npm run smoke` | 1316 pass, 0 fail |
| `npm test` (повний unit suite) | 4894 pass, 0 fail, 4 skipped (pre-existing) |

### Live (справжній Qdrant + ONNX CPU + Qdrant Cloud)

`node benchmarks/external/production-path/run-structural-smoke.mjs`

**Було** (`audit-2026-09-06/structural-before.json`): verdict INCOMPLETE, по
3 `embedding_failed` на кожному профілі (local — no onnxEmbed, cloud — no
cloudEmbed), CLI exit 0.

**Стало** (`structural-smoke-after.log`): **verdict ACCEPT**, exit 0.
- structural suite --smoke: **COMPLETE** для обох профілів;
- local (BGE-M3 ONNX): zero errors, zero query errors, zero unmapped hits, cleanup deleted;
- cloud (E5-small + BM25): те саме + telemetry 35 indexing / 3 query dense inference items, 49 qdrant_sdk ops;
- dedicated entity_raw / retrievability probe: усі 3 queries + усі 3 exact identifiers знайдено verbatim; collection cleaned up;
- cleanup sweep: 0 orphaned collections (scanned 22).

`BENCH_SKIP_INDEX=1 BENCH_JSON=1 node benchmarks/retrieval/custom-50/run-v3.js`

**Було** (`audit-2026-09-06/custom50-before.log`): exit 1 на c01,
`no onnxEmbed capability available` — benchmark не виконав пошук.

**Стало** (`custom50-skipindex-after.log`): усі 50 запитів виконано, exit 0.
Метрики (chunkRecall@3 75.5%, nDCG@10 0.689, MRR@10 0.648) **залишаються
invalid-for-quality** — qrels під семантичним переглядом в Етапі B.

## Залишкові проблеми (для наступних етапів)

| # | Проблема | Етап |
|---|---|---|
| 1 | custom-50 qrels семантично не відповідають корпусу (c44/c38/c37/c09 та ін.); ChunkRecall = Hit@K; NegativePassRate ≠ abstention | B |
| 2 | Немає corpus/evaluation manifest, content hashes, evidence spans, versioned qrels | B |
| 3 | 5 службових round trips перед кожним search (`runHybridSearch` → `adapter.getCollection()`) | C |
| 4 | Немає bounded top=3/5/10 evidence-level eval; evidence після compact window/token budget не вимірюється | D |
| 5 | `Qdrant Web Documentation` через MCP → низькорівнева `point_kind index` помилка замість typed unsupported/migration diagnostic | D |
| 6 | Повний SciFact production path, held-out ukr set, hard negatives, operational latency gates | після B–D |

**Етап A не робить задачу завершеною.** CLI більше не дає false success,
live runners працюють на обох профілях, але qrels ще не перевірені й
достовірного quality baseline поки немає.

## Оновлені підтримувані команди

Див. `entry-point-support.md` у цьому ж каталозі — повна таблиця
supported / historical / was-broken.
