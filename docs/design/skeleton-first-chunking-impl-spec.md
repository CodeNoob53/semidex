# Skeleton-first Chunking — Implementation Spec (MVP)

> Похідний від `skeleton-first-chunking.md` (design v3). Тут — **технічна
> специфікація**, не код: сигнатури, файли, payload-схема, індекси, прапор, тести,
> fixture і жорсткі обмеження. Реалізація йде потім, маленькими задачами (§11).
>
> Section-посилання (§N) вказують на **дизайн-док**, якщо не сказано інше.

---

## 0. Scope і non-goals

**In scope (MVP, етап 1):**

- AST-парсинг Markdown у дерево типізованих вузлів (`parseSkeleton`).
- Mapping `mdast → node_type → policy` + fallback нерозпізнаного в `paragraph`
  (design §5.1).
- Warnings-лог у JSONL, окремо від Qdrant (design §5.2).
- `applyNodePolicy` — призначення policy за типом (design §7.2).
- `chunkFromSkeleton` — проза в чанки, table/code/checklist в окремі content-вузли,
  плейсхолдери в parent prose (design §7, §11).
- `isContentBearing` — структурний gate проти порожніх чанків (design §7.3).
- `buildFileSkeleton` — file-level nav-вузли + JSON inspect-артефакт (design §9, §14).
- Розширений payload + нові Qdrant-індекси (`point_kind`, `node_type`).
- Прапор `SKELETON_CHUNKING=1`, legacy-шлях незмінний.

**Out of scope (НЕ робимо в цьому етапі):**

- Collection-level summary (design §19 крок 11).
- `qdrant_get_skeleton` / `qdrant_get_content` MCP-tools (design §15) — окремий етап
  після того, як skeleton-вузли стабільно пишуться.
- LLM-контекст рівнів для skeleton (design §12) — перший етап парсера працює
  **без LLM**.
- Callouts/admonitions (stage 1.5), images-OCR, math, footnotes.
- Codebase memory.

---

## 1. Прапор і збереження legacy-шляху

- Новий env-прапор: `SKELETON_CHUNKING` (`'1'` = увімкнено, інакше legacy).
- Точка розгалуження — `chunkFileFromPath()` у `src/indexer/phases/chunk.js`.
  Коли прапор увімкнено **і** `ext === '.md'` -> новий шлях `parseSkeleton` →
  `applyNodePolicy` → `chunkFromSkeleton`. Інакше — поточний `parseMarkdown`/
  `chunkSections` без змін.
- Не-Markdown (pdf, pandoc, txt) у MVP **завжди** йдуть legacy-шляхом, навіть із
  прапором (AST-стек — лише для Markdown).
- `parseMarkdown` (regex) **не видаляється** — лишається легасі-шляхом, доки flag не
  стане default (design §5). Default не перемикаємо в цьому етапі (§10).
- Контракт виходу нового шляху **сумісний за формою** з legacy: масив об'єктів-чанків,
  які далі проходять context/tag/embed/upsert. Додаткові поля (node_*, raw_content,
  point_kind) — адитивні; legacy-споживачі їх ігнорують.
- **`mergeChunks` НЕ є безпечним для skeleton-v1 «as is»** (див. §6) — поточна
  реалізація склеює `prev.text + current.text` і зберігає metadata лише від `prev`,
  що знищило б `node_id`/`raw_content`/`node_type`/`parent_id`. Тому новий шлях НЕ
  передає структурні вузли в наявний merge без правок (§6).

---

## 2. Нові / змінені файли

| Файл | Статус | Призначення |
|------|--------|-------------|
| `src/indexer/phases/skeleton.js` | **новий** | `parseSkeleton()` — remark AST → дерево вузлів |
| `src/indexer/phases/node-policy.js` | **новий** | mapping-таблиця + `applyNodePolicy()` + `isContentBearing()` |
| `src/indexer/phases/skeleton-chunk.js` | **новий** | `chunkFromSkeleton()` — вузли → чанки/content-вузли + плейсхолдери |
| `src/indexer/phases/skeleton-index.js` | **новий** | `buildFileSkeleton()` — file nav-вузли + JSON |
| `src/indexer/skeleton-warnings.js` | **новий** | writer для `skeleton-warnings.jsonl` |
| `src/core/node-id.js` | **новий** | `makeNodeId()` — стабільний hash вузла |
| `src/indexer/phases/chunk.js` | змінений | розгалуження за `SKELETON_CHUNKING` у `chunkFileFromPath` |
| `src/indexer/index.js` | змінений | payload-поля node_*, `point_kind`, `raw_content`; пропуск `isEmptySectionChunk`-guard для skeleton-v1 |
| `src/core/qdrant.js` | змінений | `createCollection` додає індекси `point_kind`, `node_type` |
| `src/sync.js` | змінений | `REQUIRED_INDEXES` += `point_kind`, `node_type` |
| `package.json` | змінений | dep: `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`; нові smoke-скрипти |

