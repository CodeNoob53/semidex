# Ревізія коду semidex — 2026-06-10

Обсяг: весь `src/` (77 файлів, ~8 250 рядків). Фокус: коректність, продуктивність, безпека, архітектура/техборг. Знахідки №1 і №2 відтворені експериментально (Node-репродукція регексів та `runBatched`), решта — за статичним аналізом.

## Підсумок

Кодова база у хорошому стані: чисте розшарування (core / indexer / mcp), продуманий порядок безпеки в пайплайні індексації (деструктивні операції лише після успішного embed), детерміністичні point ID, 39 секцій смоук-тестів. Знайдено 2 підтверджені баги з ризиком втрати/деградації даних, 2 проблеми надійності в ONNX-шарі та низку середніх зауважень щодо стійкості й продуктивності.

---

## Критичні та високі

### 1. 🔴 CRLF ламає frontmatter та setext-заголовки (Windows)

`src/indexer/phases/chunk.js`

- `parseFrontmatter` (рядок 44): регекс `/^---\n([\s\S]*?)\n---\n/` не матчить `---\r\n`. На файлах із CRLF frontmatter **не зрізається**: `meta.tags` губляться, а рядки `---`/`tags: ...` індексуються як текст.
- `parseMarkdown` (рядки 370–371): `/^=+$/` та `/^-+$/` не матчать `===\r` — setext-заголовки на CRLF-файлах не розпізнаються, секціонування зникає.

Підтверджено тестом: CRLF → frontmatter no-match, setext no-match; LF → обидва ok. ATX-заголовки (`# ...`) не страждають (`.` не матчить `\r`).

Це безпосередньо актуально: робоче середовище — Windows, а в поточному diff видно масовий CRLF-churn.

**Фікс:** нормалізація на вході — у `chunkFile` / `chunkFileAsync` (або одразу після `readFileSync`/pandoc/pdf2md):

```js
text = text.replace(/\r\n?/g, '\n');
```

Увага: зміна нормалізації змінює хеш-незалежну розбивку чанків → варто підняти `CHUNKING_SCHEMA_VERSION`, щоб уражені файли переіндексувалися.

### 2. 🔴 Невалідний `LLM_BATCH_SIZE` → тиха втрата даних файлу

`src/indexer/index.js:26` + `src/indexer/batch.js`

`BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '3')` без валідації. При `LLM_BATCH_SIZE=abc` → `NaN`. Підтверджено: `runBatched(items, NaN, fn)` повертає `[]` (перша ітерація: `slice(0, NaN)` → `[]`, далі `i += NaN` → вихід із циклу).

Ланцюжок: stageB → `taggedChunks = []` → stageC проходить валідацію (`0 === 0`) → stageD: `deleteBySourceFile` (якщо `needsDelete`) + upsert 0 точок + `deleteTrailingChunks(…, 0)` — **усі точки файлу видаляються, нові не записуються**, без жодної помилки.

**Фікс (два рівні):**

```js
// 1) Валідація (взяти envInt, що вже є в qdrant.js/rerank.js/chunk.js)
const BATCH_SIZE = envInt('LLM_BATCH_SIZE', 3, 1, 64);

// 2) Запобіжник у stageD: не комітити порожній результат для непорожнього файлу
if (pointsWithDense.length === 0 && rawChunks.length > 0) {
  throw new Error(`stageD: refusing to commit 0 points for ${sourceFile} (${rawChunks.length} raw chunks)`);
}
```

### 3. 🟠 Гонка ініціалізації в `onnx-embed.js: load()`

`src/core/onnx-embed.js:114–151`

`load()` не має promise-guard: `if (tokenizer && session) return;` не захищає від конкурентних викликів. Стандартний продакшн-шлях (`ONNX_EMBED=1` без DML) викликає `embedForIndex` через `runBatched` із конкуренцією `BATCH_SIZE=3` — перший батч запускає **3 паралельні `load()`**:

- 3 × `AutoTokenizer.from_pretrained` + 3 × `InferenceSession.create` (зайва памʼять, перші embed повільніші);
- найгірше — при першому завантаженні моделі 3 конкурентні `downloadFile` пишуть в один файл (`createWriteStream` із `'w'`/`'a'`) → ймовірне **пошкодження кешу `model.onnx.data` (2.27 GB)**, яке перевірка «розмір ≥ 99% очікуваного» не виявить.

**Фікс:** той самий патерн, що вже застосовано в `token-count.js: loadBgeTokenizer` (`_tokenizerPromise`):

