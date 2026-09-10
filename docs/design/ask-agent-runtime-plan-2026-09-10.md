# Ask Agent Runtime: план реалізації для Claude

Дата: 2026-09-10. Статус: завдання на реалізацію, не опис наявного API.

## 1. Мета

Додати універсальний агентний режим Ask: модель отримує інструкції застосунку
та описи дозволених інструментів, повертає структуровані виклики, а після
отримання результатів продовжує генерацію. Інструменти виконує зовнішній
бекенд. Semidex не підключається до MCP-серверів користувача і не володіє
їхніми обліковими даними.

Перший споживач — Budget Guardian, але код Semidex не повинен знати назв
Silpo tools, категорій продуктів, кошиків, гривень чи рецептів. Наскрізний
сценарій продукту: Ask -> tool call -> перевірка й Silpo MCP у Budget Guardian
-> tool result -> наступний крок Ask. Запис у кошик і підтвердження користувача
залишаються у Budget Guardian.

Реалізувати код, тести, типи клієнта, приклад і документацію. Не зупинятися
на новому плані. Не публікувати пакет і не виконувати live cart writes.

## 2. Вихідна точка та межі

Прочитати `AGENTS.md` і `docs/design/embedded-sdk-plan-2026-09-06.md`.
У плані SDK tool calling відкладений: це завдання підвищує його пріоритет,
але не вимагає завершення embedded SDK, індексатора чи JSON storage.

Перевірені місця інтеграції:

- `src/core/generation/provider.js`, `runtime.js`, `registry.js`;
- `src/cloud/generation/gemini-provider.js`;
- `src/core/ask/coordinator.js`, `coordinator-v2.js`, `budget-ledger.js`;
- `src/core/ask-api/v1/` і `v2/`;
- `src/shared/admin/register-neutral-routes.js`;
- `src/core/http/authorize.js`, `route-audience.js`;
- `packages/lite/lite-src/client/index.js` та `index.d.ts`;
- Full/Lite composition, staging та dependency-closure перевірки.

Робоча копія містить сторонні зміни, особливо в Admin UI. Зберегти їх.
Не запускати масове форматування і не редагувати generated staging.

Grounded Ask v1/v2 зберігають чинні запити, SSE, grounding, citations та
відмови. Не додавати tool/system roles до старої conversation-схеми.
Не маскувати tool calls JSON-командами у звичайному тексті відповіді.

## 3. Архітектурне рішення

Новий режим — окремий `POST /api/v3/ask`, метод клієнта `askAgent()`.
Один HTTP-запит виконує один модельний крок до фінальної відповіді або
готової групи tool calls. Зовнішній застосунок володіє циклом виконання.

Виділити transport-neutral runtime у core; route лише авторизує, валідує
та проєктує події. Core не імпортує HTTP, Admin, CLI чи конкретний provider.
Розширити спільний generation-контракт, а не дублювати Gemini transport.

Перший реліз підтримує tool calling через Gemini. Інші провайдери явно
декларують відсутність capability та повертають `capability_unavailable`
до retrieval/генерації. Звичайний текстовий Ask у них продовжує працювати.

Це agent mode з application-controlled tools, а не обіцянка автоматичного
grounding усіх тверджень. Retrieval підключається явно через інструменти
застосунку над чинним Semidex Search/Content API. Не запускати прихований
пошук на кожному tool-result кроці й не видавати текст tool result за
підтверджену цитату з індексу. Автоматичний grounded-agent preset — поза зрізом.

## 4. Provider-контракт

Додати окрему capability і метод структурованого кроку поряд із чинним
текстовим `generate()`. Конкретні назви узгодити з existing conventions.

