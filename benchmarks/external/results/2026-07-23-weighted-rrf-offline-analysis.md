# Offline weighted-RRF candidate analysis

Verdict: **CANDIDATES_SELECTED**

> This offline analysis narrows candidates only. Final acceptance requires
> real Qdrant 1.17+ weighted-RRF queries using `query.rrf.weights`.

This analysis uses ONLY already-completed TREC runs. No Qdrant queries were
executed, no ONNX models were loaded, and no collections were created or
deleted while producing this report.

## Qdrant's real weighted-RRF formula

Qdrant 1.17+ (this project runs server 1.17.1, `@qdrant/js-client-rest`
1.18.0) computes a document's per-lane weighted-RRF contribution as:

```
contribution(rank, weight, k) = 1 / (k + (rank + 1) / weight - 1)
```

where `rank` is ZERO-BASED. This is passed via
`query: { rrf: { k, weights: [denseWeight, sparseWeight] } }` — never via
`prefetch.weight` (no such field exists in Qdrant's hybrid-query API), and
never approximated with `FormulaQuery` (which sees raw prefetch scores, not
prefetch ranks, and is therefore not a substitute for rank fusion). The
naive formula `weight / (k + rank)` is explicitly WRONG and is not used
anywhere in this analysis.

### Why raw weights mean different things under k=2 vs k=60

At rank=0 (the top result), `contribution(0, w, k) = 1 / (k + 1/w - 1)`.
When `k` is small (k=2), `1/w` is a large fraction of the denominator, so
changing `w` moves the contribution a lot. When `k` is large (k=60), `k`
itself dominates the denominator and `1/w` barely matters — a raw
`weight=0.25` at k=60 leaves the top-rank contribution at ~95% of equal
weighting (`1/60 / (1/60 + (1-1)/1)`... concretely: dense contributes
1/60≈0.01667 at rank 0 regardless; sparse at weight 0.25 contributes
1/(60+4-1)=1/63≈0.01587 — barely reduced), while the SAME raw weight at
k=2 cuts the top-rank contribution to 40% of equal weighting. This is
exactly why this analysis parametrizes configurations by a TARGET rank-1
contribution ratio `rho`, converted to the actual Qdrant weight per-k via
`sparseWeightFromRho(k, rho) = 1 / (k * (1/rho - 1) + 1)`, rather than
sweeping raw weight values that would mean incomparable things at k=2 vs
k=60.

| k | rho | sparseWeight |
|---:|---:|---:|
| 2 | 0.10 | 0.0526316 |
| 2 | 0.25 | 0.1428571 |
| 2 | 0.50 | 0.3333333 |
| 2 | 0.75 | 0.6000000 |
| 2 | 1.00 | 1.0000000 |
| 60 | 0.10 | 0.0018484 |
| 60 | 0.25 | 0.0055249 |
| 60 | 0.50 | 0.0163934 |
| 60 | 0.75 | 0.0476190 |
| 60 | 1.00 | 1.0000000 |

## Dataset roles

- **SciFact (local BGE-M3)**: English, full 300-query test split.
- **MIRACL Russian (local BGE-M3)**: 100-query pooled subset. Already
  inspected in prior tasks — NOT a blind holdout. Treated here as
  diagnostic/validation evidence, never as confirmatory evidence for a
  final decision.
- **Belebele (7 languages, local BGE-M3)**: parallel corpus, MRC-derived
  qrels (one relevant passage per query) — see
  `../slavic/fetch-belebele.mjs`'s module header for the full caveat.
- Only local BGE-M3 runs are used. Qdrant Cloud E5/BM25 runs are never
  mixed into this analysis.

## Input ranking depth and dataset revision

Belebele dataset: `mteb/belebele` @ `979a211276faa22f671e69d096634193567cfd05`.

| Scope | Queries | Dense depth (min/max) | Sparse depth (min/max) |
|---|---:|---:|---:|
| scifact_local | 300 | 100/100 | 100/100 |
| miracl_local | 100 | 100/100 | 32/100 |
| belebele_ukr_Cyrl | 900 | 100/100 | 25/100 |
| belebele_rus_Cyrl | 900 | 100/100 | 6/100 |
| belebele_bul_Cyrl | 900 | 100/100 | 12/100 |
| belebele_pol_Latn | 900 | 100/100 | 17/100 |
| belebele_ces_Latn | 900 | 100/100 | 17/100 |
| belebele_slk_Latn | 900 | 100/100 | 8/100 |
| belebele_eng_Latn | 900 | 100/100 | 12/100 |

## Parity with real Qdrant runs

Offline equal-RRF (weights=[1,1]) reconstructed from the saved dense/sparse
TREC lanes and compared against a REAL Qdrant hybrid run for the same
scope/k, where one exists.

| Scope | k | Available | Max |Δmetric| | Queries w/ top-10 diff | Faithful? |
|---|---:|---|---:|---:|---|
| scifact_local | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "scifact_local") |
| scifact_local | 60 | yes | 0.0033 | 91/300 (30.3%) | NO — do not treat as exact simulation |
| miracl_local | 2 | yes | 0.0200 | 25/100 (25.0%) | NO — do not treat as exact simulation |
| miracl_local | 60 | yes | 0.0083 | 17/100 (17.0%) | NO — do not treat as exact simulation |
| belebele_ukr_Cyrl | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_ukr_Cyrl") |
| belebele_ukr_Cyrl | 60 | yes | 0.0022 | 175/900 (19.4%) | NO — do not treat as exact simulation |
| belebele_rus_Cyrl | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_rus_Cyrl") |
| belebele_rus_Cyrl | 60 | yes | 0.0043 | 187/900 (20.8%) | NO — do not treat as exact simulation |
| belebele_bul_Cyrl | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_bul_Cyrl") |
| belebele_bul_Cyrl | 60 | yes | 0.0038 | 177/900 (19.7%) | NO — do not treat as exact simulation |
| belebele_pol_Latn | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_pol_Latn") |
| belebele_pol_Latn | 60 | yes | 0.0056 | 171/900 (19.0%) | NO — do not treat as exact simulation |
| belebele_ces_Latn | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_ces_Latn") |
| belebele_ces_Latn | 60 | yes | 0.0028 | 187/900 (20.8%) | NO — do not treat as exact simulation |
| belebele_slk_Latn | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_slk_Latn") |
| belebele_slk_Latn | 60 | yes | 0.0017 | 201/900 (22.3%) | NO — do not treat as exact simulation |
| belebele_eng_Latn | 2 | no | n/a | n/a | n/a (no real Qdrant hybrid_k2 TREC run exists for scope "belebele_eng_Latn") |
| belebele_eng_Latn | 60 | yes | 0.0011 | 133/900 (14.8%) | NO — do not treat as exact simulation |

