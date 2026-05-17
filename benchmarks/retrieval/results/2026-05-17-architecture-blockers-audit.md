# Architecture Performance & Blockers Audit — 2026-05-17

**Scope:** повний статичний аналіз `src/` + `benchmarks/retrieval/`, перевірка call-graph
кожної фази індексування та пошуку, кореляція з усіма наявними benchmark-результатами.
**Method:** код-цитати + перевірка проти таблиць latency у `results/`.
**Goal:** знайти блокери продуктивності, що залишилися та НЕ описані в
`2026-05-17-performance-bottleneck-audit.md`, не порушуючи коректності.
**Constraint per user:** лише безпечні оптимізації — нічого з розділу `Do NOT do yet`.

**Revisions (2026-05-17 v3 — за user feedback):**
- `addTagsBatch` fallback переоцінено (#2.9): запропонований фікс `runBatched(chunks,
  BATCH_SIZE, addTags)` не є реальним покращенням, бо fallback уже виконується
  всередині slice розміром `BATCH_SIZE` (index.js викликає `addTagsBatch(slice)`).
  Пункт перенесено з Tier 1 у deferred/measurement; Tier 1 тепер містить тільки
  два справжніх zero-risk quick wins.

**Revisions (2026-05-17 v2 — за user feedback):**
- Скоригована оцінка ризику для `keep-alive` (#2.3): undici має дефолтний pool;
  стара оцінка «30–50% overhead» була необґрунтована без вимірювання — це тепер
  захардкоджено як «measurement-first», а не automatic fix.
- Скоригована оцінка ризику для batch payload (#2.4): різні backlink-payload-и
  ускладнюють батч; lost-update ризик описано явно.
- Скоригований ризик для `shouldMerge` precompute (#2.5): з low → medium, бо
  семантика залежна від попередніх merge-рішень. Потрібен окремий quality eval.
- Знижений ROI claim для async `saveChunksMd` / `chunkFile` (#2.6, #2.10): у
  single-file sequential pipeline economy незначна; цінне після file-level
  parallelism (Do NOT yet).
- ONNX BigInt cleanup (#2.7) перепозиціонований як micro-opt, не priority.

---

## 0. TL;DR — рекомендований порядок (за user feedback)

**Виконати спочатку (high confidence, low risk):**

| # | Блокер | Файл:рядок | Ризик | Підстава |
|---|--------|-----------|-------|----------|
| 1 | `loadGraph` — sync `readFileSync` + JSON parse на кожен MCP-search/rerank | `src/core/rerank.js:110` + `src/core/graph.js:8-12` | низький | mtime-cache, поведінка зберігається |
| 2 | `qdrant_related` — sequential `scroll` у циклі links | `src/mcp/tools/related.js:22-28` | нульовий | `Promise.all` з збереженням порядку |

**Після quick wins, тільки з equivalence test:**

| # | Блокер | Файл:рядок | Ризик | Підстава |
|---|--------|-----------|-------|----------|
| 3 | Phase 5 (link) повторно ембеджить chunk, який вже ембеджений у phase 4 | `src/indexer/index.js:99-101` + `src/indexer/phases/link.js:14` | низький — **АЛЕ** потрібен live equivalence test (links/backlinks до/після) | dense вектор з phase 4 пробросити в `buildLinks`; уніфікувати embed-text формат |

**Перевірити вимірюванням, перш ніж робити:**

| # | Блокер | Що міряти |
|---|--------|-----------|
| 4 | HTTP keep-alive до Qdrant | Чи дефолтний undici pool вже дає reuse-connection. Профілювати link-фазу з/без custom `Agent`. |
| 5 | Batch payload updates для backlinks | Чи `set_payload` API підтримує per-point payload в одному виклику; як уникнути lost-update. |
| 6 | `addTagsBatch` fallback | Як часто batch parse реально падає; якщо часто — обрати serial fallback або `TAG_FALLBACK_CONCURRENCY`. |

**Залишити на пізніше / micro-opt:**

| # | Блокер | Чому не зараз |
|---|--------|--------------|
| 7 | Async I/O в `saveChunksMd` / `chunkFile` | У single-file sequential pipeline economy незначна; цінно після file-level parallelism (Do NOT yet). |
| 8 | `embedOnnx` BigInt алокаційний cleanup | Micro-optimization 1–3% per call; розбирати разом з іншою роботою в `onnx-embed.js`. |
| 9 | Batched `shouldMerge` boundary checks | **Не низький ризик** — рішення `i` залежить від попередніх merge’ів. Потрібен окремий quality eval. |

---

## 0.1 Що змінилось у пріоритетах vs первинна версія звіту

| # | Як було | Як стало | Причина |
|---|---------|----------|---------|
| Graph cache | rank 2 | **rank 1** | Найвище співвідношення ROI / ризик |
| addTagsBatch fallback | rank 9 | **deferred** | Запропонований фікс неефективний: fallback уже виконується у batch-sized slice; потрібно виміряти частоту fallback і вибрати serial/env-controlled policy |
| qdrant_related | rank 8 | **rank 3** | Три рядки, нульовий ризик, видимий ефект на MCP latency |
| Dense reuse phase 4→5 | rank 1 | **rank 4 з equivalence test** | ROI підтверджується тільки після перевірки що `links`/`backlinks` ідентичні до/після |
| Keep-alive | rank 3 ("nullable risk") | **deferred — measure first** | Глобальний undici pool вже має keep-alive за замовчуванням |
| Batch payload | rank 5 ("low risk") | **deferred — design review** | Різний payload per-point ускладнює batch; ризик lost-update |
| Batched shouldMerge | rank 8 ("low risk") | **deferred — needs quality eval** | Семантика залежна від попередніх рішень |
| Async I/O | ranks 6, 7 | **deferred — низький ROI у single-file pipeline** | Cycles виграш видно тільки після file parallelism |
| ONNX BigInt | rank 10 | **micro-opt — bundle later** | Не пріоритет |

---

## 0.2 Recap: повний інвентар блокерів (без перерейтингу)

Усі 9 знахідок залишаються валідними як **інвентар**, але їхні рекомендовані статуси
тепер різні. Деталі по кожній — у секції 2.

---

## 1. Як цей звіт співвідноситься з 2026-05-17-performance-bottleneck-audit.md

Попередній аудит вичерпно описав:

- послідовність файлів у головному циклі індексера (`for...of` у `index.js:288-291`);
- послідовність фаз context→tag→embed→link;
- неможливість truly паралельного ONNX без зміни сесії;
- дублювання encoding’у в ColBERT-бенчмарку (вже виправлено через `scoreColBERTAll`);
- query-encode дублювання у ColBERT (виправлено).

Він **НЕ описав** дев’ять інших структурних блокерів, які перелічено нижче. Шість із
них (#1, #2, #3, #4, #6, #7 з таблиці вище та #8, #9, #10 нижче) не вимагають взагалі
жодних архітектурних ризиків — це чиста гігієна. Це позиція, з якої доречно почати.

---

## 2. Детальний аналіз нових блокерів

### 2.1 — `loadGraph` синхронний на кожен MCP-search

**Файли:** `src/core/rerank.js:108-111`, `src/core/graph.js:8-12`,
`src/mcp/tools/related.js:18`, `src/mcp/tools/backlinks.js:17`.

```js
// rerank.js — ВИКЛИКАЄТЬСЯ на КОЖЕН search із RERANK_ENABLED=1
let graph = {};
if (collection) {
  try { graph = loadGraph(collection); } catch (_) { /* no graph file is fine */ }
}
```

```js
// graph.js
export function loadGraph(collection = 'default') {
  const p = graphPath(collection);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));   // ← sync I/O + JSON.parse кожен раз
}
```

**Проблема:** граф (наприклад `graph.semidex-docs.json` — 14 KB у репо) перечитується
з диска і парситься на кожен MCP-запит, плюс на кожен виклик `rerankResults`. На
гарячому шляху MCP це 5-50 ms блокуючого I/O per request — без жодної функціональної
користі. Сам файл змінюється тільки під час `npm run index`.

**Виклики у MCP**: `rerank.js` + `related.js` + `backlinks.js` = до 3 окремих
`readFileSync` на користувацький запит, якщо клієнт ланцюжком викликає search →
related → backlinks.

**Фікс:** module-level cache з mtime invalidation (~10 рядків).

```js
const _graphCache = new Map();  // collection → { mtimeMs, data }
export function loadGraph(collection = 'default') {
  const p = graphPath(collection);
  if (!existsSync(p)) return {};
  const stat = statSync(p);
  const cached = _graphCache.get(collection);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const data = JSON.parse(readFileSync(p, 'utf8'));
  _graphCache.set(collection, { mtimeMs: stat.mtimeMs, data });
  return data;
}
```

Зберігає поточну поведінку (граф підхоплюється після reindex автоматично, бо mtime
зміниться при `saveGraph`).

---

### 2.2 — Подвійний ембеджинг у phase 4 → phase 5 (потребує live equivalence test)

**Файли:** `src/indexer/index.js:99-120` (phase 4) + `src/indexer/phases/link.js:14`
(phase 5).

```js
// phase 4
const points = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
  const embedText = `${chunk.context}\n\n${chunk.text}`;
  const { dense, sparse, meta } = await embedForIndex(collection, embedText);
  ...
});
```

```js
// phase 5 — link.js
const { dense } = await embedForSearch(sourceCollection, chunk.context + '\n' + chunk.text);
```

**Проблема:** для побудови links chunk ембеджиться **вдруге** з майже ідентичним
текстом (різниця тільки `\n\n` vs `\n`). На ONNX-шляху це окремий `session.run`
(~100-125 ms) на чанк; на Ollama-шляху — окремий HTTP-виклик до Ollama (1-5 s).

Для файлу з 30 чанків це: 30 додаткових ONNX викликів (~3-4 с) або 30 додаткових
Ollama викликів (~30-150 с). Це ПОЛОВИНА часу phase 5.

**Фікс:** передавати `dense` вектор з phase 4 у phase 5. Уніфікувати формат
embed-тексту: завжди `chunk.context + '\n\n' + chunk.text`. Тоді у `buildLinks`
використати готовий вектор — без повторного `embedForSearch`.

```js
// phase 4 (in indexer/index.js)
const pointsWithVectors = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
  const embedText = `${chunk.context}\n\n${chunk.text}`;
  const { dense, sparse, meta } = await embedForIndex(collection, embedText);
  return { point: {...}, dense };  // зберігаємо dense для link фази
});

