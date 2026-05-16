# BGE-M3 ColBERT-head probe — 2026-05-16

**Model:** aapot/bge-m3-onnx  
**Provider:** cpu  
**Session init:** 1 012 ms (cold, one-time)  
**Probe script:** `benchmarks/retrieval/bge-m3-colbert-probe.js`

---

## Output shapes

| Output | Index | Shape |
|--------|-------|-------|
| dense_vecs | 0 | [1, 1024] |
| sparse_vecs | 1 | [1, seq_len, 1] |
| colbert_vecs | 2 | [1, seq_len, 1024] |

colbert_vecs dimension: **1024** (same as dense; XLM-RoBERTa hidden size).

---

## Token counts (example query)

Query: "How does semidex index documents with ONNX embeddings?"

| Metric | Value |
|--------|-------|
| Raw seq_len (padded) | 15 |
| After attn_mask filter | 15 |
| After special-token filter | 14 |

---

## L2-normalisation check

| Metric | Value |
|--------|-------|
| Norms of first 5 query tokens | 1.0000, 1.0000, 1.0000, 1.0000, 1.0000 |
| Vectors pre-normalised | **yes** |

Cosine similarity = dot product — no division needed in MaxSim loop.

---

## MaxSim scores (3 candidate chunks)

| Chunk | Description | Tokens | MaxSim score | Rank |
|-------|-------------|--------|-------------|------|
| 0 | ONNX indexing (relevant) | 61 | **0.7395** | #1 |
| 1 | Qdrant payload indexes (partial) | 48 | 0.5611 | #2 |
| 2 | BGE-M3 ColBERT description (topic-adjacent) | 52 | 0.3970 | #3 |

Expected ordering: chunk 0 > chunk 1 ≥ chunk 2.  
Actual ordering correct: **yes**

Score spread (0 → #1): 0.74. Score gap (#1 → #3): 0.34. Strong discrimination.

---

## Latency (CPU, single-threaded, warm session)

| Scenario | Total ms | Per-chunk ms (amortised) |
|----------|----------|--------------------------|
| Query + 1 chunk | 160 ms | 80 ms |
| Query + 10 chunks | 1 219 ms | 111 ms |
| Query + 40 chunks | 4 880 ms | 119 ms |

Each row includes one full query inference + N chunk inferences + MaxSim computation.  
Top-40 CPU latency: **~5 s** — not reliably under 5 s (observed 4 880–5 111 ms across runs).

Note: latency grows ~linearly (one inference call per chunk). DML must be measured separately;
prior bench:onnx-provider on this machine showed DML slower than CPU for BGE-M3 dense/sparse,
so speedup is not assumed.

---

## Verdict

**Status: PROCEED (with latency caveat)**

### Criteria checklist

| Criterion | Status |
|-----------|--------|
| colbert_vecs present (by name) | ✓ confirmed |
| Shape is [batch, seq_len, 1024] | ✓ confirmed |
| Vectors L2-normalised (dot = cosine) | ✓ confirmed |
| MaxSim ordering correct on 3-chunk probe | ✓ correct |
| Top-40 CPU latency < 5 000 ms | ⚠ ~5 s — not reliably under budget |
| Smoke tests pass (section 20) | ✓ (re-run after refactor) |

### Latency risk

CPU top-40 is ~5 s per query and not reliably under the 5 s target (4 880–5 111 ms observed).
Offline batch benchmarking on CPU is feasible (custom-50 runs are not latency-sensitive).
Production use would require separate latency work: DML measurement, batching/cache,
or top-N trimming (e.g. top-20).

### Key implementation notes

1. **No padding issue:** seq_len for a query is exactly the tokenised length (no forced
   padding to max_length=8192); sparse_vecs shape confirms per-query dynamic length.
2. **Special tokens:** CLS/SEP/pad filtered with the existing `SPECIAL_TOKENS` set —
   identical logic to production `processSparse`. No new token handling needed.
3. **Normalisation:** vectors are pre-normalised to unit L2 by the model — cosine = dot.
   MaxSim inner loop is pure dot product.
4. **Shape:** colbert_vecs is `[1, seq_len, 1024]` — extract `flat.slice(t*1024, (t+1)*1024)`
   per live token. Compatible with the probe's `extractTokenVecs` helper.
5. **No Qdrant multivector needed:** reranker reads colbert_vecs at query time only;
   stored vectors in Qdrant remain dense+sparse unchanged.

### Risks before full benchmark

- **Latency on long chunks:** chunks with 100+ tokens (PDF or large markdown) will push
  per-chunk time higher. Measure 90th-percentile chunk length in custom-50 fixtures.
- **seq_len cap at 512 vs 8192:** the probe used max_length=8192 (same as production
  `embedOnnx`). For a reranker-only path, capping at 512 reduces latency ≈4× with minimal
  quality loss for typical chunk sizes — worth testing in the benchmark.
- **Score distribution shift:** MaxSim scores (0.39–0.74) are not directly comparable to
  hybrid RRF scores (0.016–0.033). The full benchmark must compare MRR@10, not raw scores.
- **DML provider not tested:** prior bench:onnx-provider showed DML slower than CPU for
  BGE-M3 dense/sparse on this machine — speedup is not assumed. Run
  `ONNX_EXECUTION_PROVIDER=dml npm run bench:colbert-probe` and measure before committing
  to top-40 N.

---

## Next step

Implement `bench:custom50:colbert` — rerank hybrid top-40 (or top-20 for speed) with MaxSim
and compare MRR@10 against two reference points:
- **hybrid baseline**: 0.634 MRR@10 (custom-50, hybrid ONNX, 2026-05-10)
- **CE v4 reference**: 0.764 MRR@10 (custom-50, CE-routed v4, 2026-05-16) — the bar to beat

Gate (matching CE routing gate, measured vs hybrid baseline):
- MRR@10 ≥ hybrid + 0.030 (i.e. ≥ 0.664)
- negativePass 100% (zero rank≤3 → >3 regressions)
- recall not below hybrid
- no query-type MRR drop ≥ 0.030 vs hybrid
- ordering-loss count < 2 (CE v4 had 2 CE-caused losses on custom-50)

If ColBERT reaches or exceeds CE v4 (0.764), it replaces CE routing as the reranking candidate.
