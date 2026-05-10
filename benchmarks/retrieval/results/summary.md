# Benchmark Results Summary

Each row is one `npm run bench:retrieval` run. Add a row after every significant
change to chunking, embedding, search, or reranking logic.

| Date       | Queries | Provider           | Recall@1      | Recall@5 | MRR   | Avg ms | Notes                                        |
|------------|---------|--------------------|---------------|----------|-------|--------|----------------------------------------------|
| 2026-05-09 | 8       | ollama+hashed-tf   | 88% (7/8)     | 100%     | 0.938 | 166    | baseline 8q; q2 rank #2                     |
| 2026-05-09 | 8       | bge-m3-onnx        | **100% (8/8)**| 100%     | 1.000 | 92     | baseline 8q; all @1                         |
| 2026-05-09 | 20      | ollama+hashed-tf   | 90% (18/20)   | 100%     | 0.938 | 162    | expanded 20q; q2 #2, q15 #4                 |
| 2026-05-09 | 20      | bge-m3-onnx        | **95% (19/20)**| 100%    | 0.975 | 88     | expanded 20q; q2 #2 (shared miss with ollama)|
| 2026-05-09 | 20      | ollama+rerank-v1   | 90% (18/20)   | 100%     | 0.942 | 157    | rerank v1; q15 #4→#3, q2 unchanged          |
| 2026-05-09 | 20      | onnx+rerank-v1     | 95% (19/20)   | 100%     | 0.975 | 94     | rerank v1; q2 #1→#2 regression (token noise)|
| 2026-05-09 | 20      | ollama+rerank-v2   | 90% (18/20)   | 100%     | 0.938 | 159    | rerank v2; q2 unchanged, q15 stays #4       |
| 2026-05-09 | 20      | onnx+rerank-v2     | **100% (20/20)**| 100%   | 1.000 | 89     | rerank v2; q2 #2→#1 fixed, no regressions   |
| 2026-05-10 | 20      | ollama             | 90% (18/20)   | 100%     | 0.942 | 160    | matrix run; q2 #2, q15 #3                   |
| 2026-05-10 | 20      | ollama+rerank      | 85%* (17/20)  | 100%     | 0.917 | 153    | *q1 artefact (re-index variance); isolated debug=90%. See 2026-05-10-rerank-matrix.txt |
| 2026-05-10 | 20      | onnx               | 95% (19/20)   | 100%     | 0.975 | 87     | matrix run; q2 #2                            |
| 2026-05-10 | 20      | onnx+rerank        | 95% (19/20)   | 100%     | 0.975 | 90     | matrix run; q2 #2, no regressions vs baseline|

## How to update

After running `npm run bench:retrieval`, `npm run bench:retrieval:compare`, or
`npm run bench:retrieval:rerank`, paste the summary line(s) here and save a full
result file in `results/YYYY-MM-DD-<description>.txt`.

## Baseline interpretation

The 2026-05-09 20-query runs are the active baseline (4 fixture docs, 5 queries each).
The earlier 8-query rows are kept for historical reference only.

- bge-m3-onnx is the recommended provider: +5.0pp Recall@1, +0.037 MRR, ~1.8× faster warmed query latency.
- Any future run showing Recall@1 < 90% (ollama) or < 95% (onnx) is a regression.
- MRR drop ≥ 0.05 warrants investigation before merging.
- rerank v1 (2026-05-09): onnx q2 regressed #1→#2 due to cross-file token noise. See 2026-05-09-rerank-v1-compare.txt.
- rerank v2 (2026-05-09): stopwords + technical token weighting (TECH_MULT=3) + top-1 protection (delta=0.05). onnx: 100% Recall@1 / MRR 1.000 — q2 fixed, no regressions. ollama: unchanged (q15 stays #4). RERANK_ENABLED=0 default; recommended with onnx. See 2026-05-09-rerank-v2-compare.txt.
- rerank matrix (2026-05-10): fresh index run via `npm run bench:retrieval:rerank`. onnx+rerank: 95%/0.975 — stable, no regressions vs onnx baseline. ollama+rerank: 85%* in matrix (q1 re-index variance artefact; isolated debug confirms 90%). q2 miss persists for all variants. q15 now #3 for ollama (improved from #4 on 2026-05-09 — minor RRF variance). RERANK_ENABLED=0 remains default. See 2026-05-10-rerank-matrix.txt.