Caveat (applies to every row above): the saved dense/sparse TREC lane
files are capped at top-100 per query, while the real Qdrant hybrid
queries used prefetch limit 200 per lane. This reconstruction is never
claimed to be an exact simulation of the live prefetch=200 request.

## Aggregate metrics per scope and configuration

### scifact_local (SciFact full test split — local BGE-M3)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.6380 | 0.5958 | 0.7718 | 0.9070 | 0.6044 | 0 (0.0%) | 0 (0.0%) | 300 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.6344 | 0.5921 | 0.7663 | 0.9036 | 0.6008 | 60 (20.0%) | 70 (23.3%) | 170 | -0.0036 | 0.0000 | MIXED (meanΔ=-0.0036, CI95%=[-0.0362, 0.0298]) |
| k2_rho0.10 | 0.6394 | 0.5976 | 0.7751 | 0.9203 | 0.6052 | 8 (2.7%) | 3 (1.0%) | 289 | 0.0014 | 0.0000 | MIXED (meanΔ=0.0014, CI95%=[-0.0019, 0.0053]) |
| k2_rho0.25 | 0.6494 | 0.6034 | 0.7958 | 0.9237 | 0.6116 | 26 (8.7%) | 10 (3.3%) | 264 | 0.0114 | 0.0000 | B_BETTER (meanΔ=0.0114, CI95%=[0.0042, 0.0194]) |
| k2_rho0.50 | 0.6633 | 0.6148 | 0.8141 | 0.9270 | 0.6226 | 48 (16.0%) | 22 (7.3%) | 230 | 0.0253 | 0.0000 | B_BETTER (meanΔ=0.0253, CI95%=[0.0130, 0.0379]) |
| k2_rho0.75 | 0.6720 | 0.6263 | 0.8141 | 0.9303 | 0.6353 | 53 (17.7%) | 32 (10.7%) | 215 | 0.0340 | 0.0000 | B_BETTER (meanΔ=0.0340, CI95%=[0.0185, 0.0520]) |
| k2_rho1.00 | 0.6727 | 0.6278 | 0.8109 | 0.9303 | 0.6383 | 56 (18.7%) | 37 (12.3%) | 207 | 0.0347 | 0.0000 | B_BETTER (meanΔ=0.0347, CI95%=[0.0145, 0.0555]) |
| k60_rho0.10 | 0.6587 | 0.6208 | 0.7784 | 0.9070 | 0.6296 | 45 (15.0%) | 25 (8.3%) | 230 | 0.0207 | 0.0000 | B_BETTER (meanΔ=0.0207, CI95%=[0.0049, 0.0357]) |
| k60_rho0.25 | 0.6600 | 0.6221 | 0.7801 | 0.9070 | 0.6299 | 54 (18.0%) | 43 (14.3%) | 203 | 0.0220 | 0.0000 | MIXED (meanΔ=0.0220, CI95%=[-0.0002, 0.0419]) |
| k60_rho0.50 | 0.6619 | 0.6153 | 0.8058 | 0.9170 | 0.6247 | 65 (21.7%) | 48 (16.0%) | 187 | 0.0239 | 0.0000 | MIXED (meanΔ=0.0239, CI95%=[-0.0004, 0.0481]) |
| k60_rho0.75 | 0.6663 | 0.6223 | 0.8033 | 0.9203 | 0.6298 | 65 (21.7%) | 51 (17.0%) | 184 | 0.0283 | 0.0000 | B_BETTER (meanΔ=0.0283, CI95%=[0.0014, 0.0559]) |
| k60_rho1.00 | 0.6762 | 0.6390 | 0.7953 | 0.9303 | 0.6478 | 67 (22.3%) | 29 (9.7%) | 204 | 0.0382 | 0.0000 | B_BETTER (meanΔ=0.0382, CI95%=[0.0150, 0.0607]) |