---

## 3. Сигнатури функцій

Усі функції — ESM-екпорти. Типи описано в JSDoc-стилі (проєкт без TS).

### 3.1 `parseSkeleton(markdown, ctx)` — `phases/skeleton.js`

```js
/**
 * Парсить Markdown у плоский упорядкований масив структурних вузлів (з parent-зв'язками).
 * Тільки парсинг + позиціювання. Без policy, без чанкінгу, без LLM.
 *
 * @param {string} markdown
 * @param {{ sourceFile: string }} ctx
 * @returns {SkeletonNode[]}  // у документному порядку, кожен із parentPath/ordinal
 */
export function parseSkeleton(markdown, ctx)
```

`SkeletonNode` (внутрішня форма, до policy):

```jsonc
{
  "mdastType": "table",            // сирий тип remark
  "nodeType": "table",             // наш тип після mapping (§5.1); "unknown" якщо нема
  "rawContent": "| ... |",         // точний вихідний текст вузла
  "text": "...",                   // плоский текст (для prose); для table/code = rawContent
  "lang": "bash",                  // лише code
  "headingPath": ["Linux","systemd"],
  "structuralPath": "install/table",   // для node_id, без ordinal
  "ordinalWithinParent": 1,
  "parentStructuralPath": "install",
  "position": { "startLine": 142, "endLine": 159, "order": 4 },
  "warning": null                  // або { kind, reason } якщо unknown/parse issue
}
```

- Heading відкриває секцію й оновлює `headingPath`; сам heading-вузол стає `section`.
- `frontmatter` (yaml) → `nodeType:"frontmatter"`, його дані передаються як `meta`.
- Нерозпізнаний block → `nodeType:"unknown"`, `warning` заповнюється; **текст
  зберігається** (стане paragraph на наступному кроці).
- **`rawContent` береться slice-ом з оригінального markdown** за
  `node.position.start.offset`/`end.offset` (remark дає offset-и), а **не**
  реконструюється з AST (stringify). Інакше «authoritative raw» непомітно перестане
  бути точним (втрата вирівнювання таблиць, оригінальних лапок, відступів коду).
  `parseSkeleton` тримає посилання на вихідний `markdown` саме для цього slice.

### 3.2 `applyNodePolicy(node)` — `phases/node-policy.js`

```js
/**
 * Призначає policy і фінальний point_kind вузлу за таблицею §5.1/§7.2.
 * Чиста функція, без сайд-ефектів.
 *
 * @param {SkeletonNode} node
 * @returns {SkeletonNode}  // + { policy, pointKind }
 */
export function applyNodePolicy(node)
```

- Таблиця mapping живе тут як єдине джерело істини (експортований `const NODE_POLICY`).
- `unknown` → policy `chunk_text`, pointKind `retrieval_content` (індексується як
  paragraph, design §5.1).
- `section`/`file`/`collection` → policy `nav_summary`, pointKind `skeleton_nav`.

### 3.3 `isContentBearing(node)` — `phases/node-policy.js`

```js
/**
 * Чи має вузол стати retrieval_content point. Єдиний gate проти порожніх чанків (§7.3).
 *
 * structural (table/code/checklist/image-ref) -> true (має raw_content/metadata).
 * prose (paragraph/list/blockquote) -> normalize(text) має >= MIN_CONTENT_TOKENS
 *   значущих токенів, де плейсхолдери [table node: ...]/[code block node: ...]
 *   та голі heading-рядки НЕ рахуються (§11-правило).
 *
 * @param {SkeletonNode} node
 * @returns {boolean}
 */
export function isContentBearing(node)
```

- `MIN_CONTENT_TOKENS` — env `MIN_CONTENT_TOKENS` (default 4), як інші пороги у
  `chunk.js` через `envInt`.
- placeholder-only prose → false (design §11, §7.3).

### 3.4 `chunkFromSkeleton(nodes, ctx)` — `phases/skeleton-chunk.js`

