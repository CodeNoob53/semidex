# Skeleton-first Chunking — Design Spec (v3 draft)

> Статус: **draft v3**. Це нова **архітектура чанкінгу**, а не retrieval-фіча і не
> окремий "entity model" шар. Відкриті/відкладені рішення зібрані в §18 і §20;
> у тексті відкладені інлайн-пункти позначені `OPEN:`.
>
> Термінологія (зафіксовано):
> - **Skeleton-first Chunking** — нова модель чанкінгу.
> - **Structural node (вузол)** — одиниця, яку продукує чанкер: section, paragraph,
>   table, code_block, list, blockquote, image. "Entity" тут = structural node,
>   а НЕ regex-сутність і НЕ retrieval-буст.

---

## 1. Відправна точка (поточний код)

Pipeline одного файлу (`src/indexer/index.js`):

```
chunkFileFromPath()  -> parseMarkdown() -> chunkSections()   // phases/chunk.js
  -> deterministic finalization -> addContext()/tags           // phases/chunk.js, context.js, combined.js
  -> embedForIndex()  (dense = embed(context + text))
  -> upsertPoints()   (1 чанк = 1 Qdrant point)
```

Факти з коду, що формують дизайн:

1. `parseMarkdown()` ріже **лише за заголовками**; тіло секції зливається у плоский
   `section.text`. Таблиці/код/списки розчиняються в прозі й можуть бути порізані
   `chunkBySentences` (ріже по `.!?\n`, не знає про fenced code).
2. `heading_path` фактично однорівневий (`chunk.section` = лише найближчий заголовок).
3. 1 чанк = 1 point. У payload **немає** `node_type`, `node_id`, `parent_id`,
   `raw_content`, повного `heading_path`, `point_kind`.
4. Dense = embed(`context + text`) — контекст уже сильний сигнал; raw лишається в `text`.
5. Roadmap-принципи: *structure-aware chunking first-class*, *keep raw text
   authoritative*, *benchmark before defaults*, *make chunks inspectable*,
   *Qdrant — єдиний storage*.

---

## 2. Головний принцип

> **Skeleton-first Chunking — це нова модель чанкінгу. Структурні вузли — це те,
> що продукує чанкер. Скелет будується першим (для файлу і для колекції), і вже
> на його основі приймаються рішення: що різати на чанки, що зберігати в payload,
> що видаляти.**

Універсальність: таблиця є таблиця, code block є code block — жодних доменних
(Linux/semidex/код) правил у самій моделі.

---

## 3. Дві ролі скелета (ключове прояснення)

Скелет обслуговує **два різні шари**, які НЕ змішуються:

```
1. RETRIEVAL CONTENT LAYER      point_kind = "retrieval_content"
   - paragraph / prose chunks
   - table nodes
   - code_block nodes
   - list / checklist nodes
   -> шукаються через qdrant_search (default)

2. NAVIGATION / PROJECT MAP LAYER   point_kind = "skeleton_nav"
   - collection summary
   - file summaries
   - section summaries + інвентар дочірніх вузлів
   -> НЕ для default search
   -> доступ лише через skeleton-MCP-tool
```

Мета navigation-шару: модель не перечитує весь проєкт. Вона:

```
show collection skeleton  -> бачить N файлів і короткий опис кожного
  -> обирає файл -> show file skeleton -> секції + короткий опис
    -> обирає секцію -> get content nodes (chunks/table/code) всередині
```

Це mind-map / table-of-contents-with-summaries. **Navigation nodes — не результати
пошуку, це map nodes.** Це знімає ризик "section-summary засмічує search".

---

## 4. Цільовий pipeline

```
document
  -> parseSkeleton()        // AST (remark) -> дерево типізованих вузлів
  -> applyNodePolicy()      // тип вузла -> policy
  -> chunkFromSkeleton()    // prose -> chunks; table/code/list -> content nodes
  -> addContext()           // context по рівнях (collection/file/section/table/code)
  -> embed()                // embedding_text -> dense/sparse; raw_content у payload
  -> upsert content nodes (point_kind=retrieval_content)
  -> buildFileSkeleton() / buildCollectionSkeleton()
  -> upsert skeleton_nav nodes  +  JSON inspect-артефакт
     // Qdrant upsert for skeleton_nav happens only after search filters exclude nav nodes
```

