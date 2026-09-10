# Уточнення аудиту: custom-150 і три зовнішні набори

Дата: 2026-09-07. Це перегляд збережених вимірювань та offline re-evaluation
raw TREC, не повторний live запуск цих трьох наборів на поточному runtime.

Попередня відповідь надто зосереджувалася на custom-50 і малому pilot.
Зовнішні результати не можна відкидати через несправність іншого harness.
Вони дають значно більше доказів якості document/passage retrieval, хоча
не вимірюють весь production chunking/context/Ask pipeline.

## Що фактично є

| Набір | Реальний обсяг | Що перевіряє |
|---|---|---|
| custom-150 | 75 queries: 72 positive, 3 negative | Внутрішні chunk-level qrels, ширші query classes; legacy |
| BEIR SciFact | 5183 docs / 300 test queries | Англійський document-level retrieval; Local/Cloud, native/common-512 |
| MIRACL Russian | 1000 passages / 100 queries | Pooled subset російського dev; 289 positives + 711 annotated negatives |
| Slavic/Belebele | 488 passages / 900 queries на кожну із 7 мов | Parallel MRC-derived retrieval; включає українську, сумарно 6300 queries |

Fusion — серія експериментів над цими наборами, не четвертий незалежний
датасет. Production-path — окремий шлях запуску індексації та пошуку.

## Перевірка raw artifacts

`verify-external-saved.mjs` повторно завантажує qrels із local caches,
перевіряє query IDs/duplicate ranks/docs та обчислює nDCG, MAP, Recall,
Precision, MRR. Допуск до saved JSON: 1e-6.

- SciFact: 10/14 configurations PASS.
- MIRACL: 8/8 PASS.
- Belebele: 21/21 PASS (7 languages × 3 modes).
- Разом 39 PASS, 4 FAIL через неповне query coverage raw files.

Чотири SciFact cloud-native TREC зараз містять лише query IDs 1 і 3,
замість 300. Saved full-run JSON при цьому містить повні metrics.
`beir/run-scifact.mjs` розділяє smoke/full JSON, але пише TREC в однакові
`${runId}-${label}.trec`. Це підтверджена колізія шляхів; наявні короткі
файли сумісні зі smoke overwrite, хоча хто і коли їх перезаписав не встановлено.
Full cloud-native цифри з JSON не вважаю повторно перевіреними за raw.
Common-512 Cloud та обидва Local режими перевірено.

Артефакт: `external-saved-verification-2026-09-07.json`. PASS означає
арифметичну/структурну відповідність збереженого run, не його свіжість,
незалежний аудит labels або відтворення поточною моделлю.

## Результати, які уточнюють оцінку

### SciFact: fusion має виміряний позитивний ефект

Звіт `2026-07-21-beir-scifact-provider-comparison.md`, common-512:

| Profile | Dense nDCG@10 | Sparse | Hybrid k60 | Hybrid k2 |
|---|---:|---:|---:|---:|
| Local BGE-M3 | 0.6380 | 0.6344 | 0.6778 | Не запускався у full |
| Cloud E5-small/BM25 | 0.6785 | 0.6585 | 0.6977 | 0.7078 |

Local hybrid Recall@10=0.7919, @100=0.9303. Cloud k2: 0.8459/0.9537.
Це повний корпус цього benchmark, а не 150-document pilot. Є реальне
підтвердження корисного retrieval, але 0.68 nDCG не можна назвати SOTA без
зіставних моделей/baselines/configuration. nDCG — не відсоток правильних відповідей.

### MIRACL: equal fusion реально погіршує сильний dense ranking

Звіт `2026-07-22-miracl-ru-provider-comparison.md`:

| Profile | Dense nDCG@10 | Sparse | Hybrid k60 | Hybrid k2 |
|---|---:|---:|---:|---:|
| Local | 0.8995 | 0.7526 | 0.8346 | 0.8460 |
| Cloud | 0.8420 | 0.5696 | 0.7130 | 0.7613 |

