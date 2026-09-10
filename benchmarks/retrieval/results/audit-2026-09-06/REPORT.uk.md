# Аудит retrieval Semidex — 2026-09-06

Доповнення від 2026-09-07: див. `EXTERNAL-ADDENDUM-2026-09-07.uk.md` —
повніший розбір custom-150 (75 queries), SciFact, MIRACL та Belebele,
із повторною offline перевіркою 43 raw configurations. Воно уточнює
оцінку provider-level quality; проблеми custom-50 не скасовують зовнішні докази.

## Висновок

Головна знайдена проблема — надійність вимірювання якості. Чинні benchmark
entry points відстали від runtime, а custom-50 має семантично неправильні qrels
для наявної колекції. Зелені offline-тести й відсотки з таких qrels не дають
підстав називати retrieval ані хорошим, ані поганим.

Окремо підтверджено реальні витрати production search: перед vector query
виконується п'ять послідовних службових Qdrant calls. Це конкретний кандидат
на покращення швидкодії без зміни embedding model або ranking policy.

Default ranking, qrels і користувацькі колекції в цьому аудиті не змінювалися.
Нові scripts/results розташовані поруч із цим звітом. Це аудит і діагностичні
запуски, не завершений ремонт усієї benchmark інфраструктури.

## Обсяг і відтворюваність

- Перевірена робоча копія над HEAD `e0f1d797d8c7199b136ad46e77efcf723d776ad1`,
  зі сторонніми незакоміченими змінами. Це не clean-commit release certification.
- Node v25.2.1, Windows; cached BGE-M3 ONNX, CPU; Qdrant Cloud доступний.
- `npm run doctor`: 161 PASS, 1 FAIL — Ollama недоступна. Для ONNX/Cloud
  retrieval вона не потрібна. Операцій sync/reindex документації не виконувалося.
- 96 targeted retrieval/MCP/rerank/security tests: PASS.
- 258 BEIR/MIRACL/production-path harness tests: PASS.
- 532 fusion/Slavic harness tests: PASS.
- `npm run smoke`: 1316 passed, 0 failed.
- Це вибрані suites та smoke, не повний `npm test` і не Ask answer-quality eval.
- Existing custom-50: 10 файлів, 98 points, 50 запитів, із них 49 positive і
  один negative. Read-only matrix: 350 search operations, query embeddings
  обчислювалися один раз на query, а не окремо для кожного режиму.
- Один локальний write artifact перервався через Windows `UNKNOWN` error;
  збережені query rows відновлені лише після перевірки hashes corpus/queries.
  Фінальний `live-matrix.json`: 50 rows, `complete: true`. Cold-start latency
  змішаних процесів не використовується як порівняння providers.
- Fresh structural і SciFact pilot виконано через реальні indexer/search
  зі explicit capability composition у `prodpath-explicit.mjs`.
  Generated collections мають benchmark prefix і видаляються через finally.

## Знахідки за пріоритетом

### P1. Benchmark entry points не працюють із поточними capabilities

Відтворення без індексації:

```powershell
$env:BENCH_SKIP_INDEX='1'
$env:BENCH_JSON='1'
node benchmarks/retrieval/custom-50/run-v3.js
```

Результат: exit 1 на c01, `no onnxEmbed capability available`.
`run-v3.js` викликає `embedForSearch(PROFILE, queryText)` без capabilities.
Це не невдача моделі й не пропуск релевантного результату — benchmark не виконав пошук.

`run-structural-prodpath.mjs --smoke --restart` індексував документи, але всі
3 local і 3 cloud queries повернули embedding_failed: у local відсутня
onnxEmbed, у cloud — cloudEmbed. Обидві колекції прибрано, verdict INCOMPLETE.

Причина в `benchmarks/external/production-path/core/query-via-search.mjs`:
wrapper покладається на старий implicit embedding default і не передає
cloudEmbed. Тести wrapper підставляють embedQuery та не перевіряють реальну
composition root. Вони тому проходять попри несправність live entry point.

