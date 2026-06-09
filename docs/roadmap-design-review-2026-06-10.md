# Ревізія роадмапу та дизайн-плану — 2026-06-10

Обсяг: `docs/en/roadmap.md` (2026-05-31), `docs/design/skeleton-first-chunking.md` (v4 draft), `docs/design/skeleton-first-chunking-impl-spec.md`, суміжні design-доки та ADR. Усі твердження звірені з фактичним кодом `src/` (див. також `docs/code-review-2026-06-10.md`).

## Підсумок

Роадмап — рідкісно чесний і добре структурований: dependency-ordered замість календаря, явні exit-гейти, явні non-goals, послідовний принцип «benchmark before defaults». Skeleton-дизайн зрілий, ключові ризики (порядок «фільтр → nav upsert», збереження legacy, межі стабільності `node_id`) продумані. Знайдено: один суттєвий пропуск у специфікації (reindex-детекція не знає про `chunking_model`), один пропуск покриття фільтром (`point_kind` лише для search, але не для list-tools), кілька внутрішніх суперечностей між документами та прямий звʼязок із багами з кодової ревізії, які варто закрити **до** старту skeleton-задачі №1.

Перевірено по коду: skeleton-робота ще не починалась (немає `remark`/`unified` у залежностях, немає `skeleton.js`/`node-policy.js`) — отже всі зауваження дешево виправити зараз, на рівні документів.

---

## A. Що добре (і що варто зберегти)

- **Roadmap ↔ код: shipped baseline точний.** Усі пункти «Shipped baseline» підтверджені кодом: hash-skip, детерміністичні point ID, `PRUNE_STALE`, 7 MCP-tools, doctor, reranker default-off, реальний BGE-M3 token counting. Жодних завищених заяв.
- **Порядок «search-фільтр → лише потім upsert skeleton_nav»** повторюється консистентно в трьох місцях (roadmap queue 5–6, design §9, impl spec §11 кроки 5–6). Це головний анти-ризик «nav-сміття в пошуку», і він зафіксований жорстко.
- **Impl spec §1 правильно ловить небезпеку `mergeShortChunks`** для структурних вузлів (склейка знищила б `node_id`/`raw_content`) — це саме той клас багів, який легко пропустити.
- **`rawContent` через offset-slice оригіналу, а не AST stringify** (spec §3.1) — критично правильне рішення для «authoritative raw».
- **Декомпозиція spec §11** (перша задача — чистий парсер без Qdrant/LLM) — мінімізує радіус вибуху.
- **Explicit non-goals** і таблиця conditional research із тригерами — захищає від scope creep.

---

## B. Суттєві пропуски

### B1. 🔴 Reindex-детекція не побачить перемикання на skeleton

Spec §9: «Зміна chunking-моделі = нова indexing-версія; реіндекс повний (через `FORCE_REINDEX` або зміну `chunking_model` у meta)». Але **порівняльний кортеж у `stageA` (`src/indexer/index.js:57–67`) не включає ані `chunking_model`, ані `indexing_schema_version`** — він знає лише `chunking_schema_version` + `token_count_mode`. Наслідок: увімкнення `SKELETON_CHUNKING=1` на вже проіндексованій колекції дасть `✓ unchanged, skipping` для всіх незмінних файлів — skeleton-реіндекс мовчки не відбудеться, колекція стане сумішшю legacy/skeleton точок без жодного попередження.

**Фікс у spec:** задача 3 (payload-розширення) має явно включати: (а) додати `chunking_model` / `indexing_schema_version` у `getStoredMeta` і в умову skip stageA; (б) smoke-тест «toggle прапора → файл реіндексується».

### B2. 🟠 `point_kind`-фільтр специфіковано лише для search, але не для list-tools

Spec §11 крок 5: фільтр «у всіх шляхах пошуку (`qdrant_search`, link/backlink)». Але навігаційні tools теж постраждають від nav-точок:

- `qdrant_list_files` (`aggregateFiles`) рахує `chunkCount` за **усіма** точками з `source_file` — nav-вузли (які мають `source_file`) завищать лічильники і зіпсують `minChunkIndex`/`firstSection`;
- `qdrant_list_directories` — те саме для `chunkCount` на директорію;
- `qdrant_get_chunk`/`fetchWindowChunks` — захищені лише випадково (nav-вузли, ймовірно, без `chunk_index`).

**Фікс у spec:** крок 5 розширити: «фільтр/виключення `point_kind != "skeleton_nav"` у всіх scroll-агрегаціях (listFiles, listDirectories, listTags), а не лише в search» — як передумова кроку 6.

### B3. 🟠 Подвійне версіонування: `indexing_schema_version` vs наявний `chunking_schema_version`

Дизайн §13 вводить **новий** `indexing_schema_version: 3`, але код **уже має** `chunking_schema_version = 3` (`token-count.js`, у payload і reindex-детекції). Жоден документ не каже, як вони співіснують: чи `indexing_schema_version` замінює `chunking_schema_version`, чи живуть паралельно, і хто з них бере участь у skip-порівнянні. Збіг початкових значень (обидва = 3) гарантує плутанину.

**Фікс:** одна явна таблиця в spec §9: поле → що версіонує → чи входить у reindex-кортеж → що відбувається зі старим полем. Найпростіше: `indexing_schema_version` поглинає `chunking_schema_version` (нове поле, старе лишається тільки в legacy-точках).

### B4. 🟡 MVP-бенчмарк виміряє не той дизайн, який описано

Spec §3.4: у MVP `embedding_text` для table/code **не** будується — embed лишається `context + text` (де text = повний raw таблиці/коду). Але рішення «вмикати default чи ні» (roadmap queue 10, spec §11 крок 8 → design §19 крок 8) ухвалюється за результатами саме цього MVP-бенчмарку. Тобто гейт оцінює skeleton **без** ключової retrieval-механіки §8 (context + surface_terms + boundedRaw) — і може хибно показати «виграшу нема».

**Фікс:** або (а) включити `embedding_text` у scope перед вимірюванням default-гейта, або (б) у roadmap/spec явно записати: «MVP-бенчмарк = гейт лише на не-регресію; default-рішення відкладене до задачі embedding_text». Зараз це неоднозначно.

---

## C. Внутрішні суперечності документів