| Фаза | Файл | Що робить |
|------|------|-----------|
| `parseSkeleton()` | новий `phases/skeleton.js` | remark AST -> дерево вузлів |
| `applyNodePolicy()` | новий `phases/node-policy.js` | тип -> policy |
| `chunkFromSkeleton()` | рефактор `chunkSections()` | prose->chunks, structural->nodes |
| `addContext()` | змінений `phases/context.js` | рівнева політика контексту |
| `buildFileSkeleton()` / `buildCollectionSkeleton()` | новий `phases/skeleton-index.js` | nav-вузли + JSON |

Усе під прапором `SKELETON_CHUNKING=1` поряд зі старим шляхом (узгоджено з
"benchmark before defaults").

---

## 5. Парсер — тільки AST

Однозначно AST, не regex (regex знов дасть борг на tables/task-lists/fences/
frontmatter). MVP-стек:

```
unified
remark-parse
remark-gfm          // tables, task lists, strikethrough, autolinks
remark-frontmatter  // YAML frontmatter
```

`parseMarkdown()` (regex) лишається для legacy-шляху, доки flag не стане default.

### 5.1 Розпізнавання вузлів (mapping + fallback)

Чітка таблиця "тип AST-вузла remark → наш node_type → policy". Це єдине місце,
де визначається, що ми знаємо в MD і як з ним поводимось:

| mdast тип (remark) | наш node_type | policy | примітка |
|--------------------|---------------|--------|----------|
| `heading` | section (відкриває) | `nav_summary` | формує heading_path |
| `paragraph` | paragraph | `chunk_text` | |
| `text` (loose) | → paragraph | `chunk_text` | remark сам коерсить вільний текст у paragraph |
| `table` (gfm) | table | `payload_raw_embed_context` | |
| `code` (fenced) | code_block | `payload_raw_embed_context` | + `lang` |
| `list` / `listItem` | list / checklist | за §7 | task-list → checklist |
| `blockquote` | blockquote | за розміром | |
| `image` / `imageReference` | image | `future_processor` | §10 |
| `yaml` (frontmatter) | frontmatter | `payload_metadata_only` | |
| `thematicBreak` | — | `drop` | роздільник, не контент |
| `html` (raw block) | **unknown** | див. нижче | |
| `math`, `footnote*`, `definition`, callout | **unknown** | див. нижче | поза MVP (§7.1) |

**Fallback-політика (зафіксовано):**

- **Нічого не губимо.** Будь-що нерозпізнане — вільний/інлайн текст, raw `html`, math,
  callout, будь-який вузол поза mapping — **за замовчуванням стає `paragraph` /
  plain text** (retrieval_content) і **ембедиться як завжди**. Тобто текст завжди
  потрапляє в пошук, незалежно від того, помилка це чи ні.
- **Паралельно** факт нерозпізнавання **обовʼязково логується** (§5.2) — окремо, у
  файл, **у базу лог не потрапляє**. Тобто індексація і лог — два незалежні потоки:
  контент → Qdrant як paragraph; warning → JSONL.
- Мета логу: накопичити статистику реальних unknown-вузлів на нашій базі → потім
  свідомо розширювати mapping (callouts у stage 1.5 тощо), а не вгадувати наперед.
  Лог не впливає на те, що індексується.

### 5.2 Обгортка чанкування + логування

`parseSkeleton()` і `applyNodePolicy()` працюють під обгорткою, яка ніколи не валить
індексацію цілого файлу через один проблемний вузол:

```
for each node:
  try:
    map node -> node_type -> policy
    if node_type == "unknown":
      record warning            // окремий лог-потік
      index as paragraph        // АЛЕ контент усе одно ембедиться
  catch err:
    record warning { reason: err.message }
    index raw text as paragraph // навіть при помилці контент не губимо
    continue
```