Докази: `custom50-before.log`, `structural-before.json`, `structural-before.log`.
Explicit audit composition над тими самими production indexer/search
проходить structural на обох profiles; це локалізує проблему у benchmark wiring.

Потрібно: спільна benchmark runtime factory з explicit capabilities і close;
перевести всі entry points, додати live smoke для реального entry point та
offline composition test, що не підміняє саме місце wiring. Не повертати
process-wide embedding singleton задля сумісності бенчмарків.

### P1. Qrel validation перевіряє існування ID, але пропускає неправильну відповідь

Усі qrel IDs custom-50 існують у snapshot — поточна validation проходить.
Проте читання payload показує:

| Query | Еталон relevance=3 | Що реально містить еталон | Фактичний результат |
|---|---|---|---|
| c44: RERANK_PROTECT_TOP1_DELTA | config-env.md#9 | Опис config.json, потрібного параметра немає | Rank 1: config-env.md#7 з точним параметром і значенням |
| c38: SCHEMA_VERSION в embeddings.js | project-structure.md#4 | Опис src/core/config.js | Rank 2: project-structure.md#5 із поясненням SCHEMA_VERSION; qrel дає йому лише relevance=2 |
| c37: bench:custom50 / run-v3.js | project-structure.md#8 | Реєстрація MCP server | Expected exact chunk не відповідає запиту; rank 1–3 містять bench:custom50, але шлях runner треба добрати |
| c09: HYBRID_PREFETCH_LIMIT | qdrant.md#2 | Загальний опис RRF; параметра немає | Rank 1–2: таблиці з HYBRID_PREFETCH_LIMIT; current evaluator рахує miss |

Це не привід «підігнати відповіді під видачу». Потрібно незалежно переглянути
всі qrels і прив'язати їх до frozen corpus: content hashes, evidence spans,
section/node identity, версія chunker/indexing profile. Якщо один факт є у
кількох місцях, усі дійсні відповіді мають бути judged.

Не переносити labels через саму схожість номерів чанків. У repo є окремий
skeleton overlay, але default run-v3 не застосовує його; поточна collection
має legacy payload без skeleton identity. Overlay для іншого chunker також
не можна застосувати навмання.

Докази: `custom50-payload-snapshot.json`, `matrix-analysis.json` та qrels у
`benchmarks/retrieval/custom-50/queries.json`. Список token warnings — тільки
review hints; відсутність рядка сама по собі не доводить помилку розмітки.

### P1. INCOMPLETE benchmark може виглядати успішним для CI

Original structural live command закінчився exit code 0 при verdict INCOMPLETE
і шести query errors. CLI друкує state.verdict, але не встановлює exitCode.
Тому CI, що перевіряє лише process exit, пропустить фактично невиконаний eval.

Окремий gate gap: `isCompletedProfileRun()` не перевіряє
`queriesWithInsufficientDepth`. Відтворено offline: валідний profile block
із цим полем, зміненим на 3, усе ще повертає true.
Це не означає, що поточний pilot має depth failure; це прогалина validation.

Потрібно: fail exit на INCOMPLETE, перевірка coverage й finite metrics,
кількості виконаних queries, depth status; тест executable entry point.
Неповна глибина може бути окремим чесно позначеним результатом, але не
мовчазним COMPLETE для заявленого Recall@100.

### P2. П'ять службових round trips перед кожним search

`runHybridSearch()` викликає adapter.getCollection(), а та робить:

1. getCollections для existence;
2. getCollection для schema/profile;
3. scroll sample payload;
4. scroll skeleton root;
5. count content points;
6. лише після цього виконується search query.

На п'яти чергованих парах запитів з однаковими готовими векторами:

| Шлях | Час, min–max | Median | Qdrant calls |
|---|---:|---:|---:|
| Production core | 282–350 ms | 293 ms | 6 |
| Raw hybrid, ті самі vectors/filter/k/prefetch | 46–63 ms | 60 ms | 1 |