```js
/**
 * Перетворює вузли скелета у масив чанків, сумісний за формою з legacy chunkFile().
 * - prose (chunk_text): ріже по MAX_CHUNK_TOKENS (повторно вживає recursiveChunkText
 *   з chunk.js — НЕ дублювати логіку).
 * - table/code/checklist: один content-вузол, rawContent цілим; у parent prose
 *   вставляється плейсхолдер.
 * - section/file/collection: НЕ потрапляють у retrieval-вихід (це робота skeleton-index).
 * - проганяє isContentBearing: вузли, що не пройшли, не емітяться.
 *
 * @param {SkeletonNode[]} nodes
 * @param {{ sourceFile: string, meta: object, links: string[] }} ctx
 * @returns {Chunk[]}  // {text, section, source_file, meta, links, needsBoundaryCheck,
 *                     //  node_type, node_id, node_path, parent_id, heading_path,
 *                     //  raw_content, lang, point_kind, position, chunkIndex, totalChunks}
 */
export function chunkFromSkeleton(nodes, ctx)
```

- `chunkIndex`/`totalChunks` проставляються в кінці (як зараз `chunkFile`), щоб
  `deleteTrailingChunks` і legacy MCP-сумісність працювали. `chunk_index` deprecated,
  але присутній (design §6).
- `embedding_text` у MVP **не** будується тут (потребує context/LLM, design §8) —
  на першому етапі парсера embed-input лишається `context + text` як зараз; розведення
  `embedding_text` для table/code — окрема задача після LLM-контексту.

### 3.5 `buildFileSkeleton(nodes, ctx)` — `phases/skeleton-index.js`

```js
/**
 * Будує file-level nav-вузли (point_kind=skeleton_nav) + JSON inspect-артефакт.
 * MVP: тільки file + section summaries з ІНВЕНТАРЮ дітей (без LLM-summary —
 * summary = heading-текст / перші N символів, доки LLM-контекст не підключено).
 *
 * @param {SkeletonNode[]} nodes
 * @param {{ sourceFile: string, collection: string }} ctx
 * @returns {{ navPoints: NavNode[], json: object }}
 */
export function buildFileSkeleton(nodes, ctx)
```

- `navPoints` призначені для майбутнього окремого upsert із
  `point_kind:"skeleton_nav"`. У першій реалізації `buildFileSkeleton` пише тільки
  inspect JSON; Qdrant upsert дозволений лише після search-фільтра `point_kind`
  (див. §6 і §11).
- `json` пишеться в `.tmp/semidex-inspect/<collection>/<file>.skeleton.json` (inspect-only,
  не джерело істини, design §14).
- Collection-skeleton тут **не** будується (out of scope).

### 3.6 `makeNodeId(parts)` — `core/node-id.js`

```js
/**
 * Стабільний внутрішній id вузла. Стабільний при реіндексі незмінного файлу;
 * НЕ гарантований при структурних правках (design §6 — межі стабільності).
 *
 * node_id = uuidv5(collection \x00 sourceFile \x00 structuralPath \x00 nodeType \x00 ordinalWithinParent)
 *
 * @param {{collection, sourceFile, structuralPath, nodeType, ordinalWithinParent}} parts
 * @returns {string} uuid
 */
export function makeNodeId(parts)
```

- Повторно вживає `uuidv5` із `core/point-id.js` (винести спільний хелпер або
  імпортувати). Формат id-вузла відмінний від `makePointId`, щоб не плутати.

### 3.7 `logSkeletonWarning(event)` — `skeleton-warnings.js`

```js
/**
 * Append одного JSONL-рядка у .tmp/semidex-inspect/<collection>/skeleton-warnings.jsonl.
 * Лог НІКОЛИ не йде в Qdrant. Помилка запису логу не валить індексацію.
 *
 * @param {{ collection, source_file, kind, mdast_type, node_type, position, reason, raw_excerpt }} event
 */
export function logSkeletonWarning(event)
```

---

## 4. Payload-схема (skeleton-v1)

Адитивно до поточного payload (`text, context, section, source_file, tags, links,
chunk_index, total_chunks, file_hash, vector_size, ...meta`). Нові поля:

| Поле | Тип | Примітка |
|------|-----|----------|
| `point_kind` | keyword | `"retrieval_content"` \| `"skeleton_nav"` |
| `node_type` | keyword | table/code_block/paragraph/section/... |
| `node_id` | keyword | стабільний hash (§3.6) |
| `node_path` | keyword | readable `docs/f.md#install/table-1` |
| `parent_id` | keyword | node_id батька |
| `heading_path` | keyword[] | повний ланцюг заголовків |
| `raw_content` | text | повний оригінал (authoritative) |
| `lang` | keyword | лише code_block |
| `position` | object | `{start_line,end_line,order}` |
| `indexing_schema_version` | integer | НОВЕ, окремо від embedding (design §13) |
| `chunking_model` | keyword | лише `"skeleton-v1"` (legacy-точки поля НЕ мають) |