### miracl_local (MIRACL Russian pooled subset — local BGE-M3)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.8995 | 0.8385 | 0.9851 | 1.0000 | 0.9163 | 0 (0.0%) | 0 (0.0%) | 100 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.7526 | 0.6794 | 0.8898 | 0.9817 | 0.7466 | 13 (13.0%) | 59 (59.0%) | 28 | -0.1469 | -0.0506 | A_BETTER (meanΔ=-0.1469, CI95%=[-0.1978, -0.0972]) |
| k2_rho0.10 | 0.8994 | 0.8381 | 0.9851 | 1.0000 | 0.9167 | 1 (1.0%) | 3 (3.0%) | 96 | -0.0000 | 0.0000 | MIXED (meanΔ=-0.0000, CI95%=[-0.0010, 0.0011]) |
| k2_rho0.25 | 0.8935 | 0.8347 | 0.9740 | 1.0000 | 0.9170 | 6 (6.0%) | 16 (16.0%) | 78 | -0.0060 | 0.0000 | A_BETTER (meanΔ=-0.0060, CI95%=[-0.0117, -0.0006]) |
| k2_rho0.50 | 0.8819 | 0.8205 | 0.9740 | 1.0000 | 0.8945 | 13 (13.0%) | 28 (28.0%) | 59 | -0.0175 | 0.0000 | A_BETTER (meanΔ=-0.0175, CI95%=[-0.0328, -0.0024]) |
| k2_rho0.75 | 0.8664 | 0.7966 | 0.9790 | 1.0000 | 0.8683 | 14 (14.0%) | 36 (36.0%) | 50 | -0.0331 | 0.0000 | A_BETTER (meanΔ=-0.0331, CI95%=[-0.0534, -0.0137]) |
| k2_rho1.00 | 0.8559 | 0.7828 | 0.9790 | 0.9967 | 0.8483 | 15 (15.0%) | 39 (39.0%) | 46 | -0.0435 | 0.0000 | A_BETTER (meanΔ=-0.0435, CI95%=[-0.0670, -0.0212]) |
| k60_rho0.10 | 0.8522 | 0.7817 | 0.9835 | 1.0000 | 0.8245 | 11 (11.0%) | 30 (30.0%) | 59 | -0.0473 | 0.0000 | A_BETTER (meanΔ=-0.0473, CI95%=[-0.0723, -0.0229]) |
| k60_rho0.25 | 0.8179 | 0.7370 | 0.9790 | 1.0000 | 0.7792 | 17 (17.0%) | 47 (47.0%) | 36 | -0.0815 | 0.0000 | A_BETTER (meanΔ=-0.0815, CI95%=[-0.1157, -0.0460]) |
| k60_rho0.50 | 0.8028 | 0.7149 | 0.9790 | 1.0000 | 0.7650 | 18 (18.0%) | 50 (50.0%) | 32 | -0.0966 | -0.0025 | A_BETTER (meanΔ=-0.0966, CI95%=[-0.1343, -0.0588]) |
| k60_rho0.75 | 0.7958 | 0.7037 | 0.9791 | 1.0000 | 0.7601 | 18 (18.0%) | 53 (53.0%) | 29 | -0.1037 | -0.0190 | A_BETTER (meanΔ=-0.1037, CI95%=[-0.1428, -0.0646]) |
| k60_rho1.00 | 0.8378 | 0.7633 | 0.9652 | 0.9967 | 0.8361 | 16 (16.0%) | 41 (41.0%) | 43 | -0.0616 | 0.0000 | A_BETTER (meanΔ=-0.0616, CI95%=[-0.0938, -0.0321]) |

### belebele_ukr_Cyrl (Belebele ukr_Cyrl)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9372 | 0.9217 | 0.9856 | 0.9989 | 0.9212 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8596 | 0.8381 | 0.9311 | 0.9700 | 0.8364 | 56 (6.2%) | 160 (17.8%) | 684 | -0.0776 | 0.0000 | A_BETTER (meanΔ=-0.0776, CI95%=[-0.0975, -0.0600]) |
| k2_rho0.10 | 0.9381 | 0.9221 | 0.9878 | 0.9989 | 0.9217 | 7 (0.8%) | 0 (0.0%) | 893 | 0.0009 | 0.0000 | B_BETTER (meanΔ=0.0009, CI95%=[0.0001, 0.0020]) |
| k2_rho0.25 | 0.9400 | 0.9241 | 0.9889 | 0.9989 | 0.9237 | 22 (2.4%) | 7 (0.8%) | 871 | 0.0028 | 0.0000 | B_BETTER (meanΔ=0.0028, CI95%=[0.0013, 0.0046]) |
| k2_rho0.50 | 0.9477 | 0.9344 | 0.9889 | 0.9978 | 0.9340 | 48 (5.3%) | 18 (2.0%) | 834 | 0.0105 | 0.0000 | B_BETTER (meanΔ=0.0105, CI95%=[0.0057, 0.0155]) |
| k2_rho0.75 | 0.9495 | 0.9363 | 0.9900 | 0.9967 | 0.9361 | 55 (6.1%) | 36 (4.0%) | 809 | 0.0123 | 0.0000 | B_BETTER (meanΔ=0.0123, CI95%=[0.0057, 0.0190]) |
| k2_rho1.00 | 0.9462 | 0.9323 | 0.9889 | 0.9956 | 0.9320 | 59 (6.6%) | 51 (5.7%) | 790 | 0.0090 | 0.0000 | B_BETTER (meanΔ=0.0090, CI95%=[0.0008, 0.0170]) |
| k60_rho0.10 | 0.9450 | 0.9310 | 0.9878 | 0.9989 | 0.9307 | 62 (6.9%) | 45 (5.0%) | 793 | 0.0078 | 0.0000 | MIXED (meanΔ=0.0078, CI95%=[-0.0005, 0.0164]) |
| k60_rho0.25 | 0.9340 | 0.9161 | 0.9878 | 0.9989 | 0.9157 | 64 (7.1%) | 77 (8.6%) | 759 | -0.0032 | 0.0000 | MIXED (meanΔ=-0.0032, CI95%=[-0.0135, 0.0067]) |
| k60_rho0.50 | 0.9224 | 0.9001 | 0.9900 | 0.9989 | 0.8998 | 65 (7.2%) | 98 (10.9%) | 737 | -0.0148 | 0.0000 | A_BETTER (meanΔ=-0.0148, CI95%=[-0.0266, -0.0035]) |
| k60_rho0.75 | 0.9151 | 0.8912 | 0.9889 | 0.9989 | 0.8908 | 66 (7.3%) | 109 (12.1%) | 725 | -0.0221 | 0.0000 | A_BETTER (meanΔ=-0.0221, CI95%=[-0.0352, -0.0099]) |
| k60_rho1.00 | 0.9267 | 0.9143 | 0.9678 | 0.9956 | 0.9131 | 70 (7.8%) | 60 (6.7%) | 770 | -0.0105 | 0.0000 | MIXED (meanΔ=-0.0105, CI95%=[-0.0238, 0.0021]) |