Лог — **окремий JSONL inspect-артефакт**, НЕ в Qdrant:

```
.tmp/semidex-inspect/<collection>/skeleton-warnings.jsonl
```

Один рядок = одна подія:

```jsonc
{
  "source_file": "docs/guide.md",
  "kind": "unknown_node" | "parse_error",
  "mdast_type": "html",
  "node_type": "unknown",
  "position": { "start_line": 88, "end_line": 92 },
  "reason": "no mapping for mdast type 'html'",
  "raw_excerpt": "<div class=...>",        // обрізаний, для очей
  "chunking_model": "skeleton-v1"
}
```

Призначення: після індексації ми відкриваємо JSONL, бачимо що саме не розпізналось,
як часто, в яких файлах — і ухвалюємо, що додати в mapping чи як виправити. Це
інструмент аналізу, не runtime-залежність.

---

## 6. Модель вузла (розведені text / raw_content / embedding_text)

Критична правка: зараз `text` одночасно є і embed-input, і display, і raw.
У skeleton-моделі їх розводимо:

```jsonc
{
  "point_kind": "retrieval_content",       // або "skeleton_nav"
  "node_type": "table",
  "node_id": "a1b2c3d4...",                // СТАБІЛЬНИЙ internal id = hash(...), див. нижче
  "node_path": "docs/guide.md#install/table-1",  // human-readable, може мінятись при редагуванні heading
  "node_index": 12,                        // порядковий серед вузлів
  "chunk_index": 12,                       // DEPRECATED у skeleton-v1, лише legacy MCP-сумісність
  "source_file": "docs/guide.md",
  "parent_id": "<node_id батьківської секції>",
  "heading_path": ["Linux", "systemd", "Autostart"],  // людська навігація
  "position": { "start_line": 142, "end_line": 159, "order": 4 },
  "policy": "payload_raw_embed_context",
  "lang": "bash",                          // лише code_block

  "text": "...",            // те, що бачить/показує агент (для table/code = raw або bounded)
  "raw_content": "| Directive | Meaning |\n|---|---|\n| ExecStart | ... |",  // ПОВНИЙ оригінал, authoritative
  "embedding_text": "...", // те, що РЕАЛЬНО пішло в embedding (див. §8)
  "context": "Таблиця директив unit-файлу systemd (ExecStart, Restart).",
  "surface_terms": ["Directive", "ExecStart", "Restart"],

  "tags": [...], "links": [...],
  "total_chunks": 285, "file_hash": "...", "vector_size": 1024,
  "indexing_schema_version": 3,            // НОВЕ, окремо від embedding schema
  "chunking_model": "skeleton-v1",         // НОВЕ
  "dense_provider": "...", "sparse_provider": "..."
}
```

Правила:
- `raw_content` — **завжди authoritative**, LLM його не змінює.
- **Розведення id (важливо):** slug у `node_path` ламається при редагуванні heading,
  тому він НЕ є ключем. Стабільний ключ — `node_id`:
  ```
  node_id   = hash(source_file + structural_path + node_type + ordinal_within_parent)
  node_path = "docs/file.md#install/table-1"   // readable, для агента/дебагу
  heading_path = ["Linux","systemd",...]        // human navigation context
  ```
  Qdrant/links/parent_id працюють по `node_id`; агент бачить `node_path`.
- **Межі стабільності `node_id` (чесно зафіксовано):** `node_id` стабільний при
  **повторній індексації незмінного файлу** (identical reindex). Він **НЕ
  гарантований при структурних правках** — вставка нового sibling-вузла вище зсуває
  `ordinal_within_parent` і змінює `node_id` усіх наступних вузлів. Для MVP це
  прийнятно (реіндекс файлу і так перебудовує його піддерево). `OPEN:` якщо
  codebase-memory потребуватиме **довгоживучих посилань** через правки — додамо
  content-fingerprint / line-range стратегію поверх `node_id` (окремий дизайн).
