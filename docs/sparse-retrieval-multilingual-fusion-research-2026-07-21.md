# Sparse Retrieval, Multilingual Search і Hybrid Fusion для Semidex Lite

> Статус: documentation research, перевірено 2026-07-21.  
> Scope: публічна документація Qdrant, BGE-M3 paper/model card, SPLADE,
> MIRACL та фактичний retrieval-контракт Semidex. Production-код і Qdrant
> колекції не змінювалися.

## Позначення

- **FACT** — прямо підтверджено первинним джерелом або поточним кодом Semidex.
- **INFERENCE** — технічний висновок із підтверджених фактів.
- **HYPOTHESIS** — твердження, яке має перевірити benchmark.
- **LIVE** — залежить від каталогу моделей, тарифу або версії конкретного
  Qdrant Cloud-кластера.

## Executive summary

1. **BGE-M3 sparse не є BM25 і не є SPLADE.** Це learned lexical
   representation: спільний multilingual encoder обчислює контекстну вагу
   кожного токена, але sparse-пошук далі вимагає перетину token IDs. Модель не
   робить SPLADE-style vocabulary expansion. **FACT**
2. **Qdrant `qdrant/bm25` є класичним статистичним sparse retrieval.** Він
   дешевий, виконується server-side і має офіційний Node.js приклад. Якість для
   неанглійського тексту залежить від tokenizer, normalization, stemming та
   stopwords. Дефолтні English-параметри не можна використовувати як чесний
   український baseline. **FACT**
3. Для української Qdrant документує language-neutral конфігурацію
   `language: "none"` + `tokenizer: "multilingual"`, але не заявляє окремий
   український stemmer. Отже це multilingual tokenization/lemmatization, а не
   доказ якісної української морфології. **FACT + INFERENCE**
4. Публічно підтверджена hosted learned-sparse модель у Qdrant Cloud — English
   SPLADE PP EN v1. Public docs і live Console показують різні exact model IDs;
   на перевіреному free cluster модель вимагає dedicated cluster. Вона не є
   основним кандидатом для українського Semidex Lite. **FACT + LIVE**
5. Qdrant Query API підтримує RRF, configurable `k`, weighted RRF, DBSF і
   Formula Query. Semidex зараз використовує equal-weight RRF із власним
   `RRF_K=60`, а не актуальний Qdrant default `k=2`; prefetch кожної lane за
   замовчуванням дорівнює `max(top * 2, top + 1)`. **FACT**
6. Найпростіший Lite-кандидат — hosted multilingual dense + server-side BM25 +
   Qdrant RRF. Це архітектурно дешевше за local BGE-M3, але не доведено як
   рівноцінне за retrieval quality. **INFERENCE**
7. Переможця визначає тільки однаковий benchmark: той самий corpus, chunking,
   qrels, filters, candidate limits і metrics. Обов'язкові зовнішні тести та
   окремий український technical-retrieval набір. **RECOMMENDATION**

## 1. Sparse retrieval taxonomy

| Підхід | Dimension | Вага | Expansion | Corpus statistics | Neural inference |
|---|---|---|---:|---:|---:|
| TF-IDF / BM25 | term ID або стабільний hash терма | TF, IDF, length normalization | ні | так | ні |
| BGE-M3 sparse | token ID із XLM-R tokenizer vocabulary | learned contextual token weight | ні | ні | так |
| SPLADE | token ID із fixed model vocabulary | learned contextual activation | так | ні | так |
| miniCOIL | term identity + contextual vector | learned contextual representation | ні | ні | так |

### Classical lexical sparse

BM25 представляє документ як невелику кількість ненульових термів. Dimension
ідентифікує lexical term; вага залежить від частоти терма, довжини документа та
рідкісності терма у корпусі. Терм, якого немає після tokenization/normalization,
не з'явиться у векторі.

Переваги: низька CPU-вартість, добра поведінка для exact identifiers, прозоре
ранжування. Ризики: morphology і cross-language semantics не виникають самі;
вони залежать від text processing. Storage приблизно пропорційний кількості
унікальних термів документа.

### BGE-M3 learned lexical sparse

BGE-M3 використовує той самий transformer hidden state для dense, lexical
sparse і multi-vector representations. Для token `t` lexical head обчислює
вагу на кшталт `ReLU(W_lex^T H_t)`. Для повторів token ID зберігається
максимальна вага. Sparse score — сума добутків ваг для token IDs, спільних між
query і passage.