// phase 5
await runBatched(taggedChunks, BATCH_SIZE, (chunk, i) =>
  buildLinks(chunk, allCollections, graph, collection, pointsWithVectors[i].dense));
```

**КРИТИЧНО для безпеки зміни:**
1. Поточний код у phase 4 і phase 5 використовує **різний** embed-текст: phase 4 —
   `${chunk.context}\n\n${chunk.text}`, phase 5 — `chunk.context + '\n' + chunk.text`.
   Перед reuse ці форматування мають бути уніфіковані (single newline vs double
   matter — це впливає на токенізацію і отже на вектор).
2. Provider/model має збігатися у `embedForIndex` і `embedForSearch` для тієї ж
   collection — поточний код це задовольняє через `getEmbeddingConfig(collection)`,
   але це треба assertити в тестах.
3. **Live equivalence check:** зіндексувати той самий corpus двічі (до зміни і
   після) і diff’ити отримані `links` / `backlinks` у Qdrant payload та у
   `graph.<col>.json`. Очікуваний результат: bit-identical (з точністю до
   randomUUID для chunk IDs).
4. Тільки після проходу equivalence test зливати в main.

Без цих кроків це **не** «низький ризик», а «потенційно zero-impact зміна, що
випадково зсуне ваги»: різниця у `\n` vs `\n\n` справді може дати інший токенізаційний
результат → інший dense → інші links.

---

### 2.3 — HTTP keep-alive до Qdrant — **deferred, потребує вимірювання**

**Файл:** `src/core/qdrant.js:1-13`.

```js
const headers = () => ({ 'api-key': KEY, 'Content-Type': 'application/json' });

