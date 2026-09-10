# План вбудованого Semidex SDK

Дата: 2026-09-06. Статус: проєкт реалізації; API нижче запропонований і ще не існує.
Робоча назва пакета: `semidex-sdk`; доступність назви в npm не перевірялася.

## 1. Мета та результат

Розробник встановлює бібліотеку у свій Node.js бекенд і викликає індексацію,
пошук та Ask звичайними функціями. Окремий процес Semidex, його HTTP-сервер,
Admin UI та MCP для цього не потрібні. Qdrant і вибрані зовнішні модельні
сервіси залишаються інфраструктурними залежностями відповідного провайдера.

Бекенд розробника володіє HTTP-роутами, автентифікацією, доступом до колекцій,
історією розмов, конфігурацією, системними інструкціями та життєвим циклом SDK.
SDK відповідає за документний pipeline, retrieval, складання доказів,
генерацію, цитування й технічні обмеження виконання.

Окремий продукт означає окремий npm-пакет, exports, типи, документацію,
приклади та версіонування. На першому етапі він живе в `packages/sdk` цього
репозиторію. Окремий Git-репозиторій не потрібен для незалежного встановлення.

## 2. Підтверджена основа в поточному коді

| Ділянка | Поточна реалізація | Наслідок для SDK |
|---|---|---|
| HTTP-клієнт | `packages/lite/lite-src/client/index.js`, `index.d.ts`: search, askV1, askV2, askText | Зберегти чинний клієнт і контракт; він обслуговує віддалений сервер |
| Пакування Lite | `packages/lite/package.json`, `build.mjs`: curated staging, перевірка залежностей зібраного пакета | Повторно використати механізм перевірок, без UI та CLI у SDK |
| Retrieval | `src/core/retrieval/search.js`: `runHybridSearch({adapter, embedQuery, ...})` | Використати той самий алгоритм; прибрати неявні глобальні fallback-залежності зі шляху SDK |
| Ask | `src/core/ask/coordinator.js`: `createAskCore`; `coordinator-v2.js`: спільне ядро та gate | Виділити бібліотечний контракт над спільним ядром |
| Промпти | `src/core/ask/prompt.js`; `evidence.js` рахує токени через `buildPromptParts()` | Власний промпт має використовуватися і під час підгонки доказів, і під час генерації |
| Storage | `src/core/storage/adapter.js`, `qdrant-adapter.js` | Контракт можна розвивати; зараз він не є повним контрактом запису для індексатора |
| Qdrant | `src/core/qdrant/client.js`: dotenv import, env credentials, module cache | Потрібна фабрика незалежних клієнтів/store, з explicit config |
| Config/settings | `src/shared/core/config.js`: шлях визначається на рівні модуля; `settings/service.js`: є env write-back | SDK використовує власні instance-scoped settings/profile repository |
| Індексація | `src/shared/indexer/run.js`: module-level COLLECTION, SOURCE_ROOT, mutable profile/settings, process.exit | Обов'язкове відокремлення runner від CLI та спільного mutable state |
| JSON-файли | `src/shared/indexer/files.js`: `.json` відсутній у supported extensions | JSON storage і JSON ingestion потрібно спроєктувати явно |

Це оцінка поточної робочої копії. У ній уже є сторонні незакомічені зміни;
цей план їх не змінює і не вважає частиною SDK-рефакторингу.

## 3. Межі першого релізу

Перший повний preview включає:

- Node.js ESM і TypeScript declarations; нижню версію Node узгодити з чинним пакетом і CI.
- Qdrant storage з явним URL/key або клієнтом, переданим користувачем.
- Cloud embedding/Gemini як перший перевірений наскрізний шлях та контракти для власних провайдерів.
- Пошук, читання chunks/content/skeleton, Ask із потоковою та зібраною відповіддю.
- Незалежні `context.build`, `generate`/`generateStream`; generation provider
  не потрібний для indexing/retrieval-only використання.
