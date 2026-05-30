# BGE-M3 chunking — чеклист узгодження semidex

> Джерело: `Оптимальний розмір чанку для BGE-M3.md` (звіт). Нижче — що в semidex
> **вже відповідає** рекомендаціям, і що **варто покращити**, з посиланнями на
> реальні файли. Пріоритети: **P0** критично, **P1** варто, **P2** дослідницьке.

---

## A. Уже відповідає (не чіпати, лише підтвердити)

- [x] **Гібрид dense+sparse+RRF.** `src/core/qdrant.js` (`hybridSearch`), `sparse.js`,
      `embeddings.js`. Звіт: головна перевага BGE-M3 — не використовувати лише dense. ✓
- [x] **Розмір чанка в діапазоні.** `MAX_CHUNK_TOKENS=400` (`chunk.js:23`) — у вікні
      400–512 зі звіту. ✓
- [x] **Рекурсивний спліттер по природних межах.** `recursiveChunkText` (`chunk.js:60`):
      `\n\n` → речення → слова. Звіт рекомендує саме це. ✓
- [x] **CLS-pooling, не mean.** `onnx-embed.js` працює з CLS/special-tokens — тому
      **Late Chunking свідомо НЕ застосовний** (звіт §«Late Chunking»). Це правильно,
      нічого не міняти. ✓
- [x] **Structure-first напрям.** skeleton-first chunking (design-доки) = саме
      paragraph/section-based стратегія, яку звіт називає кращою за fixed-size. ✓

---

## B. Покращення

> **Note:** Items P0 and P1/overlap have a detailed implementation plan in
> `docs/design/bge-m3-token-aware-chunking-plan.md`. That document supersedes the
> brief notes below for those two items.

### P0 — токен-лічильник

- [x] **Замінити `length/4` на реальний токенайзер BGE-M3.** *(implemented — see plan doc and `2026-05-30T1334-bge-m3-token-count-production-default.md`)*
      `chunk.js:27` (`countTokens = len/4`), `length-bucket.js:16`, `index.js:246`.
      Звіт §«Діапазон 400–512»: для української через субслівний BPE XLM-RoBERTa
      400 токенів ≈ 200–300 слів — `length/4` (англоцентрична евристика) для кирилиці
      систематично **недооцінює** токени, тож реальні чанки виходять довші за 400 і
      ризикують semantic dilution. Використати токенайзер, що вже є для embeddings
      (XLM-R), або його приблизну кирилично-свідому корекцію.
      Acceptance: розмір чанка в **токенах токенайзера**, не в символах/4.

### P1 — overlap

- [ ] **Перевести overlap на 10–20% від розміру чанка (target ~15%).** *(in design — see plan doc)*
      Зараз `OVERLAP_SENTENCES=2` (`chunk.js:25`), речення, лише між суб-чанками
      секції, скидається на межі heading (`context.js:45`). Звіт §«Математика
      перекриття»: рекомендований overlap 50–100 токенів для 512 (≈15% = 75).
      Дві короткі репліки можуть давати <10%. Додати `CHUNK_OVERLAP_TOKENS` (або %)
      і різати overlap по токенах, а не по фіксованій кількості речень.
      Acceptance: overlap між сусідніми чанками одного parent у межах 10–20% токенів.

### P1 — reranker

- [ ] **Оцінити перехід на cross-encoder `bge-reranker-v2-m3`.**
      Поточний `src/core/rerank.js` — **евристичний лексичний буст** (stopwords/
      technical-token boosts по text/section/tags/backlink), а не CE. Звіт §«Гібридний
      пайплайн»: best practice = Hybrid + **Cross-encoder reranker** (саме
      bge-reranker-v2-m3). CE-бенч уже існує (`bench:custom50:ce`,
      `ce-routing-bench`) — прогнати на custom-50/150 і порівняти nDCG@5/Recall@1
      проти евристики; якщо виграш стабільний — зробити CE опційним reranker-шляхом.
      Acceptance: рішення «CE vs евристика» на основі бенчмарку, не на віру.

### P1 — узгодити з skeleton-first specs

- [ ] **Пакувати структурні/prose вузли до ~512, не 400.** Звіт §«Section-Based»:
      суміжні секції об'єднувати до ~500 токенів (paragraph grouping > fixed-size).
      У impl-spec `chunkFromSkeleton` цільовий розмір прозового чанка ще «підбирається
      бенчмарком» — зафіксувати верхню межу 512 (не 400) для BGE-M3.
- [ ] **`qdrant_get_content` = parent-context для LLM (≈1000–1500 ток).**
      Звіт §«Parent-Child»: дрібний чанк для пошуку (300–400), великий батьківський
      (1500) для контексту LLM. Наш anchored `qdrant_get_content` (design §15.1) — це
      і є «parent retrieval»: переконатися, що вікно навколо якоря може віддавати
      ~1000–1500 токенів секції, а не лише 1–2 сусідні вузли.
- [ ] **`boundedRaw` для code тримати ≤512.** design §8 (code=400) — у межах. Лише
      підтвердити, що excerpt не перевищує 512 на жодному типі.

### P2 — дослідницьке

- [ ] **MCLS (Multiple CLS) для довгих документів.** Звіт §«MCLS»: нативна для BGE-M3
      альтернатива агресивній фрагментації — вставляти CLS кожні 256 токенів і
      усереднювати. Перевірити, чи це підтримує наш ONNX-провайдер
      (`onnx-embed.js`); якщо так — експеримент для дуже довгих файлів замість
      різання. Низький пріоритет, лише після skeleton MVP.
- [ ] **Доменно-адаптивний розмір чанка (per-collection).** Звіт §«Доменно-специфічна
      адаптація»: фактологічні дані → 256, технічні/юридичні → parent-child 400–1500.
      Винести розмір чанка в конфіг колекції (зараз глобальний env). Опційно.

---

## C. Anti-items (свідомо НЕ робити)

- [ ] ~~Late Chunking з BGE-M3~~ — архітектурно несумісно (CLS-pooling, не mean).
      Звіт §«Архітектурний конфлікт». Не впроваджувати.
- [ ] ~~Overlap >20–30%~~ — роздуває векторне сховище й дає дублікати в контексті LLM.
      Тримати ≤20%.
- [ ] ~~Мікро-чанки 50–128 ток як default~~ — шкодять sparse-лексиці (втрата
      частотного розподілу TF-IDF) і dense-контексту. 400–512 — база.

---

## D. Порядок виконання (рекомендований)

1. P0 токен-лічильник (впливає на ВСЕ — розмір, overlap, bounds).
2. P1 overlap по токенах.
3. P1 узгодити skeleton-spec цільові розміри (512, parent-context).
4. P1 reranker-бенч CE vs евристика → рішення.
5. P2 MCLS / доменна адаптація — після skeleton MVP.

> Примітка: пункти B/P1 «skeleton-first» вже частково покриті дизайн-доками —
> цей чеклист лише прив'язує їх до конкретних чисел зі звіту (512, 15% overlap,
> 1500 parent).
