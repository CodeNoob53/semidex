# DML Batching — Production Wiring Design (2026-05-17)

**Status:** design document — production implementation is the next task.

**Context:** ONNX batching provider comparison (2026-05-17) confirmed:
- CPU bucketed batching: 0.92× (defer — `session.run()` overhead dominates)
- DML bucketed batching: 3.19× vs DML sequential, 4.61× vs CPU sequential
- CUDA: falls back to CPU — `onnxruntime-node` does not bundle CUDA EP
- Correctness on DML: FP-equivalent (max dense delta 2.3e-7, cosine=1.000000)

---

## 1. Trigger Condition

Batching activates **only** when all three conditions hold simultaneously:

```
ONNX_EMBED=1
ONNX_EXECUTION_PROVIDER=dml
```

Optional tuning variable (parsed at indexer startup):

```
ONNX_BATCH_SIZE=4   # default: 4; valid range: 1–64
```

Decision function (`shouldUseOnnxBatching(env)`):

```js
function shouldUseOnnxBatching(env) {
  const onnxEmbed = env.ONNX_EMBED === '1' || env.ONNX_EMBED === 'true';
  const provider  = (env.ONNX_EXECUTION_PROVIDER ?? '').trim().toLowerCase();
  return onnxEmbed && provider === 'dml';
}
```

**Gate cases:**

| Configuration | Batching active? | Reason |
|---------------|------------------|--------|
| (default / Ollama) | No | `ONNX_EMBED` unset |
| `ONNX_EMBED=1` (no provider) | No | provider defaults to `cpu` |
| `ONNX_EMBED=1` + `cpu` | No | CPU batching regresses (0.92×) |
| `ONNX_EMBED=1` + `dml` | **Yes** | confirmed 3.19× speedup |
| `ONNX_EMBED=1` + `cuda` | No | CUDA falls back to CPU in current `onnxruntime-node`; treat as CPU until research completes |
| `ONNX_EMBED=1` + invalid value | No | `resolveOnnxExecutionProviders` already warns + falls back to `cpu` |

`ONNX_BATCH_SIZE` parsing:

```js
function resolveOnnxBatchSize(env) {
  const raw = parseInt(env.ONNX_BATCH_SIZE ?? '4', 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 64) {
    process.stderr.write(`[onnx] ONNX_BATCH_SIZE="${env.ONNX_BATCH_SIZE}" invalid — using 4\n`);
    return 4;
  }
  return raw;
}
```

Invalid value falls back to 4 (not disabling batching — if `dml` is set, the user has
already explicitly opted in; an invalid batch size is a misconfiguration, not a
signal to disable the feature).

---

## 2. Indexer Integration Point

**File:** `src/core/embeddings.js`
**Phase:** 4 (embedding + upserting) — `src/indexer/index.js:98`

Changes are confined to these two files. All other phases are unchanged:

| Phase | File | Batching change? |
|-------|------|------------------|
| 1 — chunk | `phases/chunk.js` | No |
| 2 — context | `phases/context.js` | No |
| 3 — tag | `phases/tag.js` | No |
| **4 — embed + upsert** | `index.js` + `embeddings.js` | **Yes — DML gate only** |
| 5 — link | `phases/link.js` | No (uses precomputedDense already passed from phase 4) |

The link phase (`buildLinks`) already receives the `precomputedDense` vector from
phase 4 via the existing zip pattern — no change needed there.

**Current phase 4 structure** (CPU/Ollama path — preserved as-is):

```js
const pointsWithDense = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
  const embedText = `${chunk.context}\n\n${chunk.text}`;
  const { dense, sparse, meta } = await embedForIndex(collection, embedText);
  return { dense, point: { ... } };
});
```

**New phase 4 structure** (both paths unified via `embedForIndexBatch`):

```js
const embedTexts     = taggedChunks.map(chunk => `${chunk.context}\n\n${chunk.text}`);
const embedResults   = await embedForIndexBatch(collection, embedTexts);
const pointsWithDense = taggedChunks.map((chunk, i) => {
  const { dense, sparse, meta } = embedResults[i];
  return { dense, point: { ... } };
});
```

`embedForIndexBatch` handles the gate internally:
- DML active → `embedBucketed(texts, embedOnnxBatch, maxBatch)`
- all other cases → sequential `for` loop of `embedForIndex` calls (identical to current)

---

## 3. Data Flow