- Індексацію Markdown, plain text та документів у пам'яті; JSON через явне перетворення.
- Окреме JSON-сховище конфігів у Qdrant.
- Скасування, прогрес, типізовані помилки, close та ізоляцію екземплярів.

Не блокують перший preview: готові Express/Fastify/Nest adapters, browser runtime,
вбудований чат UI, автоматичне збереження розмов, distributed job queue,
публікація всіх локальних провайдерів, повна підтримка всіх файлових конвертерів.
Локальні ONNX/Ollama реалізації зберігаються для Full; їх підключення до SDK
потребує окремого acceptance, зокрема щодо ресурсів і закриття workers.

## 4. Архітектура та пакування

```text
Бекенд розробника -> packages/sdk -> спільні бібліотечні сервіси
Full CLI/MCP/Admin -------------> ті самі сервіси
Lite CLI/Admin ----------------> ті самі сервіси
                                  |
                        storage / embedding / generation
```

Правило залежностей: бібліотечне ядро не імпортує composition roots Full/Lite,
HTTP routes, CLI bootstrap або Admin UI. Transport адаптує ядро, а не навпаки.
Не створювати другу реалізацію ranking, chunking або Ask у `packages/sdk`.

Runtime тут означає engine з lifecycle, а не обов'язково окремий OS process.
Основний SDK виконує engine у процесі бекенду. Full/Lite запускають його через
власні application entry points. Lite залишається cloud-oriented distribution,
що може бути self-hosted; цей план не перетворює її на hosted service.
Керування daemon через IPC/HTTP можливе як майбутній transport adapter, але
не є умовою SDK і не входить у перший preview. HTTP client залишається валідним
видом SDK для віддаленого сервісу; новий пакет додає саме embedded primitives.

Пропоновані exports:

- `semidex-sdk`: `createSemidex`, публічні типи та помилки.
- `semidex-sdk/qdrant`: фабрика storage та JSON store.
- `semidex-sdk/providers/gemini`, `semidex-sdk/providers/qdrant-cloud`: готові адаптери.

Відокремлений export сам собою не прибирає npm-залежності. Важкі локальні
провайдери/конвертери надалі постачати окремими пакетами або explicit peer
dependencies; не включати їх як звичайні залежності основного SDK.

На старті застосувати staging зі спільних джерел, як у Lite. Generated code
не редагувати й не комітити. Загальний closure validator виділити лише настільки,
наскільки це потрібно двом пакетам; не переписувати весь build на workspaces.
Перехід на фізичний пакет shared core можливий пізніше, без зміни публічного API.

## 5. Запропонований публічний контракт

### Створення й володіння ресурсами

```ts
// Ескіз майбутнього API, не готовий приклад для запуску.
const storage = createQdrantStorage({ url, apiKey });
const sdk = createSemidex({
  storage,
  embedding,
  generation,
  settings: { /* типізовані налаштування */ },
  ask: { systemInstructions: 'Відповідай українською у стилі нашого продукту.' },
  logger,
});

await sdk.ready();
await sdk.index.documents({ collection: 'docs', documents });
const hits = await sdk.search({ collection: 'docs', query: 'Як налаштувати оплату?' });
const answer = await sdk.ask({ collection: 'docs', question: 'Як налаштувати оплату?' });
await sdk.close();
await storage.close(); // зовнішній ресурс закриває його власник
```

`createSemidex()` перевіряє конфігурацію без мережі; `ready()` виконує явну
перевірку готовності без створення/міграції користувацьких колекцій і без
платної пробної генерації. Мережеві probes з витратами — окремі explicit операції.
SDK не завантажує `.env`, не змінює cwd/env, не встановлює signal handlers
і не відкриває HTTP-порт. CLI може робити це у власному bootstrap.

`close()` ідемпотентний: припиняє прийняття нових операцій, скасовує активні,
чекає обмежений час на завершення та звільняє ресурси, створені SDK.
Передані користувачем ресурси не закриваються автоматично.

