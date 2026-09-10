# Задача: відновити достовірність retrieval evaluation і скоротити службові запити пошуку

## Контекст і мета

Потрібно доопрацювати Semidex за результатами аудиту 2026-09-06. Основна мета:
зробити бенчмарки працездатними на поточному runtime, забезпечити достовірність
їхніх висновків та прибрати зайві Qdrant round trips із production search.

Потрібна реалізація з перевірками, а не лише новий план чи опис рекомендацій.
Працюй послідовними reviewable змінами. Дотримуйся AGENTS.md репозиторію.
У робочій копії є незакомічені зміни інших задач: перевір status і не перезаписуй їх.

Обов'язково прочитай:

- `benchmarks/retrieval/results/audit-2026-09-06/REPORT.uk.md`.
- `custom50-before.log`, `structural-before.json` у тому самому каталозі.
- `custom50-payload-snapshot.json`, `live-matrix.json`, `matrix-analysis.json`.
- `metadata-probe.mjs`, `metadata-probe.json`.
- `prodpath-explicit.mjs`, `structural-explicit.json`, `scifact-pilot-explicit.json`.

Audit scripts — діагностичні артефакти, не готовий production дизайн. Вони
демонструють проблему та працездатну explicit composition, але не повинні
замінити підтримувані benchmark entry points. Вихідні audit results не перезаписуй.

## Підтверджені проблеми

1. `benchmarks/retrieval/custom-50/run-v3.js` у skip-index режимі падає на c01:
   `no onnxEmbed capability available`. Викликає embedForSearch без capabilities.
2. `benchmarks/external/production-path/core/query-via-search.mjs` не передає
   актуальні embedding capabilities. Original structural smoke отримує по
   три embedding_failed на Local і Cloud; explicit audit composition проходить.
3. Original structural CLI повернув exit 0 при verdict INCOMPLETE.
   `isCompletedProfileRun()` також ігнорує queriesWithInsufficientDepth.
4. Custom-50 qrels проходять ID validation, але семантично не відповідають
   наявному корпусу. Приклади: c44 exact=config-env.md#9 про config.json,
   тоді як потрібний параметр є у #7; c38 exact=project-structure.md#4 про
   config.js, тоді як SCHEMA_VERSION пояснює #5. c37 та c09 також потребують
   перегляду. Не вважай перелік вичерпним.
5. `runHybridSearch()` викликає важкий adapter.getCollection(), який перед
   пошуком робить getCollections, getCollection, scroll sample, scroll skeleton,
   count content. Разом із query — шість послідовних звернень.
6. NegativePassRate custom-50 означає відсутність expected token у top-1,
   а не відмову від неправильної відповіді. ChunkRecall фактично є Hit@K.
7. Production-path eval із 400 chunk candidates та document collapse не
   вимірює якість user-facing top=3/5 і контексту після assembly/truncation.
8. `Qdrant Web Documentation` через MCP показується як legacy_unmigrated,
   але search/skeleton повертають низькорівневу помилку про point_kind index.

## Етап A. Полагодити benchmark runtime і статус завершення

### Реалізація

- Перевір підтримувані retrieval benchmark entry points із package.json та
  production-path runners. Склади таблицю: підтримується / історичний / зламаний.
  Не оголошуй старий script підтримуваним лише тому, що він імпортується.
- Винеси актуальну explicit capability composition у benchmark-owned factory
  і підключи її до підтримуваних runners. Забезпеч Local ONNX та Cloud шлях,
  а для Ollama — коректне wiring, без вимоги її доступності для інших profiles.
- Передавай dependencies per instance/per call. Не відновлюй process-wide
  singleton через applyEmbeddingCapabilities як спосіб обходу рефакторингу.
- Закривай створені ONNX/worker resources у finally; не запускай generation
  чи встановлення моделей приховано під час import/offline tests.
- CLI має повертати nonzero для INCOMPLETE/failed run. Помилка query не є
  порожньою успішною видачею і не повинна зникати з denominator як success.
- Зроби coverage/depth status явним. Для COMPLETE заявленої метрики мають
  виконуватися query-count, error, finite-metric, cleanup і depth gates.
  Якщо допустимий partial результат — він окремо позначений, без COMPLETE.
- Перевір resume/checkpoint: stored completed result не повинен проходити
  після зміни corpus/qrels/profile/evaluation contract або пропускати потрібні
  per-query дані для порівняння. Не розширюй ремонт за межі виявлених проблем.

### Приймання

- Тести охоплюють реальну composition boundary Local і Cloud, а не лише
  wrapper із fake embedQuery, який приховує відсутні dependencies.