Нейтральний input включає system instructions, user/assistant/tool messages,
tool definitions, output budget, AbortSignal. Tool definition містить `name`,
`description`, `inputSchema`. Для MVP визначити підтримувану підмножину
JSON Schema: object/properties/required/additionalProperties, базові типи,
enum, arrays/items. Непідтримані конструкції відхиляти явно, не видаляти.
Використати наявний validator або перевірену бібліотеку замість власного
неповного JSON Schema engine. Обмежити розмір, глибину і кількість tools.

Результат розрізняє `completed` і `requires_action`; tool call має унікальний
`id`, `name`, `arguments` як JSON object. Валідувати ім'я за allowlist та
аргументи за схемою до передачі виконавцю. Не приймати текст, схожий на JSON,
за native function call. Partial arguments не є виконуваною подією.

Перед реалізацією перевірити встановлену версію `@google/genai` і офіційну
документацію: function declarations, function responses, streaming, finish
reasons, thought signatures та правила продовження. Не покладатися на пам'ять.
Зберегти необхідні native parts/signatures у приватному provider state;
не перестворювати наступний contents лише з text/name/args, втрачаючи metadata.
Не повертати hidden reasoning чи приватний provider state у публічному API.
Якщо провайдер не повернув call ID, адаптер створює стабільний ID і зберігає
мапінг до native call у continuation state.

Одна відповідь може містити кілька calls. Порядок та IDs зберігаються;
зовнішній executor сам вирішує, чи дозволено паралельне виконання.
Safety refusal, незавершений stream і token limit не є `completed`.

## 5. HTTP та continuation

Початковий запит (ескіз, який реалізація має закріпити тестами):

```json
{
  "input": "Find an appropriate option",
  "systemInstructions": "Application-owned instructions",
  "tools": [{
    "name": "lookup_items",
    "description": "Read available items",
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"],
      "additionalProperties": false
    }
  }]
}
```

Продовження містить лише `continuationId` і `toolResults`, кожен результат —
`callId` плюс discriminated success/error payload. Інструкції, tools, модель
і бюджет у continuation-запиті змінювати не можна. Застосунок створює новий
run для нової задачі. Колекції у tool args не надають доступу: кожний
Search/Content виклик окремо проходить чинну collection authorization.

Використати обмежений instance-scoped in-memory continuation store:

- випадковий непрозорий ID, TTL, max active runs, max bytes на run і глобально;
- прив'язка до стабільної identity авторизованого integration principal;
- frozen instructions/tools/model, історія та приватний provider state;
- pending call IDs та стан ready/in-flight/consumed/expired;
- atomic claim перед платним continuation-кроком, один переможець replay;
- missing/extra/duplicate results відхиляються до генерації і claim;
- malformed request не спалює валідне продовження;
- перевірка scope/revocation/budget на кожному запиті, не лише на старті;
- expiry/close звільняють пам'ять; рестарт чесно робить старий ID недійсним.

Приймати одну повну групу результатів на крок; не виконувати часткове
продовження. Зміст результату є зовнішніми даними, а не system instructions.
Валідація JSON не доводить істинність результату — за нього відповідає executor.

Reuse чинної integration authorization і `COST_CLASS.LLM`. Визначити явне
право на agent mode за існуючим механізмом scopes: не відкривати нове керування
інструкціями всім search-only tokens. Додати міграційні інструкції для ключів.
Без розширення доступу до Admin-only routes або всіх колекцій.

SSE: `answer_delta` для тексту, один terminal `done` зі статусом `completed`
або `requires_action`, чи terminal `error`. Лише `done(requires_action)`
передає повністю перевірені calls і continuationId. Після початку SSE
помилка не перетворюється на успішний done. Sources/citations не вигадувати.
Модельний текст до `requires_action` не називати завершеною відповіддю.

Немає автоматичного retry після початку генерації, втрати stream або
неоднозначного timeout. Повтор старого continuation не запускає генерацію.
За втраченої відповіді executor не повторює дію лише тому, що Ask недоступний.
Цей store не гарантує exactly-once зовнішніх side effects — це документувати.

## 6. Бюджети та lifecycle