### belebele_rus_Cyrl (Belebele rus_Cyrl)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9466 | 0.9330 | 0.9889 | 0.9967 | 0.9327 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8873 | 0.8709 | 0.9422 | 0.9733 | 0.8695 | 49 (5.4%) | 127 (14.1%) | 724 | -0.0592 | 0.0000 | A_BETTER (meanΔ=-0.0592, CI95%=[-0.0765, -0.0429]) |
| k2_rho0.10 | 0.9472 | 0.9335 | 0.9900 | 0.9967 | 0.9332 | 9 (1.0%) | 0 (0.0%) | 891 | 0.0007 | 0.0000 | B_BETTER (meanΔ=0.0007, CI95%=[0.0002, 0.0016]) |
| k2_rho0.25 | 0.9491 | 0.9355 | 0.9911 | 0.9967 | 0.9352 | 21 (2.3%) | 9 (1.0%) | 870 | 0.0026 | 0.0000 | B_BETTER (meanΔ=0.0026, CI95%=[0.0010, 0.0043]) |
| k2_rho0.50 | 0.9564 | 0.9448 | 0.9922 | 0.9967 | 0.9446 | 44 (4.9%) | 18 (2.0%) | 838 | 0.0099 | 0.0000 | B_BETTER (meanΔ=0.0099, CI95%=[0.0055, 0.0145]) |
| k2_rho0.75 | 0.9552 | 0.9437 | 0.9911 | 0.9967 | 0.9434 | 48 (5.3%) | 38 (4.2%) | 814 | 0.0087 | 0.0000 | B_BETTER (meanΔ=0.0087, CI95%=[0.0018, 0.0153]) |
| k2_rho1.00 | 0.9497 | 0.9366 | 0.9900 | 0.9967 | 0.9363 | 50 (5.6%) | 52 (5.8%) | 798 | 0.0031 | 0.0000 | MIXED (meanΔ=0.0031, CI95%=[-0.0047, 0.0109]) |
| k60_rho0.10 | 0.9467 | 0.9324 | 0.9900 | 0.9967 | 0.9321 | 50 (5.6%) | 50 (5.6%) | 800 | 0.0001 | 0.0000 | MIXED (meanΔ=0.0001, CI95%=[-0.0078, 0.0080]) |
| k60_rho0.25 | 0.9402 | 0.9237 | 0.9900 | 0.9967 | 0.9234 | 53 (5.9%) | 78 (8.7%) | 769 | -0.0063 | 0.0000 | MIXED (meanΔ=-0.0063, CI95%=[-0.0159, 0.0031]) |
| k60_rho0.50 | 0.9309 | 0.9106 | 0.9922 | 0.9967 | 0.9104 | 57 (6.3%) | 98 (10.9%) | 745 | -0.0157 | 0.0000 | A_BETTER (meanΔ=-0.0157, CI95%=[-0.0271, -0.0046]) |
| k60_rho0.75 | 0.9267 | 0.9054 | 0.9922 | 0.9967 | 0.9051 | 59 (6.6%) | 102 (11.3%) | 739 | -0.0198 | 0.0000 | A_BETTER (meanΔ=-0.0198, CI95%=[-0.0317, -0.0080]) |
| k60_rho1.00 | 0.9382 | 0.9275 | 0.9733 | 0.9967 | 0.9265 | 60 (6.7%) | 53 (5.9%) | 787 | -0.0084 | 0.0000 | MIXED (meanΔ=-0.0084, CI95%=[-0.0204, 0.0030]) |