Це latency-only vector replay, без embedding. Паралельна індексація могла
вплинути на час; це не обіцянка прискорення у 5 разів під production load.
Але кількість зайвих round trips підтверджена незалежно від шуму часу.

Потрібно: легкий search-specific read, який перевіряє existence і live
profile/schema без dashboard enrichment. TTL/cache лише з явною invalidation
та fail-closed поведінкою при schema/model mismatch. Не прибирати перевірку
сумісності vectors і не кешувати профілі безстроково.

Доказ: `metadata-probe.json`; код — `src/core/storage/qdrant-adapter.js`,
метод getCollection, та `src/core/retrieval/search.js`.

### P2. NegativePassRate не вимірює утримання від відповіді

У custom-50 лише один negative запит — про PostgreSQL connection pool.
Search повертає MCP registration chunk із RRF score 0.032291666; positive
top-1 scores у цьому запуску лежать у межах 0.016666668–0.033333335.

Поточна negativePassRate перевіряє відсутність expected token у top-1 text,
а не рішення «відповіді немає», релевантність evidence або поведінку Ask.
Вона може дати 100%, коли всі negative запити повертають сторонні результати.
Сам по собі пошук сусідів не зобов'язаний повертати порожню видачу; проблема
саме в інтерпретації метрики як надійності answer policy.

Потрібні окремі retrieval-negative та Ask-abstention набори: невідомий факт,
неправильна версія, інший provider/environment, конфліктуючі джерела,
неповна таблиця, питання з хибною передумовою. Вимірювати false answer rate,
false refusal rate, evidence support і coverage, а не один score threshold.

Також `chunkRecall@K` у custom-50 — фактично Hit@K: «знайдено хоча б один
exact chunk», а не частка всіх релевантних чанків. В analysis обидві метрики
розділені; на dense@10 вони вже відрізняються. Для multi-evidence питань
потрібна ще all-required-evidence coverage.

### P2. Benchmark operating point відрізняється від реальної роботи агента

Production-path suite запитує 400 chunks, після чого collapse за документом
оцінює document-level metrics. MCP рекомендує top=3/window=1; Ask зазвичай
працює з набагато меншим набором evidence. Це різні задачі.

Додатково prefetch = max(top * multiplier, top + 1): зміна final top змінює
сам candidate pool. У матриці top=3 і перші 3 з top=50 відрізнялися у
15/49 positive queries. Частина перестановок має tied scores; цей аудит
не приписує всі зміни лише candidate depth і не доводить погіршення якості.

Потрібно оцінювати окремо: candidate recall, final ranking, evidence після
window/assembly/token budget, і готову відповідь. Порівнювати top=3/5/10 на
їхньому справжньому шляху, а не лише обрізати один top=400 run.

### P2. Доступ до сторонньої/legacy колекції дає низькорівневу помилку

Через справжній MCP stdio transport виконано collection_info → skeleton →
search для `Qdrant Web Documentation`. collection_info показує 18 828 points,
unknown provider і legacy_unmigrated. Skeleton/search натомість падають на
відсутньому keyword index point_kind, до зрозумілого повідомлення про profile.

Потрібно early compatibility validation і зрозумілий unsupported/migration
diagnostic. Не створювати індекси або не підбирати embedding model автоматично
в чужій collection. Документацію для цього аудиту прочитано з офіційного сайту.
Докази: `mcp-info.json`, `mcp-docs.json`.

## Діагностична матриця custom-50

**Ці значення не є валідною оцінкою якості через підтверджені qrel defects.**
Вони збережені, щоб відтворювати аудит; не використовувати як release baseline
або підставу змінювати defaults. Corpus не переіндексовувався.

