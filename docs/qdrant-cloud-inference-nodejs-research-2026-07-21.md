# Qdrant Cloud Inference у Node.js/TypeScript

> Статус: documentation research, перевірено 2026-07-21.  
> Scope: публічна документація, OpenAPI/TypeScript-контракти та офіційний
> `@qdrant/js-client-rest`. Якість retrieval і вибір embedding stack мають бути
> перевірені окремим benchmark.

## Висновок

Qdrant Cloud Inference технічно придатний для прототипу Semidex Lite. Поточний
`@qdrant/js-client-rest` 1.18.0 дозволяє передавати текст і model ID замість
готових числових векторів під час `upsert` і `query`. API також підтримує named
dense/sparse vectors, multivectors, prefetch і fusion.

Публічного Data API для отримання каталогу inference-моделей не знайдено.
Доступні конкретному кластеру моделі, їхні розмірності та ціни показуються у
вкладці **Inference** в Qdrant Cloud Console. Тому Semidex Lite потребуватиме
власного versioned model catalog/configuration, а не model discovery через
Qdrant Data API.

Поточний verdict:

> **JS SDK sufficient for a prototype; transport and batching require live
> validation.**

## Межа відповідальності

Qdrant Cloud Inference обчислює embeddings, але не замінює document pipeline:

- Semidex парсить файли;
- Semidex будує structural skeleton;
- Semidex формує та обмежує chunks;
- кожен retrieval chunk надсилається в Qdrant як окремий point;
- Qdrant перетворює переданий текст на vector і виконує retrieval.

Якщо текст перевищує context limit моделі, Qdrant може обрізати його. Отже,
контроль token budget залишається обов'язком Semidex.

## Перевірені джерела