### Функції

| API | Основний контракт |
|---|---|
| `collections.create/get/list` | Профіль embedding обов'язковий при створенні; невідповідність профілю не виправляється мовчки |
| `search` | Типізовані hits, metadata, filters; без залежності від HTTP envelope |
| `context.build` | Context із переданих hits, source mapping, budget і truncation metadata; без прихованого повторного search |
| `generate`, `generateStream` | Явні systemPrompt/messages/context/model options; без retrieval і автоматичного застосування Ask policy |
| `content.get`, `chunks.get`, `skeleton.get/children` | Використовують чинну семантику bounded context і navigation |
| `ask` | Зібраний результат: text, sources/citations, usage, completion/refusal status |
| `askStream` | AsyncIterable discriminated events; один terminal result/error, cancellation через AbortSignal |
| `index.documents` | Документи з id, content, format, metadata; без тимчасових файлів як обов'язкового посередника |
| `index.path` | Явні collection, sourceRoot/path, signal, onProgress, prune policy |
| `documents.delete` | Видалення за стабільним source identity, узгоджене з navigation metadata |
| `storage.collection(name)` | App-owned JSON records: upsert/get/delete/list; окремий контракт від managed retrieval collections |

`index.documents` має upsert-семантику за стабільним document id: повторний
запис замінює попередній документ і прибирає застарілі chunks. Окремий alias
`documents.upsert` не вводити до обґрунтованої потреби. Це не raw points upsert.

Усі довгі операції приймають `signal`. Public SDK errors мають стабільний `code`,
безпечне повідомлення та cause; HTTP status з'являється тільки в transport adapter.
Ask не робить автоматичних повторів після неоднозначної відмови генерації.

Публічний Ask не дублює назви HTTP v1/v2: один conversational API, опційна
історія як input та оновлений контекст як output. Зберігання й розділення
розмов за користувачами належать бекенду. Existing v1/v2 залишаються сумісними.

### Композиція замість обов'язкової Ask orchestration

```ts
// Ескіз: усі три операції можна використовувати незалежно.
const results = await sdk.search({ collection: 'docs', query, filters });
const context = await sdk.context.build({
  query, results, strategy: 'compact', maxTokens: 3000,
});
const answer = await sdk.generate({
  systemPrompt: myPrompt, messages, context, options: modelOptions, signal,
});
// Або передати context власному LLM/agent loop без sdk.generate().
```

`context.build` повертає text, sources, stable node/document IDs, citation
mapping, оцінку токенів/ідентичність tokenizer та причини скорочення.
Перший strategy — deterministic compact assembly. Якщо потрібне додаткове
читання raw structural nodes, воно виконується через переданий storage і
дотримується області переданих hits; цей I/O документується.

Reranking і compression — явні opt-in hooks з signal, budget та збереженням
source mapping; другий rerank не запускається автоматично після search.
LLM compression не є прихованою витратою context.build. Власні transformers
можна підключити в preview; готові додаткові стратегії не блокують реліз.

`generate` перевіряє фінальний input/output budget з tokenizer вибраної моделі;
оцінка context.build не замінює цю перевірку, особливо при зміні провайдера.
Raw generation не обіцяє grounded answer або validated citations. Ask додає
відповідні policy/validators поверх тих самих primitives.

Generation messages мають окремий контракт від HTTP Ask conversation;
model options і tool definitions передаються лише за заявленої provider
capability. Непідтримані options/tools повертають явну помилку. SDK сам не
виконує tools і не запускає agent loop.

**Оновлення 2026-09-10.** Tool calling більше не «подальший етап» у сенсі
нереалізованого: його реалізовано окремим зрізом — agent mode, `POST
/api/v3/ask` та `askAgent()`/`agentStep()` у клієнті. Див.
`docs/en/agent-api-v3.md`. Ключове для цього плану:

- Ядро agent mode (`src/core/agent/runtime.js`, `continuation-store.js`,
  `tool-schema.js`) є transport-neutral і не імпортує HTTP/Admin/CLI. Саме
  тому майбутній embedded SDK перевикористовує його напряму, без HTTP.
- Provider-контракт розширено окремою capability (`agentStep`,
  `capabilities().toolCalling`), а не зміною `generate()`. Провайдер без
  tool calling повертає `capability_unavailable` ДО retrieval/генерації.
- Підтримується лише Gemini. Підмножина JSON Schema для tool-схем — явна;
  непідтримані конструкції відхиляються, а не ігноруються.
- SDK і надалі НЕ виконує tools і НЕ запускає agent loop: цикл виконання
  належить застосунку. Це не змінилося — змінилося лише те, що тепер існує
  структурований спосіб отримати виклик і повернути результат.

Embedded SDK, JSON storage та indexing refactor залишаються окремими
задачами; цей зріз їх не закриває і не блокує.

Ask — preset над search/context/generation з evidence policy, citations,
refusal, history/rewrite/summary та спільним request budget. Це не буквально
три виклики: додаткові кроки також зберігаються і тестуються.
Зовнішній orchestrator може використати лише потрібні primitives, не
відтворюючи внутрішній HTTP контракт або Ask conversation state.

`createSemidex` перевіряє лише передані capabilities. `ready()` не вимагає
generation credentials у retrieval-only екземпляра; виклик generate/ask без
generation повертає `capability_unavailable`. Операція також перевіряє власні
залежності: читання вже збереженого content не потребує embedding provider.

## 6. Контроль промпта й Ask runtime

Режим за замовчуванням: додаткові `systemInstructions` поряд зі стандартними
правилами grounding/citations. Для повного контролю — `promptBuilder`, що
отримує question, evidence, conversation і повертає system/user parts.
Це trusted server-side configuration, а не поле, яке HTTP route автоматично
приймає від браузера.

Потрібні зміни:

1. Передати єдиний prompt builder через evidence fitting і generation.
2. Після остаточного вибору/перенумерації evidence побудувати й перевірити
   фінальний prompt; саме ці parts передати провайдеру.
3. Врахувати output reservation, question, history і custom instructions.
   Якщо prompt не вміщається навіть без evidence — повернути явну помилку.
4. Визначити default та custom answer policies. Custom formatting, що не
   підтримує стандартні citation markers, не повинен отримувати неправдивий
   статус «citations validated». Grounded режим за замовчуванням зберігається.
5. Rewrite/summary prompts мають власні hooks: зміна answer prompt не повинна
   мовчки змінювати призначення цих двох операцій.
6. Budget ledger створюється для кожного SDK Ask незалежно від HTTP auth.
   Облік account spending/quotas підключається окремим host callback.
7. Gate/concurrency належить екземпляру. У першому preview документувати
   обмеження за замовчуванням; не обіцяти необмежений parallel Ask.

Типи streaming events не перевикористовують raw SSE envelope. Чинні HTTP
маршрути проєктують core events у власні v1/v2 контракти та зберігають їхні тести.
Обов'язкові випадки: early iterator return, abort до/після першого token,
помилка provider, відсутність evidence, помилка prompt builder, переповнений budget.

## 7. Qdrant та JSON-конфіги

### Незалежні storage instances

Перетворити Qdrant client/store на фабрики з явними read/write clients,
таймаутами й network policy. Зберегти нинішні правила URL prefix/port,
нормалізацію помилок і захист egress у стандартній фабриці.
Переданий клієнт є явною залежністю host application; не стверджувати, що
внутрішня policy перехоплює всі його прямі виклики.

Повний raw Qdrant API доступний через клієнт, який створив/отримав розробник.
Не дублювати весь офіційний Qdrant SDK у Semidex. Raw mutation managed
collection обходить інваріанти Semidex; звичайні документні записи проходять pipeline.

### JSON storage