| Mode | Hit@1 | Hit@3 | Hit@10 | Graded nDCG@10 |
|---|---:|---:|---:|---:|
| Production top=3, k=60 | 53.1% | 75.5% | — | — |
| Production top=10, k=60 | 51.0% | 75.5% | 85.7% | 0.6913 |
| Production top=50, оцінено перші 10 | 53.1% | 75.5% | 85.7% | 0.6896 |
| RRF k=2, top=10 | 55.1% | 75.5% | 87.8% | 0.7015 |
| Dense-only, raw Qdrant | 57.1% | 75.5% | 87.8% | 0.7044 |
| Sparse-only, raw Qdrant | 44.9% | 71.4% | 85.7% | 0.6469 |

Paired bootstrap (5000 resamples, 49 queries) для k=2 − k=60:
nDCG delta +0.0102, CI95 [-0.0112, +0.0314]. Dense − hybrid:
+0.0132, CI95 [-0.0254, +0.0521]. Навіть до виправлення labels це не дає
підстав оголосити k=2 або dense універсально кращими. CI тут exploratory:
немає held-out split, є multiple comparisons і семантичні label defects.

## Fresh production-path результати

Structural: 4 documents, 3 queries; Local і Cloud COMPLETE, zero query errors,
zero unmapped hits, cleanup confirmed. Document-level nDCG@10/Recall@10 = 1
для обох. Це plumbing/structural smoke, а не зовнішній доказ якості: усі
три питання стосуються одного релевантного документа, навколо лише 3 distractors.
Сама ця метрика не доводить, що повернувся точний рядок таблиці/коду.

SciFact pilot: **COMPLETE для обох profiles**, по 150 documents / 25 queries,
zero errors, zero unmapped hits, zero insufficient-depth queries; cleanup confirmed.
Офіційний cached SciFact archive перевірено за MD5, усі qrels references валідні.

| Metric | Local BGE-M3 ONNX | Cloud E5-small + BM25 |
|---|---:|---:|
| nDCG@10 | 0.9220 | 0.9252 |
| Recall@10 / @100 | 1.000 / 1.000 | 1.000 / 1.000 |
| MRR@10 | 0.8973 | 0.9000 |
| Query p50 / p95 | 379 / 464 ms | 428 / 588 ms |
| Indexing wall time | 186.3 s | 97.0 s |

Cloud − Local nDCG delta +0.0032, paired bootstrap CI95 [-0.0548, +0.0790],
2000 resamples. Різниця не підтверджена. Corpus subset побудований для timing
pilot із positive inclusion та deterministic unjudged padding, а не як
representative hard-negative benchmark. 100% Recall тут не означає 100%
на повному SciFact (5183 documents / 300 test queries).

Cloud telemetry: 474 dense + 474 sparse inference items для індексації,
25 + 25 для queries. Це обсяг операцій, не ціна в доларах.
Peak RSS sampler повернув null для обох profiles; memory usage не виміряно.
Частина Local indexing перетиналася з іншими audit probes, тому наведений
wall time не є контрольованим порівнянням швидкості Local/Cloud.

Документні metrics після 400 chunk candidates не перевіряють answer correctness,
обсяг контексту, що дістався LLM, або user-facing top=3. Generation не запускалася.

## Зіставлення з зовнішніми джерелами