export async function listCollections() {
  const r = await fetch(`${URL}/collections`, { headers: headers() });
  ...
}
```

**Що було в первинній версії звіту (виправляється):** твердження «кожен виклик
робить TCP+TLS handshake» — необґрунтоване. Глобальний `fetch` у Node 18+ йде
через undici, і undici за замовчуванням використовує `getGlobalDispatcher()` →
`Agent` з вбудованим пулом з’єднань і keep-alive. Тобто reuse-connection вже
**мабуть** працює без явного `Agent`.

**Що насправді треба перевірити:**
1. Виміряти типову link-фазу (з `INDEX_PROFILE=1` плюс додатковий лог `fetch` -
   start/end timestamps) — чи бачимо ми ~ms overhead на кожен запит або
   ~50-100 ms (що було б ознакою re-handshake).
2. Перевірити, чи cloud Qdrant закриває idle connections швидше за
   `keepAliveTimeout` (default ~4 с у undici).
3. Тільки якщо вимірювання покаже видимий handshake-overhead → пробувати
   custom `Agent` з `keepAliveTimeout: 30_000` і `connections: 8`.

**Метод вимірювання:**
- Додати тимчасовий wrapper навколо `fetch` у `qdrant.js`, що логує
  `performance.now()` до і після, і пише в окремий profiler bucket.
- Запустити reindex 10-15 файлів з і без custom `Agent`.
- Порівняти p50/p95 окремих Qdrant-викликів. Якщо різниця < 5 ms — не варто
  втручатись.

Висновок: **не починати з цього**. Це може бути zero-impact зміна.

---

### 2.4 — `updatePayload` per-backlink — **deferred, потребує design review**

**Файл:** `src/indexer/phases/link.js:30-46`.

```js
for (const r of results) {
  if (r.score < LINK_MIN_SCORE) continue;
  ...
  const targetBacklinks = r.payload?.backlinks || [];
  if (!targetBacklinks.includes(chunk.source_file)) {
    await updatePayload(collection, r.id, {                // ← sequential!
      backlinks: [...targetBacklinks, chunk.source_file],
    });
  }
  ...
}
```

**Проблема:** усередині phase 5 для кожного знайденого backlink робиться окремий
`POST /collections/{c}/points/payload`. Qdrant підтримує batch payload update
(`/collections/{c}/points/payload` приймає масив `points`). Для файлу з 30
чанків × 5 hits ≈ 150 окремих POST.

**Доповнення:** також у `index.js:128-134` post-link `updatePayload` на оновлений
`links` per chunk вже **паралелізований** через `Promise.all`, але теж не batched.

**Чому це не «low risk»:**

Qdrant `POST /collections/{c}/points/payload` приймає або:
- один payload + масив `points` ids (усі точки отримують **той самий** payload), або
- через `/points/payload/set_payload` — теж один payload на виклик.

У нашому випадку кожна точка має **різний** `backlinks` array (бо це
доповнюється `[...targetBacklinks, chunk.source_file]` — попередні backlinks
читаються з payload, отриманого від `search`). Тобто:

1. Якщо просто погрупувати ops з однаковим **новим масивом** — це
   рідкісний кейс і виграш не масштабний.
2. Якщо для кожної target-точки робити «прочитати backlinks → доповнити →
   записати», то це класичний read-modify-write з ризиком lost update, якщо
   та сама точка буде target’ом для двох різних source чанків у тій самій
   фазі (а вона буде, бо в межах файлу багато чанків можуть бекланкати на
   ту саму точку іншого файлу).
3. Поточний sequential `await` усередині `buildLinks` випадково запобігає
   цьому race-у в межах одного чанку, але якщо `runBatched(BATCH_SIZE=3)`
   запускає 3 `buildLinks` паралельно — два з них можуть прочитати ту саму
   target-точку, додати свої different `source_file` у backlinks, і
   останній write перепише попередній.

**Що потрібно перевірити перед фіксом:**
- Чи поточний код взагалі коректний при `BATCH_SIZE > 1` у phase 5 — є
  підозра, що так, lost-updates вже відбуваються тихо. Потрібен smoke test
  з двома чанками одного source-файлу, що мають однакову target-точку.
- Чи треба переходити на CRDT-подібний підхід: збирати усі `(target_id,
  source_file)` пари в окремий buffer, потім робити один pass через `scroll`
  + `set_payload` з повним новим списком (рідкісний batch у кінці phase 5).

Це окремий design ticket, не quick win.

---

### 2.5 — Sequential `shouldMerge` — **deferred, потребує quality eval (НЕ low risk)**

**Файл:** `src/indexer/phases/context.js:36-56`.

```js
export async function processChunks(chunks) {
  const merged = [];
  let i = 0;
  while (i < chunks.length) {
    const current = chunks[i];
    if (current.needsBoundaryCheck && i > 0 && merged.length > 0) {
      const prev = merged.at(-1);
      const merge = await shouldMerge(prev, current);   // ← один Ollama call за раз
      ...
    }
    ...
  }
  ...
}
```

**Проблема:** boundary-decision не можна повністю розпаралелити (бо рішення `i` залежить
від результату `i-1` — якщо merge відбувся, наступний кандидат — той самий `merged.at(-1)`).
**Але** у переважній більшості випадків `prev` НЕ змінюється — більшість чанків мають
`needsBoundaryCheck=false`, а коли всі чанки потребують перевірки, у 80%+ випадків
рішення `split`, і `prev` оновлюється до `current`.

Це означає: можна **спекулятивно** запускати усі N-1 порівнянь паралельно як один
batch (як це робить `addTagsBatch`), а потім обробляти результати у тому ж циклі
з override’ом, якщо merge змінює `prev`.

**Чому це НЕ «low risk» (виправлення):**

У поточному циклі `prev = merged.at(-1)`. Якщо chunk[i-1] був merged з
chunk[i-2], то для chunk[i] порівняння буде з merged-блоком, а не з
оригінальним chunk[i-1]. Pre-computed batch порівнює `chunks[i-1]` vs
`chunks[i]` — це **інші пари** для всіх позицій після першого merge’у.

Тобто batched варіант буде **семантично відрізнятись**: якщо chunk[i-2] +
chunk[i-1] утворюють один тематичний блок, поточний код порівняє його з
chunk[i]; batched порівняє chunk[i-1] (наполовину поза контекстом) з
chunk[i] — і може дати інший «merge» / «split» висновок.

Чи це впливає на кінцеву якість retrieval — невідомо до eval’у. Це
**окремий quality eval** на тестовому корпусі (custom-50 / custom-150) з
порівнянням MRR@10 і chunkRecall@5 до/після.

Не починати без цього eval’у.

---

### 2.6 — Sync I/O в `saveChunksMd` — **низький ROI у single-file pipeline**

**Файл:** `src/indexer/index.js:146-166`.

```js
function saveChunksMd(filePath, chunks) {
  const outDir = join(CHUNKS_OUT_DIR, basename(dirname(filePath)));
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (entry.startsWith(`${base}__chunk`) && entry.endsWith('.md')) rmSync(...);
  }
  chunks.forEach((chunk, i) => {
    writeFileSync(join(outDir, `${base}__chunk${i + 1}.md`), `...`, 'utf8');
  });
}
```

**Проблема:** усе синхронно. Для 30 чанків це 1 + (старі rm) + 30 = 60+ блокуючих
syscalls. Поки triggered, event loop не обробляє жодного іншого I/O — навіть
keep-alive Qdrant пакети чекають.

**Фікс:** `fs/promises` + `Promise.all`. ~10 рядків.

```js
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
async function saveChunksMd(filePath, chunks) {
  await mkdir(outDir, { recursive: true });
  const oldFiles = (await readdir(outDir)).filter(e => e.startsWith(`${base}__chunk`));
  await Promise.all(oldFiles.map(e => rm(join(outDir, e))));
  await Promise.all(chunks.map((chunk, i) =>
    writeFile(join(outDir, `${base}__chunk${i + 1}.md`), buildChunkMd(chunk, i, chunks.length))
  ));
}
```

**Виправлення оцінки ROI:** у поточному single-file sequential pipeline
наступний файл і так чекає завершення попереднього (бо `for...of` у
`index.js:288-291`). Тому unblock event loop сам по собі не дає прискорення.
Реальний виграш — тільки після впровадження file-level concurrency (а це Do
NOT yet за попереднім аудитом).

Залишається теоретичний benefit для MCP-серверу, який працює одночасно з
індексацією (бо event loop не блокується під час `saveChunksMd`), але це
рідкісний use case.

**Висновок:** робити при перших архітектурних змінах у `indexer/index.js`,
не як окремий ticket.

---

### 2.7 — `embedOnnx` алокаційний шум — **micro-opt, не пріоритет**

**Файл:** `src/core/onnx-embed.js:160-188`.

```js
const dims    = encoded.input_ids.dims;
const toInt64 = (data) => new ort.Tensor('int64',
  BigInt64Array.from(Array.from(data).map(BigInt)), dims);