Отже BGE-M3 sparse займає проміжне місце:

- як BM25, він lexical і потребує спільних token IDs;
- на відміну від BM25, важливість токена визначає multilingual transformer;
- на відміну від SPLADE, він не активує відсутні у вхідному тексті vocabulary
  terms.

### SPLADE-like learned sparse

SPLADE проектує contextual transformer states на vocabulary і може активувати
терми, яких буквально не було у вхідному тексті. Це дає semantic expansion, але
збільшує inference cost, число non-zero dimensions і ризик шуму. Fixed
vocabulary також погано поводиться з невідомими product IDs та out-of-domain
мовою; це прямо зазначає документація Qdrant.

## 2. BGE-M3 sparse architecture

**Підтверджені властивості:**

- підтримує dense, sparse та multi-vector retrieval одним shared encoder;
- заявлена підтримка понад 100 мов;
- максимальна довжина input — 8192 tokens;
- базується на XLM-R tokenizer, тому sparse dimensions є tokenizer token IDs;
- sparse head генерує learned lexical weights без vocabulary expansion;
- dense output використовує normalized CLS representation;
- офіційний основний runtime — Python `FlagEmbedding`;
- офіційного first-class Node.js API для повного BGE-M3 sparse contract не
  знайдено.

Поточний Semidex використовує custom ONNX export `aapot/bge-m3-onnx`. Один
`session.run()` повертає dense `[1024]` і sparse weights `[sequence_length]`, а
Semidex перетворює token IDs та weights у Qdrant sparse vector. Файли моделі
займають приблизно 2.27 GB.

### Чи можна завантажити лише sparse або dense частину

Окремий output можна не матеріалізувати, якщо export/runtime це підтримує, але
обидва heads спираються на основний BGE-M3 transformer. Вимкнення sparse output
не перетворює BGE-M3 на малу dense-only модель і не прибирає головну вартість
завантаження shared encoder. Поточний Semidex ONNX export завжди повертає обидва
outputs.

Фраза model card про sparse output "without additional cost" означає reuse
того самого forward pass; це не гарантія буквально нульової пам'яті або
постобробки.

### Multilingual evidence і українська

BGE-M3 paper оцінює multilingual retrieval на MIRACL, однак оригінальний
MIRACL має 18 мов і **не містить української**. Тому загальна підтримка 100+
мов — сильна підстава включити BGE-M3 до українського benchmark, але не готовий
український quality result. Публічного контрольованого BGE-M3 sparse benchmark
саме для української в перевірених первинних джерелах не знайдено.

## 3. Qdrant `qdrant/bm25`

### Де виконується

Qdrant приймає `{ text, model: "qdrant/bm25", options }` без готового sparse
vector, генерує sparse representation server-side та зберігає отриманий vector.
Офіційна документація дає приклади для REST і `@qdrant/js-client-rest`.

Документація називає цей шлях **Qdrant Cluster (BM25)** окремо від hosted Cloud
Inference models. Це підтверджує server-side BM25 у сучасному Qdrant, але
мінімальну сумісну версію self-hosted server треба перевірити окремим version
spike перед підтримкою. Поточна документація не дає окремої BM25 token-price;
користувач оплачує ресурси/зберігання кластера. Називати BM25 безумовно
"безкоштовним" некоректно.

### Формула і параметри

Для query terms Qdrant/FastEmbed використовує BM25-подібний score:

```text
sum IDF(q_i) * f(q_i,d) * (k + 1)
                  / (f(q_i,d) + k * (1 - b + b * |d| / avg_len))
```

Документовані defaults:

| Параметр | Default | Роль |
|---|---:|---|
| `k` | 1.2 | saturation term frequency |
| `b` | 0.75 | document-length normalization |
| `avg_len` | 256 | очікувана середня довжина поля |

Sparse vector має бути створений із `modifier: "idf"`. Document vector містить
term-frequency contribution, а Qdrant додає current corpus IDF під час query.
Тому після insert/delete corpus statistics змінюються без повторного embedding
всіх документів. Консистентність одразу після масових змін усе одно треба
перевіряти з урахуванням wait/indexing behavior кластера.

### Text processing і українська

Qdrant BM25 підтримує tokenizer, lowercasing, ASCII folding, stemming, stopword
removal і token length filters. Дефолт — English stemming/stopwords, що офіційна
документація називає непридатним без налаштування для інших мов.

