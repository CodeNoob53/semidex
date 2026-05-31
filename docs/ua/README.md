# semidex

Інші мови: [English](../en/README.md)

![semidex](../../assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-local%20embeddings-blue?logo=onnx&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**semidex — це local-first інфраструктура для створення RAG-асистентів і AI-агентів,
які працюють із документацією користувача.**

Ви індексуєте власну бібліотеку знань — внутрішні інструкції, регламенти,
документацію продукту, наукові чи навчальні матеріали, технічні специфікації — і
semidex дає AI-агентові набір MCP-інструментів, щоб знаходити релевантні фрагменти,
читати сусідній контекст, досліджувати структуру бібліотеки, ходити за зв'язками та
перевіряти джерело **перед** тим, як відповісти.

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
2. semidex готує матеріали до retrieval (розбиває на чанки, додає короткі резюме й
   теґи, будує граф зв'язків) і складає у векторну базу Qdrant.
3. Ви під'єднуєте semidex як MCP-сервер до свого AI-агента.
4. Під час діалогу агент сам користується інструментами semidex.

**Чим це відрізняється від класичного RAG:**

- **Classic RAG** — фіксований конвеєр: `query → retrieve → augment → generate`.
  Один пошук, один набір чанків, одна відповідь.
- **Agentic RAG із semidex** — агент **сам вирішує**, які MCP-інструменти викликати:
  може зробити кілька кроків пошуку й навігації, переглянути структуру бібліотеки,
  піти за посиланнями між документами, дочитати сусідній контекст і зібрати достатньо
  матеріалу, перш ніж відповісти.

## Приклади застосування

- **Консультант на сайті**, який відповідає клієнтам за документацією продукту.
- **Внутрішній AI-помічник** для команди (регламенти, інструкції, бази знань).
- **Асистент для наукової чи навчальної бібліотеки**.
- **Локальний помічник** для приватних документів, які не можна віддавати в хмару.
- **Технічний асистент** для специфікацій та інструкцій з експлуатації.
- *(roadmap)* **Codebase Memory** — пам'ять про великі та legacy-репозиторії коду.

## Що вже реалізовано

- індексація документів (md, txt, pdf, docx, odt, rtf, epub, html);
- tokenizer-aware chunking (межі за реальним токенайзером BGE-M3);
- локальна генерація context/теґів через Ollama (теґи опційні — `TAG_GEN=0`);
- гібридний пошук dense + sparse з RRF-fusion;
- 9 read-only MCP-інструментів;
- сховище: локальний Qdrant **або** Qdrant Cloud;
- повністю локальний режим (без зовнішніх API для контенту);
- SHA-256 skip — незмінені файли не переобробляються;
- `PRUNE_STALE` — прибирання точок для видалених файлів;
- verified-платформа: **Windows 10/11**.

Усе, що не в цьому списку (skeleton-first chunking, OCR, профілі, зовнішні API,
Agent Memory, Codebase Memory), — це [дорожня карта](#дорожня-карта), а не готові
можливості.

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
  roadmap (профіль semidex Light). Сьогодні ці фази локальні.

## Підтримка платформ

Перевірена end-to-end підтримка наразі — **лише Windows 10/11** (Node.js + ONNX
Runtime на CPU або DirectML, Ollama на доступному GPU-backend).

**Linux і macOS — експериментальні / неперевірені.** CPU-шлях і Node.js-залежності
мають бути переносними, а Ollama може використовувати CUDA/Metal, але це очікувані
можливості, а не гарантія підтримки до тестування на фізичному залізі. Детальна
матриця: [docs/en/configuration.md](../en/configuration.md#platform-support).

## Технічна архітектура

Чотири шари пошуку (під капотом):

1. **Dense-вектори** — нейронні ембединги передають сенс; знаходять перефразування й міжмовні запити.
2. **Sparse-вектори** — лексичні ваги знаходять точні терміни, ідентифікатори, env-змінні, назви функцій.
3. **RRF fusion** — Reciprocal Rank Fusion об'єднує обидва ранжування, щоб жоден не домінував. Це **основний шлях пошуку**, а не опція.
4. **Reranker** — опційний локальний детермінований постпроцесор (вимкнений за замовчуванням; див. обмеження).

Конвеєр індексації:

```
Документи (md, txt, pdf, docx, odt, rtf, epub, html)
  │
  ├─ [1] Chunk          — заголовки → речення; межі за токенайзером BGE-M3
  ├─ [2] Contextualize  — локальний LLM пише 1–2 речення резюме чанку в контексті документа
  ├─ [3] Tag            — LLM генерує 3–7 семантичних теґів на чанк (опційно, TAG_GEN)
  ├─ [4] Embed + Upsert — dense + sparse вектори → Qdrant named vectors + payload
  └─ [5] Link           — семантичний граф: top-N сусідів між колекціями, двосторонньо
         │
         ▼
    Колекція Qdrant (dense · sparse · text · context · section · tags · source_file)
         │
         ├──▶ graph.<collection>.json  (sidecar-граф: links/backlinks)
         │
         ▼
    MCP-інструменти (9) ── AI-агент отримує точний контекст
```

Вектор обчислюється з `context + text` разом, тож навіть короткий фрагмент коду
знаходиться за природномовним запитом завдяки вбудованому LLM-резюме. Граф зберігається
у `graph.<collection>.json` (посилання дублюються в payload точок); `qdrant_related`/
`qdrant_backlinks` читають саме цей файл, а не обчислюють зв'язки всередині Qdrant.
Під час запиту MCP-сервер ембедить запит **тим самим провайдером**, що й при індексації.

## Швидкий старт

### 1. Встановлення

```bash
npm install
cp .env.example .env
# задайте QDRANT_URL; QDRANT_KEY — лише якщо Qdrant захищений ключем
# (для локального незахищеного Qdrant ключ не потрібен, Qdrant Cloud — потрібен)
```

### 2. Запуск Qdrant

Qdrant Cloud або локально:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Провайдер ембедингів

**Рекомендовано — ONNX-режим** (якісний, багатомовний, найкраще для української):

```bash
# у .env:
ONNX_EMBED=1
# модель bge-m3-onnx (~2.3 ГБ) завантажиться один раз у ./models/. Ollama для ЕМБЕДИНГІВ не потрібен.
```

```bash
# context/tag-фази все одно потребують Ollama + gemma3:4b (навіть у ONNX-режимі):
ollama pull gemma3:4b
```

**Fallback — Ollama для всього** (легкий, мінімальне налаштування):

```bash
ollama pull bge-m3        # dense ембединги
ollama pull gemma3:4b     # LLM для контексту + теґів
```

> **Важливо:** Ollama має бути **запущена** і модель `gemma3:4b` витягнута в **обох**
> режимах — бо контекст (і теґи, якщо `TAG_GEN` не вимкнено) генерує локальний LLM
> через Ollama. `ONNX_EMBED=1` прибирає Ollama лише з фази ембедингів, не з
> context/tag. Якщо теґи не потрібні — `TAG_GEN=0`.

### 4. Синхронізація та індексація

```bash
npm run sync                                    # генерує config.json з реальних колекцій Qdrant
COLLECTION=my-docs npm run index ./docs/        # індексація папки
```

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

semidex надає 9 read-only інструментів:

| Інструмент | Аргументи | Опис |
|------------|-----------|------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?`, `window?`, `window_format?` | Гібридний пошук (dense + sparse + RRF) з фільтрами та контекстним вікном |
| `qdrant_collection_info` | — | Список колекцій з кількістю точок, провайдером, описом |
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Один чанк (+опційні сусіди) за точним розташуванням |
| `qdrant_related` | `collection`, `source_file` | Вихідні семантичні посилання файлу (граф) |
| `qdrant_backlinks` | `collection`, `source_file` | Вхідні посилання на файл (граф) |
| `qdrant_find_by_tag` | `collection`, `tag?`, `tags?[]`, `match?`, `limit?` | Чанки за теґом/теґами, згруповані за файлом |
| `qdrant_list_directories` | `collection`, `source_prefix?`, `depth?`, `limit?` | Префікси директорій з кількістю файлів/чанків |
| `qdrant_list_files` | `collection`, `source_prefix?`, `tags?[]`, `tag_match?`, `limit?` | Унікальні файли з кількістю чанків і першою секцією |
| `qdrant_list_tags` | `collection`, `source_prefix?`, `tag_prefix?`, `contains?`, `min_count?`, `limit?` | Теґи з кількістю чанків/файлів |

**Рекомендований workflow агента** — воронка від загального до конкретного:

```
qdrant_collection_info
  → qdrant_list_directories(collection, depth=1)                  # карта верхніх областей
  → qdrant_list_directories(collection, source_prefix="<area>/")  # заглиблення
  → qdrant_list_files(collection, source_prefix="<area>/")        # файли в області
  → qdrant_search(query, top=3, window=1, window_format="compact")
  → qdrant_get_chunk (якщо потрібен ширший контекст)
  → qdrant_related / qdrant_backlinks
```

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
| `MAX_CHUNK_TOKENS` | `400` | Максимум токенів на чанк |
| `OVERLAP_SENTENCES` | `2` | Перекриття речень між сусідніми чанками |
| `TAG_GEN` | `1` | `0` — пропустити теґи (`tags: []`); на основний пошук не впливає |
| `COMBINED_LLM` | `0` | `1` — один LLM-виклик на context+tags |
| `CONTEXT_MODEL` / `TAG_MODEL` | `gemma3:4b` | Локальні LLM-моделі |
| `COLLECTION` / `SOURCE_ROOT` / `PRUNE_STALE` | — | Параметри індексації |

Reranker (`RERANK_ENABLED` + бусти) і RRF (`RRF_K`, `HYBRID_PREFETCH_LIMIT`) —
див. [configuration.md](../en/configuration.md) та [retrieval.md](../en/retrieval.md).

### Формати

`.md`, `.txt` — нативний парсер; `.pdf` — `@opendocsg/pdf2md`; `.docx`/`.odt`/`.rtf`/
`.epub`/`.html`/`.htm` — через `pandoc` (потрібен лише для цих форматів).

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

**semidex Light** *(план)* — профіль для випадків, коли локальний ПК слабкий або
зайнятий і його ресурси треба берегти, **а дані дозволено передавати зовнішнім
сервісам**: опційні зовнішні API для embeddings/генерації контексту, cloud
storage/inference. Не готова функція.

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
- **Assistant Runtime** *(план, опційно)* — runtime для побудови готових
  RAG-застосунків поверх semidex: консультантів на сайтах, внутрішніх помічників
  компаній тощо. Матиме HTTP API для запитань, retrieval policy, формування grounded
  prompt, streaming-відповіді та citations до конкретних файлів, секцій і чанків.
  Генератор відповідей **змінний**: локальна модель або зовнішній API; Ollama —
  практичний кандидат для першого локального adapter. Нативна ONNX LLM-генерація — це
  research-напрям, а не готова обіцянка.
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
- skeleton-first chunking, retrieval-grade розбиття великих документів, OCR зображень,
  кращі діагностики — також у плані.

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
| [obsidian.md](../en/obsidian.md) | Obsidian-сумісний review-вивід `chunks_out/` |

## Подяки

Розроблено за участі AI:

- **[OpenAI Codex](https://openai.com/blog/openai-codex)** — рев'ю коду
- **[Claude](https://claude.ai) (Anthropic)** — генерація коду, документація

Дизай