### belebele_bul_Cyrl (Belebele bul_Cyrl)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9333 | 0.9192 | 0.9800 | 0.9978 | 0.9181 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8789 | 0.8632 | 0.9322 | 0.9678 | 0.8617 | 57 (6.3%) | 130 (14.4%) | 713 | -0.0544 | 0.0000 | A_BETTER (meanΔ=-0.0544, CI95%=[-0.0717, -0.0376]) |
| k2_rho0.10 | 0.9347 | 0.9198 | 0.9833 | 0.9978 | 0.9189 | 10 (1.1%) | 0 (0.0%) | 890 | 0.0014 | 0.0000 | B_BETTER (meanΔ=0.0014, CI95%=[0.0003, 0.0028]) |
| k2_rho0.25 | 0.9375 | 0.9225 | 0.9856 | 0.9978 | 0.9217 | 26 (2.9%) | 5 (0.6%) | 869 | 0.0042 | 0.0000 | B_BETTER (meanΔ=0.0042, CI95%=[0.0021, 0.0066]) |
| k2_rho0.50 | 0.9451 | 0.9326 | 0.9856 | 0.9978 | 0.9319 | 44 (4.9%) | 20 (2.2%) | 836 | 0.0118 | 0.0000 | B_BETTER (meanΔ=0.0118, CI95%=[0.0071, 0.0167]) |
| k2_rho0.75 | 0.9470 | 0.9353 | 0.9856 | 0.9978 | 0.9346 | 49 (5.4%) | 37 (4.1%) | 814 | 0.0137 | 0.0000 | B_BETTER (meanΔ=0.0137, CI95%=[0.0072, 0.0206]) |
| k2_rho1.00 | 0.9458 | 0.9340 | 0.9844 | 0.9956 | 0.9333 | 52 (5.8%) | 46 (5.1%) | 802 | 0.0125 | 0.0000 | B_BETTER (meanΔ=0.0125, CI95%=[0.0038, 0.0214]) |
| k60_rho0.10 | 0.9399 | 0.9264 | 0.9833 | 0.9978 | 0.9255 | 55 (6.1%) | 45 (5.0%) | 800 | 0.0066 | 0.0000 | MIXED (meanΔ=0.0066, CI95%=[-0.0017, 0.0146]) |
| k60_rho0.25 | 0.9336 | 0.9170 | 0.9856 | 0.9978 | 0.9162 | 61 (6.8%) | 77 (8.6%) | 762 | 0.0003 | 0.0000 | MIXED (meanΔ=0.0003, CI95%=[-0.0109, 0.0112]) |
| k60_rho0.50 | 0.9276 | 0.9079 | 0.9889 | 0.9978 | 0.9074 | 69 (7.7%) | 91 (10.1%) | 740 | -0.0057 | 0.0000 | MIXED (meanΔ=-0.0057, CI95%=[-0.0180, 0.0061]) |
| k60_rho0.75 | 0.9234 | 0.9022 | 0.9900 | 0.9978 | 0.9018 | 69 (7.7%) | 99 (11.0%) | 732 | -0.0099 | 0.0000 | MIXED (meanΔ=-0.0099, CI95%=[-0.0224, 0.0025]) |
| k60_rho1.00 | 0.9305 | 0.9197 | 0.9667 | 0.9956 | 0.9185 | 65 (7.2%) | 52 (5.8%) | 783 | -0.0028 | 0.0000 | MIXED (meanΔ=-0.0028, CI95%=[-0.0153, 0.0096]) |

### belebele_pol_Latn (Belebele pol_Latn)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9401 | 0.9285 | 0.9789 | 0.9967 | 0.9275 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8507 | 0.8317 | 0.9133 | 0.9478 | 0.8304 | 42 (4.7%) | 158 (17.6%) | 700 | -0.0895 | 0.0000 | A_BETTER (meanΔ=-0.0895, CI95%=[-0.1098, -0.0711]) |
| k2_rho0.10 | 0.9413 | 0.9290 | 0.9822 | 0.9967 | 0.9280 | 7 (0.8%) | 0 (0.0%) | 893 | 0.0012 | 0.0000 | B_BETTER (meanΔ=0.0012, CI95%=[0.0002, 0.0025]) |
| k2_rho0.25 | 0.9440 | 0.9308 | 0.9867 | 0.9967 | 0.9302 | 22 (2.4%) | 6 (0.7%) | 872 | 0.0039 | 0.0000 | B_BETTER (meanΔ=0.0039, CI95%=[0.0020, 0.0060]) |
| k2_rho0.50 | 0.9464 | 0.9343 | 0.9856 | 0.9967 | 0.9336 | 37 (4.1%) | 22 (2.4%) | 841 | 0.0063 | 0.0000 | B_BETTER (meanΔ=0.0063, CI95%=[0.0020, 0.0110]) |
| k2_rho0.75 | 0.9460 | 0.9340 | 0.9844 | 0.9978 | 0.9333 | 41 (4.6%) | 37 (4.1%) | 822 | 0.0058 | 0.0000 | MIXED (meanΔ=0.0058, CI95%=[-0.0005, 0.0124]) |
| k2_rho1.00 | 0.9348 | 0.9194 | 0.9833 | 0.9978 | 0.9187 | 42 (4.7%) | 70 (7.8%) | 788 | -0.0053 | 0.0000 | MIXED (meanΔ=-0.0053, CI95%=[-0.0138, 0.0038]) |
| k60_rho0.10 | 0.9397 | 0.9264 | 0.9822 | 0.9967 | 0.9256 | 41 (4.6%) | 44 (4.9%) | 815 | -0.0005 | 0.0000 | MIXED (meanΔ=-0.0005, CI95%=[-0.0085, 0.0076]) |
| k60_rho0.25 | 0.9306 | 0.9130 | 0.9856 | 0.9967 | 0.9123 | 46 (5.1%) | 78 (8.7%) | 776 | -0.0095 | 0.0000 | MIXED (meanΔ=-0.0095, CI95%=[-0.0190, 0.0007]) |
| k60_rho0.50 | 0.9156 | 0.8925 | 0.9878 | 0.9967 | 0.8919 | 48 (5.3%) | 112 (12.4%) | 740 | -0.0245 | 0.0000 | A_BETTER (meanΔ=-0.0245, CI95%=[-0.0364, -0.0123]) |
| k60_rho0.75 | 0.9042 | 0.8788 | 0.9856 | 0.9967 | 0.8780 | 52 (5.8%) | 125 (13.9%) | 723 | -0.0359 | 0.0000 | A_BETTER (meanΔ=-0.0359, CI95%=[-0.0501, -0.0223]) |
| k60_rho1.00 | 0.9069 | 0.8978 | 0.9422 | 0.9978 | 0.8954 | 48 (5.3%) | 76 (8.4%) | 776 | -0.0332 | 0.0000 | A_BETTER (meanΔ=-0.0332, CI95%=[-0.0493, -0.0178]) |