Для language-neutral text Qdrant документує:

```json
{
  "language": "none",
  "tokenizer": "multilingual",
  "ascii_folding": true
}
```

`language: "none"` вимикає language-specific stemming і stopwords;
`tokenizer: "multilingual"` вмикає multilingual tokenization/lemmatization.
Українська не входить до явного списку language-specific BM25 languages у
FastEmbed source. Використовувати Russian stemming як заміну українському було
б методологічною помилкою.

**Висновок:** BM25 як формула не англомовний; конкретна multilingual quality
повністю залежить від preprocessing. Qdrant має Unicode/multilingual шлях, але
якість української словозміни не доведена документацією.

Для `QDRANT_URL`, `MAX_CHUNK_TOKENS`, paths, hyphens, package names і versions
BM25 теоретично сильний, але exact behavior залежить від tokenizer. Потрібен
live tokenization/retrieval test: `word`, `whitespace` і `multilingual` можуть
по-різному розбити `_`, `/`, `-`, `.`, `@` та `:`.

## 4. Qdrant-hosted learned sparse models

| Model ID | Тип | Мови | Input limit | Availability | Джерело |
|---|---|---|---|---|---|
| Public docs: `prithivida/splade_pp_en_v1`; live Console: `prithivida/splade-pp-en-v1` | SPLADE++ learned sparse | English | не показано у free-tier Console | Dedicated cluster required | Qdrant docs + Console snapshot 2026-07-21 |
| `qdrant/bm25` | classical BM25 sparse | залежить від text processing | не neural context window | Qdrant Cluster | Qdrant BM25 docs |

Qdrant також документує miniCOIL як learned contextual lexical method без
vocabulary expansion, але публічна сторінка показує client-side FastEmbed, а не
підтверджує його наявність у Cloud-каталозі конкретного кластера.

Live Console підтвердив free-tier `qdrant/bm25`, але SPLADE потребує dedicated
cluster. Розбіжність exact SPLADE model ID між публічною документацією та
Console треба вважати versioned provider-contract issue, а не виправляти
евристикою. Публічно підтвердженої hosted learned-sparse моделі з окремою заявою
про українську не знайдено.

Qdrant може зберігати named vectors, створені різними providers. Тому hosted
dense + client-generated BGE-M3 sparse технічно можливі, якщо під час indexing
і query кожна named lane використовує один і той самий provider/model contract.
Однак цей варіант усе одно потребує local BGE-M3 і послаблює головну перевагу
Lite.

## 5. Очікувана поведінка для українських запитів

Оцінки нижче — **HYPOTHESIS**, не результати benchmark.

| Query type | Qdrant BM25 | BGE-M3 sparse | SPLADE-like sparse |
|---|---|---|---|
| Природна українська | exact lexical overlap; залежить від tokenizer | contextual learned weights + subword overlap | залежить від multilingual training/vocab |
| Відмінки, словозміна | ризик miss без українського morphology | subword overlap може допомогти, але не гарантує | expansion може допомогти лише у multilingual model |
| UA + EN | exact tokens обох мов | сильний multilingual кандидат | English SPLADE ненадійний для UA |
| API/library names | сильний exact lane | можливий subword split | OOV/fixed-vocab ризик |
| env vars, paths, CLI | потенційно найкращий після tokenizer tuning | exact subword overlap, punctuation може змінити token IDs | підвищений OOV ризик |
| Числа, versions, SKUs | сильний exact lane | залежить від tokenizer | fixed-vocab ризик |
| Транслітерація | без exact bridge | dense краще; sparse лише при shared subwords | залежить від model training |

## 6. Qdrant fusion contract

### Prefetch

Query API спочатку виконує child prefetch queries, потім main query над їхніми
результатами. `offset` діє тільки на main query, тому prefetch limit має бути не
меншим за `limit + offset`. Fusion не може повернути point, який не потрапив до
жодного prefetch candidate set.

### RRF

Актуальна формула weighted RRF у Qdrant:

```text
score(d) = sum 1 / (k + (rank(d) + 1) / weight - 1)
```

Qdrant використовує zero-based rank. Defaults: `k=2`, weight кожної lane `1`.
Configurable `k` доступний із Qdrant 1.16; weighted RRF — із 1.17. Ваги
відповідають порядку prefetch queries.