- **Legacy-точки не чіпаємо** — нові поля їм не додаються, бекфілу немає.
  `chunking_model` пишеться **тільки** для skeleton-enabled reindex (`"skeleton-v1"`).
- **Відсутність `chunking_model` = legacy.** Саме за цим розрізняємо точки/колекції;
  окремого значення `"legacy"` не вводимо (узгоджено з §1 і §6: legacy незмінний).
- На рівні колекції рішення про search-фільтр приймається за stored-meta
  `chunking_model` (записується при першому skeleton-reindex колекції), а не за
  кожною точкою — design §9.

---

## 5. Qdrant-індекси

- `createCollection` (`core/qdrant.js`) додатково створює payload-індекси:
  `point_kind` (keyword), `node_type` (keyword). Поточні (`source_file`, `tags`,
  `chunk_index`) лишаються.
- `REQUIRED_INDEXES` у `src/sync.js` += `point_kind`, `node_type` — щоб `npm run sync`
  добивав їх на наявні колекції (idempotent).
- Фільтр `point_kind="retrieval_content"` у пошуку — **окрема задача етапу MCP/search**,
  не в першій задачі. Спершу просто пишемо поле й індекс.

---

## 6. Точки інтеграції в `index.js`

- `chunkFileFromPath()` повертає чанки з новими полями (за прапором). Map у
  `pointsWithDense` додає нові payload-поля з `chunk.node_*`/`raw_content`/`point_kind`
  (з безпечними дефолтами для legacy: `point_kind ?? "retrieval_content"` лише коли
  поле є; для legacy не додавати взагалі).
- **Empty-section guard:** наразі `index.js` кидає помилку, якщо
  `isEmptySectionChunk` спрацював. Для skeleton-v1 порожніх не існує за побудовою
  (§7.3), тож guard для цього шляху **вимикається** (skip, якщо
  `chunking_model==="skeleton-v1"`). `empty-section.js` лишається для legacy.
- skeleton_nav nodes (з `buildFileSkeleton`) — **окремий** upsert-виклик зі своїми
  point-id (на базі node_id), щоб не плутати з content-точками. **Порядок критичний:**
  цей upsert підключається ТІЛЬКИ після того, як search-фільтр
  `point_kind="retrieval_content"` уже діє (§11 кроки 4→5→6). До того
  `buildFileSkeleton` пише лише `*.skeleton.json`, у Qdrant нічого не йде. Payload/
  ID-схему фіксуємо тут заздалегідь.
- `makePointId` для content-вузлів skeleton-v1 у MVP лишається на `chunkIndex`
  (сумісність із `deleteTrailingChunks`); `node_id` живе як окреме payload-поле.
  Перехід point-id на node_id — пізніший крок (потребує заміни trailing-cleanup).

---

## 7. Smoke tests (додати)

Скрипти в `package.json` (стиль наявних `smoke:*`), кожен — окремий node-файл,
**без Qdrant і без LLM** для першої задачі:

1. `smoke:skeleton-parse` — на фікс-наборі `.md` перевіряє, що `parseSkeleton`
   повертає очікувані `nodeType`/`headingPath`/`ordinal`; table/code не порізані;
   fenced code з `.!?` всередині лишається цілим (регресія проти `chunkBySentences`).
2. `smoke:skeleton-mapping` — кожен mdast-тип з §5.1 дає правильний `node_type`/
   `policy`; невідомий тег → `unknown` + warning, але текст присутній.
3. `smoke:skeleton-empty` — heading-only секція і placeholder-only prose НЕ дають
   content-вузлів (`isContentBearing=false`); структура лишається у nav.
4. `smoke:skeleton-warnings` — unknown/parse-подія пише рівно один JSONL-рядок із
   потрібними полями; лог не потрапляє у вихідні чанки.
5. `smoke:skeleton-legacy-intact` — з вимкненим прапором вихід `chunkFileFromPath`
   байт-у-байт як до змін (golden-snapshot на кількох файлах).

---

## 8. Benchmark-fixture (потрібен)