const feeds = {
  input_ids:      toInt64(encoded.input_ids.data),
  attention_mask: toInt64(encoded.attention_mask.data),
  token_type_ids: toInt64(
    encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0)
  ),
};
```

**Проблема:** для seq_len 512 (типовий) це 3 × (Array.from → map(BigInt) →
BigInt64Array.from) = 6 алокацій масивів довжиною 512 + 1536 BigInt boxing
operations на КОЖЕН embed. Для індексації 1000 чанків — 1.5M BigInt boxings.

Також: `encoded.input_ids.data` уже є typed-array (Int32Array або BigInt64Array),
але код спершу конвертує через `Array.from`, потім через `BigInt`, потім назад у
`BigInt64Array` — три зайві проходи.

**Фікс:** конвертувати typed-array прямо в `BigInt64Array` без проміжного `Array`:

```js
const toInt64 = (data, dims) => {
  // data може бути Int32Array, BigInt64Array або number[]
  if (data instanceof BigInt64Array) return new ort.Tensor('int64', data, dims);
  const out = new BigInt64Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = BigInt(data[i]);
  return new ort.Tensor('int64', out, dims);
};
```

Дрібниця per-call, але економія масштабується з кількістю чанків.

Додатково: `processSparse` потім робить ще `Array.from(...).map(Number)` на двох
буферах (`outputs[names[1]].data` і `encoded.input_ids.data`) — теж зайве для
вже typed-array вхідних даних.

**Виправлений пріоритет:** 1–3% per call це справді micro-opt. Робити «у супутку»
з іншою роботою у `onnx-embed.js` (наприклад, разом з ONNX threading knobs
або true batching), а не окремим ticket’ом.

---

### 2.8 — `qdrant_related` MCP-tool робить N послідовних `scroll`

**Файл:** `src/mcp/tools/related.js:22-28`.

```js
for (const target of node.links) {
  const points = await scroll(collection, {
    must: [{ key: 'source_file', match: { value: target } }],
  }, 1, ['context', 'section', 'tags']);
  ...
}
```

**Проблема:** для файлу з 8 links → 8 послідовних HTTP-запитів. На холодному
з’єднанні це 1-2 секунди затримки відповіді MCP-tool.

**Фікс:** `Promise.all` усередині мапи. ~3 рядки.

```js
const points = await Promise.all(node.links.map(target =>
  scroll(collection, { must: [{ key: 'source_file', match: { value: target } }] }, 1, ['context','section','tags'])
));
```

---

### 2.9 — `addTagsBatch` fallback — **deferred, потребує вимірювання**

**Файл:** `src/indexer/phases/tag.js:93-95` (fallback), `src/indexer/index.js` (caller).

```js
// tag.js — fallback when batch JSON parse fails
if (!result) {
  console.warn(‘  [tag] batch parse failed, falling back to individual’);
  return Promise.all(chunks.map(addTags));
}
```

**Переоцінка (v3):** запропонований у v1/v2 фікс `runBatched(chunks, BATCH_SIZE, addTags)`
насправді **не змінює поведінки**. Причина:

`index.js` викликає `addTagsBatch` вже з slice розміром `BATCH_SIZE`:

```js
// index.js — phase 3 (tag)
for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
  await addTagsBatch(contextChunks.slice(i, i + BATCH_SIZE));
}
```

Тобто `chunks` всередині `addTagsBatch` — це вже masiv розміром ≤ `BATCH_SIZE`.
`runBatched(chunks, BATCH_SIZE, addTags)` над slice довжиною ≤ 3 еквівалентний
`Promise.all(chunks.map(addTags))` — обидва запускають ≤ 3 паралельних виклики.
Фікс нічого не змінює.

**Справжня проблема (якщо вона є):** при `OLLAMA_NUM_PARALLEL=1` навіть 2–3
паралельних виклики серіалізуються на сервері. Але це вже відомо з попереднього
аудиту (`#4 — OLLAMA_NUM_PARALLEL`) і не вирішується на рівні client-side batching.