- Є executable-level test: INCOMPLETE → nonzero exit.
- Є тести на query error, недостатню глибину, missing query та invalid metrics.
- Підтримуваний structural smoke проходить з CLI на обох profiles і прибирає
  власні колекції. Не використовуй audit wrapper як єдиний доказ виправлення.

## Етап B. Відновити ground truth і чесні метрики

### Реалізація

- Визнач, що саме вимірює кожен набір: legacy regression чи поточний production
  Markdown pipeline. Не порівнюй raw chunk indices різних chunkers як тотожні.
- Проведи семантичний перегляд усіх 50 custom-50 queries проти відповідного
  frozen corpus. Познач valid/incorrect/ambiguous/unanswerable із поясненням.
- Для кожної positive qrel зафіксуй evidence span/verification anchor та
  content hash. Врахуй альтернативні правильні джерела і питання, для яких
  потрібні кілька evidence units. Stable node ID корисний, але не замінює hash.
- Не виправляй labels за принципом «те, що повернув retriever, і є правильно».
  Спочатку визнач відповідь із corpus, потім перевіряй retrieval.
- Для ambiguous queries уточнюй intent або маркуй ambiguity; не видаляй
  складні запити, щоб покращити aggregate. Не перенось skeleton overlay
  автоматично на legacy collection.
- Додай manifest: corpus/query/qrel hashes, chunking/indexing/profile versions,
  config, runtime/code identity і точний шлях виконання. Skip-index повинен
  відхиляти несумісний корпус або чесно відокремлювати legacy scope.
- Назви метрики відповідно до формул: Hit@K окремо від Recall@K; вкажи gain
  convention для graded nDCG. Збережи compatibility aliases лише з явною
  позначкою, якщо старі consumers залежать від колишніх назв.
- Перейменуй/поясни token-based negative diagnostic. Не називай його
  abstention/no-answer quality. Додай корпус negative cases різних типів:
  невідомий факт, scope/provider/version mismatch, false premise, конфлікт
  джерел. Для кожного явно визнач, яку саме поведінку перевіряє тест.

### Приймання

- Є review table всіх 50 queries, versioned qrels і manifest.
- Пошкодження content при збереженому chunk ID більше не проходить validation.
- Відомі c44/c38/c37/c09 кейси перевірені за текстом corpus, а не rank.
- Ручні маленькі fixtures підтверджують Hit/Recall/nDCG і multi-evidence metrics.
- Старі audit цифри лишаються invalid-for-quality; новий baseline має новий
  version/hash. Не представляй зміну метрик через relabeling як покращення ranking.
- Переглянутий custom-50 є regression/tuning set, не незалежний held-out доказ.

## Етап C. Скоротити hot-path metadata overhead

### Реалізація

- Вивчи `src/core/retrieval/search.js`, `src/core/storage/qdrant-adapter.js`,
  profile resolution/cache і всі callers getCollection().
- Виділи легкий search-specific шлях existence/profile/schema resolution.
  Не виконуй dashboard enrichment (sample/skeleton/count) перед кожним search.
- Збережи guards: collection not found, invalid/missing profile, schema/model
  mismatch, unsupported provider, nav/entity_raw exclusion і source/tag filters.
- Визнач поведінку при collection delete/recreate, profile changes і invalidation.
  Спочатку прибери зайві операції; кеш не має приховувати несумісні vectors.
- Не змінюй RRF_K, prefetch multiplier, embeddings, reranker defaults або
  порядок ranking у цьому performance refactor.

### Приймання

- Spy/integration test рахує remote operations: немає sample/skeleton/count
  у звичайному search; запланований cold/warm call budget задокументований.
- Контрольоване before/after порівняння використовує ті самі vectors, filters,
  candidate pool і query mode. Не порівнюй raw dense з production hybrid як
  начебто це чиста різниця алгоритмів.
- На fixed corpus перевірені IDs/scores і score ties, а також error/filter
  contracts. Поясни допустиму нестабільність tie order, не маскуй її.
- Заміряй warm/cold p50/p95 окремо; для latency run не запускай одночасно
  CPU indexing. П'яти audit repetitions достатньо для діагнозу, не для SLA.
- Full/Lite/MCP/Search API та Ask retrieval path зберігають контракт.

## Етап D. Evidence-level перевірки й зрозумілі diagnostics

- Додай bounded eval для справжніх top=3/5/10. Candidate recall, final hit
  ranking, window/assembled evidence та document-level score звітуються окремо.
- На структурних fixtures перевір точний рядок таблиці, code identifier,
  checklist item і відповідні значення, а не тільки source document ID.