### belebele_ces_Latn (Belebele ces_Latn)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9403 | 0.9253 | 0.9878 | 0.9978 | 0.9248 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8868 | 0.8728 | 0.9344 | 0.9733 | 0.8715 | 57 (6.3%) | 127 (14.1%) | 716 | -0.0535 | 0.0000 | A_BETTER (meanΔ=-0.0535, CI95%=[-0.0709, -0.0376]) |
| k2_rho0.10 | 0.9410 | 0.9258 | 0.9889 | 0.9978 | 0.9253 | 8 (0.9%) | 0 (0.0%) | 892 | 0.0007 | 0.0000 | B_BETTER (meanΔ=0.0007, CI95%=[0.0002, 0.0015]) |
| k2_rho0.25 | 0.9429 | 0.9281 | 0.9889 | 0.9978 | 0.9276 | 26 (2.9%) | 9 (1.0%) | 865 | 0.0026 | 0.0000 | B_BETTER (meanΔ=0.0026, CI95%=[0.0009, 0.0042]) |
| k2_rho0.50 | 0.9515 | 0.9397 | 0.9889 | 0.9978 | 0.9392 | 51 (5.7%) | 19 (2.1%) | 830 | 0.0112 | 0.0000 | B_BETTER (meanΔ=0.0112, CI95%=[0.0066, 0.0160]) |
| k2_rho0.75 | 0.9531 | 0.9423 | 0.9878 | 0.9967 | 0.9417 | 54 (6.0%) | 38 (4.2%) | 808 | 0.0128 | 0.0000 | B_BETTER (meanΔ=0.0128, CI95%=[0.0062, 0.0197]) |
| k2_rho1.00 | 0.9470 | 0.9353 | 0.9844 | 0.9967 | 0.9346 | 54 (6.0%) | 54 (6.0%) | 792 | 0.0067 | 0.0000 | MIXED (meanΔ=0.0067, CI95%=[-0.0017, 0.0149]) |
| k60_rho0.10 | 0.9488 | 0.9359 | 0.9889 | 0.9978 | 0.9355 | 57 (6.3%) | 43 (4.8%) | 800 | 0.0084 | 0.0000 | B_BETTER (meanΔ=0.0084, CI95%=[0.0001, 0.0169]) |
| k60_rho0.25 | 0.9442 | 0.9302 | 0.9878 | 0.9978 | 0.9296 | 63 (7.0%) | 66 (7.3%) | 771 | 0.0038 | 0.0000 | MIXED (meanΔ=0.0038, CI95%=[-0.0061, 0.0137]) |
| k60_rho0.50 | 0.9355 | 0.9182 | 0.9900 | 0.9978 | 0.9177 | 66 (7.3%) | 85 (9.4%) | 749 | -0.0048 | 0.0000 | MIXED (meanΔ=-0.0048, CI95%=[-0.0161, 0.0066]) |
| k60_rho0.75 | 0.9303 | 0.9121 | 0.9889 | 0.9978 | 0.9115 | 69 (7.7%) | 91 (10.1%) | 740 | -0.0101 | 0.0000 | MIXED (meanΔ=-0.0101, CI95%=[-0.0224, 0.0021]) |
| k60_rho1.00 | 0.9305 | 0.9202 | 0.9667 | 0.9967 | 0.9188 | 64 (7.1%) | 59 (6.6%) | 777 | -0.0098 | 0.0000 | MIXED (meanΔ=-0.0098, CI95%=[-0.0225, 0.0022]) |

