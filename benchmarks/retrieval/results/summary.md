# Benchmark Results Summary

Each row is one `npm run bench:retrieval` run. Add a row after every significant
change to chunking, embedding, search, or reranking logic.

| Date       | Queries | Provider           | Recall@1      | Recall@5 | MRR   | Avg ms | Notes                                        |
|------------|---------|--------------------|---------------|----------|-------|--------|----------------------------------------------|
| 2026-05-09 | 8       | ollama+hashed-tf   | 88% (7/8)     | 100%     | 0.938 | 166    | baseline 8q; q2 rank #2                     |
| 2026-05-09 | 8       | bge-m3-onnx        | **100% (8/8)**| 100%     | 1.000 | 92     | baseline 8q; all @1                         |
| 2026-05-09 | 20      | ollama+hashed-tf   | 90% (18/20)   | 100%     | 0.938 | 162    | expanded 20q; q2 #2, q15 #4                 |
| 2026-05-09 | 20      | bge-m3-onnx        | **95% (19/20)**| 100%    | 0.975 | 88     | expanded 20q; q2 #2 (shared miss with ollama)|

## How to update

After running `npm run bench:retrieval` or `npm run bench:retrieval:compare`, paste
the summary line here and save a full result file in `results/YYYY-MM-DD-<provider>.txt`.

## Baseline interpretation

The 2026-05-09 runs are the founding baseline on 8 queries / 4 fixture docs.

- bge-m3-onnx is the recommended provider: +12.5pp Recall@1, +0.062 MRR, 1.8× faster warmed query latency.
- Any future run showing Recall@1 < 88% (ollama) or < 100% (onnx) is a regression.
- MRR drop ≥ 0.05 warrants investigation before merging.