```
taggedChunks[]
  │
  ├─ map → embedTexts[]    (context\n\nchunk.text for each chunk)
  │
  ▼
embedForIndexBatch(collection, embedTexts, maxBatch)
  │
  ├─ [DML path]
  │    bucketBatches(embedTexts, maxBatch)
  │      → buckets by estimated token count (chars/4)
  │      → batches with original indices preserved
  │    for each batch:
  │      embedOnnxBatch(batch.texts) → [{ dense, sparse }, ...]
  │    restore order via batch.indices[i]
  │    return [{ dense, sparse, meta }, ...]  ← aligned to embedTexts input order
  │
  └─ [sequential fallback]
       for each text: embedForIndex(collection, text)
       return [{ dense, sparse, meta }, ...]  ← aligned to embedTexts input order
  │
  ▼
taggedChunks.map((chunk, i) => ({
  dense: embedResults[i].dense,
  point: {
    id: randomUUID(),
    vector: { dense: embedResults[i].dense, sparse: embedResults[i].sparse },
    payload: { ...chunkFields, ...embedResults[i].meta },
  }
}))
  │
  ▼
upsertPoints(collection, points)   ← unchanged
  │
  ▼
zip: chunksWithDense = taggedChunks.map((chunk, i) => ({
  chunk, dense: pointsWithDense[i].dense
}))
→ buildLinks(..., precomputedDense)   ← unchanged
```

The output shape is identical to the current path. Qdrant payload fields, vector
structure, and upsert call are unchanged.

---

## 4. Fallback Behavior

If `embedForIndexBatch` throws (DML session error, OOM, driver failure):

1. **Warn once** to stderr with the error message.
2. **Retry the entire file's chunks sequentially** via `embedForIndex` per text.
3. **Do not partially upsert.** If the batch call fails after some texts but before
   completion, the entire embed step for that file must retry from scratch — no partial
   `pointsWithDense` array is passed to upsert.
4. **No silent CPU batching.** The fallback path is sequential `embedOnnx` calls
   (same as current CPU path), not `embedOnnxBatch` with CPU.

Implementation sketch:

```js
let embedResults;
try {
  embedResults = await embedForIndexBatch(collection, embedTexts);
} catch (batchErr) {
  process.stderr.write(`[embed] DML batch failed (${batchErr.message}) — retrying sequential\n`);
  embedResults = [];
  for (const text of embedTexts) {
    embedResults.push(await embedForIndex(collection, text));
  }
}
```

This fallback lives in `index.js` phase 4, not inside `embedForIndexBatch`, so that
the caller controls the retry boundary and never sees a partial result.

---

## 5. Correctness Guardrails

After `embedForIndexBatch` returns, before constructing `pointsWithDense`:

```js
if (embedResults.length !== taggedChunks.length) {
  throw new Error(
    `embedForIndexBatch: expected ${taggedChunks.length} results, got ${embedResults.length}`
  );
}
for (let i = 0; i < embedResults.length; i++) {
  const { dense, sparse } = embedResults[i];
  if (!Array.isArray(dense) || dense.length !== configVectorSize) {
    throw new Error(`embedForIndexBatch: chunk ${i} dense length ${dense?.length} ≠ ${configVectorSize}`);
  }
  if (!Array.isArray(sparse?.indices) || !Array.isArray(sparse?.values)) {
    throw new Error(`embedForIndexBatch: chunk ${i} sparse shape invalid`);
  }
}
```

**Provider metadata:** `embedForIndexBatch` returns the same `meta` object as
`embedForIndex` — `dense_provider`, `dense_model`, `sparse_provider`,
`embedding_schema_version`. Changing `ONNX_EXECUTION_PROVIDER` from `cpu` to `dml`
does not change any of these fields. **No reindex is required solely for changing
the execution provider.** (FP differences are numerically negligible; embeddings from
different providers are interchangeable within the same collection.)

**`embedBucketed` already throws** if `embedOnnxBatch` returns a different count
than it was given (guard added 2026-05-17 in `length-bucket.js:67`), so the batch
result count mismatch is caught before order restoration.

---

## 6. Smoke Tests to Add at Implementation Stage

All pure/unit tests — no ONNX session, no Qdrant:

```
Section 24 — dml-batching gate
```