Provider-neutral публічна поверхня — `sdk.storage.collection(name)` з
методами `upsert({id, payload})`, `get(id)`, `delete(id)`, `list({cursor, limit})`.
Namespace задається у storage configuration. Ініціалізація колекції — явна
операція `sdk.storage.createCollection(name)`; отримання handle не робить I/O.
`createQdrantJsonStore` — фабрика Qdrant-реалізації цього контракту, не другий
паралельний public API з назвами put/key/value.

Generic records capability є окремою від RetrievalStorage: backend може
підтримувати retrieval і не підтримувати records або native access.
Capabilities перевіряються до виклику; unsupported має явний error code.
Не переносити Qdrant filter DSL, vector schema, scroll offsets чи snapshots
в generic records API. Перший контракт обмежений CRUD і opaque pagination;
другий database provider не потрібен для першого релізу, але contract tests
використовують нейтральний in-memory adapter.

Qdrant escape hatch: `sdk.storage.raw({provider: 'qdrant'})` повертає
типізований native client лише за збігу provider/capability. Типи Qdrant
живуть у `semidex-sdk/qdrant`; основні SDK results не залежать від них.
Raw calls обходять generic contracts, SDK audit/budgets і managed schema checks;
володіння клієнтом та правила close залишаються явними.

Внутрішній record: namespace, id, payload, schemaVersion, updatedAt; Qdrant point ID — стабільний
UUID від namespace/id із перевіркою payload identity. `payload` — JSON object,
без виконання або автоматичного застосування конфігурації до SDK.
Визначити розмір запису, відхилення циклів/BigInt/не-JSON значень і pagination.

Колекція конфігів має окрему ownership metadata; Semidex не повинен додавати
до неї retrieval schema або включати її в документну навігацію. Перевірити
поведінку list/sync/doctor щодо сторонніх і config collections.
Generic collection handle відхиляє записи в Semidex-managed retrieval
collections. Namespace є областю імен, а не механізмом авторизації;
доступ користувачів і tenant mapping визначає бекенд.

Для підтвердженого read-after-write використовувати завершений запис, а не
лише прийняття запиту. Перший контракт — last-write-wins без обіцянки CAS,
транзакцій чи distributed locks. Vectorless collection/points та їх сумісність
зі підтримуваним Qdrant підтвердити live spike до фіксації схеми.

### JSON як знання

`index.documents` приймає результат явного JSON mapper: id, text/markdown,
metadata та original object/reference. Mapper визначає поля для пошуку,
стабільний порядок і відображення масивів. Саме JSON storage нічого не embed-ить.
Markdown mapper може отримати skeleton через чинний Markdown pipeline;
не обіцяти нативну JSON skeleton-навігацію в першому релізі.

## 8. Послідовність реалізації

Кожен етап — окремий reviewable PR або мала серія PR. Не переходити до
масової міграції наступного шару, поки не пройдено критерій поточного.

| Етап | Робота й основні файли | Критерій завершення |
|---|---|---|
| 0. Контракти й baseline | Інвентар import graph SDK entry points; зафіксувати exports, provider ownership, error/event types; існуючі Full/Lite checks | Погоджений API draft, список глобальних залежностей і baseline результатів; відомі попередні failures відділені |
| 1. Storage/config isolation | `core/qdrant/{client,store,ensure-schema}.js`, `core/storage/*`, `shared/core/config.js`, settings/profile caches | Два екземпляри з різними клієнтами/колекціями працюють паралельно без env write-back; CLI wrappers сумісні |
| 2. Retrieval/context primitives | `core/retrieval/*`, assembly, context.build, embedding capability wiring; SDK composition root | Search + bounded context без generation credentials, Semidex HTTP, env та config.json; context можна передати зовнішньому LLM |
| 3. Generation та Ask preset | generate/generateStream, `core/ask/*`, generation runtime, transport mapping | Незалежна generation та ask/askStream поверх спільних primitives; custom prompt, tokens/citations, abort, budgets; existing v1/v2 tests проходять |
| 4. Embedded indexer | `shared/indexer/run.js`, index-runtime, phases, files, progress; typed write capability | `index.documents` і `index.path` без process.exit/global settings; два незалежні indexing runs не змішують стан |
| 5. Generic records та Qdrant adapter | Storage records contract, Qdrant JSON store, typed raw access, mapper, ownership classification | Нейтральні contract tests + Qdrant roundtrip, namespace isolation, overwrite/delete/list, restart persistence; generic writes не торкаються managed retrieval |
| 6. Package та integration | `packages/sdk`, build validator, exports/types, README en/uk, standalone example | npm pack + clean install поза repo, відсутність UI/MCP/native важких deps у базовому SDK |
| 7. Compatibility та preview | Full/Lite regression, live acceptance, release notes та migration guide | Пройдені gates нижче; публікація тільки після конкретного release review |