Semidex зараз передає:

```js
prefetchLimit = Math.max(top * HYBRID_PREFETCH_LIMIT, top + 1)
query = { rrf: { k: RRF_K } }
```

Defaults Semidex: `HYBRID_PREFETCH_LIMIT=2`, `RRF_K=60`, equal weights. Отже
поточний результат не дорівнює Qdrant `{ rrf: {} }` із default `k=2`.

RRF працює з rank order, тому ручна normalization dense/BM25 scores не потрібна.
Якщо point є тільки в одній lane, він отримує contribution лише від неї. Якщо
один point ID присутній у двох lists, contributions сумуються в одному final
result. API повертає final fused score; стандартна відповідь не дає окремої
розкладки внеску кожної lane. Для діагностики lanes треба запускати окремо.

### DBSF і Formula Query

DBSF нормалізує scores кожної lane за mean і sample standard deviation:

```text
normalized = (score - (mean - 3 * sigma)) / (6 * sigma)
```

Після цього normalized scores сумуються. DBSF чутливий до prefetch sample та
outliers; Qdrant не заявляє універсального переможця між DBSF і weighted RRF.
Formula Query може додати recency/popularity/payload logic поверх fused score,
але не є прямою заміною measured dense/sparse weights.

## 7. Semidex Local vs Lite candidates

| Критерій | A: Local BGE-M3 dense+sparse | B: Hosted dense + BM25 | C: Hosted dense + hosted learned sparse | D: Hosted dense + client BGE-M3 sparse |
|---|---|---|---|---|
| Local compute | високий | мінімальний | мінімальний | високий encoder cost |
| Multilingual potential | високий | середній, preprocessing-dependent | model-dependent | високий sparse potential |
| Exact-token potential | високий subword lexical | високий після tokenizer tuning | OOV/model-dependent | високий subword lexical |
| Ukrainian morphology | не доведено, але multilingual | не доведено; немає UA stemmer | не підтверджено hosted model | як A для sparse |
| Indexing cost | local CPU/GPU time | cluster + hosted dense billing | hosted inference + larger sparse | hosted dense + local BGE |
| Query cost | local embedding + Qdrant | hosted dense + cluster BM25 | two hosted neural lanes | hosted dense + local BGE |
| Storage cost | dense + learned sparse | dense + BM25 sparse | dense + potentially larger sparse | dense + BGE sparse |
| Operational complexity | model/cache/runtime | найнижча | catalog/model availability | найвища |
| Vendor dependency | Qdrant storage | Qdrant inference + storage | Qdrant model catalog + storage | split dependency |
| Expected latency | hardware-dependent | network/inference-dependent | дві hosted neural lanes | network + local encoder |

### Додаткова обов'язкова ablation

**E: hosted dense-only.** Вона потрібна не як продуктова рекомендація, а щоб
виміряти реальний marginal gain sparse lane. Інакше RRF може приховати слабку
sparse модель за сильним dense retriever.

## 8. Risks and unknowns

- Немає прямої зовнішньої української оцінки BGE-M3 sparse.
- MIRACL не має української; російська або перекладені datasets не є заміною.
- Qdrant BM25 default English preprocessing може створити хибно слабкий Lite
  baseline.
- `multilingual` tokenizer не гарантує якісну українську morphology.
- Cloud model catalog, prices, dimensions і limits залежать від кластера.
- Hosted SPLADE++ English-only не можна екстраполювати на українську.
- Learned sparse може збільшити non-zero count, storage та query cost.
- `RRF_K=60`, Qdrant default `k=2`, prefetch size і lane weights можуть змінити
  висновок сильніше, ніж очікується; їх треба фіксувати й ablate окремо.
- Сильний dense retriever може маскувати sparse regression у final RRF metrics.
- Exact identifiers можуть ламатися через tokenizer punctuation rules.

## 9. Benchmark hypotheses