| Джерело | Що підтверджує |
|---|---|
| [Inference in Qdrant Managed Cloud](https://qdrant.tech/documentation/cloud/inference/) | Доступність Cloud Inference, регіони, моделі, billing і Cloud Console |
| [Inference API](https://qdrant.tech/documentation/inference/) | Client-side, cluster BM25, Cloud та external inference |
| [Qdrant Cloud Inference](https://qdrant.tech/documentation/inference/cloud-inference/) | `Document` input для upsert/query, options і truncation |
| [Server-side BM25](https://qdrant.tech/documentation/inference/inference-bm25/) | `qdrant/bm25`, sparse vectors і JS-приклади |
| [External Providers](https://qdrant.tech/documentation/inference/external-inference-providers/) | OpenAI/Cohere/Jina/OpenRouter, headers та `options` |
| [Hybrid Search with Cloud Inference](https://qdrant.tech/documentation/tutorials-basics/cloud-inference-hybrid-search/) | Named dense/sparse vectors, prefetch і RRF |
| [Qdrant JS SDK](https://github.com/qdrant/qdrant-js) | Офіційний Node.js/TypeScript SDK |
| [`@qdrant/js-client-rest`](https://www.npmjs.com/package/@qdrant/js-client-rest) | Версія, HTTP transport і package contract |
| [Qdrant OpenAPI](https://github.com/qdrant/qdrant/blob/master/docs/redoc/master/openapi.json) | REST schema, з якої генеруються TypeScript types |
| [Qdrant pricing](https://qdrant.tech/pricing/) | Cloud Inference availability за тарифами |

## SDK та REST-контракт

Semidex використовує `@qdrant/js-client-rest` `^1.18.0`. Реліз містить
TypeScript types, згенеровані з конкретної версії Qdrant OpenAPI. Це дає typed
доступ до контракту цієї OpenAPI-версії, але не гарантує, що SDK миттєво
відображає кожну нову Cloud-функцію до виходу наступного релізу пакета.

### Capability matrix

| Можливість | JS SDK 1.18.0 | Примітка |
|---|---:|---|
| Server-side inference під час upsert | Так | `vector` приймає `{ text, model, options? }` |
| Server-side inference під час query | Так | `query` приймає той самий document input |
| Named dense vectors | Так | Через object map у `vector`/`using` |
| Named sparse vectors | Так | Конфігурація через `sparse_vectors` |
| Batch writes with inference | Так | Масив points; практичний batch limit не задокументований |
| Query batch | Так | `queryBatch()` присутній у SDK |
| Prefetch | Так | Частина Query API |
| RRF fusion | Так | Частина Query API |
| Multivectors / late interaction | Так | Підтримується API/schema |
| Model discovery | Ні | Публічного Data API endpoint не знайдено |
| Model capability discovery | Ні | Size/type/context limit треба брати з Cloud Console/model card |
| Qdrant Data API key | Так | `new QdrantClient({ url, apiKey })` |
| External-provider key via header | Так | `withHeaders(...)` |
| External-provider key via document options | Так | `options: { "openai-api-key": ... }` |
| Request timeout | Так | Client-level timeout через `AbortSignal` |
| Automatic retry policy | Ні | У SDK немає documented retry strategy |

### Фактичний document type

В актуальних generated types inference input має тип `Schemas['Document']`:

```ts
import type { Schemas } from '@qdrant/js-client-rest';

const document = {
  text: 'Example chunk text',
  model: 'sentence-transformers/all-MiniLM-L6-v2',
} satisfies Schemas['Document'];
```

У generated schema 1.18.0 цей тип досі має застарілий коментар
`Work-in-progress, unimplemented`. Це стосується schema description, а не
фактичної доступності Cloud Inference: офіційна Cloud документація й приклади
використовують цю структуру.

## Мінімальні Node.js приклади

Model IDs нижче ілюстративні. Перед live run потрібно взяти точні model ID,
vector size і availability із вкладки **Inference** конкретного кластера.

### Підключення

```ts
import { QdrantClient } from '@qdrant/js-client-rest';

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_KEY,
});
```

`QDRANT_KEY` тут є Database/Data API key конкретного кластера, а не Cloud
Management Key.

### Колекція з dense і sparse vectors

```ts
await client.createCollection('semidex-lite-spike', {
  vectors: {
    dense: {
      size: 384,
      distance: 'Cosine',
    },
  },
  sparse_vectors: {
    sparse: {
      modifier: 'idf',
    },
  },
});
```

`384` є прикладом для `all-MiniLM-L6-v2`, а не універсальним default.

### Batch write із server-side inference

```ts
import type { Schemas } from '@qdrant/js-client-rest';

const denseModel = 'sentence-transformers/all-MiniLM-L6-v2';
const sparseModel = 'qdrant/bm25';

const chunks = [
  { id: 1, text: 'First prepared Semidex chunk.' },
  { id: 2, text: 'Second prepared Semidex chunk.' },
];

const points: Schemas['PointStruct'][] = chunks.map((chunk) => ({
  id: chunk.id,
  payload: { text: chunk.text },
  vector: {
    dense: {
      text: chunk.text,
      model: denseModel,
    },
    sparse: {
      text: chunk.text,
      model: sparseModel,
    },
  },
}));

await client.upsert('semidex-lite-spike', {
  wait: true,
  points,
});
```

Це batch write із inference documents, а не окремий спеціалізований
batch-inference endpoint. Фактичний безпечний розмір batch треба виміряти.

### Dense query текстом

```ts
const result = await client.query('semidex-lite-spike', {
  query: {
    text: 'What does this collection explain?',
    model: denseModel,
  },
  using: 'dense',
  limit: 5,
  with_payload: true,
});
```

Це dense query. Hybrid retrieval потребує окремих dense/sparse prefetch та
fusion і буде перевірений наступним дослідженням та benchmark.

## Зовнішні embedding-провайдери

Qdrant Cloud може проксіювати embeddings до OpenAI, Cohere, Jina AI та
OpenRouter. Provider key можна передати двома офіційно задокументованими
способами.

Через request context:

```ts
import { withHeaders } from '@qdrant/js-client-rest';

await withHeaders(
  { 'openai-api-key': process.env.OPENAI_API_KEY },
  () => client.upsert('collection', { points }),
);
```

Або через document options:

```ts
const document = {
  text: 'Text to embed',
  model: 'openai/text-embedding-3-large',
  options: {
    'openai-api-key': process.env.OPENAI_API_KEY,
    dimensions: 512,
  },
} satisfies Schemas['Document'];
```

Передача ключа в body може потрапити до application/network logs. Semidex має
за замовчуванням використовувати secret-aware transport/configuration і не
логувати headers, options або raw request body з credentials.

## Model discovery

У публічному Qdrant Data API та generated JS SDK не знайдено endpoint для:

- списку доступних моделей;
- отримання vector size моделі;
- визначення dense/sparse/multivector output;
- context limit або ціни моделі.

Qdrant направляє користувача до вкладки **Inference** на сторінці кластера.
Для Semidex Lite практичний контракт має бути таким:

1. versioned catalog відомих Qdrant-hosted моделей;
2. перевірка доступності моделі під час connection/setup flow;
3. можливість вручну ввести model ID, vector size і output type;
4. заборона створення колекції без узгодженого vector size;
5. точні model IDs фіксуються у benchmark report.

Це конфігураційний registry, а не hardcoded UI/source branching.

## Availability, billing і регіони

- Free cluster підтримує free Qdrant-hosted models і external providers.
- Paid Qdrant-hosted models потребують paid cluster.
- Деякі моделі позначені `Cost: Free` і документовані без token limit;
  конкретні rate limits публічно не наведені.
- Для paid cluster надається до 5 мільйонів безкоштовних text tokens на місяць
  залежно від моделі, per model, а не як один спільний pool.
- Non-free usage тарифікується за кількістю оброблених tokens; актуальна ціна
  показується у Cloud Console.
- Qdrant-hosted free models розміщені тільки в US.
- Для EU clusters платний Qdrant-hosted inference виконується в EU; для інших
  регіонів документація вказує US.
- External-provider inference виконується відповідним зовнішнім провайдером,
  а billing відбувається через його API key.

## Питання для live spike

Documentation research не підтверджує runtime-поведінку конкретного кластера.
Наступний ізольований spike має перевірити:

1. чи ввімкнений Inference для наявного кластера;
2. які model IDs, vector sizes, output types і ціни показує Cloud Console;
3. один dense upsert/query через `@qdrant/js-client-rest` 1.18.0;
4. один sparse upsert/query;
5. один hybrid query із prefetch + RRF;
6. batch sizes і bounded concurrency без припущення про safe default;
7. timeout/error behavior і відсутність завислих promises;
8. фактичні 429/rate-limit headers;
9. latency з майбутнього регіону розгортання Semidex Lite;
10. cleanup ізольованої spike-колекції.

Issues [#130](https://github.com/qdrant/qdrant-js/issues/130) і
[#131](https://github.com/qdrant/qdrant-js/issues/131) описують зависання на
SDK 1.17.0. Вони є причиною додати transport validation, але не доводять дефект
поточної 1.18.0. Поточний Node.js transport документований як HTTP/1.1, а
встановлений SDK створює `undici.Agent` без `allowH2` (`false` за замовчуванням).
До відтворення проблеми Semidex не повинен додавати transport workaround.

## Подальші етапи

Після live spike окремо виконуються:

1. дослідження Qdrant sparse/BM25, multilingual та української;
2. перевірка hybrid fusion contract;
3. retrieval benchmark локального BGE-M3 ONNX проти Qdrant-hosted stack;
4. зовнішні datasets: BEIR, підтримувані мови MIRACL, окремий український
   technical-retrieval dataset, згодом MLDR;
5. тільки після вимірювань - production provider abstraction для Semidex Lite.