### belebele_slk_Latn (Belebele slk_Latn)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9441 | 0.9324 | 0.9822 | 0.9956 | 0.9317 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.8803 | 0.8649 | 0.9322 | 0.9678 | 0.8635 | 52 (5.8%) | 134 (14.9%) | 714 | -0.0638 | 0.0000 | A_BETTER (meanΔ=-0.0638, CI95%=[-0.0826, -0.0447]) |
| k2_rho0.10 | 0.9454 | 0.9329 | 0.9856 | 0.9967 | 0.9323 | 8 (0.9%) | 1 (0.1%) | 891 | 0.0012 | 0.0000 | B_BETTER (meanΔ=0.0012, CI95%=[0.0002, 0.0026]) |
| k2_rho0.25 | 0.9483 | 0.9356 | 0.9878 | 0.9967 | 0.9352 | 26 (2.9%) | 3 (0.3%) | 871 | 0.0041 | 0.0000 | B_BETTER (meanΔ=0.0041, CI95%=[0.0021, 0.0064]) |
| k2_rho0.50 | 0.9518 | 0.9399 | 0.9889 | 0.9967 | 0.9396 | 42 (4.7%) | 21 (2.3%) | 837 | 0.0077 | 0.0000 | B_BETTER (meanΔ=0.0077, CI95%=[0.0028, 0.0123]) |
| k2_rho0.75 | 0.9528 | 0.9411 | 0.9889 | 0.9967 | 0.9408 | 47 (5.2%) | 40 (4.4%) | 813 | 0.0086 | 0.0000 | B_BETTER (meanΔ=0.0086, CI95%=[0.0008, 0.0162]) |
| k2_rho1.00 | 0.9498 | 0.9375 | 0.9878 | 0.9967 | 0.9372 | 50 (5.6%) | 54 (6.0%) | 796 | 0.0056 | 0.0000 | MIXED (meanΔ=0.0056, CI95%=[-0.0035, 0.0148]) |
| k60_rho0.10 | 0.9455 | 0.9324 | 0.9856 | 0.9956 | 0.9319 | 52 (5.8%) | 51 (5.7%) | 797 | 0.0013 | 0.0000 | MIXED (meanΔ=0.0013, CI95%=[-0.0074, 0.0097]) |
| k60_rho0.25 | 0.9417 | 0.9270 | 0.9867 | 0.9956 | 0.9265 | 55 (6.1%) | 74 (8.2%) | 771 | -0.0025 | 0.0000 | MIXED (meanΔ=-0.0025, CI95%=[-0.0131, 0.0084]) |
| k60_rho0.50 | 0.9306 | 0.9120 | 0.9878 | 0.9967 | 0.9117 | 56 (6.2%) | 97 (10.8%) | 747 | -0.0135 | 0.0000 | A_BETTER (meanΔ=-0.0135, CI95%=[-0.0264, -0.0018]) |
| k60_rho0.75 | 0.9213 | 0.9010 | 0.9856 | 0.9967 | 0.9004 | 55 (6.1%) | 108 (12.0%) | 737 | -0.0228 | 0.0000 | A_BETTER (meanΔ=-0.0228, CI95%=[-0.0369, -0.0095]) |
| k60_rho1.00 | 0.9258 | 0.9157 | 0.9611 | 0.9967 | 0.9141 | 54 (6.0%) | 68 (7.6%) | 778 | -0.0183 | 0.0000 | A_BETTER (meanΔ=-0.0183, CI95%=[-0.0326, -0.0051]) |

### belebele_eng_Latn (Belebele eng_Latn)

| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| dense | 0.9555 | 0.9448 | 0.9889 | 0.9978 | 0.9443 | 0 (0.0%) | 0 (0.0%) | 900 | 0.0000 | 0.0000 | INCONCLUSIVE (meanΔ=0.0000, CI95%=[0.0000, 0.0000]) |
| sparse | 0.9222 | 0.9099 | 0.9633 | 0.9811 | 0.9090 | 52 (5.8%) | 91 (10.1%) | 757 | -0.0332 | 0.0000 | A_BETTER (meanΔ=-0.0332, CI95%=[-0.0486, -0.0184]) |
| k2_rho0.10 | 0.9560 | 0.9451 | 0.9900 | 0.9978 | 0.9446 | 6 (0.7%) | 1 (0.1%) | 893 | 0.0005 | 0.0000 | B_BETTER (meanΔ=0.0005, CI95%=[0.0000, 0.0014]) |
| k2_rho0.25 | 0.9589 | 0.9472 | 0.9944 | 0.9978 | 0.9470 | 20 (2.2%) | 1 (0.1%) | 879 | 0.0035 | 0.0000 | B_BETTER (meanΔ=0.0035, CI95%=[0.0017, 0.0055]) |
| k2_rho0.50 | 0.9676 | 0.9596 | 0.9922 | 0.9978 | 0.9593 | 43 (4.8%) | 10 (1.1%) | 847 | 0.0122 | 0.0000 | B_BETTER (meanΔ=0.0122, CI95%=[0.0074, 0.0171]) |
| k2_rho0.75 | 0.9707 | 0.9638 | 0.9922 | 0.9978 | 0.9635 | 47 (5.2%) | 16 (1.8%) | 837 | 0.0153 | 0.0000 | B_BETTER (meanΔ=0.0153, CI95%=[0.0091, 0.0217]) |
| k2_rho1.00 | 0.9665 | 0.9582 | 0.9922 | 0.9967 | 0.9579 | 47 (5.2%) | 28 (3.1%) | 825 | 0.0110 | 0.0000 | B_BETTER (meanΔ=0.0110, CI95%=[0.0038, 0.0185]) |
| k60_rho0.10 | 0.9662 | 0.9585 | 0.9900 | 0.9978 | 0.9581 | 50 (5.6%) | 29 (3.2%) | 821 | 0.0107 | 0.0000 | B_BETTER (meanΔ=0.0107, CI95%=[0.0031, 0.0181]) |
| k60_rho0.25 | 0.9588 | 0.9473 | 0.9933 | 0.9978 | 0.9471 | 53 (5.9%) | 50 (5.6%) | 797 | 0.0033 | 0.0000 | MIXED (meanΔ=0.0033, CI95%=[-0.0060, 0.0125]) |
| k60_rho0.50 | 0.9532 | 0.9397 | 0.9944 | 0.9978 | 0.9396 | 54 (6.0%) | 64 (7.1%) | 782 | -0.0022 | 0.0000 | MIXED (meanΔ=-0.0022, CI95%=[-0.0122, 0.0082]) |
| k60_rho0.75 | 0.9497 | 0.9360 | 0.9922 | 0.9978 | 0.9358 | 54 (6.0%) | 66 (7.3%) | 780 | -0.0058 | 0.0000 | MIXED (meanΔ=-0.0058, CI95%=[-0.0172, 0.0057]) |
| k60_rho1.00 | 0.9527 | 0.9444 | 0.9800 | 0.9967 | 0.9437 | 50 (5.6%) | 39 (4.3%) | 811 | -0.0027 | 0.0000 | MIXED (meanΔ=-0.0027, CI95%=[-0.0132, 0.0070]) |