**Правильні варіанти (якщо fallback стає проблемою):**

1. **Serial fallback:** `for (const chunk of chunks) await addTags(chunk)` — усуває
   будь-яку потенційну Ollama-queue-pressure при fallback; ціна: трохи повільніше
   на машинах з `OLLAMA_NUM_PARALLEL > 1`.
2. **Env knob:** `TAG_FALLBACK_CONCURRENCY` (default=1) — дає можливість tune без
   зміни дефолтної поведінки.
3. **Виміряти спочатку:** перевірити, як часто batch parse насправді падає
   (`console.warn` рядок у продакшн-логах). Якщо fallback рідкісний — не варто
   витрачати час.

**Рекомендований статус: deferred** — виміряти частоту fallback перед будь-яким
рішенням.

---

### 2.10 — Sync I/O в `chunkFile` (phase 1)

**Файл:** `src/indexer/phases/chunk.js:218-252`.

```js
const data = readFileSync(filePath);        // line 220 — PDF buffer
...
const text = readFileSync(filePath, 'utf8'); // line 252 — md/txt/etc
```

**Проблема:** phase 1 синхронно читає весь файл з диска. Для великих PDF це
блокує event loop на сотні мс. У контексті майбутньої файлової паралельності
(не зараз — це в Do NOT do yet) це теж стане видимим. Але навіть сьогодні в
single-file режимі це блокує keep-alive до Qdrant та Ollama.