| # | Де | Суперечність | Пропозиція |
|---|----|--------------|------------|
| C1 | spec заголовок | Impl spec: «Похідний від design **v3**», але дизайн уже **v4 draft**. Невідомо, чи всі правки v4 враховані в spec. | Перевірити diff v3→v4 і підняти посилання; додати в обидва доки дату узгодження. |
| C2 | design §7.2 vs spec §3.3 | Policy-таблиця: `image` → `future_processor` → **skeleton_nav**. Але `isContentBearing` каже: «structural (table/code/checklist/**image-ref**) → true» — тобто image-ref наче content-bearing. Як написано — двозначно: чи консультується gate для `future_processor`-вузлів взагалі? | У spec уточнити: `isContentBearing` застосовується лише до вузлів із `pointKind=retrieval_content`; прибрати image-ref з його переліку. |
| C3 | roadmap Stage 2 vs spec §0 | Roadmap відносить payload-поля (`point_kind`, `node_type`, `node_id`, …) і фільтр до **Stage 2**, а impl spec кладе їх у **Stage 1** (задачі 3, 5). Near-term queue (items 3, 5) узгоджений зі spec, тобто сам roadmap внутрішньо суперечить собі між секцією Stage 2 і queue. | У Stage 2 лишити тільки те, чого нема в queue 1–7: MCP-tools (`qdrant_get_skeleton`/`qdrant_get_content`), LLM-summaries, collection map. |
| C4 | design §6 vs §9 | §6: `node_id` = «hash(...)» (uuid). §9 у прикладі nav-вузла: `node_id: "guide.md#sec-3"` — це формат `node_path`, не `node_id`. | Виправити приклад §9 — інакше перша ж реалізація скопіює неправильний формат. |
| C5 | roadmap research table vs design §21 | «Literal payload search — Deferred» (roadmap) і «Grep-буст по raw_content» (design §21 Stage 2) — одна ідея у двох місцях без перехресного посилання і з різним статусом. | Звести в одну позицію з одним тригером. |

---

## D. Гігієна статусів документів

- `docs/design/pipeline-redesign-and-deterministic-chunking.md` — статус «draft for implementation planning», але описане **вже реалізовано** в коді: `PIPELINE_MODE`, stage A–D, `Semaphore`/`SerialQueue`, детерміністичний merge без LLM. Оновити до «implemented decision record» (як зразково зроблено в `bge-m3-token-aware-chunking-plan.md`) — інакше док виглядає як невиконана робота.
- Два ADR із номером 0005 (`0005-entity-boost-opt-in` Accepted і `0005-entity-indexing-benchmark-first` Superseded) — індекс це пояснює, але нумерація колізійна; superseded-файл краще перенумерувати або позначити в імені.
- Roadmap: «Near-term Execution Queue» дублює spec §11 у скороченому вигляді — два джерела істини для порядку задач. Достатньо одного речення з посиланням на spec §11.

---

## E. Звʼязок із кодовою ревізією (порядок робіт)

Знахідки з `code-review-2026-06-10.md` напряму впливають на план:

1. **CRLF-баг (№1) закрити ДО skeleton-задачі №1.** Дві причини: (а) `smoke:skeleton-legacy-intact` — golden-snapshot legacy-виходу: якщо знімати снапшот зараз, **баг буде заморожений як еталон**; (б) remark нормалізує CRLF коректно, тож legacy-vs-skeleton бенчмарк на Windows-корпусі дасть skeleton нечесну фору — конфаунд у головному default-гейті.
2. **`LLM_BATCH_SIZE`-guard (№2) — теж до старту.** Skeleton збільшує кількість точок на файл; сценарій «порожній результат → стерти точки файлу» стає дорожчим.
3. **Необмежена конкуренція stageA у pipeline-режимі (№9)** — узгоджується з §6 pipeline-redesign-доку («Profiling Requirements»); якщо док оновлюється до implemented-статусу, цей пункт варто перенести в його «Open Questions» або в роадмап.
4. **Full-scan list-tools (№12)** — skeleton помножить кількість точок («Більше points», design §17), тож `scrollAllPoints`-агрегації подорожчають пропорційно. Разом із B2 це аргумент додати у Stage 3 вимірювань: «латентність list-tools до/після skeleton».

## F. Дрібниці

- Design §17.1 (mind map, codebase intelligence, автодокументація) — гарний vision, але за обсягом і тоном це вже roadmap-матеріал; у дизайн-доку він розмиває MVP-фокус. Перенести у `roadmap.md` Track B/D або у design §21.
- Stage 3 вимірює throughput/LLM cost/Qdrant ops, але не **обсяг payload**: skeleton-v1 зберігає `text` + `raw_content` + (пізніше) `embedding_text` — потенційно ×2–3 до розміру колекції. Додати storage-метрику в Stage 3.
- Track A (Assistant Runtime) фактично не залежить від skeleton (HTTP answer API працюватиме і на legacy-чанках). Якщо зʼявиться потреба показати продуктову цінність раніше — roadmap дозволяє це чесно розщепити, варто лише прибрати формулювання «share Stages 1–3» для Track A.
- `MIN_CONTENT_TOKENS` default: spec §3.3 каже 4, spec §12 — «пропоную 4», design §7.3 — «3–5». Дрібне, але зафіксувати одне число.

## Вердикт

План реалістичний і добре впорядкований; головні архітектурні ризики продумані. Перед стартом skeleton-задачі №1 рекомендую: закрити B1 (reindex-детекція — інакше тихий змішаний стан колекцій), розширити B2 (фільтр для list-tools), вирішити B3 (версіонування) і виправити CRLF у legacy (п. E1). Суперечності C1–C5 — правки на годину, але вони запобігають тому, щоб перша реалізація скопіювала помилковий приклад.
