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

## CLS offset (token alignment)

`aapot/bge-m3-onnx` **strips CLS from `colbert_vecs` output**.

| Metric | Value |
|--------|-------|
| `input_ids` length | 5 (includes CLS at position 0) |
| `colbert_vecs` seq_len | 4 (CLS stripped) |
| Inferred offset | **1** — `colbert_row[t] → inputIds[t + 1]` |
| First token IDs | `[0, 33600, 31, 8999, 2]` — CLS=0, EOS=2 |
| Last mapped token | EOS (id=2) — present in colbert output |

Token policy (`COLBERT_TOKEN_POLICY` env):
- **`official`** (default) — exclude CLS(0), bos(1), unk(3), mask(250001); **keep EOS(2)**
- **`no-eos`** — also exclude EOS(2)

Use `extractTokenVecsBGE()` (not the legacy `extractTokenVecs`) which detects offset automatically
from `inputIds.length - seqLen` and enforces policy. Throws on unexpected offset.

---

## Token counts (example query)

Query: "How does semidex index documents with ONNX embeddings?"

| Metric | Value |
|--------|-------|
| `input_ids` length (incl. CLS) | 15 |
| `colbert_vecs` seq_len (CLS stripped) | 14 |
| After attn_mask filter | 14 |
| After special-token filter (`official`) | 13 |

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

1. **CLS stripped by model (offset=1):** `colbert_vecs` seq_len = `inputIds.length − 1`.
   Token mapping: `colbert_row[t] → inputIds[t + 1]`. Use `extractTokenVecsBGE()`.
2. **No padding issue:** seq_len for a query is exactly the tokenised length (no forced
   padding to max_length=8192); sparse_vecs shape confirms per-query dynamic length.
3. **Special tokens:** filter CLS(0), bos(1), unk(3), mask(250001) via `COLBERT_TOKEN_POLICY`.
   EOS(2) kept by `official` policy (matches BGE-M3 authors), excluded by `no-eos`.
4. **Normalisation:** vectors are pre-normalised to unit L2 by the model — cosine = dot.
   MaxSim inner loop is pure dot product.
5. **Shape:** colbert_vecs is `[1, seq_len, 1024]` — extract `flat.slice(t*1024, (t+1)*1024)`
   per live token.
6. **No Qdrant multivector needed:** reranker reads colbert_vecs at query time only;
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

## Full benchmark results (2026-05-16 – 2026-05-17)

`bench:custom50:colbert` run with `COLBERT_TOP_N=40 MAX_LENGTH=512 SCORE_MODE=mean`, two token policies.

### Policy comparison — colbert-top40 (gate-evaluated mode)

| Metric | official | no-eos | Δ |
|--------|----------|--------|---|
| MRR@10 | 0.718 | **0.720** | +0.002 |
| nDCG@10 | 0.767 | **0.768** | +0.001 |
| chunkRecall@3 | 81.6% | **83.7%** | +2.1 pp |
| chunkRecall@5 | 93.9% | 93.9% | 0 |
| negativePass | 100% | 100% | = |
| Rank≤3 regressions | **1** (c36 #2→#4) | **0** | ✓ |
| Ordering losses | **3** (c05, c32, c39) | **3** (c05, c32, c36) | = count |
| Total MRR loss | 1.500 | **1.167** | −0.333 |
| Gate | FAILED | FAILED | = |
| p50 latency | 11 400 ms | 11 195 ms | ≈ |

**Policy interpretation:**
- `official` — FlagEmbedding parity reference: keeps EOS(2) as a content token per the released scoring code.
- `no-eos` — ablation based on an open FlagEmbedding issue/PR about EOS handling. Better experimental policy for semidex: eliminates the hard regression, lower total MRR loss, slightly higher MRR/nDCG.
- The EOS token appears to hurt c36 (`source-navigation`) specifically — removing it shifts c36 from a hard regression (#2→#4) to a softer ordering-loss (#2→#3, mrrLoss=0.167).
- The 3 persistent ordering losses (c05, c32 in both policies; c39 in `official`, c36 in `no-eos`) are structural: ColBERT promotes lexically similar but non-relevant `config-env.md` chunks above the hybrid top-1 because the term overlap with the query is high. This is a ranker-level limitation, not a guard issue.

### Gate verdict

Both policies: **FAILED**

`official`:
- ✗ 1 rank≤3 regression (c36: hybrid#2 → colbert#4)
- ✗ ordering-loss count = 3 (gate requires < 2)

`no-eos`:
- ✓ zero rank≤3 regressions
- ✗ ordering-loss count = 3 (gate requires < 2; CE v4 had 2)

### Artifact references

| Policy | Result file | Notes |
|--------|-------------|-------|
| official (initial run) | `benchmarks/retrieval/results/2026-05-16-custom50-colbert-top40-maxlen512-mean-official.txt` | first official run |
| official (post-optimization) | `benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt` | after eliminating top-20 duplicate ONNX encoding; quality metrics identical |
| no-eos | `benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt` | ablation — better experimental policy |

### Mode summary (no-eos run, for reference)

| Mode | MRR@10 | vs hybrid-true | nDCG@10 | p50 latency |
|------|--------|----------------|---------|-------------|
| hybrid-true | 0.665 | — | 0.712 | 183 ms |
| det-rerank | 0.683 | +0.018 | 0.728 | 52 ms |
| colbert-top20 | 0.718 | +0.053 | 0.763 | 6 024 ms |
| colbert-top40 | **0.720** | **+0.055** | 0.768 | 11 195 ms |
| CE v4 reference | 0.764 | — | — | — |

**Latency:** colbert-top40 p50 ≈ 11 200 ms (63× slower than hybrid). colbert-top20 p50 ≈ 6 000 ms — both far over any production budget. Latency is CPU-bound per-inference; no batch/cache path tested yet.

---

## Stage 1 verdict — DEFER standalone ColBERT

**Standalone ColBERT reranking is deferred.** Neither token policy passes the gate.

The gate-blocking criterion is ordering-loss count ≥ 2 in both cases. The losses are structural: c05 and c32 both involve ColBERT promoting a lexically-matching but irrelevant `config-env.md` chunk above the correct hybrid top-1. This is a known limitation of token-level interaction without a top-1 protection mechanism.

**Recommended next experiment if continuing:** guarded/blended ColBERT variants only:
- top-1 protection (do not displace hybrid #1 unless ColBERT score advantage exceeds a threshold)
- hybrid/ColBERT score blend
- trigger-only rerank (apply ColBERT only when hybrid confidence is low)

**No production runtime changes.** ColBERT remains benchmark-only. No `src/` or MCP changes.
