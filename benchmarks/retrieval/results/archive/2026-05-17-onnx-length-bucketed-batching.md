# ONNX Length-Bucketed Batching — Benchmark Results (2026-05-17)

**Question:** Does length-bucketed batching recover the ONNX embedding speedup on a
realistic fixture corpus? What is the best batch-size / bucket strategy? Is this
ready for opt-in production use?

**Method:** `benchmarks/onnx-batch-indexing-bench.js` — three strategies on 6 fixture
docs (163 paragraph-chunks): sequential `embedOnnx()`, naive fixed-batch
`embedOnnxBatch()`, length-bucketed `embedBucketed()`. Correctness verified against
sequential baseline (max dense delta, max sparse delta, avg cosine sim).

---

## Corpus

| Doc | Chunks |
|-----|--------|
| benchmarking.md | 41 |
| config-env.md | 32 |
| mcp-workflow.md | 28 |
| multilingual.md | 25 |
| obsidian.md | 20 |
| project-structure.md | 17 |
| **Total** | **163** |

Token-length distribution (estimated, chars/4):

| Range | Count | % |
|-------|-------|---|
| 1–16 | 74 | 45.4% |
| 17–32 | 15 | 9.2% |
| 33–64 | 43 | 26.4% |
| 65–128 | 25 | 15.3% |
| 129–256 | 5 | 3.1% |
| >256 | 1 | 0.6% |

---

## Timing Results (2026-05-17, CPU, bge-m3-onnx, batch-size=4)

| Strategy | Total ms | ms/text | Speedup vs sequential |
|----------|----------|---------|----------------------|
| Sequential | 18 145 ms | 111.3 ms | 1.00× (baseline) |
| Naive batch (size=4) | 38 061 ms | 233.5 ms | **0.48×** |
| Bucketed (maxBatch=4) | 19 434 ms | 119.2 ms | **0.93×** |

Naive batching at size=4 is dramatically slower (0.48×): a padded batch of 4 texts
takes more than 4× the time of a single text on CPU, overwhelming any throughput
benefit. Bucketed batching avoids the worst padding waste but still regresses to 0.93×.

---

## Correctness vs Sequential

| Strategy | Max dense delta | Max sparse delta | Avg cosine sim | Bit-identical |
|----------|-----------------|------------------|----------------|---------------|
| Naive batch (size=4) | 0 | 0 | 1.000000 | **Yes** |
| Bucketed (maxBatch=4) | 0 | 0 | 1.000000 | **Yes** |

**Result: correctness PASS.** Both strategies are bit-identical to sequential.
Batch inference with bge-m3-onnx is deterministic: padding positions are masked out
by `attention_mask`, so the outputs for each text are unaffected by other texts in
the batch.

---

## Why Bucketing Did Not Speed Up

The dominant cost is not padding — it is **ONNX session overhead per `session.run()`
call** at small batch sizes on CPU:

- `session.run()` call overhead is roughly constant per call regardless of batch size.
- Naive batch N=4: pads all texts to the longest in the batch, so compute scales with
  max-length rather than average-length. On a heterogeneous corpus this easily 2–4×es
  the work per call while `session.run()` overhead stays fixed → 0.48× net.
- Bucketed N=4: keeps similar-length texts together, reducing within-bucket padding.
  Still does not recover: per-call overhead + some residual padding → 0.93×.
- The probe (`2026-05-17-onnx-true-batching-probe.md`) showed N=2 → ~1.25× on
  synthetic uniform-length inputs. That speedup disappears on a real corpus because
  average effective N per bucket is low and padding variance within buckets is high.

---

## Verdict

| Question | Answer |
|----------|--------|
| Does bucketing recover speedup? | **No** — 0.93× (marginal regression) on CPU |
| Naive batching? | **No** — 0.48× (significant regression) on CPU |
| Correctness safe? | **Yes** — bit-identical to sequential (max delta = 0) |
| Ready for opt-in production? | **No** — no latency benefit on CPU |
| Next step | DML/CUDA probe where parallel execution units make batching worthwhile; or abandon |

**The `embedBucketed` / `embedOnnxBatch` helpers remain in codebase as benchmark
infrastructure.** They are not wired into the production indexer. No production
change needed.

---

## Artifacts

- `benchmarks/onnx-batch-indexing-bench.js` — benchmark script
- `benchmarks/lib/length-bucket.js` — pure bucketing helper (no ONNX dependency)
- `src/core/onnx-embed.js` — `embedOnnxBatch()` added (benchmark/opt-in only)
- `src/smoke/sections/23-length-bucket.js` — 32 assertions on pure helpers (all pass)
- Prior probe: `2026-05-17-onnx-true-batching-probe.md`
