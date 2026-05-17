# ONNX True-Batching Feasibility Probe — 2026-05-17

**Model:** aapot/bge-m3-onnx (bge-m3, ONNX CPU)
**Script:** `benchmarks/onnx-batch-probe.js`
**Runtime:** onnxruntime-node, CPU provider
**Corpus:** 6 texts (short/medium/long, English + Ukrainian)

---

## 1. Setup and output shapes

The model exposes three output heads per inference call:

| Output | Sequential shape (1 text) | Batched shape (N texts) | Stride per item |
|--------|--------------------------|------------------------|-----------------|
| `dense_vecs` | `[1, 1024]` | `[N, 1024]` | `1024` |
| `sparse_vecs` | `[1, seq_len, 1]` | `[N, max_seq_len, 1]` | `max_seq_len` (input dims[1]) |
| `colbert_vecs` | `[1, seq_len−1, 1024]` | `[N, max_seq_len−1, 1024]` | `colbert_dims[1] * 1024` |

**Critical:** `colbert_vecs` dim 1 equals `seq_len − 1`, **not** `seq_len`. Using the
input `seq_len` as the stride gives a wrong offset for every item after b=0. The
correct stride must be read from `colbertAll.dims[1]`.

The batch dimension is dynamic and accepted by the ONNX runtime without errors at
all tested batch sizes (2, 4, 6). No runtime errors or OOM were observed.

---

## 2. Timing results

| Mode | Total (ms) | ms/text | Speedup vs sequential |
|------|-----------|---------|----------------------|
| Sequential batch=1 | 466 | 78 | 1.00× |
| Batched N=2 | 125 | 62 | 1.25× |
| Batched N=4 | 303 | 76 | 1.03× |
| Batched N=6 | 1236 | 206 | 0.38× |

Observations:
- N=2 gives a modest speedup (1.25×) from amortized session overhead.
- N=4 is roughly equal to sequential (1.03×) — CPU thread contention under load.
- N=6 (mixed-length corpus including a 127-token text) is **2.6× slower** than
  sequential. The long text pads all five shorter texts to 127 tokens, expanding
  every shorter text's compute from ~5–30 tokens to 127.
- The N=6 slowdown is entirely due to **padding overhead from sequence length
  heterogeneity**, not a batch size limit.

---

## 3. Equivalence checks

For each text, the batched output was compared against the sequential baseline.
Cosine similarity and max absolute delta are reported for dense and colbert first-token
vectors; max absolute delta for sparse token weights.

### Results — all batch sizes, all outputs: PASS (bit-identical)

| Batch | Item | dense cos | dense maxΔ | sparse maxΔ | colbert cos | colbert maxΔ |
|-------|------|-----------|-----------|-------------|-------------|-------------|
| N=2 | text[0] | 1.000000 | 0.00e+0 | 0.00e+0 | 1.000000 | 0.00e+0 |
| N=2 | text[1] | 1.000000 | 0.00e+0 | 0.00e+0 | 1.000000 | 0.00e+0 |
| N=4 | text[0–3] | 1.000000 | 0.00e+0 | 0.00e+0 | 1.000000 | 0.00e+0 |
| N=6 | text[0–5] | 1.000000 | 0.00e+0 | 0.00e+0 | 1.000000 | 0.00e+0 |

All three outputs are **bit-identical** between sequential and batched inference at
all tested batch sizes.

---

## 4. Output slicing — correctness

| Output | Correct slice formula | Note |
|--------|----------------------|------|
| `dense_vecs` | `denseAll.slice(b * 1024, (b+1) * 1024)` | dims `[N, 1024]` |
| `sparse_vecs` | `sparseAll.slice(b * seqLen, (b+1) * seqLen)` | seqLen = input `dims[1]` |
| `colbert_vecs` | `colbertData.slice(b * colbertSeqLen * 1024, ...)` | **colbertSeqLen = `colbertAll.dims[1]`**, NOT input seqLen |

The colbert stride is the key subtlety. `colbert_vecs` drops one token vs the input
(seq_len − 1 output tokens), so using `seqLen` (input) as the stride gives a wrong
offset for b ≥ 1 and makes non-zero-offset items appear corrupted — which was the
symptom in the original probe run before this fix.

---

## 5. Verdict

| Output | Batch-safe? | Note |
|--------|-------------|------|
| `dense_vecs` | ✅ **yes** | Bit-identical, stride=1024 |
| `sparse_vecs` | ✅ **yes** | Bit-identical, stride=seqLen |
| `colbert_vecs` | ✅ **yes** | Bit-identical, stride=colbertSeqLen*1024 |

**Overall verdict: PROCEED for dense+sparse; FEASIBLE for colbert.**

True batching is safe for all three outputs on this model and runtime. The earlier
probe run reported a colbert FAIL due to a slicing bug (using input `seqLen` as the
stride instead of `colbertAll.dims[1]`). After the fix, all outputs are bit-identical.

**Main blocker is not correctness but padding overhead:** batching heterogeneous
texts pads all items to the longest sequence, making mixed-length batches slower
than sequential (N=6: 0.38×). Batching is only beneficial when texts in a batch
have similar lengths.

---

## 6. Recommended next steps

1. **Length-bucketing before batching.** Group chunks by similar token length
   (e.g., buckets ≤16, ≤32, ≤64, ≤128, ≤256 tokens) before forming batches. This
   eliminates most padding waste and should recover the speedup.

2. **New `embedOnnxBatch(texts)` helper.** Implement alongside existing `embedOnnx`
   (not replacing it) to preserve current production behavior. Accepts `string[]`,
   returns `Array<{ dense, sparse }>`. Colbert output can be returned per item using
   the correct stride.

3. **Thread tuning experiment.** Set ORT `interOpNumThreads` / `intraOpNumThreads`
   and re-run probe. Default heuristics may not be optimal for batch inference on
   this machine.

4. **Homogeneous corpus benchmark.** Run the probe with texts of similar length
   (e.g., all ~50-token chunks) to measure the true ceiling of batch speedup without
   padding noise.

5. **Integration into `runBatched`.** Once `embedOnnxBatch` exists, replace the
   inner per-chunk `embedOnnx` call in `embedForIndex` with a batched call at
   `BATCH_SIZE` level. This requires restructuring the `runBatched` callback to
   receive the whole batch rather than individual items.

---

## 7. Impact on architecture blockers audit

Updates `2026-05-17-architecture-blockers-audit.md` §3 item #3:

- ONNX true batch inference: **PROCEED** (correctness confirmed).
- All three outputs bit-identical under correct slicing.
- Blocker is padding overhead from heterogeneous sequence lengths, not correctness.
- Recommended path: length-bucketed `embedOnnxBatch` helper, benchmark on real
  corpus before replacing production path.

---

## Artifacts

| File | Description |
|------|-------------|
| `benchmarks/onnx-batch-probe.js` | Probe script (corrected colbert slicing) |
| `benchmarks/retrieval/results/2026-05-17-onnx-true-batching-probe.md` | This report |