| Test ID | Label | Assertion |
|---------|-------|-----------|
| 24a | shouldUseOnnxBatching — unset env | `false` |
| 24b | shouldUseOnnxBatching — ONNX_EMBED=1, no provider | `false` |
| 24c | shouldUseOnnxBatching — ONNX_EMBED=1, cpu | `false` |
| 24d | shouldUseOnnxBatching — ONNX_EMBED=1, dml | `true` |
| 24e | shouldUseOnnxBatching — ONNX_EMBED=1, DML (uppercase) | `true` (case-insensitive) |
| 24f | shouldUseOnnxBatching — ONNX_EMBED=1, cuda | `false` |
| 24g | shouldUseOnnxBatching — ONNX_EMBED=0, dml | `false` |
| 24h | resolveOnnxBatchSize — unset → 4 | `4` |
| 24i | resolveOnnxBatchSize — "4" → 4 | `4` |
| 24j | resolveOnnxBatchSize — "8" → 8 | `8` |
| 24k | resolveOnnxBatchSize — "0" → 4 (invalid, fallback) | `4` |
| 24l | resolveOnnxBatchSize — "abc" → 4 (invalid, fallback) | `4` |
| 24m | resolveOnnxBatchSize — "65" → 4 (out of range, fallback) | `4` |
| 24n | resolveOnnxBatchSize — "64" → 64 (upper bound) | `64` |
| 24o | resolveOnnxBatchSize — "1" → 1 (lower bound) | `1` |

`shouldUseOnnxBatching` and `resolveOnnxBatchSize` must be exported from
`src/core/embeddings.js` (or a dedicated `src/core/onnx-batch-config.js`) so the
smoke section can import them without triggering ONNX session load.

---

## 7. Live Verification Plan

After implementation, verify with a real collection (e.g. `semidex-docs`):

### Step 1 — CPU baseline

```bash
ONNX_EMBED=1 ONNX_EXECUTION_PROVIDER=cpu INDEX_PROFILE=1 node src/indexer/index.js
```

Record:
- point count in collection
- `embedding_phase_ms` from profiler output
- sample search: `qdrant_search "graph cache"` → top-3 results + scores

### Step 2 — DML run (same file, same collection)

```bash
ONNX_EMBED=1 ONNX_EXECUTION_PROVIDER=dml INDEX_PROFILE=1 node src/indexer/index.js
```

Record same metrics. The file hash will match → indexer skips re-embed unless the
collection is cleared first. To force re-embed: delete the collection or change a
source file.

### Step 3 — Compare

| Check | Expected |
|-------|----------|
| Point count | Identical |
| `dense_provider` payload field | `bge-m3-onnx` (both) |
| `sparse_provider` payload field | `bge-m3-onnx` (both) |
| `embedding_phase_ms` (DML vs CPU) | DML ≤ 40% of CPU time |
| Dense vector length | 1024 (both) |
| Sparse indices non-empty | Yes (both) |
| Search result order | Likely identical; minor score differences (≤ 1e-4) acceptable |
| No reindex warning in stdout | Confirm — changing provider must not trigger reindex |

### Step 4 — Fallback path

Temporarily set an invalid DML condition (e.g. break DML by unsetting required
driver) and confirm the indexer falls back to sequential with a single warning line,
completes successfully, and produces the same point count.

---

## 8. Non-Goals (Explicit)

- **No CUDA implementation** until Deep Research returns with Linux/CUDA findings.
  `onnxruntime-node` does not bundle CUDA EP; adding `onnxruntime-node-gpu` is a
  dependency change outside this scope.
- **No file-level parallel indexing** — race conditions on graph mutations.
- **No context/tag batching changes** — those phases use LLM calls (Ollama), not ONNX.
- **No pipeline overlap** (context/tag/embed concurrent) — correctness risk from
  phase dependency chain.
- **No default change from CPU** — CPU/Ollama path remains the default and is
  unaffected by this implementation.
- **No ColBERT production work** — DEFER per Stage 1 verdict.
- **No change to search/MCP paths** — `embedForSearch` is unchanged; DML gate applies
  to indexing only.

---

## Summary

Production implementation is **ready as the next task**. All infrastructure exists:

| Component | Status |
|-----------|--------|
| `embedOnnxBatch` | ✅ in `src/core/onnx-embed.js` |
| `embedBucketed` + `bucketBatches` | ✅ in `benchmarks/lib/length-bucket.js` |
| `embedForIndexBatch` (with DML gate + sequential fallback) | ⬜ to implement in `src/core/embeddings.js` |
| Phase 4 wiring in `index.js` | ⬜ to implement (replace `runBatched` + `embedForIndex` loop with `embedForIndexBatch` call) |
| `shouldUseOnnxBatching` export | ⬜ to add (needed for smoke section 24) |
| `resolveOnnxBatchSize` | ⬜ to add |
| Correctness guardrails in phase 4 | ⬜ to add |
| Fallback on DML batch error | ⬜ to add |
| Smoke section 24 | ⬜ to add |
| Live verification | ⬜ to run |