Для hybrid k60 − dense: Local delta=-0.0649, CI95 [-0.0977,-0.0348];
Cloud delta=-0.1289, CI95 [-0.1793,-0.0781]. Це значущий negative effect
у виміряному scope, а не просто нестача доказів або шум малого custom-50.
Водночас Recall@100 hybrid=1: правильні passages часто є в candidate pool,
але fusion розташовує їх гірше. Це проблема ordering, не повна неспроможність знайти.

Scope — pooled 1000 passages, не повний багатомільйонний MIRACL і не українська.

### Belebele: український retrieval виміряний, але fusion policy має значення

Звіт `2026-07-23-slavic-belebele-benchmark.md`, українська:

- Dense nDCG@10=0.9372, Recall@10=0.9856.
- Sparse nDCG@10=0.8596, Recall@10=0.9311.
- Hybrid k60 nDCG@10=0.9274, Recall@10=0.9700.
- Hybrid−dense CI включає нуль для української; для польської k60 regression
  значуща: delta=-0.0344, CI95 [-0.0504,-0.0192].

Пізніший окремий live report `2026-07-24-slavic-weighted-rrf.md` дає для
української dense=0.9378, equal k2=0.9428, equal k60=0.9249,
k2_rho0.25=0.9406. Це інший run: не змішувати його decimals із попереднім.
Equal k2 − dense CI [-0.0038,+0.0135] включає нуль. Rho0.25 − dense має
малий позитивний delta +0.0028 у цьому eval. Weighted rows тут прочитані
зі звіту, не входять у 43 raw configurations повторної перевірки.

Weighted SciFact/MIRACL report прямо має candidate verdict WEIGHTED_RRF_MIXED:
на MIRACL мала sparse вага наближає fusion до dense, але глобального виграшу
на всіх scopes не встановлено. Ці набори вже впливали на вибір параметрів;
це diagnostic/tuning evidence, не blind confirmation.

900 запитів на мову — суттєвий обсяг, але passages лише 488, вони короткі,
qrels походять від MRC source passage, а питання можуть поділяти один passage.
Для малих confidence intervals варто додати bootstrap за passage clusters,
а не лише незалежне resampling queries. Це методологічна рекомендація,
не твердження, що наведені point estimates неправильні.

### Custom-150: корисний історичний сигнал про точність фрагмента

Підраховано безпосередньо `custom-150/queries.json`: 75 queries.
Звіт `2026-05-15-custom150-onnx-hybrid.txt`:

- Chunk Hit@3=55.6%, @5=68.1%, @10=76.4% (історична назва chunkRecall).
- Window Hit@5=88.9%; fileRecall@10=100%.
- nDCG@10=0.562; MRR@10=0.508.
- Cross-lingual MRR=0.520; source-navigation=0.452; English=0.310.

Deterministic reranker у парному звіті: Hit@5=63.9%, @10=70.8%,
nDCG=0.549; cross-lingual Hit@5 падає з 75% до 50%.
Combined-qwen run від 2026-05-18: nDCG=0.581, Hit@10 лишається 76.4%.

Це підтримує окремий висновок: знайти правильний файл легше, ніж доставити
точний evidence chunk. Але корпус/labels застарілі; повного semantic qrel
audit c150 ще немає. Не трактувати історичні misses як доведені поточні bugs.

## Переглянута оцінка

Формулювання «є лише працездатна база, якість майже не доведена» надто слабке
щодо document/passage retrieval: є три зовнішні набори й raw evidence.
На виміряних scopes dense retrieval показує високу здатність знайти потрібний
passage, а hybrid корисний на SciFact. Це більше, ніж plumbing demo.

Конкретна слабкість — універсальна equal-weight fusion policy: вона може
погіршувати сильний dense ranking, особливо коли sparse lane слабша. Це
доведено для MIRACL subset, а не лише висунуто як гіпотезу.

Якість поточного повного Semidex pipeline (chunking → top3/5 → bounded context
→ answer) цими provider benchmarks не доведена. Потрібно переносити зовнішні
qrels на справжній production path і оцінювати delivered evidence. Це межа
застосовності доказів, а не причина ігнорувати вже виміряний retrieval.