## Belebele macro summaries (descriptive only — never used to select weights)

DESCRIPTIVE ONLY — never used to select weights by script or language. See per-language results for the actual evidence.

| Group | Languages | nDCG@10 by config |
|---|---:|---|
| cyrillicMacroAverage | 3 | dense=0.9390, sparse=0.8753, k2_rho0.10=0.9400, k2_rho0.25=0.9422, k2_rho0.50=0.9498, k2_rho0.75=0.9506, k2_rho1.00=0.9472, k60_rho0.10=0.9439, k60_rho0.25=0.9359, k60_rho0.50=0.9270, k60_rho0.75=0.9217, k60_rho1.00=0.9318 |
| slavicLatinMacroAverage | 3 | dense=0.9415, sparse=0.8726, k2_rho0.10=0.9426, k2_rho0.25=0.9451, k2_rho0.50=0.9499, k2_rho0.75=0.9506, k2_rho1.00=0.9439, k60_rho0.10=0.9446, k60_rho0.25=0.9388, k60_rho0.50=0.9272, k60_rho0.75=0.9186, k60_rho1.00=0.9211 |
| englishControl | 1 | dense=0.9555, sparse=0.9222, k2_rho0.10=0.9560, k2_rho0.25=0.9589, k2_rho0.50=0.9676, k2_rho0.75=0.9707, k2_rho1.00=0.9665, k60_rho0.10=0.9662, k60_rho0.25=0.9588, k60_rho0.50=0.9532, k60_rho0.75=0.9497, k60_rho1.00=0.9527 |
| allSevenMacroAverage | 7 | dense=0.9425, sparse=0.8809, k2_rho0.10=0.9434, k2_rho0.25=0.9458, k2_rho0.50=0.9524, k2_rho0.75=0.9535, k2_rho1.00=0.9486, k60_rho0.10=0.9474, k60_rho0.25=0.9404, k60_rho0.50=0.9308, k60_rho0.75=0.9244, k60_rho1.00=0.9302 |

## Selected candidates for a future live Qdrant benchmark

Verdict: **CANDIDATES_SELECTED**

MIRACL has already been inspected during scope construction and is not a blind holdout — treated as diagnostic/validation evidence, not confirmatory evidence.

### Dense-heavy candidate: `k2_rho0.10`

```js
{
  "query": {
    "rrf": {
      "k": 2,
      "weights": [
        1,
        0.05263157894736842
      ]
    }
  }
}
```

The only config satisfying the balanced/quality rule was identical to the
dense-heavy candidate above, and no other distinct eligible config existed
— rather than print the same payload twice, no separate balanced/quality
candidate is reported.

### Equal RRF (control, not a recommendation)

`k2_rho1.00`:
```js
{
  "query": {
    "rrf": {
      "k": 2,
      "weights": [
        1,
        1
      ]
    }
  }
}
```
`k60_rho1.00`:
```js
{
  "query": {
    "rrf": {
      "k": 60,
      "weights": [
        1,
        1
      ]
    }
  }
}
```

## Limitations of offline reconstruction

- **Measured parity result: 0/10 available (scope, k) checks were
  sufficiently faithful.**
  In this run, 10/10 available parity checks failed
  the faithfulness threshold (14.8-30.3% of queries showed a
  different top-10 ranking than the real Qdrant run, even where aggregate
  nDCG@10 differed by only ~0.0011-0.0200) — see the parity
  table above for exact per-scope numbers. This means offline weighted-RRF
  metrics in this report should be read as DIRECTIONAL evidence for
  narrowing candidates, not as a precise prediction of what a live Qdrant
  weighted-RRF query will score.
- Saved dense/sparse TREC lanes are capped at top-100 per query; real
  Qdrant hybrid queries use prefetch limit 200 per lane — this is the most
  likely cause of any parity gap above (queries whose true top-100-under-
  prefetch-200 candidate set differs from the saved top-100-only lane).
- The same SciFact/MIRACL/Belebele scopes used to SELECT the candidate
  weights above are also used to EVALUATE them — there is no held-out
  validation split. A live Qdrant run on these same scopes will confirm
  whether the offline reconstruction matches real Qdrant behavior, but it
  will NOT confirm that the selected weights generalize beyond this exact
  eval set. Per Qdrant's own tuning guidance, weights should ideally be
  tuned on one part of an eval set and confirmed on a separate, untouched
  holdout before being treated as validated.
- MIRACL has already been inspected in prior tasks and is not a blind
  holdout for this analysis.
- Belebele qrels are MRC-derived (one relevant document per query), not
  pooled IR judgments — see `../slavic/README.md`.
- This offline analysis does not by itself justify a production RRF
  default change. It only narrows candidates for a future live benchmark.