- **`chunk_index` deprecated для skeleton-v1**, існує лише для сумісності зі старими
  MCP-tools. Нові tools мусять використовувати `node_id`. (Інакше агенти/тести
  далі мислять chunk-only.)

---

## 7. Типи вузлів і policy

### 7.1 MVP scope (етап 1)

```
section  paragraph  table  code_block  list  blockquote  image  frontmatter
```

Поки НЕ чіпаємо: `math, footnotes, html_block, definition, callout/admonition`.
(Callouts важливі для Obsidian, але багато варіантів синтаксису — stage 1.5.)

### 7.2 Policy enum + матриця

| policy | Сенс | Embed | point_kind |
|--------|------|-------|------------|
| `chunk_text` | проза, ріжеться як зараз | text | retrieval_content |
| `payload_raw_embed_context` | raw у payload, embed = context+terms+excerpt | §8 | retrieval_content |
| `nav_summary` | summary-вузол навігації | summary | skeleton_nav |
| `payload_metadata_only` | метадані | ні | (у skeleton) |
| `drop_with_placeholder` | прибрати тіло, лишити placeholder | ні | — |
| `future_processor` | відкласти (OCR), лишити node+metadata | ні | skeleton_nav |
| `merge_with_parent` | приєднати до батька | — | — |

| Тип | Policy MVP | point_kind | Коментар |
|-----|-----------|-----------|----------|
| paragraph | `chunk_text` | retrieval_content | як зараз |
| **section** | `nav_summary` | **skeleton_nav** | НЕ retrieval-point у MVP |
| table | `payload_raw_embed_context` | retrieval_content | raw цілою |
| code_block | `payload_raw_embed_context` | retrieval_content | + `lang`, не різати по реченнях |
| list (prose) | `chunk_text` | retrieval_content | |
| list (checklist/steps) | `payload_raw_embed_context` | retrieval_content | кроки не зливати |
| blockquote | `chunk_text` / `payload+context` за розміром | retrieval_content | |
| image | `future_processor` | skeleton_nav | див. §10 |
| frontmatter | `payload_metadata_only` | — | як зараз `meta` |
| **unknown** | `chunk_text` (як paragraph) + log | retrieval_content | §5.1/§5.2: ембедиться як paragraph, паралельно логується |
| file | `nav_summary` | skeleton_nav | file summary |
| collection | `nav_summary` | skeleton_nav | collection summary |

Конфлікт із v1 усунено: **section не дає retrieval-point**, лише nav-вузол.