Залежності: 0 → 1 → 2 → 3; 4 потребує 1 та стабільних provider contracts;
5 потребує 1; 6 збирає 2–5; 7 завершує все. Retrieval+Ask можна показати
як внутрішній milestone після етапу 3, але це ще не весь запитаний SDK.

### Деталі найризикованішого етапу 4

- Винести collection/sourceRoot/profile/settings/capabilities у контекст запуску.
- Замінити process.exit на return/result/errors; process exit codes залишити CLI.
- Передавати write store у pipeline, включно з schema/profile/indexing state.
- Винести читання argv/env, логування CLI та filesystem config у bootstrap.
- Зберегти entity_raw-before-fragments ordering, deterministic IDs,
  incremental detection, Markdown skeleton rollup та prune semantics.
- Явно визначити завершення index(): записи й фінальна metadata вже доступні
  для читання; перевірити нинішні wait:false writes та додати потрібний barrier.
- Cancellation може залишити частково записану колекцію: повернути стан,
  позначити незавершену індексацію й підтримати повторний запуск; не обіцяти rollback.
- Prune дозволений тільки для явно повного source root. Documents API не
  трактує передану підмножину як повний набір для видалення решти.
- Спочатку serialize writes в одну колекцію в межах екземпляра; одночасні
  writers із різних процесів мають координуватися host application.

## 9. Перевірки та критерії приймання

### Автоматичні gates

1. Import пакета без env/config files: немає dotenv loading, listener, server,
   мережевих викликів або filesystem writes.
2. Instance isolation: різні URLs/keys, profiles, prompts/settings; паралельні
   запити та close одного екземпляра не змінюють поведінку іншого.
3. Retrieval parity: одинакові fixtures/config дають однакову семантику ranking,
   filters, sources і bounded content через SDK та серверний шлях.
4. Ask contracts: prompt і token budget узгоджені; citations/refusal/history,
   stream cancellation, errors, concurrency, spend ledger перевірені.
5. Index correctness: Markdown структури, повторна індексація, видалення,
   partial failure/retry, stale prune, запис/читання без гонки завершення.
6. JSON: exact object roundtrip, namespace separation, cursor listing,
   неправильні типи/ліміти; config collections не змінюються через sync.
7. Strict TypeScript consumer tests для exports, events narrowing і errors.
8. Packed tarball у чистому каталозі: imports не виходять за пакет, generated
   files існують, залежності задекларовані, native engines не встановлюються випадково.
9. Існуючі Full/Lite boundary та відповідні CLI/MCP/HTTP tests; smoke і повний
   unit suite на фінальному integration gate, typecheck чинного Lite client.
10. Primitives незалежні: search/context без generation; generate без search;
    Ask і ручна композиція використовують спільні сервіси. Тестувати prompt,
    source mapping і budget, а не однаковий текст різних orchestration policies.
11. Generic storage contract працює з in-memory і Qdrant adapters; provider
    mismatch у raw(), unsupported records та запис у managed collection
    відхиляються явно. Core declarations не імпортують native Qdrant types.

