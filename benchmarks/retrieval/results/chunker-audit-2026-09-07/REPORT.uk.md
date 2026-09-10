# Аудит Markdown-чанкера — 2026-09-07

## Висновок

Архітектура продумана для структурованої документації: AST, окремі структурні сутності, навігація, контекст заголовків, збереження canonical raw для розділених сутностей. Проте поточна реалізація не гарантує збереження змісту. Це не лише питання оптимального розміру чанків: є відтворювані втрати фактів і зміни команд. Перед наступним тюнінгом retrieval варто закрити ці дефекти.

## Що перевірено

- Прочитано skeleton parser, policy, chunk assembly, recursive splitting, structural splitter, nav identity, coordinator dispatch і ONNX truncation.
- Запущено 95 тестів у п'яти файлах: entity-split, skeleton-chunk-budget, token-budget-split, skeleton-first-invariant, skeleton-payload-entity-refs. 95 pass, 0 fail.
- Вісім власних offline fixtures через справжні parseSkeleton → chunkFromSkeleton → buildFileSkeleton. Скрипт `probe.mjs`, результат `probe.json` поруч. Запуск: `node benchmarks/retrieval/results/chunker-audit-2026-09-07/probe.mjs`.
- У fixture-викликах бюджет null, що відповідає локальному Markdown-шляху. Qdrant/embeddings не запускались, колекції не змінювались.
- Спроба виміряти справжні BGE tokens не завершилася за час перевірки й була перервана; причина не встановлена. `tokens: null` у результаті означає відсутність вимірювання. Не видаємо chars/4 за реальні токени.
- Переглянуто історичний clean carryover report від 2026-06-28: 13 targets, exact-token @10=10/13. Це історичне вузьке свідчення, не поточний comprehensive benchmark чанкінгу.

## Підтверджені проблеми й пріоритет

### P1: відсікання коротких фактів

`node-policy.js: meaningfulTokenCount/isContentBearing`, `skeleton-chunk.js: flushProse`.

Документ із секціями `Defaults → Timeout: 30s.` та `Security → TLS required.` дає **0 retrieval chunks**. Парсер бачить обидва факти, але gate вимагає щонайменше 4 whitespace-токени. Навігаційні точки не замінюють evidence. Це особливо небезпечно для налаштувань, коротких FAQ і відповідей так/ні. Короткий хвіст після splitting теж проходить цей gate.

Виправлення: відрізняти відсутність змісту від стислого факту; зберігати змістовні короткі секції. Не приєднувати їх до іншої секції без provenance. Acceptance: обидва факти доступні як retrieval evidence.

### P1: tiny-code policy змінює код, а minified код може зникати

`node-policy.js: isTinyCodeBlock`, `skeleton-chunk.js: inlineTinyCode`.

`mkdir sample\ncd sample` перетворюється на `mkdir sample cd sample`. Це інша shell-команда, не косметична зміна. Умова tiny рахує whitespace-слова, а не model tokens/bytes: JSON довжиною понад 5000 символів без пробілів класифікується як tiny. Після recursive splitting його окремий шматок відкидає gate; у результаті лишається тільки вступне речення.

Виправлення: merge без втрати fence/newline/indentation; upper bound tiny за розміром, не лише словами. Acceptance: багаторядковий код зберігає семантику, minified JSON залишається доступним повністю або через fragments + canonical raw.

### P1: списки й вкладені блоки склеюються

`skeleton.js: mdastToText` рекурсивно використовує `join('')`, а обхід структурних вузлів іде лише по верхньому рівню AST.

Три list items дають `hostDisable ... loggingRestart`. Код усередині list item дає `PORT=443Restart...`, не отримує окремої structural identity. На retrieval-виході губляться межі елементів і межі коду. Збережений parser rawContent сам по собі не рятує: prose assembly бере `n.text`.

Виправлення: block-aware serialization, рекурсивне збереження вкладених структур і provenance. Acceptance: ordered/unordered/nested lists, blockquotes із code/table не склеюють слова та не змінюють код.

### P1: локальні великі entities не обмежуються вікном embeddings

Fixture на 121009 символів коду дає один retrieval chunk, без fragments. `chunkFromSkeleton` викликає structural splitting тільки за ненульового budget. Локальний ONNX має MAX_SEQUENCE_LENGTH=8192 та явне обрізання encoding у `src/local/core/onnx-embed.js`.

Доведено відсутність обмеження у chunk output та наявність truncation у адаптері. Точну кількість токенів fixture і втрату recall в live search тут не виміряно. Наслідок для вмісту за межею вікна випливає з коду: raw payload може бути цілий, але embedding не представлятиме весь текст.

Окремо: локальний Markdown створює реальний countFn у chunkFileFromPath, але передає у skeleton лише null budget; recursiveChunkTextForBudget(null) викликає sync recursiveChunkText із chars/4. Отже повідомлення про BGE token counter не означає, що саме Markdown prose реально ділиться ним.

Виправлення: model-specific budget для local і cloud, включно з фактичним embedding prefix/context. Acceptance: усі assembled embedding inputs вкладаються у вікно, sentinel наприкінці великого entity має searchable fragment.

### P2: однакові sibling headings зливають identity секції

`skeleton.js: slugify/headingStack`, `skeleton-index.js: buildFileSkeleton`.

Для двох `## Settings` fixture повертає 4 nav points із лише 3 унікальними node_id. Обидва prose chunks мають однаковий parent_id. Це вже документоване MVP-обмеження, а не нове відкриття. Проте для bounded section context воно істотне: два окремих scope не відрізняються identity.

Виправлення: collision-safe structural paths для повторів і slug collisions; узгоджена міграція identity/reindex. Acceptance: окремі секції мають окремі ID й не змішують children.

## Що варто зберегти

- Один remark AST і offset slices для raw таблиць/звичайних code entities.
- Розділення retrieval, navigation та canonical entity_raw: це підтримує bounded retrieval без втрати повного структурного оригіналу.
- Повтор заголовків таблиць і fences у fragments, typed errors для неможливого budget, окремі IDs fragments; наявні regression tests покривають багато вже виправлених тонких помилок.
- Heading context та same-section carryover без LLM-викликів. Позитивний fixture повернув таблицю без змін, правильний heading context і surrounding prose.

## Відповідність практикам і межі оцінки

[CommonMark](https://spec.commonmark.org/spec) визначає list items і blockquotes як контейнери інших блоків. Тому просто склеїти дочірні тексти недостатньо для збереження структури; проблема тут у власній трансформації AST, не в remark.

[Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) підтримує напрям додавання chunk-specific context перед embedding. Semidex heading/carryover — дешевша детермінована реалізація спорідненої ідеї; це не доводить рівну якість і не компенсує втрачений body.

Це correctness-аудит Markdown-шляху, не повний аудит PDF extraction чи production search. Вісім навмисно складних fixtures не дають частоти дефектів у реальному корпусі. Для вимірювання впливу потрібні незмінний corpus/query set, evidence-level qrels та A/B лише chunker при фіксованих embedding/ranking. Окремо вимірювати збереження фактів/структури, section isolation, budget overflow, кількість чанків і retrieval evidence recall; document hit rate недостатній.

Перший пакет доопрацювання: збереження фактів, code/list serialization і наскрізний budget. Другий: identity секцій. Лише після цього — зміна overlap, розмірів і carryover з контрольованим A/B. Production-код під час аудиту не змінювався.