**Фікс:** `readFile` з `fs/promises`. ~2 рядки.

---

## 3. Перевірка кожного існуючого пункту з 2026-05-17 аудиту — статус

| # з 2026-05-17 | Проблема | Поточний стан коду |
|----------------|----------|----------------------|
| 1 | ColBERT top-20 re-encoding | ✅ **виправлено** — `scoreColBERTAll` у `colbert-rerank.js:124`, p50 top20 = 50 ms (раніше 5971 ms) |
| 2 | Query encoded twice у ColBERT | ✅ **виправлено** разом з 1 |
| 3 | ONNX true batch inference | ❌ не зроблено — `embedOnnx` все ще batch=1 |
| 4 | `OLLAMA_NUM_PARALLEL=1` server default | ⚠ потребує лише server-side зміни, не коду |
| 5 | Sequential candidate encoding у ColBERT | ❌ не зроблено (вимагає multi-session або worker) |
| 6 | File-level concurrency | ❌ не зроблено (correctness risk — в Do NOT do yet) |
| 7 | `updatePayload` per-backlink | ❌ не зроблено — підтверджено в #2.4 вище |
| 8 | `embedForSearch` дублює dense у ColBERT-бенчмарку | ❌ не зроблено — `colbert-bench.js:218` досі викликає `embedForSearch` перед `scoreColBERTAll` |