> **Не плутати два розміри:** розмір прозового чанка (`chunk_text`, скільки токенів
> у paragraph-чанку) — окремий параметр, який ще підбираємо бенчмарком. `boundedRaw`
> 200/300/**400** (§8) стосується лише *excerpt у `embedding_text`* для table/code,
> а не розміру прозового чанка. У коді — різні константи.

### 7.3 Порожні чанки — структурне рішення (не пост-фільтр)

Зараз порожні/heading-only чанки прибирає `empty-section.js` — це **пост-фільтр
(костиль)**: ми спершу робимо поганий чанк, а потім ловимо й викидаємо. У
skeleton-моделі порожнеча зникає **за побудовою**, бо джерело проблеми зникає:

1. **Heading-only більше не може стати retrieval-точкою.** Заголовок без тіла — це
   `section` -> `nav_summary` -> `skeleton_nav` (§7.2). Секція ніколи не є
   retrieval-point. Тобто головне джерело порожніх чанків (секція = лише заголовок
   або лише підзаголовки) усувається самою моделлю, а не фільтром.
2. **Єдиний gate емісії.** content-вузол (`retrieval_content`) **створюється тоді й
   лише тоді**, коли проходить предикат:
   ```
   isContentBearing(node):
     structural (table/code/checklist/image-ref) -> true (має raw_content / metadata)
     prose (paragraph/list/blockquote)
       -> normalize(text) має >= MIN_CONTENT_TOKENS значущих токенів
          (після зняття whitespace, самотніх пунктуаційних/маркерних символів,
           голих heading-рядків)
   ```
   Не пройшов -> **point не створюється взагалі** (не доходить до `upsert`), а не
   «створили й відфільтрували».
3. **Структура не губиться.** Навіть якщо секція не дала жодного content-вузла, вона
   лишається у nav-шарі (`skeleton_nav`) зі своїм summary і `children` — агент бачить
   її в скелеті, але вона не засмічує пошук.
4. **Порожнє після вилучення table/code.** Якщо параграф складався лише з таблиці/коду
   (які пішли в окремі вузли, §11), залишковий прозовий вузол часто стає порожнім —
   той самий gate його не емітить; лишається тільки плейсхолдер у тексті секції.

Наслідок: `empty-section.js` для skeleton-v1 **не потрібен** — нема що
пост-фільтрувати. `MIN_CONTENT_TOKENS` — єдиний параметр, фіксуємо бенчмарком
(стартове значення мале, напр. 3–5 значущих токенів).

---

## 8. embedding_text для table/code (не чистий summary)

Ризик: embed лише summary -> втрата exact terms (колонки, ключі, команди). Але
BGE-M3 dense+sparse генерується з одного input, тож MVP робимо простим і безпечним:

```
embedding_text =
  context
  + "\n\nKey terms:\n" + surface_terms.join(", ")
  + "\n\nRaw excerpt:\n" + boundedRaw(raw_content)   // обмежений, не вся гігантська таблиця
```

- `surface_terms` — заголовки колонок / ключі / імена команд (sparse leg їх ловить).
- `boundedRaw` — **не одне число для всього**: стратегія залежить
  від `node_type`, бо для коду критично не обрізати посеред логічного блоку:
  ```
  default       = 200 токенів
  table         = 300 токенів (або до кінця рядка таблиці)
  code_block    = 400 токенів або до першої safe boundary (кінець функції/блоку)
  ```
  `boundedRaw(raw, node_type)` -> різні стратегії.
- `raw_content` у payload завжди повний.

> `OPEN:` пізніше можна розвести dense-input (context+terms) і sparse-input
> (context+raw), коли/якщо перейдемо на роздільні input-и. Для MVP — один `embedding_text`.

---

## 9. Navigation nodes (skeleton_nav)

```jsonc
{
  "point_kind": "skeleton_nav",
  "node_type": "section",
  "node_id": "guide.md#sec-3",
  "source_file": "docs/guide.md",
  "heading_path": ["Linux", "systemd", "Autostart"],
  "summary": "Section about enabling services at boot and configuring unit files.",
  "children": [
    "guide.md#sec-3/paragraph-1",
    "guide.md#sec-3/table-1",
    "guide.md#sec-3/code-1"
  ]
}
```

- file nav-вузол: `node_type=file`, `summary=file_context`, `children=[секції]`.
- collection nav-вузол: `node_type=collection`, `summary`, `children=[файли]`.
- Контекст рівня collection генерується рідко / інкрементально.

**Default `qdrant_search` фільтрує `point_kind = "retrieval_content"` — але не глобально й не наосліп**:

```
For skeleton-v1 collections (chunking_model = "skeleton-v1"):
  default search filters point_kind = "retrieval_content".
For legacy collections without chunking_model / point_kind:
  default search keeps current behavior (no filter).
```

Рішення про фільтр приймається за `chunking_model` колекції (з config / stored meta),
а не за наявністю поля в окремій точці. Це треба як payload-index на `point_kind`
(як зараз tags/section) + умовний фільтр у `core/qdrant.js`. skeleton_nav ніколи
не з'являється в звичайному пошуку на skeleton-v1 колекціях.

> У специфікацію прямо: *Skeleton nav nodes are not search results. They are map
> nodes, accessed through skeleton MCP tools, not default qdrant_search.*

---

## 10. Images

Не повний drop:

```
image node лишається в skeleton
raw/base64 тіло прибирається
alt / title / path / hash лишаються
policy = future_processor   (OCR пізніше = ще один processor, не міграція моделі)
```

---

## 11. Parent prose placeholder

table/code вилучаються з тексту батьківського prose-чанка й замінюються
осмисленим плейсхолдером (контекст без дублювання raw):

```
[table node: guide.md#sec-3/table-1 — directives and meanings]
[code block node: guide.md#sec-3/code-1 — example service startup command]
```

**Правило (зафіксовано):** плейсхолдер — НЕ контент. Якщо після вилучення table/code
прозовий вузол складається **лише з плейсхолдерів** (нема значущого тексту поза ними),
`isContentBearing` (§7.3) повертає false і вузол **не створює `retrieval_content`
point**. Плейсхолдери при підрахунку значущих токенів ігноруються. Це не допускає
появи search-чанків типу `[table node: ...]` — тобто нового шуму. Плейсхолдер живе
тільки всередині тексту змістовного prose-чанка або при anchored-збірці (§15.1),
де він розгортається назад у raw.

---

## 12. Контекст по рівнях

(не на кожен paragraph — економія LLM; зараз `addContext` б'є по кожному чанку):

| Рівень | Контекст? |
|--------|-----------|
| collection | так, рідко/інкрементально |
| file | так |
| section (nav) | так (summary) |
| table | так |
| code_block | так |
| list/checklist (значущий) | так |
| paragraph | **ні** (text = embedding_text) |

---

## 13. Версіонування схеми (розведено)

Зміна payload-полів сама по собі не вимагає bump `embedding_schema_version`.
Але зміна point-моделі / point IDs / embedding-input / chunking-behavior вимагає
нової **indexing** schema. Тому:

```
embedding_schema_version  -> лишається для vector/provider compatibility
indexing_schema_version: 3   -> НОВЕ: point model + chunking behavior
chunking_model: "skeleton-v1"
```

---

## 14. Storage / source of truth

```
Qdrant = source of truth (content nodes + skeleton_nav nodes)
JSON skeleton artifact = inspect/debug only, НЕ правда
```

Жорстко: JSON ніколи не стає другим джерелом істини.

---

## 15. Retrieval і MCP

1. Default `qdrant_search` -> тільки `retrieval_content`. Результат містить
   `node_type`, `raw_content` (повна таблиця/код), `parent_id`, `heading_path`.
2. Новий skeleton-tool — **один tool з явним контрактом**:
   ```
   qdrant_get_skeleton(collection, source_file?, node_id?, depth=1, include="summary")
   ```
   - без аргументів -> collection map (файли + summary);
   - `source_file` -> file map (секції + summary);
   - `node_id` -> children цього вузла;
   - `include` керує обсягом, щоб агент не тягнув зайве:
     ```
     summary | children | content_refs | all
     ```

### 15.1 Збірка секції / файлу цілим (anchored context expansion)

**Сценарій:** після `qdrant_search` агент знайшов чанк, але контексту замало. Він
хоче прочитати **всю секцію (або файл), у якій знайшовся цей чанк**, як цілісний
документ, а не мозаїку. Tool реконструює контент з content-вузлів за `parent_id` +
`position.order`:

```
qdrant_get_content(collection, anchor_node_id, scope="section"|"file",
                   max_tokens=<бюджет агента>, cursor=null, format="text")
```

- `anchor_node_id` — вузол із результату пошуку (звідки розширюємось).
- `scope="section"` -> склеює content-вузли секції-батька якоря в порядку `order`;
  `scope="file"` -> весь файл, секція за секцією.
- `format`: `text` (готовий Markdown) | `nodes` (масив вузлів з метаданими).
- Це **не пошук** — детермінована збірка вже проіндексованих вузлів. Skeleton_nav
  вузли не включаються; беремо `retrieval_content` + їх `raw_content`, плейсхолдери
  таблиць/коду розгортаються назад у raw.

**Нюанс «секція/файл більша за вікно агента» — вирішується вікном навколо якоря, а
не дампом усього:**

- Агент **завжди передає свій `max_tokens`**; tool ніколи не повертає більше.
- Якщо весь scope влазить у бюджет -> повертається цілим.
- Якщо ні -> повертається **вікно, відцентроване на якорі**: сам якірний вузол +
  сусіди за `order` в обидва боки, доки не вичерпано бюджет. Якір позначений
  (`anchor: true`).
- Відповідь несе курсори розширення:
  ```jsonc
  {
    "items": [...],            // вузли у порядку order
    "anchor_node_id": "...",
    "total_tokens": 8200,      // скільки важить увесь scope
    "returned_tokens": 3900,
    "has_more_before": true,   // є вузли до вікна
    "has_more_after": true,    // є вузли після
    "cursor_before": "...",    // тягнути попередній блок
    "cursor_after": "..."      // тягнути наступний блок
  }
  ```
- Агент гортає `cursor_before`/`cursor_after` рівно стільки, скільки треба — контроль
  обсягу лишається в нього, а не «все або нічого».

Збірка і вікно можливі саме тому, що §6 зберігає `parent_id`, `position.order` і
повний `raw_content` — нічого не перечитуємо з диска.

### 15.2 Ліміти і пагінація скелета (великі колекції)

Колекція на тисячі файлів НЕ повертається одним викликом, і **ніколи не повертається
одразу з контекстом/summary всіх рівнів**. Правила:

- **Дешево за замовчуванням.** `qdrant_get_skeleton` без `node_id` повертає лише
  верхній рівень (директорії або файли), `include="summary"` дає максимум один рядок
  на вузол. Повні summary/children тягнуться тільки на запит, по вузлу.
- **Пагінація обовʼязкова** на будь-якому рівні з дітьми:
  ```
  qdrant_get_skeleton(..., limit=50, offset=0)
  -> { items: [...], total: 3412, next_offset: 50 }
  ```
  default `limit` невеликий (напр. 50); агент гортає сам.
- **Глибина обмежена.** `depth=1` за замовчуванням — лише прямі діти. Рекурсивний
  дамп усього дерева заборонений; глибше — окремими викликами по `node_id`.
- **Групування для масштабу.** Якщо файлів багато, верхній рівень — це **директорії**
  (`qdrant_list_directories` вже існує), а не плаский список тисяч файлів. Агент
  спускається директорія -> файли -> секції.
- **Бюджет відповіді.** Tool ріже відповідь за приблизним токен-бюджетом і повертає
  `truncated: true` + `next_offset`, щоб агент не отримав мегабайтну відповідь.
- Контекст рівня collection (§9) лишається рідкісним/інкрементальним і **не** входить
  у дефолтну видачу скелета — тільки `include="all"` явно.

---

## 16. Зв'язок із codebase memory

Це і є фундамент: модель спершу читає **карту** (collection skeleton), потім
drill-down, а не перечитує весь проєкт.

- code-вузли: `file -> symbol -> function/class -> code_block` (ті ж механізми).
- collection skeleton = карта проєкту; зв'язки між вузлами мають будуватися
  поверх skeleton-моделі, а не через старий file-level graph.
- інкрементальність (roadmap: "refreshes only changed files"): `file_hash` уже є;
  при зміні файлу перебудовуємо лише його піддерево.
- codebase memory — окремий наступний дизайн-док поверх стабільної skeleton-моделі.

---

## 17. Прогнозований результат

- Кращий пошук по таблицях/коду (не розмазані, не обрізані; raw цілий у payload).
- Зникають порожні/heading-only чанки структурно (не через `empty-section.js`, §7.3).
- Агент отримує карту проєкту -> drill-down без читання всього.
- Після пошуку агент може розширити контекст до цілої секції/файлу вікном навколо
  якоря (§15.1), не впираючись у вікно контексту.
- Кращі відповіді на "де показано / яка команда / що означає колонка/параметр".
- Менша залежність від якості LLM-контексту (структурний тип — сильний сигнал).
- Більше points, але типізовані й розділені шари (search vs nav).
- **Новий benchmark**: розширити qrel-схему `node_id`, додати `tableRecall@K`/
  `codeRecall@K` поряд із `chunkRecall@5`/`windowRecall@5`. Перевірити, що
  skeleton_nav не протікає в search (фільтр `point_kind`).

---

## 18. Ризики / відкриті питання

- `boundedRaw` довжина N (§8).
- `MIN_CONTENT_TOKENS` поріг для `isContentBearing` (§7.3) — підібрати бенчмарком.
- `node_id` формат і стабільність (розширення `makePointId`).
- Дедуплікація: гарантувати, що структурний вузол вилучено з parent prose (§11).
- Вартість контексту — рівнева політика (§12) + `COMBINED_LLM`.
- Backward-compat: `point_kind`-фільтр треба додати в усі шляхи пошуку
  (`qdrant_search`, link/backlink) перш ніж вмикати nav-вузли.
- Обсяг `unknown`-вузлів на реальній базі невідомий — спершу логуємо (§5.2),
  потім розширюємо mapping за статистикою, а не наосліп.
- `qdrant_get_content` (§15.1): курсорна модель вікна навколо якоря — узгодити
  формат курсора з токен-бюджетом, щоб не було перетину/пропусків між сторінками.

> **Нагадування про скор:** payload (raw_content/context/tags) НЕ впливає на скор
> гібридного пошуку — скор рахується тільки з векторів (dense+sparse, RRF). Контекст
> впливає лише через те, що потрапило в `embedding_text` (§8). Payload читає вже
> rerank-стадія (`rerank.js`), не сам пошук.

---

## 19. Поетапний план

1. Зафіксувати MVP-scope вузлів (§7.1) і матрицю policy (§7.2).
2. `parseSkeleton()` (remark) за `SKELETON_CHUNKING=1`, поряд зі старим шляхом.
   Включає mapping-таблицю (§5.1) + обгортку з warnings-JSONL (§5.2) з першого дня —
   щоб одразу збирати статистику unknown-вузлів.
3. Payload-розширення (§6) + payload-index на `point_kind` і `node_type`.
   Ввести `indexing_schema_version` + `chunking_model`.
4. **Умовний фільтр `point_kind=retrieval_content`** за `chunking_model` (§9), legacy не ламати.
5. content nodes: table/code/list policy + placeholder у parent prose (§11) +
   `isContentBearing` gate (§7.3) — порожні взагалі не емітяться, `empty-section.js`
   вимикається для skeleton-v1.
6. **File skeleton** (file summaries) як JSON-артефакт (inspect).
7. Новий benchmark-fixture (таблиці/код) + qrel із `node_id` + `tableRecall`/`codeRecall`.
8. Виміряти vs baseline -> тільки потім рішення про default.
9. skeleton_nav nodes + `qdrant_get_skeleton` (file-level drill-down) з пагінацією
   (`limit/offset`, `depth=1`, токен-бюджет, групування по директоріях — §15.2).
10. `qdrant_get_content` — anchored збірка секції/файлу з вікном навколо якоря (§15.1).
11. **Collection summary** — лише після того, як file summaries стабільні
    (інакше одразу тягнемо aggregation/incremental-update складність).
12. Callouts/admonitions — **stage 1.5** (не stage 1, але й не ігноруються назавжди:
    важливі для Obsidian-бази; багато варіантів синтаксису -> окремий процесор).
13. Codebase memory — окремий дизайн-док.

---

## 20. Зафіксовані рішення

1. **`boundedRaw` по типах (§8)** — default 200 / table 300 / code 400 токенів.
   `code_block` ріжеться **тільки по safe boundary** (кінець функції/блоку), ніколи
   посеред логічного блоку.
2. **`node_id` = stable hash**, `node_path` = readable (§6) — прийнято.
3. **Навігація і читання — різні tools:** `qdrant_get_skeleton` з
   `include = summary | children | content_refs | all` (§15) для карти; окремий
   `qdrant_get_content` (§15.1) для anchored-збірки секції/файлу з вікном.
4. **File-level skeleton достатній** для першого codebase-memory експерименту;
   collection summary — пізніше (§19 крок 11).
5. **Порожні чанки — структурно (§7.3):** єдиний `isContentBearing` gate на емісії
   point, без пост-фільтра `empty-section.js`.