1. Qdrant рекомендує перевіряти dense і sparse окремо, fusion, held-out queries
   та candidate pool. Default Qdrant k=2 не є доказом, що Semidex має перейти
   на нього. Є також різниця rank convention: paper k=60 відповідає Qdrant
   k=61; це уточнення документації, не причина мовчазного зміщення defaults.
   [Qdrant: How to Tune Hybrid Search](https://qdrant.tech/articles/how-to-tune-hybrid-search/).
2. Candidate depth і ANN search accuracy — окремі параметри. Потрібно
   порівнювати ANN із exact search та вимірювати ceiling candidate union;
   збільшення prefetch саме по собі не гарантує кращої відповіді.
   [Qdrant: Candidate Depth](https://qdrant.tech/articles/candidate-depth/),
   [Qdrant: Measuring ANN Recall](https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/).
3. BEIR потрібен для різнорідного zero-shot retrieval evaluation. Tiny internal
   corpus і SciFact pilot не заміняють оцінку на повному corpus та інших доменах.
   [BEIR paper](https://arxiv.org/abs/2104.08663).
4. Contextual retrieval треба оцінювати ablation на власних даних: contextual
   embedding, lexical representation, reranking і final context окремо.
   Чужі improvement percentages не переносяться на Semidex автоматично.
   [Anthropic: Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval).
5. Чим більше context, тим не обов'язково краще: важлива позиція evidence.
   Ця робота мотивує окремий final-context eval, але не доводить ту саму
   величину ефекту для поточних моделей Semidex.
   [Lost in the Middle](https://arxiv.org/abs/2307.03172).

## Що попередні результати вже дозволяють сказати

Це історичні вимірювання, не нові live runs цього аудиту:

- `benchmarks/external/results/2026-07-22-cross-dataset-fusion-diagnosis.md`:
  SciFact full local nDCG@10 dense=0.6380, sparse=0.6344, hybrid=0.6778.
  Отже, існує scope, де fusion давав виграш.
- `2026-07-23-slavic-belebele-benchmark.md`: Ukrainian dense=0.9372,
  hybrid=0.9274, CI включає нуль; Polish dense=0.9401, hybrid=0.9057,
  hybrid−dense CI [-0.0504,-0.0192]. Отже, fixed equal fusion не універсальне.
- Belebele — MRC-derived короткі passages, MIRACL тут pooled subset.
  Ці цифри не є результатом на довгих українських документах чи повному MIRACL.

Звідси потрібні явні retrieval policies й per-corpus evaluation, а не
автоматичне проголошення hybrid, reranker або contextualization кращим шляхом.

## Порядок покращень

1. **Зробити eval достовірним:** capability wiring, fail exit, frozen corpus,
   semantic qrel review, content hashes, окремі tuning/held-out sets.
2. **Прибрати службові calls із hot path:** зберегти profile/schema guards,
   заміряти до/після на однаковому режимі та під concurrency.
3. **Додати evidence-level evaluation:** точні рядки таблиць, code literals,
   multi-source coverage, version/provider scope, context після truncation.
4. **Розділити retrieval policies:** dense/sparse/hybrid і candidateLimit окремо
   від final top; протестувати k=2/60, інші values, DBSF/rerank тільки після
   виправлення labels, із baseline і незалежною валідацією.
5. **Розширити реальний корпус:** повний SciFact production path, held-out
   український набір, довгі Markdown/PDF, hard negatives, update/delete cases.
6. **Операційні gates:** latency p50/p95 під навантаженням, cold/warm окремо,
   RAM/token/cloud cost, index freshness, empty/no-answer behavior і CI smoke.

Повний 4-suite production run із попередньою оцінкою близько 5 годин не
запускався: спочатку локалізовано несправні entry points і labels. Масштабування
такого eval без ремонту дасть більше витрат, а не більш достовірний висновок.

## Артефакти

- `live-matrix.mjs`, `analyze-matrix.mjs`, `live-matrix.json`, `matrix-analysis.json`:
  відтворювана read-only матриця та analysis, hashes і complete status.
- `custom50-payload-snapshot.json`: точний snapshot корпусу для перевірки labels.
- `prodpath-explicit.mjs`, `structural-explicit.json`, `scifact-pilot-explicit.json`:
  поточний production path із explicit dependency wiring.
- `metadata-probe.mjs`, `metadata-probe.json`: трасування службових calls.
- `mcp-read.mjs`, `mcp-*-request.json`, `mcp-info.json`, `mcp-docs.json`: MCP evidence.
- `*-tests.log`, `smoke.log`, `custom50-before.log`, `structural-before.json`:
  перевірки й вихідні failure reproductions.

Для повторного запуску matrix потрібна та сама existing collection; зміна
payload/query hashes навмисно блокує resume. Для fresh pilot потрібні Qdrant
credentials і cached/downloadable embedding model; будуть створені й видалені
лише benchmark collections. Не запускати паралельно два production-path suites:
їхній поточний orphan sweep спільний для всього benchmark prefix.