- Перевір evidence після compact window/token budget: що є в output зараз,
  а що доступне лише через get_chunk/get_content. Не зараховуй потенційно
  доступний сусідній чанк як уже доставлений LLM доказ.
- Додай multi-source питання та scope-sensitive/negative fixtures. Без
  live generation не роби висновків про answer correctness чи refusal quality.
- Забезпеч early compatibility diagnostic для legacy/foreign collections:
  зрозумілий typed error замість point_kind index failure, де це можливо
  встановити read-only. Різні tools можуть мати різні schema requirements:
  не блокуй валідне читання лише через відсутність можливості embedding search.
- `Qdrant Web Documentation` не мігруй, не індексуй повторно, не додавай їй
  payload indexes і не вгадуй model. Використай її помилку як reproduction,
  а тестову incompatible collection або mocks — для безпечної перевірки.

## Перевірки та live межі

1. Почни з targeted tests для змінених шарів і benchmark harness tests.
2. Після інтеграції виконай smoke, відповідні Full/Lite boundary/contract tests,
   strict client types і повний unit suite. Відділи попередні failures від нових.
3. Запусти справжній structural smoke і SciFact pilot (150 docs / 25 queries)
   для Local/Cloud; збережи raw per-query runs, errors, telemetry і cleanup.
4. Тимчасові collections і локальні config/cache повинні бути ізольованими.
   COLLECTION завжди явний; prune лише full root; не чіпай користувацькі дані.
5. Перевір scope cleanup: поточний production harness має global prefix sweep.
   Не запускай такі suites паралельно й не видаляй артефакти активного чужого run.
6. Для нового quality baseline використай виправлені versioned labels і
   задокументований corpus. Не підміняй ним незалежний тест.
7. Повний багатогодинний 4-suite run та масовий parameter/model sweep не потрібні
   для закриття цієї задачі. Спочатку мають пройти перелічені bounded gates.

## Зовнішня перевірка

Перевір актуальну первинну документацію для змінених механік:

- https://qdrant.tech/articles/how-to-tune-hybrid-search/
- https://qdrant.tech/articles/candidate-depth/
- https://qdrant.tech/documentation/search/hybrid-queries/
- https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/
- https://arxiv.org/abs/2104.08663

Зважай на підтримувану версію Qdrant. Default k=2 у документації не означає,
що його слід увімкнути в Semidex. Original-paper k=60 і Qdrant rank convention
треба описати коректно, але не змінювати config заради косметичної відповідності.
Переваги contextual retrieval/reranking з чужих benchmarks не є доказом для
цього корпусу. Нові ranking policies — окрема задача після ремонту evaluation.

## Що здати

- Реалізацію A–D з тестами й оновленими підтримуваними benchmark commands.
- Переглянуті qrels, review table та corpus/evaluation manifests.
- Before/after hot-path call counts і контрольовані latency measurements.
- Новий датований звіт із raw evidence, exact commands/config, пропусками й
  обмеженнями; live cleanup підтверджено.
- Список залишкових проблем за пріоритетом. Не називай задачу завершеною,
  якщо CLI знову дає false success, live runners не працюють або qrels не перевірені.

Ключове правило оцінки: розділяй «полагодили вимірювання», «прискорили виконання»
і «покращили релевантність». Це три різні результати, кожен потребує власного доказу.

## Доповнення 2026-09-07: не пропустити зовнішні набори

Прочитай `benchmarks/retrieval/results/audit-2026-09-06/EXTERNAL-ADDENDUM-2026-09-07.uk.md`
та `external-saved-verification-2026-09-07.json`.

- Custom-150 має 75 queries; включи його в inventory та перевірку label/corpus
  compatibility. Не заявляй, що semantic audit custom-50 автоматично покриває c150.
- Три зовнішні набори — BEIR SciFact, MIRACL Russian subset, Slavic/Belebele.
  Їхні document/passage-level докази зберігаються незалежно від стану custom-50.
- 39/43 saved configurations повторно підтверджені за raw TREC. Чотири
  SciFact cloud-native files містять лише 2 queries замість 300.
- Виправ smoke/full collision TREC paths у beir/run-scifact.mjs: нинішній
  JSON path розділений, а raw run paths — ні. Ізолюй raw runs за mode/run ID,
  додай manifest і regression test, що smoke не перезаписує full artifacts.
- Не відновлюй відсутні full raw runs із агрегатних JSON і не замінюй їх
  smoke даними. Познач їх unavailable до окремого потрібного rerun.
- У підсумку розділи provider retrieval, production evidence retrieval та
  answer quality. Не узагальнюй MIRACL Russian як Ukrainian evaluation;
  для української тут є окремий Belebele scope.
