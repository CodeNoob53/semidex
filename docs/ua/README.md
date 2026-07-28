# semidex

Інші мови: [English](../en/README.md)

![semidex](../../assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-local%20embeddings-blue?logo=onnx&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**semidex — це експериментальний local-first retrieval і grounded-answer
runtime для AI-агентів та застосунків, які працюють із документацією
користувача.**

Ви індексуєте власну бібліотеку знань — внутрішні інструкції, регламенти,
документацію продукту, наукові чи навчальні матеріали, технічні специфікації — і
semidex дає AI-агентові набір MCP-інструментів, щоб знаходити релевантні фрагменти,
читати сусідній контекст, досліджувати структуру бібліотеки, ходити за зв'язками та
перевіряти джерело **перед** тим, як відповісти.

Є два способи використання цієї бази знань. Через **MCP** зовнішній агент сам
керує пошуком. Через **Ask runtime** semidex сам виконує retrieval, збирає
обмежений доказовий контекст і формує відповідь із посиланнями на джерела. Саме
Ask є майбутнім інтеграційним шляхом для консультантів на сайтах, Telegram-ботів,
внутрішніх порталів і власних застосунків розробників; чат в адмін-панелі — лише
еталонний клієнт цього runtime, а не межа продукту.

## Статус оцінки

semidex уже працює як retrieval-MVP, але ще не є готовою платформою для
асистентів або доведено кращою альтернативою іншим RAG-рішенням. Поточні
бенчмарки — це внутрішні regression-тести: вони допомагають порівнювати зміни
semidex із попередньою поведінкою самого semidex.

Перед заявами про конкурентні переваги потрібні окремі кроки: якісна
демо-колекція, зовнішні датасети та пряме порівняння релевантних сценаріїв із
альтернативними рішеннями. Запланований зовнішній retrieval-гейт включає BEIR,
MIRACL (мови, які датасет реально підтримує — MIRACL НЕ містить українську;
російський/кириличний прогін є доказом лише multilingual-спроможності, а не
якості для української) та MLDR; якість для української мови все одно
потребує окремого, спеціально зібраного українського датасету. Локальний
BGE-M3 і Qdrant Cloud inference мають тестуватися на однакових корпусах,
qrels і метриках. Для Ask окремо
вимірюються citation precision/recall, покриття тверджень доказами, коректність
відмови, latency і вартість.

## Яку проблему вирішує semidex

Звичайна LLM не знає ваших приватних, доменних або актуальних даних — і коли їх
бракує, схильна вигадувати відповіді. Завантажувати всю бібліотеку в чат —
дорого, повільно і часто небезпечно (приватний текст іде у зовнішній сервіс).

semidex розв'язує це так: бібліотека індексується один раз, а агент під час відповіді
дістає **релевантні фрагменти** — з можливістю перевірити їх джерело. Це дає моделі
опору на вашу документацію і зменшує ризик здогадок; повної гарантії точності немає —
агент усе ще може помилятися, тому джерело лишається доступним для перевірки.

## Як це працює для користувача

1. Ви вказуєте папку з документами і запускаєте індексацію.
2. semidex готує матеріали до retrieval (розбиває на чанки, додає короткі резюме
   й опційні теґи) і складає у векторну базу Qdrant.
3. Ви або під'єднуєте semidex як MCP-сервер до свого AI-агента, або викликаєте
   Ask runtime зі свого застосунку.
4. MCP-агент сам керує інструментами; Ask runtime виконує визначений retrieval
   workflow і повертає streaming-відповідь із citations.

**Поточна модель використання MCP-агентом:**

- **Classic RAG** — фіксований конвеєр: `query → retrieve → augment → generate`.
  Один пошук, один набір чанків, одна відповідь.
- **MCP-agent workflow** — агент **сам вирішує**, які інструменти викликати:
  може зробити кілька кроків пошуку й навігації, переглянути структуру бібліотеки,
  дочитати сусідній контекст і зібрати достатньо матеріалу, перш ніж відповісти.

**Чесне позиціонування:** сам підхід не унікальний — локальні RAG-індексатори,
Qdrant-backed MCP-сервери та agentic retrieval існують і поза semidex. Внесок
semidex — конкретна комбінація (повністю локальний конвеєр, read-only
MCP-інструменти, skeleton-навігація структурою документів, дефолти лише через
бенчмарк-гейт) плюс окремі нечасті рішення на кшталт детермінованого
structural carryover. Заяв про перевагу над іншими RAG-системами немає —
докази для них ще не зібрані.

## Приклади застосування

- *(частково реалізовано; інтеграція в roadmap)* **Консультант на сайті**, який
  відповідає клієнтам за затвердженою документацією продукту, показує джерела і
  відмовляється відповідати без достатніх доказів.
- *(roadmap)* **Telegram-бот або внутрішній портал**, під'єднаний до того самого
  публічного Ask API без повторної реалізації retrieval-логіки.
- **MCP-помічник** для команди, яка працює з регламентами, інструкціями та базами знань.
- **Асистент для наукової чи навчальної бібліотеки**.
- **Локальний помічник** для приватних документів, які не можна віддавати в хмару.
- **Технічний асистент** для специфікацій та інструкцій з експлуатації.
- *(roadmap)* **Codebase Memory** — пам'ять про великі та legacy-репозиторії коду.

## Що вже реалізовано

- індексація документів: основний формат — `.md`; інші формати приймаються з
  частковою підтримкою через нативний plain-text шлях або конвертацію;
- tokenizer-aware chunking (межі за реальним токенайзером BGE-M3);
- локальна генерація context через Ollama; теґи опційні (`TAG_GEN=1` або `backfill:tags`);
- гібридний пошук dense + sparse з RRF-fusion;
- skeleton-first chunking (безумовно для Markdown, архітектура, не опція):
  таблиці, блоки коду й чеклісти як типізовані структурні чанки +
  skeleton-навігація для агентів;
- 11 read-only MCP-інструментів;
- версіонований, stateless Ask API: `POST /api/v1/ask`, hybrid retrieval,
  обмежене складання evidence, нативні system-інструкції провайдера,
  генерація через Ollama або Gemini, SSE-streaming, citations
  і cite-or-refuse поведінка (ще не автентифіковано, не для прямого
  публічного доступу);
- сховище: локальний Qdrant **або** Qdrant Cloud;
- повністю локальний режим (без зовнішніх API для контенту);
- SHA-256 skip — незмінені файли не переобробляються;
- `PRUNE_STALE` — прибирання точок для видалених файлів;
- verified-платформа: **Windows 10/11**.

Стабільний публічний Ask API, cloud-провайдери, SDK/widget, Telegram-адаптер,
auth, sessions, OCR, Agent Memory і Codebase Memory — це
[дорожня карта](#дорожня-карта), а не готові можливості.

## Local-first і приватність

semidex спроєктований так, щоб **могти працювати повністю локально**. Чесна картина:

- **Повністю локальний контур можливий:** Ollama + ONNX + локальний Qdrant +
  локальний MCP-сумісний агент. У цьому режимі текст документів не виходить за межі
  машини.
- **Зовнішній агент** (Claude Code, Codex чи інший MCP-клієнт, у т.ч. хмарний) можна
  під'єднати. Тоді цей агент отримує **лише знайдені чанки** з відповіді на запит, а
  не весь корпус.
- **Qdrant Cloud — опційний.** Якщо ви свідомо берете його замість локального Qdrant,
  чанки і вектори зберігаються у вашому хмарному інстансі.
- **Зовнішні API для embeddings і генерації контексту зараз НЕ реалізовані** — це
  roadmap (профіль semidex Lite). Сьогодні ці фази локальні.

## Підтримка платформ

Перевірена end-to-end підтримка наразі — **лише Windows 10/11** (Node.js + ONNX
Runtime на CPU або DirectML, Ollama на доступному GPU-backend).

**Linux і macOS — експериментальні / неперевірені.** CPU-шлях і Node.js-залежності
мають бути переносними, а Ollama може використовувати CUDA/Metal, але це очікувані
можливості, а не гарантія підтримки до тестування на фізичному залізі. Детальна
матриця: [docs/en/configuration.md](../en/configuration.md#platform-support).

## Технічна архітектура

Чотири шари пошуку (під капотом):

1. **Dense-вектори** — нейронні ембединги передають сенс; допомагають знаходити перефразування й міжмовні запити.
2. **Sparse-вектори** — лексичні ваги допомагають знаходити точні терміни, ідентифікатори, env-змінні, назви функцій.
3. **RRF fusion** — Reciprocal Rank Fusion об'єднує обидва ранжування, щоб жоден не домінував. Це **основний шлях пошуку**, а не опція.
4. **Reranker** — опційний локальний детермінований постпроцесор (вимкнений за замовчуванням; див. обмеження).

Конвеєр індексації:

```
Документи (md, txt, pdf, docx, odt, rtf, epub, html)
  │
  ├─ [1] Chunk          — заголовки → речення; межі за токенайзером BGE-M3
  ├─ [2] Contextualize  — локальний LLM пише 1–2 речення резюме чанку в контексті документа
  ├─ [3] Tag            — опційні payload-теґи (`TAG_GEN=1` або `backfill:tags`)
  └─ [4] Embed + Upsert — dense + sparse вектори → Qdrant named vectors + payload
         │
         ▼
    Колекція Qdrant (dense · sparse · text · context · section · tags · source_file)
         │
         ▼
    MCP-інструменти (11) ── AI-агент отримує знайдений контекст
```

Markdown завжди парситься через AST (архітектурна константа, не налаштування):
таблиці, блоки коду й чеклісти стають типізованими структурними чанками,
контекст будується детерміновано (без LLM-викликів), а окремий шар
`skeleton_nav`-точок живить навігаційні інструменти `qdrant_get_skeleton*`.

Вектор обчислюється з `context + text` разом, тому LLM-резюме може допомогти
знайти короткий фрагмент коду за природномовним запитом.
Під час запиту MCP-сервер ембедить запит **тим самим провайдером**, що й при індексації.

## Швидкий старт

### 1. Встановлення

```bash
npm install
cp .env.example .env
```

У Windows PowerShell замість `cp` використовуйте
`Copy-Item .env.example .env`. Приклад env-файлу за замовчуванням налаштований
на локальний Qdrant. Для Qdrant Cloud замініть `QDRANT_URL` і `QDRANT_KEY`
значеннями зі сторінки вашого кластера.

### 2. Запуск Qdrant

Qdrant Cloud або локально:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Провайдер ембедингів

**Рекомендовано — ONNX-режим** (найсильніший із перевірених режимів semidex для
української та змішаних мовних даних):

```bash
# у .env:
ONNX_EMBED=1
# модель bge-m3-onnx (~2.3 ГБ) завантажиться один раз у ./models/. Ollama для ЕМБЕДИНГІВ не потрібен.
```

```bash
# context phase still requires Ollama + CONTEXT_MODEL (default gemma3:4b), even in ONNX mode:
ollama pull gemma3:4b
```

**Fallback — Ollama для всього** (легкий, мінімальне налаштування):

```bash
ollama pull bge-m3        # dense ембединги
ollama pull gemma3:4b     # LLM для контексту; також для теґів, якщо TAG_GEN=1
```

> **Важливо:** Ollama має бути **запущена** і модель `gemma3:4b` витягнута в **обох**
> режимах — бо контекст генерує локальний LLM
> через Ollama. `ONNX_EMBED=1` прибирає Ollama лише з фази ембедингів, не з
> context. Теґи вимкнені за замовчуванням; увімкніть `TAG_GEN=1`, якщо потрібні
> `qdrant_list_tags`, `qdrant_find_by_tag` або tag-фільтри.

### 4. Створення колекції та індексація

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs/
```

Окрема команда для створення колекції не потрібна. Якщо `my-docs` ще не існує,
індексатор автоматично створить колекцію Qdrant із named-векторами `dense` і
`sparse`, потрібними payload-індексами та відповідним записом у `config.json`.
Повторний запуск тієї самої команди оновлює змінені файли й пропускає незмінені.

`npm run sync` варто запускати після оновлення semidex або для вже наявних
віддалених колекцій. Команда безпечна для повторного запуску, але не потрібна
перед першою індексацією нової колекції.

### 5. Реєстрація MCP

MCP-сервер можна під'єднати до Claude Code, Codex або іншого MCP-сумісного агента.
Агент може бути хмарним або повністю локальним. Перевірений приклад нижче наведено
для Claude Code.

**Windows:**
```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

**Linux / macOS (експериментально):**
```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Перепідключіть сервер у Claude Code і виконайте `/mcp` для перевірки.

## MCP-інструменти та workflow

semidex надає 11 read-only інструментів:

| Інструмент | Аргументи | Опис |
|------------|-----------|------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?`, `window?`, `window_format?` | Гібридний пошук (dense + sparse + RRF) з фільтрами та контекстним вікном |
| `qdrant_collection_info` | — | Список колекцій з кількістю точок, провайдером, описом |
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Один чанк (+опційні сусіди) за точним розташуванням |
| `qdrant_get_skeleton` | `collection` | Кореневий вузол skeleton-карти колекції та його діти |
| `qdrant_get_skeleton_node` | `collection`, `node_id?` XOR `node_path?` | Один навігаційний skeleton-вузол із резюме та зв'язками |
| `qdrant_get_skeleton_children` | `collection`, `node_id?` XOR `node_path?`, `limit?` | Дочірні skeleton-вузли |
| `qdrant_get_node` | `collection`, `node_id?` XOR `node_path?`, `preview_chars?` | Повний оригінальний вміст структурного вузла (таблиця, блок коду тощо) |
| `qdrant_find_by_tag` | `collection`, `tag?`, `tags?[]`, `match?`, `limit?` | Чанки за теґом/теґами, згруповані за файлом |
| `qdrant_list_directories` | `collection`, `source_prefix?`, `depth?`, `limit?` | Префікси директорій з кількістю файлів/чанків |
| `qdrant_list_files` | `collection`, `source_prefix?`, `tags?[]`, `tag_match?`, `limit?` | Унікальні файли з кількістю чанків і першою секцією |
| `qdrant_list_tags` | `collection`, `source_prefix?`, `tag_prefix?`, `contains?`, `min_count?`, `limit?` | Теґи з кількістю чанків/файлів |

**Рекомендований workflow агента** — воронка від загального до конкретного:

```
qdrant_collection_info
  → qdrant_get_skeleton(collection)                               # skeleton-карта, якщо є
  → qdrant_get_skeleton_children(collection, node_path="<area>")  # заглиблення по skeleton
  → qdrant_list_directories(collection, depth=1)                  # fallback без skeleton
  → qdrant_list_files(collection, source_prefix="<area>/")        # файли в області
  → qdrant_search(query, top=3, window=1, window_format="compact")
  → qdrant_get_chunk (якщо потрібен ширший контекст)
```

Skeleton-резюме — це карта для навігації, а не доказ для відповіді: факти
перевіряйте через `qdrant_search` / `qdrant_get_chunk`.

Теґи — для розширення охоплення **після** першого пошуку: `qdrant_list_tags`
(звужуйте через `tag_prefix`/`contains`) → `qdrant_find_by_tag`.

**Правило усічення:** якщо вивід показує `Found N … showing M` і M < N — список
усічено; звузьте фільтром і повторіть. Compact-сніпети обрізаються до ~150 символів —
для таблиць/коду беріть повний чанк через `qdrant_get_chunk`.

## Індексація, env-змінні, формати, обмеження

### Індексація та sync

```bash
COLLECTION=my-docs npm run index path/to/docs/         # папка або файл
PRUNE_STALE=1 COLLECTION=my-docs npm run index ./docs/ # + прибрати точки для видалених файлів (лише повний корінь)
SOURCE_ROOT=/vault COLLECTION=my-docs npm run index /vault/docs/  # стабільні source_file ID
```

`npm run sync` генерує `config.json` з реальних колекцій і забезпечує payload-індекси.
**Важливо:** для колекцій до підтримки sparse sync лише додає sparse-схему і
**попереджає про потребу переіндексації** — він **не** бекфілить sparse-вектори у вже
наявні точки.

### Ключові env-змінні

Повний довідник: [docs/en/configuration.md](../en/configuration.md).

| Змінна | За замовч. | Опис |
|--------|-----------|------|
| `ONNX_EMBED` | `0` | `1` — `bge-m3-onnx` для dense і sparse (~2.3 ГБ у `./models/`) |
| `ONNX_EXECUTION_PROVIDER` | `cpu` | `cpu`, `dml` (Windows GPU, verified), `cuda` (Linux, експериментально) |
| `ONNX_BATCH_SIZE` | `4` | Розмір батчу для Windows DirectML (1–64) |
| `TOKEN_COUNT` | `bge-m3` | Лічильник токенів: реальний токенайзер; `heuristic` — стара `length/4` |
| `MAX_CHUNK_TOKENS` | `512` | Максимум токенів на чанк |
| `MIN_CHUNK_TOKENS` | `160` | Мінімальний розмір чанку; короткі фрагменти зливаються в межах секції |
| `CHUNK_OVERLAP_TOKENS` | `80` | Токен-бюджетне перекриття між сусідніми чанками; включено в `MAX_CHUNK_TOKENS` |
| `OVERLAP_SENTENCES` | `2` | Застарілий режим речень; використовується лише коли `CHUNK_OVERLAP_TOKENS=0` |
| `TAG_GEN` | `0` | `1` — генерувати payload-теґи під час індексації; на основний пошук не впливає |
| `COMBINED_LLM` | `0` | `1` — combined LLM path: context-only за замовчуванням, context+tags якщо `TAG_GEN=1` |
| `CONTEXT_MODEL` / `TAG_MODEL` | `gemma3:4b` / `CONTEXT_MODEL` | Локальні LLM-моделі; `TAG_MODEL` успадковує `CONTEXT_MODEL`, якщо не заданий явно |
| `COLLECTION` / `SOURCE_ROOT` / `PRUNE_STALE` | — | Параметри індексації |

Reranker (`RERANK_ENABLED` + бусти) і RRF (`RRF_K`, `HYBRID_PREFETCH_LIMIT`) —
див. [configuration.md](../en/configuration.md) та [retrieval.md](../en/retrieval.md).

### Формати

Основний формат semidex — **Markdown (`.md`)**: саме для нього зараз найкраще
зберігається структура документа. Інші формати підтримуються частково: спочатку
перетворюються на текст або Markdown, тому якість заголовків, таблиць і layout
залежить від конкретного документа та можливостей стороннього парсера.

| Формат | Метод | Поточний рівень підтримки |
|--------|-------|---------------------------|
| `.md` | Нативний парсер: заголовки, frontmatter, wikilinks | Основний формат |
| `.txt` | Нативний plain-text парсер | Без структури заголовків |
| `.pdf` | `@opendocsg/pdf2md` → Markdown | Частково; залежить від text layer і відновленої структури PDF |
| `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` | Конвертація через `pandoc` | Частково; залежить від якості конвертації |

`pandoc` потрібен лише для `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm`.

### Відомі обмеження

- **Модель BGE-M3 ONNX** — ~2.3 ГБ при завантаженні.
- **`hashed-tf` (fallback) — не BM25** (IDF=1, без корпусної статистики).
- **Reranker opt-in** — на custom-150 показав регресії, тому увімкнений лише за явним
  `RERANK_ENABLED=1`; вмикайте після бенчмарку на своїх даних.
- **ColBERT / late-interaction не реалізовано.**
- **Справжній BM25/SPLADE fallback для Node-only sparse не реалізовано.**
- **Інкрементальна синхронізація перейменованого коду не реалізована** — змінені
  файли переіндексуються за hash-check, видалені прибираються через `PRUNE_STALE=1`.
- **Бенчмарк — набір регресійних тестів**, не наукова оцінка.
- **Verified — лише Windows**; Linux/macOS неперевірені.

## Дорожня карта

Усе нижче — **плани, а не наявні можливості**. Зміни дефолтів — лише після
підтвердження бенчмарком. Профілі деплою:

**semidex Local** (поточний основний профіль) — повністю локальний або змішаний
deployment: Ollama + ONNX + Qdrant.

**semidex Lite** *(план і ціль першої публічної демки)* — малий CPU-сервер із
application-facing Ask API, Qdrant Cloud для зберігання та server-side
embedding/retrieval і хмарний LLM для генерації відповіді (для першої демки —
Gemini). Це дешевший і простіший deployment для користувачів без локального GPU,
якщо дані дозволено передавати обраним зовнішнім сервісам. Якість Qdrant Cloud
inference має бути виміряна на тих самих зовнішніх датасетах, що й локальний
BGE-M3 шлях, до заяв про еквівалентність або перевагу.

Окремі напрями:

- **Codebase Memory** *(план)* — для великих і legacy-репозиторіїв: skeleton-first
  структура проєкту; контекст для файлів, секцій і структурних сутностей; raw-код,
  source path і позиція лишаються доступними; git-aware інкрементальне оновлення після
  змін; генерація й актуалізація документації. Coding-oriented модель контексту
  обирається бенчмарком (конкретну модель не обіцяємо).
- **Agent Memory** *(план)* — майбутній opt-in writable overlay для всіх профілів,
  **окремий** від authoritative бази знань: global / user-scoped / collection-scoped
  нотатки, правила роботи з конкретною бібліотекою, inbox кандидатів знань для
  зовнішніх фактів, з provenance, review і журналом змін перед promotion у основну базу.
- **Assistant Runtime** *(часткове локальне ядро вже є)* — application-facing
  runtime для готових RAG-застосунків: консультантів на сайтах, Telegram-ботів,
  внутрішніх помічників і власних клієнтів розробників. Наявний backend уже
  виконує retrieval, grounded prompt assembly, SSE-streaming, citations і
  відмову без достатнього evidence через Ollama. Наступний етап — стабільний
  версійований HTTP/SSE контракт, Qdrant Cloud + Gemini demo, а далі
  JavaScript/TypeScript client, embeddable widget, Telegram adapter, зовнішні
  generation providers, auth, rate limits, sessions і multi-tenant isolation.
  Адмін-чат лишається reference client, а не API для інтеграцій.
- **Image understanding pipeline** *(план, поетапно)* — розуміння зображень у
  документах, без змішування з prose: base64-зображення не вмішуються в текст,
  **оригінальне зображення лишається authoritative**. OCR витягує точний видимий
  текст; vision-language модель описує схеми, графіки, скриншоти та ілюстрації.
  OCR-текст і vision-summary — це **derived payload із provenance** (похідні дані з
  посиланням на джерело), а не джерело істини. Gemma через Ollama — кандидат для
  майбутнього probe, не default і не source of truth.
- **Provider adapters** *(дослідження)* — опційні зовнішні API embeddings/контексту;
  оцінити Qdrant Cloud Inference як один із варіантів; локальні ONNX/Ollama лишаються
  основним шляхом.
- **Storage adapters** *(майбутнє)* — Qdrant лишається reference backend і
  підтримуваним default; адаптери інших vector DB — після parity-check.
- retrieval-grade розбиття великих документів, OCR зображень, кращі
  діагностики — також у плані (skeleton-first chunking уже реалізовано як
  opt-in; лишається зробити його типовим режимом після бенчмарк-гейту).

Повний напрям: [docs/en/roadmap.md](../en/roadmap.md). Backlog перекладів deep-dive
docs: [translation-backlog.md](translation-backlog.md).

## Англійська deep-dive документація

| Документ | Про що |
|----------|--------|
| [architecture.md](../en/architecture.md) | Пайплайн індексації, що зберігається |
| [retrieval.md](../en/retrieval.md) | Dense + sparse, RRF, провайдери, rerank |
| [mcp-tools.md](../en/mcp-tools.md) | Довідник MCP-інструментів і workflow агента |
| [configuration.md](../en/configuration.md) | Env-змінні, режими провайдерів, формати, індекси |
| [operations.md](../en/operations.md) | Приклади використання, обмеження, troubleshooting |
| [chunking-quality.md](../en/chunking-quality.md) | Гарантії розбиття, метрики якості |
| [benchmarking.md](../en/benchmarking.md) | Smoke-тести, бенчмарк пошуку, метрики |
| [roadmap.md](../en/roadmap.md) | Напрям продукту, профілі, non-goals |
| [project-structure.md](../en/project-structure.md) | Дерево вихідників, згенеровані файли |

## Подяки

Розроблено за участі AI:

- **[OpenAI Codex](https://openai.com/blog/openai-codex)** — рев'ю коду
- **[Claude](https://claude.ai) (Anthropic)** — генерація коду, документація

Дизайн пайплайну, основна механіка, концепція та тестування — виконані автором.