- Новий каталог `benchmarks/retrieval/skeleton/` з малим, але репрезентативним
  набором `.md`: таблиці (GFM), fenced code кількома мовами, task-lists, вкладені
  заголовки, heading-only секції, frontmatter, сирий HTML-блок (unknown).
- `qrel`-схема розширюється `node_id` (а не лише chunk). Нові метрики поряд із
  наявними `chunkRecall@5`/`windowRecall@5`: `tableRecall@K`, `codeRecall@K`
  (design §17). Окремий runner — **наступний** етап; зараз фіксуємо тільки fixture
  і формат qrel.
- Перевірка анти-регресії: skeleton_nav не з'являється в результатах пошуку
  (коли фільтр буде підключено).

---

## 9. Версіонування

- `indexing_schema_version` стартує з `3` (design §13). Зберігається у payload і
  stored-meta.
- `embedding_schema_version` (`SCHEMA_VERSION` у `core/embeddings.js`) **не чіпаємо** —
  вектор/провайдер не змінюються.
- Зміна chunking-моделі = нова indexing-версія; реіндекс skeleton-колекції повний
  (через `FORCE_REINDEX` або зміну `chunking_model` у meta).

---

## 10. Жорсткі обмеження (категорично НЕ робити)

- **No entity boost / no entities.js.** Жодних regex-сутностей, payload-полів
  `entities`/`doc_role`, бустів за ними. Це видалено й не повертається (design §0).
- **No regex shortcut.** Парсинг структури — лише AST (remark). Не «швидко regex-ом»
  для table/code/list — це і є борг, який ми прибираємо (design §5).
- **No default switch.** `SKELETON_CHUNKING` лишається opt-in; default-поведінка
  індексації не змінюється, доки бенчмарк не покаже виграш (design §19 крок 8).
- **No silent content loss.** Нерозпізнане завжди ембедиться як paragraph; помилка
  одного вузла не валить файл (design §5.2).
- **No LLM in parser stage.** Перша задача — суто структурна, без context/tag-викликів.
- **JSON не джерело істини.** `*.skeleton.json` — лише inspect (design §14).

---

## 11. Декомпозиція на задачі (порядок)

> Кожна задача — окремий маленький PR/запуск Claude. Перша навмисно без Qdrant і LLM.

1. **[ПЕРША] AST parser + mapping + warnings + isContentBearing.**
   Файли: `skeleton.js`, `node-policy.js`, `skeleton-warnings.js`, `core/node-id.js`.
   Плюс smoke 1–4 (§7). Без `chunk.js`-розгалуження, без Qdrant, без index.js.
   Чистий вхід `markdown` → вихід `SkeletonNode[]` з policy + warnings JSONL.
   Критерій приймання: smoke 1–4 зелені; table/code/fence цілі; unknown логуються
   й не губляться; порожні відсікаються gate-ом.
2. `chunkFromSkeleton` + плейсхолдери + розгалуження в `chunkFileFromPath` за прапором.
   Плюс smoke 5 (legacy intact) і smoke на плейсхолдери/placeholder-only.
3. Payload-розширення в `index.js` + індекси в `qdrant.js`/`sync.js` +
   `indexing_schema_version`/`chunking_model`. Вимкнення empty-guard для skeleton-v1.
4. `buildFileSkeleton` — **тільки `*.skeleton.json`** (inspect), **БЕЗ Qdrant upsert
   skeleton_nav**. Це знімає ризик протікання nav-вузлів у пошук, поки фільтр відсутній.
5. **Search-фільтр `point_kind="retrieval_content"`** (за `chunking_model` колекції,
   design §9) у всіх шляхах пошуку (`qdrant_search`, link/backlink). **Передумова**
   будь-якого upsert skeleton_nav.
6. Аж тепер — **upsert skeleton_nav** у Qdrant (після того, як фільтр уже діє).
7. Benchmark-fixture + qrel із `node_id` (без раннера).
8. (Пізніше, окремі етапи) MCP-tools
   `qdrant_get_skeleton`/`qdrant_get_content`, LLM-контекст рівнів + `embedding_text`
   для table/code, collection summary.

---

## 12. Відкриті дрібниці (підтвердити перед задачею 2+)

- `MIN_CONTENT_TOKENS` default — пропоную 4; фіналізуємо бенчмарком.
- Формат `node_path` slug для table/code: `#<section-slug>/<type>-<ordinal>`
  (напр. `#install/table-1`) — підтвердити.
- (Вирішено §4: бекфілу немає — `chunking_model` лише на skeleton-reindex, legacy =
  відсутність поля.)