```js
let _loadPromise = null;
async function load() {
  if (!_loadPromise) _loadPromise = _doLoad().catch(e => { _loadPromise = null; throw e; });
  return _loadPromise;
}
```

### 4. 🟠 `fetchRange`: докачка без перевірки статусу 206 псує кеш моделі

`src/core/onnx-embed.js:72–92`

При резюмі (`from > 0`) код приймає і `200`: якщо сервер/проксі проігнорує `Range` і поверне повне тіло, воно **допишеться** (`flags: 'a'`) до часткового файлу → файл стане більшим за очікуваний і пройде валідацію «≥ 99%». Також немає перевірки контрольної суми (ETag/SHA).

**Фікс:** якщо `from > 0 && res.status !== 206` — перезаписати з нуля (`flags: 'w'`, `downloaded = 0`). В ідеалі — звіряти фінальний розмір із `content-length`/`x-linked-size` і фейлитися при розбіжності.

---

## Середні

| # | Файл | Проблема | Категорія |
|---|------|----------|-----------|
| 5 | `core/qdrant.js` | Жоден `fetch` не має таймаута (`AbortSignal.timeout`) — індексація/MCP-запит може висіти нескінченно. У `preflight.js` таймаути є — перенести патерн. | Надійність |
| 6 | `core/qdrant.js:3` | `QDRANT_URL` не перевіряється: при відсутності — `fetch("undefined/collections")` і незрозуміла помилка. Один guard на старті модуля дав би зрозумілу діагностику (doctor це ловить, але індексер/MCP — ні). | Надійність |
| 7 | `core/qdrant.js:84` | Fallback `hybridSearch` спрацьовує за `err.includes('sparse') \|\| err.includes('Wrong input')` — надто широкий матч: справжні помилки запиту тихо деградують до dense-only пошуку. Звузити до конкретного коду/повідомлення Qdrant і логувати fallback у stderr. | Коректність |
| 8 | `core/qdrant.js` | Імена колекцій/значення вставляються в URL без `encodeURIComponent` — колекція зі спецсимволами зламає шлях. | Коректність |
| 9 | `indexer/index.js:426` | Пайплайн-режим: `Promise.allSettled(files.map(...))` стартує stageA для **всіх** файлів одразу — без ліміту: хеші, `getStoredMeta` (шквал HTTP) і chunking для сотень файлів конкурентно, всі `rawChunks` живуть у памʼяті одночасно. Додати вхідний семафор (наприклад, `stageA` під `new Semaphore(4)`). | Продуктивність/память |
| 10 | `indexer/phases/chunk.js:621` | `execFileAsync('pandoc', ...)` без `maxBuffer` (дефолт ~1 MB) — великий .docx/.epub впаде з `maxBuffer exceeded`. Також ENOENT (pandoc не встановлено) летить сирим — додати дружнє повідомлення. | Надійність |
| 11 | `core/config.js:13` | `saveConfig` пише `config.json` неатомарно — крах посеред запису псує конфіг усіх колекцій. Патерн tmp-файл + `renameSync`. | Надійність |
| 12 | `mcp/tools/listFiles.js, listTags.js, listDirectories.js` | Кожен виклик — повний скан колекції (`scrollAllPoints`, сторінки по 250). На великих колекціях це секунди мережевих circuit-ів на кожне звернення агента. Варіанти: Qdrant facet API для тегів, короткий TTL-кеш у процесі MCP-сервера. | Продуктивність |
| 13 | `mcp/tools/findByTag.js:47` | `scroll(…, limit=200)` без індикації трункації: «Found N chunks» показує N=кількість завантаженого, а не загальну — суперечить власному truncation-правилу з AGENTS.md. | Коректність |
| 14 | `mcp/tools/search.js:87` | Window-чанки тягнуться послідовно для кожного результату (N+1). `Promise.all` по results дав би помітне прискорення при `window>0, top=5`. Також `top` не обмежений зверху. | Продуктивність |
| 15 | `indexer/phases/tag-onnx.js:63` | `onWorkerExit(code === 0)` не реджектить pending-запити — якщо воркер завершиться «чисто» з активними запитами, вони зависнуть назавжди. Помилка `ensureWorker` кешується в `_initPromise` без retry. | Надійність |

---

## Дрібні / техборг