Reuse чинного spend/token ledger: кожний модельний крок проходить accounting,
а run має сукупний ceiling і max model steps/tool calls. Межі задає оператор;
клієнт може їх лише зменшити. Початковий крок також рахується.

Рахувати instructions, tool schemas, history, tool results і резерв output.
Не обрізати arguments/results або незавершені call/result пари мовчки;
повертати `context_budget_exceeded`. Для першого релізу не додавати приховану
LLM-компактизацію. Pending run не утримує generation lock між запитами.
Поточний single-flight policy поширюється й на v3, без глобального singleton.

Abort/disconnect зупиняє локальне читання, звільняє lock та reservations.
Не обіцяти припинення білінгу провайдера, якщо capability цього не гарантує.
Логи містять codes, counts, timings, usage; без prompts, results, tokens,
continuation IDs і provider-private metadata.

## 7. Клієнт і пакування

Додати typed `askAgent()` до чинного `semidex-lite/client`: discriminated
request/event/result types, total timeout, AbortSignal, existing error style.
Невідомі SSE events не запускають tools і не стають terminal success.
Не додавати автоматичний executor чи implicit retries у клієнт.

Full/Lite composition підключають той самий core через DI. Перевірити
packaged artifact, dependency closure та імпорт клієнта зі встановленого
tarball, а не лише зі source tree. Окремий пакет SDK у цей реліз не потрібний.

Додати runnable backend-only приклад з synthetic read-only `lookup_items`:
start -> requires_action -> local allowlist/schema validation -> fake result
-> continuation -> completed. Credentials лише з environment, жодних live
MCP writes. Приклад має пояснювати, що дозвіл на side effects належить executor.

## 8. Етапи та приймання

1. Provider primitive: capability, typed calls/results, Gemini native mapping,
   збереження continuation metadata. Tests: multiple calls, invalid name/args,
   interrupted stream, refusal, unsupported provider, native continuation.
2. Core runtime/store: frozen run context, exact pending-result matching,
   TTL, memory caps, concurrency, aggregate budget, cancellation. Tests:
   replay, two concurrent claims, cross-principal ID, expired run, limits,
   malformed results without token consumption, cleanup after error.
3. HTTP/client/composition: production route wired with auth/cost metadata,
   SSE terminal semantics, typed client. Tests через реальний router і fake
   provider; unauthenticated/insufficient-scope/revoked key -> zero generation.
4. Release evidence: Full/Lite regression, packaged-client integration,
   runnable example, docs та opt-in Gemini live characterization.

Обов'язковий наскрізний offline тест проходить саме HTTP client -> route ->
core -> Gemini adapter з fake SDK transport -> tool result -> continuation
-> final. Окремий тест доводить, що Semidex не виконує переданий інструмент
самостійно. Fake model test не називати доказом live tool calling.

Live characterization має бути opt-in, з обмеженими кроками/output і простим
локальним read-only інструментом. Якщо не виконано, релізний звіт прямо
позначає це як неперевірене, а не замінює доказом за конструкцією.
Перед broad stable release потрібен live native call/result round trip;
за його відсутності позначити новий режим experimental.

## 9. Документація і фінальний звіт

Оновити SDK-план: tool calling тепер реалізується цим зрізом; embedded SDK,
JSON storage та indexing refactor залишаються окремими задачами. Описати v3
request/SSE/errors, scopes, TTL/restart semantics, limits, supported provider
і JSON Schema subset. Старі v1/v2 приклади лишаються робочими.

Звіт: фактичний production call chain, змінені файли, виконані команди й
результати тестів, зміни доступу, sanitized live evidence або чітке його
відсутнє підтвердження. Без секретів і реальних користувацьких payloads.

Не заявляти, що Budget Guardian вже інтегрований: його wiring, агентний UI,
Silpo tool allowlist і демонстрація — наступне завдання після ревю цього API.