### Live acceptance

На окремих disposable collections виконати clean-installed SDK:
create → index Markdown + in-memory document → search → ask/stream із власним
prompt → generic JSON upsert/get → restart consumer → read → delete test collections.
Перевірити cloud шлях, реальні write visibility та vectorless JSON schema.
Model output перевіряти за формою/grounding та застосуванням промпта, а не
вимагати побайтово однаковий текст недетермінованої генерації.
За відсутності credentials зафіксувати live gate як невиконаний, не підміняти mock.

### Developer acceptance

Приклад бекенду має працювати лише з установленим пакетом і власною
конфігурацією: index endpoint/job, search route, streaming Ask route та configs.
У прикладі показати перевірку collection access, AbortSignal при disconnect,
persisted conversation у host і graceful shutdown. Не вимагати serve/admin/MCP.
Додати другий приклад retrieval-only: search → context.build → зовнішній
generation callback без Semidex Ask та generation provider; а також приклад
ручної композиції з sdk.generate для контролю messages/model options.

## 10. Сумісність і керування обсягом

- Не перейменовувати та не видаляти `semidex-lite/client` у цьому циклі.
- Default prompt, retrieval, schema/profile правила Full/Lite зберігаються.
- Env/file settings лишаються підтримуваними в application bootstrap;
  SDK configuration має явний пріоритет і ніколи не пишеться назад у env.
- Full/Lite використовують shared factories через власні composition roots;
  вони не зобов'язані залежати від опублікованого npm SDK під час розробки.
- До завершення gate кожного етапу підтримувати legacy wrappers, але без
  другої реалізації алгоритмів. Видаляти wrapper лише після міграції всіх callers.
- Не поєднувати SDK зміни з поточними UI змінами або провайдерними оновленнями.

## 11. Ризики й рішення до стабільного 1.0

| Ризик/рішення | Як закрити |
|---|---|
| Приховані env/singletons у транзитивних imports | Інвентар reachable graph плюс паралельні real-instance tests; одного grep недостатньо |
| Власний prompt ламає citations/token accounting | Єдиний prompt pipeline, явна answer policy, окремі tests на довгі інструкції |
| Qdrant використовується як config DB | Чіткий last-write-wins контракт; live перевірка persistence/read-after-write, без вигаданих transactional гарантій |
| Ресурси сторонніх providers | Явне ownership; idempotent close, no forced close зовнішніх клієнтів |
| Зростання інсталяції | Dependency graph і clean-install gate; converters/local providers окремо |
| In-process CPU/memory навантаження | Виміряти responsiveness/RSS індексації; concurrency limits, можливість host job worker без обов'язкового daemon |
| Незалежні релізи зі shared sources | Повторюваний staging, versioned contracts, package acceptance на кожному релізі |

До 1.0 окремо зафіксувати підтримувані provider/model combinations, мінімальні
версії Node/Qdrant, JSON schema compatibility, semver policy та правила
custom prompt validation. Це не перешкоджає початку етапів 0–1.

## 12. Definition of done

SDK завершений для першого повного preview, коли сторонній бекенд із чистого
встановлення індексує документи, шукає, генерує відповіді з власними системними
інструкціями та читає/записує JSON у Qdrant без окремого Semidex-процесу;
екземпляри ізольовані, imports без побічних ефектів, Full/Lite сумісні,
типи/пакування/live acceptance підтверджені й є робочий приклад інтеграції.
Retrieval/context/generation доступні окремо; Ask є preset над ними.
App-owned JSON доступний через нейтральний records API, а native Qdrant —
через explicit typed escape hatch, без Qdrant types у базовому контракті.

Перший конкретний implementation PR: instance-scoped Qdrant store/config
factories, compatibility wrappers і тест двох незалежних екземплярів.
Оцінку строків уточнити після етапу 0: найбільша невизначеність — транзитивна
конфігурація й стан індексатора, а не створення каталогу npm-пакета.