- **Дублювання `envInt`** — 4 копії (`qdrant.js`, `rerank.js`, `chunk.js`, `mcp/tools/search.js`) з різною поведінкою warn. Винести в `core/env.js`.
- **Дублювання валідних комбінацій провайдерів** — `VALID_PROVIDER_COMBOS` (`config.js:22`) і `VALID_COMBOS` (`embeddings.js:149`) — два джерела істини.
- **Sync/async дублікати чанкінгу** (`_splitLevel`/`_splitLevelAsync`, `mergeShortChunks`/`...Async`, `addSplitOverlap`/`...Async`) — задокументований компроміс, але кожна зміна логіки тепер потребує двох правок; кандидат на уніфікацію через async-only + sync-обгортку.
- `core/qdrant.js:3` — константа `URL` затіняє глобальний `new URL()`; перейменувати в `QDRANT_URL`.
- `core/qdrant.js:6` — заголовок `api-key` надсилається навіть коли ключ відсутній (значення `"undefined"`); пропускати заголовок, якщо `KEY` порожній.
- `core/ollama.js:9` — `text.slice(0, 8000)` — тихе обрізання за **символами**, не токенами; довгі чанки втрачають хвіст без попередження.
- `core/sparse.js:23` — токенайзер пропускає лише `[a-zа-яіїєґ0-9]`: кирилиця поза укр. набором (ё, ъ, ы, э), грецька, CJK — викидаються. Для мультимовних колекцій із hashed-tf це означає порожні sparse-вектори. Простіша альтернатива — `\p{L}\p{N}` з `u`-прапором.
- `indexer/files.js` — `.semidexignore` підтримує лише точні імена (без glob) і читається тільки з кореня; симлінк-директорії мовчки пропускаються (`withFileTypes` → `isDirectory() === false`). Варто задокументувати.
- `indexer/index.js:298` — мітка фази `[4/4] upserting` при нумерації `[1/5]…[4/5]` вище; косметика.
- `mcp/tools/collections.js` — `getDenseProvider`/`getDenseModel`/`getSparseProvider` кожен читає `config.json` з диска заново → 3 sync-read на колекцію на кожен виклик `qdrant_collection_info`.

## Безпека

Серйозних проблем не виявлено:

- `.env` і `config.json` у `.gitignore`, у git не трекаються — перевірено.
- `doctor.js` послідовно редагує секрети (`redactKey`, `sanitiseErrorMessage`) — добре.
- Зауваження: помилки Qdrant у MCP-відповідях повертаються агенту без санітизації (`Error: ${err.message}` у `server.js:37` може містити повний URL із query). Прогнати через `sanitiseErrorMessage` з `doctor-checks.js` — дешева страховка.
- `stageA` має коректний guard від виходу за `SOURCE_ROOT` (path traversal при формуванні `source_file`).

## Що зроблено добре

- Архітектура stage A–D із явним інваріантом «жодних деструктивних дій до успішного embed» і серіалізованим комітом (`SerialQueue`) — продумано і добре прокоментовано.
- Детерміністичні UUIDv5 point ID (`point-id.js`) з чітко задокументованим контрактом, що входить в ідентичність чанка, а що ні; `deleteTrailingChunks` закриває shrink-кейс.
- Reindex-детекція по повному кортежу (hash + provider + model + schema versions + token mode + vector size) — рідко хто робить так ретельно.
- Захист топ-1 у rerank (порівняння за ідентичністю обʼєкта, не за файлом) і diversity-відбір — акуратна, добре документована логіка.
- Смоук-тести покривають чисті функції без мережі; пайплайн-примітиви (`Semaphore`, `SerialQueue`) коректні, включно зі звільненням пермітів при помилках.
- `token-count.js` — взірцевий promise-guard ліниве завантаження + кеш із бюджетом (саме цей патерн треба перенести в `onnx-embed.js`).

## Вердикт

**Request Changes** — точкові: №1–4 варто виправити до наступного масового індексування (№1 і №2 — підтверджені сценарії втрати даних/метаданих, №3–4 — ризик зіпсувати 2.3 GB кеш моделі). Середні пункти — у беклог; жоден не блокує.

### Рекомендований порядок

1. Нормалізація CRLF у chunk.js + bump `CHUNKING_SCHEMA_VERSION` (№1)
2. `envInt` для `LLM_BATCH_SIZE` + запобіжник нульового коміту в stageD (№2)
3. Promise-guard у `onnx-embed.js: load()` (№3)
4. Перевірка 206 у `fetchRange` (№4)
5. Таймаути fetch + guard `QDRANT_URL` у `qdrant.js` (№5–6)
6. Семафор на stageA у пайплайн-режимі (№9)