Тобто з 8 пунктів попереднього аудиту реалізовано тільки 1-2 (топ-20 пройшов
дегенерацію). Залишається 6 пунктів плюс 9 нових, виявлених тут.

---

## 4. Рейтинг блокерів за impact / risk (v3 — за user feedback)

Окремо рейтую тільки ті, що **в межах user constraint** «лише безпечні
оптимізації». ColBERT true batching, file-level concurrency, ONNX concurrent
sessions — exclude.

### Тier 1 — робити зараз (2 quick wins)

| Rank | Блокер | Impact | Risk | Розмір |
|------|--------|--------|------|--------|
| 1 | Sync `loadGraph` на MCP search (#2.1) | 5-50 ms per search request | низький (mtime cache) | ~10 рядків |
| 2 | Parallel scroll у `qdrant_related` (#2.8) | 70-90% latency для запиту з 5+ links | нульовий | ~3 рядки |

### Tier 2 — робити після Tier 1, з тестом

| Rank | Блокер | Impact | Risk | Що ще треба |
|------|--------|--------|------|-------------|
| 4 | Подвійний embed phase 4→5 (#2.2) | 30-50% phase 5 (ONNX) / 50-70% (Ollama) | низький **за умови** equivalence test | live diff на links/backlinks до/після (див. §2.2) |

### Tier 3 — потребує вимірювання або design review

| Rank | Блокер | Що зробити перед фіксом |
|------|--------|-------------------------|
| 5 | HTTP keep-alive (#2.3) | Виміряти, чи дефолтний undici pool вже дає reuse |
| 6 | Batch payload (#2.4) | Перевірити lost-update ризик при `BATCH_SIZE>1` |
| 7 | Batched `shouldMerge` (#2.5) | Quality eval на custom-50/-150: MRR@10 і chunkRecall@5 до/після |
| 8 | `addTagsBatch` fallback (#2.9) | Виміряти частоту fallback; якщо часто — serial fallback або `TAG_FALLBACK_CONCURRENCY` |

### Tier 4 — micro-opt / низький ROI

| Блокер | Підстава |
|--------|----------|
| Async I/O в `saveChunksMd` / `chunkFile` (#2.6, #2.10) | low ROI у single-file pipeline |
| `embedOnnx` BigInt cleanup (#2.7) | 1-3% per call, micro-opt |
| `embedForSearch` дубль у `colbert-bench.js` | benchmark-only, ~120 ms / query |

---

## 5. Зв’язок з benchmark-даними

| Benchmark (results файл) | Симптом | Який блокер це підсвічує |
|--------------------------|---------|---------------------------|
| `2026-05-17-custom50-colbert-top40-...-official.txt` — c40 p50 = 11332 ms, c20 p50 = 50 ms після оптимізації | ColBERT все ще sequential, BUT після фіксу top20 — це підтверджує, що оптимізація #1/#2 попереднього аудиту вже працює | ColBERT-side; не наш scope (large-batch ONNX — в Do NOT) |
| `2026-05-16-custom50-ce-routing-v4-...txt` — ce-* p50 = 3335 ms, hybrid 50 ms | CE batched (batch=16) але CPU-bound; не наш scope для production | — |
| `2026-05-14-indexing-performance-instrumentation-audit.md` Q2 | вказує на «embed at batch=3 within-phase + sequential phases» | підтверджує #2 (подвійний embed) + #5 (sync boundary) |
| `2026-05-13-indexing-performance-analysis.md` Problem 2 | пише «LLM і ONNX ніколи не перекриваються» | архітектурне; перекриття — Do NOT yet (correctness risk через залежність text→tags→embed) |

Іншими словами: жоден benchmark **не** ловить блокери, які тут описано, бо всі
вони про **indexing** перформанс (не search), а timing на indexing нема в
жодному з benchmark-results — тільки в `INDEX_PROFILE=1` ad-hoc.

**Рекомендація:** наступний бенчмарк повинен явно фіксувати phase 5 (link) ms
per chunk до і після фіксу #2.2 та #2.4 — це найвищий ROI з безпечних змін.

---

## 6. Що НЕ робимо (явно — щоб не плутати з попереднім аудитом)

З 2026-05-17 аудиту, секція 9, переноситься без змін:

- ❌ Parallel file indexing — race conditions на graph mutations
- ❌ Pipeline overlap context/tag/embed — correctness risk через ланцюжок залежностей
- ❌ ONNX concurrent `session.run()` — не re-entrant у `onnxruntime-node@1.24.3`
- ❌ ONNX true batch inference у production (`onnx-embed.js`) — потребує API-зміни та
  верифікації batch_size>1 для трьох виходів (dense, sparse, colbert_vecs). Тільки
  в benchmark helper, як зазначено в попередньому аудиті.
- ❌ Length-bucketed batching — релевантне тільки після true batching
- ❌ ColBERT у production — explicit defer per Stage 1 verdict

Все, що в розділі 0 та 2 цього звіту, цих обмежень не стосується.

---

## 7. Рекомендований порядок впровадження (v3)

### Tier 1 — атомарні quick wins (тиждень 1)

1. **#2.1 graph cache** (~10 рядків) — `Map<collection, {mtimeMs, data}>` у
   `graph.js`. Зберігає auto-reload by mtime.
2. **#2.8 parallel scroll у related** (~3 рядки) — `Promise.all(node.links.map(...))`
   з збереженням порядку.

### Tier 2 — потребує equivalence test перед merge

4. **#2.2 reuse dense vector phase 4→5** (~15 рядків) — обов’язково:
   - спочатку уніфікувати embed-text формат у phase 4 і phase 5;
   - запустити re-index того ж corpus двічі (до зміни і після);
   - diff `links` / `backlinks` у Qdrant payload + у `graph.<col>.json`;
   - merge тільки після bit-identical (по модулю UUID) результату.

### Tier 3 — спершу вимірювати, потім вирішувати

5. **#2.3 HTTP keep-alive** — додати fetch profiler у `qdrant.js` на 1-2 reindex’и,
   порівняти p50/p95 окремих викликів. Якщо overhead < 5 ms — пропустити.
6. **#2.4 batch payload** — окремий design ticket з smoke test на lost-update
   при `BATCH_SIZE > 1` у phase 5.
7. **#2.5 batched shouldMerge** — quality eval на custom-50 (MRR@10 must ≥ baseline).
8. **#2.9 addTagsBatch fallback** — спочатку виміряти частоту fallback у логах;
   якщо часто — вибрати між serial fallback або `TAG_FALLBACK_CONCURRENCY` env knob
   (не `runBatched(BATCH_SIZE)` — це еквівалентно поточному `Promise.all`).

### Tier 4 — bundle later

- #2.6, #2.10 (async fs) — разом з file-level parallelism (поза цим scope).
- #2.7 (ONNX BigInt) — разом з true batching або ONNX threading knobs.

### Що залишається з попереднього 2026-05-17 аудиту

- #4 з попереднього: server-side `OLLAMA_NUM_PARALLEL=3` — power-user knob,
  не код, окремий experiment.
- #8 з попереднього: `embedForSearch` дубль у `colbert-bench.js` —
  benchmark-only cleanup.

---

## 8. Підсумок (v3)

Попередній аудит правильно ідентифікував два високовартісні дублікати в
ColBERT-бенчмарку (вже виправлено). Він **не дослідив** структурні вузькі
місця в індексері та MCP search, бо фокус був на ColBERT timings та LLM-фазах.

Цей звіт ідентифікує 9 нових пунктів. **Не всі вони safe quick wins** — після
review (за user feedback):

- **2 справжніх zero-risk quick wins** (#2.1 graph cache, #2.8 parallel scroll у
  related). Сумарно ~13 рядків коду.
- **1 з низьким ризиком при equivalence test** (#2.2 dense reuse phase 4→5).
  Ефект є потенційно великим, але до live diff не варто merge’ити.
- **4 потребують вимірювання або quality eval** (#2.3 keep-alive, #2.4 batch
  payload, #2.5 batched shouldMerge, #2.9 addTagsBatch fallback). Жоден не
  «починаємо одразу».
- **2 micro-opt** (#2.6/#2.10 fs/promises, #2.7 ONNX BigInt).

Найважливіше виправлення vs первинна версія цього звіту: **claims «нульового
ризику» для keep-alive і batch payload були необґрунтовані**. Кожен з цих
пунктів потребує дослідження перед фіксом.

**Найбезпечніший крок зараз:** Tier 1 (graph cache + parallel scroll у related).
Обидва — атомарні, незалежні, тестабельні. Після них — Tier 2 з equivalence test.
