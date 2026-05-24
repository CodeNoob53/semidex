# Indexing Performance Analysis

_2026-05-13_

## References

- https://www.glukhov.org/ru/rag/retrieval/chunking-strategies-in-rag/
- https://habr.com/ru/companies/raft/articles/954158/

---

## Problem 1 — ONNX runs on CPU, not GPU

**File:** `src/core/onnx-embed.js:106`

```js
session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],  // hardcoded
  graphOptimizationLevel: 'all',
});
```

`onnxruntime-node` підтримує GPU але execution provider захардкоджений як `cpu`.

### Options

**A — DirectML (Windows, recommended)**
- Вбудований у Windows, працює з будь-якою GPU (NVIDIA / AMD / Intel)
- Не потребує зміни пакетів — `onnxruntime-node` вже містить DirectML
- Зміна: `executionProviders: ['dml']`
- Fallback: `['dml', 'cpu']` — якщо DML недоступний, автоматично CPU

**B — CUDA (NVIDIA only)**
- Потребує заміни `onnxruntime-node` → `onnxruntime-gpu`
- Більш зріла підтримка, кращий performance ніж DirectML для великих моделей
- Складніше встановити (залежність від CUDA toolkit версії)

**C — env-driven provider selection**
- `ONNX_EXECUTION_PROVIDER=dml|cuda|cpu` в `.env`
- Fallback до `cpu` якщо не вказано
- Найгнучкіший варіант, мінімальна зміна коду

---

## Problem 2 — Sequential pipeline, no overlap between LLM and ONNX

**File:** `src/indexer/index.js:69-118`

Зараз для кожного файлу всі чанки проходять фази строго послідовно:

```
[1] chunk  →  [2] context (Ollama LLM)  →  [3] tag (Ollama LLM)  →  [4] embed+upsert (ONNX)  →  [5] link
```

`BATCH_SIZE=3` паралелізує в межах однієї фази, але LLM і ONNX ніколи не перекриваються:
поки Ollama генерує context для batch N, ONNX простоює, і навпаки.

### Options

**A — Assembly line / streaming pipeline**
- Chunk N+1 іде в context поки chunk N в embed
- Максимальне використання ресурсів
- Суттєва переробка — потрібна черга між фазами (AsyncGenerator або producer/consumer)

**B — Збільшити BATCH_SIZE для embed фази**
- ONNX може обробляти більший batch ніж LLM (немає token generation overhead)
- Окремий `EMBED_BATCH_SIZE` від `LLM_BATCH_SIZE`
- Мала зміна, частковий win

**C — Batched tokenization + single inference call**
- Зараз `embedOnnx` викликається на одному тексті за раз
- ONNX ефективніший при batch inference (один `session.run` для N текстів)
- Потребує зміни в `onnx-embed.js` — tokenize N текстів, stack tensors, один run
- Найбільший потенційний win для ONNX throughput

---

## Chunking improvements (окрема тема, з бенчмарку js-modern-book)

З аналізу статей і поточного стану:

| Стратегія | Складність | Потенціал | Статус |
|-----------|-----------|-----------|--------|
| Recursive splitter (paragraph → sentence → word) | середня | universal PDF fix | немає |
| Merge малих чанків замість drop | мала | PDF bullet points | немає |
| Semantic boundary detection (cosine similarity між реченнями) | середня | найточніші межі | немає |
| Parent/child hierarchical indexing | велика | зміна Qdrant схеми | немає |

**Висновок з Chonkie benchmark:** різниця між стратегіями 0.874 vs 0.860 — chunker має менший вплив ніж embedder. Але при хорошому embedder кращий chunker дає вищий ceiling.

**Рішення після бенчмарку js-modern-book** — побачимо де реальні прогалини.