| Гіпотеза | Dataset / slice | Метрики | Зафіксувати |
|---|---|---|---|
| BM25 достатній для identifiers, але слабший для UA inflections | український technical set, окремі exact/morphology slices | Recall@5/10, MRR@10, exact-token recall | chunks, dense model, fusion |
| BGE-M3 sparse додає multilingual recall понад dense-only | український set + MIRACL supported languages | nDCG@10, Recall@10/100 | dense lane і qrels |
| Lite B дешевший, але може втрачати quality проти A | однаковий corpus у A/B | nDCG, MRR, p50/p95, indexing time/cost | Qdrant version, region, batch size |
| RRF приховує слабку sparse lane | dense-only, sparse-only, hybrid | lane metrics + hybrid delta | prefetch, `k`, weights |
| Qdrant default English BM25 шкодить UA | English default vs language-neutral variants | UA nDCG/Recall | `k`, `b`, `avg_len`, tokenizer |
| Larger prefetch improves recall at latency cost | multipliers 2/5/10 | Recall@10/100, p95 latency | final top, fusion |
| `RRF_K=60` не обов'язково оптимальний після заміни sparse lane | `k=2/10/60`, train/validation split | nDCG@10, MRR@10 | lane weights, candidate lists |
| Learned sparse збільшує storage | A/C проти B | sparse nnz, bytes/point, index size | corpus/chunk count |

Зовнішні controls:

- BEIR SciFact і NFCorpus для стандартного English retrieval;
- MIRACL для мов, які dataset реально містить;
- MLDR для long-document retrieval;
- окремий незалежно сформований український technical corpus із qrels.

## 10. Questions for a live Qdrant Cloud spike

1. Які dense і sparse model IDs показує **Inference** конкретного кластера?
2. Які dimensions, input limits, pricing і regions у кожної моделі?
3. Який exact SPLADE ID приймає dedicated cluster і чи є multilingual learned
   sparse? На перевіреному free cluster SPLADE недоступний.
4. Чи приймає JS SDK `qdrant/bm25` options `language:none` і
   `tokenizer:multilingual` під час upsert і query?
5. Яка мінімальна server version потрібна для cluster-side BM25?
6. Як tokenizers розбивають `QDRANT_URL`, `foo-bar`, `@scope/pkg`, paths,
   `v1.17.1` і кириличні словоформи?
7. Чи однаково працюють `modifier:idf`, deletes і updates після `wait=true`?
8. Чи підтримує кластер weighted RRF і custom `k` через поточний JS SDK?
9. Які practical request/batch limits і p95 latency для hosted inference?
10. Який billing фактично видно окремо для hosted dense і cluster BM25?

## 11. Recommended benchmark configurations

Мінімальний набір:

1. **A-local:** BGE-M3 ONNX dense + BGE-M3 sparse + equal RRF.
2. **A-dense-only:** BGE-M3 ONNX dense.
3. **B-lite:** Qdrant-hosted multilingual dense + `qdrant/bm25` із
   `language:none`, `tokenizer:multilingual` + equal RRF.
4. **B-dense-only:** та сама hosted dense без sparse.
5. **B-BM25-only:** language-neutral BM25 без dense.
6. **B-negative-control:** hosted dense + default English BM25, щоб виміряти
   шкоду неправильного preprocessing, а не використовувати як продукт default.
7. **C-hosted-learned:** лише якщо Cloud Console підтвердить multilingual
   learned sparse; English SPLADE++ допустимий тільки для English controls.
8. **D-mixed diagnostic:** hosted dense + local BGE-M3 sparse, щоб ізолювати
   sparse-lane effect; не вважати автоматично Lite-кандидатом.

Для кожної hybrid конфігурації спочатку використовувати однаковий equal-weight
RRF, потім окремо порівняти `k=2` і поточний Semidex `k=60`. Weighted RRF
налаштовувати лише на train/validation split; не на тих самих queries, на яких
публікується результат.

## Sources

- [Qdrant: Server-side BM25](https://qdrant.tech/documentation/inference/inference-bm25/)
- [Qdrant: Full-Text Search](https://qdrant.tech/documentation/search/text-search/full-text-search/)
- [Qdrant: Hybrid and Multi-Stage Queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant: Cloud Inference](https://qdrant.tech/documentation/cloud/inference/)
- [Qdrant FastEmbed BM25 source](https://github.com/qdrant/fastembed/blob/main/fastembed/sparse/bm25.py)
- [BGE-M3 paper](https://arxiv.org/abs/2402.03216)
- [BGE-M3 official model card](https://huggingface.co/BAAI/bge-m3)
- [FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)
- [SPLADE v2 paper](https://arxiv.org/abs/2107.05720)
- [MIRACL paper](https://aclanthology.org/2023.tacl-1.63/)
- [MIRACL dataset](https://huggingface.co/datasets/miracl/miracl)
