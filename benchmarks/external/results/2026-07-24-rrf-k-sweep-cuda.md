# Live Qdrant RRF-k sweep — SciFact and MIRACL Russian (CUDA)

Verdict: **RRF_SWEEP_HARNESS_ACCEPT**

Execution note: local scopes used BGE-M3 ONNX through strict CUDA
(`ONNX_CUDA_STRICT=1`), with no CPU fallback. Cloud scopes used Qdrant
Inference (multilingual E5 + BM25), so their ONNX EP is not applicable.
The prior CPU report remains in `2026-07-23-rrf-k-sweep.md`.

Real Qdrant hybrid queries only — every hybrid_k row below was produced
by a live query with prefetch=200/lane, varying only `query.rrf.k`. No
local RRF reconstruction from saved TREC files is used anywhere in this
report. SciFact and MIRACL scopes are kept strictly separate.

Sweep k values: 1, 2, 5, 10, 30, 60

## Retrieval quality

| Scope | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |
|---|---|---:|---:|---:|---:|---:|---:|
| scifact-local | dense | 0.6748 | 0.6285 | 0.8260 | 0.9600 | 0.0980 | 0.6324 |
| scifact-local | sparse | 0.6836 | 0.6478 | 0.7980 | 0.9480 | 0.0950 | 0.6573 |
| scifact-local | hybrid_k1 | 0.6991 | 0.6680 | 0.8005 | 0.9580 | 0.0950 | 0.6777 |
| scifact-local | hybrid_k2 | 0.6976 | 0.6662 | 0.8005 | 0.9580 | 0.0950 | 0.6747 |
| scifact-local | hybrid_k5 | 0.7041 | 0.6695 | 0.8155 | 0.9580 | 0.0970 | 0.6780 |
| scifact-local | hybrid_k10 | 0.7046 | 0.6704 | 0.8155 | 0.9580 | 0.0970 | 0.6784 |
| scifact-local | hybrid_k30 | 0.6991 | 0.6632 | 0.8155 | 0.9580 | 0.0970 | 0.6713 |
| scifact-local | hybrid_k60 | 0.6966 | 0.6600 | 0.8155 | 0.9580 | 0.0970 | 0.6685 |
| scifact-cloud | dense | 0.7325 | 0.6939 | 0.8550 | 0.9700 | 0.1030 | 0.7048 |
| scifact-cloud | sparse | 0.6610 | 0.6210 | 0.7870 | 0.9000 | 0.0910 | 0.6255 |
| scifact-cloud | hybrid_k1 | 0.7164 | 0.6778 | 0.8430 | 0.9600 | 0.1010 | 0.6794 |
| scifact-cloud | hybrid_k2 | 0.7200 | 0.6828 | 0.8430 | 0.9600 | 0.1010 | 0.6852 |
| scifact-cloud | hybrid_k5 | 0.7271 | 0.6894 | 0.8530 | 0.9600 | 0.1020 | 0.6896 |
| scifact-cloud | hybrid_k10 | 0.7294 | 0.6889 | 0.8630 | 0.9600 | 0.1030 | 0.6906 |
| scifact-cloud | hybrid_k30 | 0.7236 | 0.6771 | 0.8730 | 0.9600 | 0.1040 | 0.6800 |
| scifact-cloud | hybrid_k60 | 0.7126 | 0.6706 | 0.8505 | 0.9600 | 0.1010 | 0.6729 |
| miracl-local | dense | 0.8995 | 0.8385 | 0.9851 | 1.0000 | 0.2830 | 0.9163 |
| miracl-local | sparse | 0.7525 | 0.6792 | 0.8898 | 0.9817 | 0.2590 | 0.7466 |
| miracl-local | hybrid_k1 | 0.8522 | 0.7808 | 0.9756 | 1.0000 | 0.2790 | 0.8417 |
| miracl-local | hybrid_k2 | 0.8530 | 0.7820 | 0.9756 | 1.0000 | 0.2790 | 0.8433 |
| miracl-local | hybrid_k5 | 0.8485 | 0.7725 | 0.9802 | 1.0000 | 0.2810 | 0.8362 |
| miracl-local | hybrid_k10 | 0.8392 | 0.7629 | 0.9769 | 1.0000 | 0.2800 | 0.8242 |
| miracl-local | hybrid_k30 | 0.8301 | 0.7547 | 0.9652 | 1.0000 | 0.2770 | 0.8211 |
| miracl-local | hybrid_k60 | 0.8369 | 0.7630 | 0.9652 | 1.0000 | 0.2770 | 0.8311 |
| miracl-cloud | dense | 0.8420 | 0.7630 | 0.9802 | 1.0000 | 0.2810 | 0.8323 |
| miracl-cloud | sparse | 0.5696 | 0.4779 | 0.7373 | 0.8554 | 0.2150 | 0.5766 |
| miracl-cloud | hybrid_k1 | 0.7583 | 0.6662 | 0.9522 | 1.0000 | 0.2690 | 0.7168 |
| miracl-cloud | hybrid_k2 | 0.7621 | 0.6715 | 0.9522 | 1.0000 | 0.2690 | 0.7217 |
| miracl-cloud | hybrid_k5 | 0.7635 | 0.6671 | 0.9571 | 1.0000 | 0.2700 | 0.7380 |
| miracl-cloud | hybrid_k10 | 0.7548 | 0.6543 | 0.9571 | 1.0000 | 0.2700 | 0.7303 |
| miracl-cloud | hybrid_k30 | 0.7261 | 0.6432 | 0.8879 | 1.0000 | 0.2550 | 0.7300 |
| miracl-cloud | hybrid_k60 | 0.7113 | 0.6313 | 0.8604 | 1.0000 | 0.2470 | 0.7226 |

## Per-k comparisons (deterministic paired bootstrap, vs dense; sign = comparison − baseline)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000.

### scifact-local

- **hybrid_k1_vs_dense**: MIXED (meanΔ=0.0244, CI95%=[-0.0142, 0.0620], W/L/T=19/15/66, n=100)
- **hybrid_k2_vs_dense**: MIXED (meanΔ=0.0228, CI95%=[-0.0160, 0.0627], W/L/T=21/16/63, n=100)
- **hybrid_k5_vs_dense**: MIXED (meanΔ=0.0293, CI95%=[-0.0113, 0.0682], W/L/T=22/13/65, n=100)
- **hybrid_k10_vs_dense**: MIXED (meanΔ=0.0298, CI95%=[-0.0124, 0.0699], W/L/T=22/11/67, n=100)
- **hybrid_k30_vs_dense**: MIXED (meanΔ=0.0243, CI95%=[-0.0178, 0.0621], W/L/T=24/12/64, n=100)
- **hybrid_k60_vs_dense**: MIXED (meanΔ=0.0219, CI95%=[-0.0176, 0.0572], W/L/T=23/11/66, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=0.0015, CI95%=[-0.0046, 0.0106], W/L/T=1/6/93, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=0.0065, CI95%=[-0.0048, 0.0196], W/L/T=8/6/86, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=0.0070, CI95%=[-0.0106, 0.0259], W/L/T=10/7/83, n=100)
- **hybrid_k30_vs_k2**: MIXED (meanΔ=0.0015, CI95%=[-0.0186, 0.0211], W/L/T=10/9/81, n=100)
- **hybrid_k60_vs_k2**: MIXED (meanΔ=-0.0010, CI95%=[-0.0253, 0.0215], W/L/T=10/9/81, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=0.0025, CI95%=[-0.0203, 0.0253], W/L/T=9/10/81, n=100)
- **hybrid_k2_vs_k60**: MIXED (meanΔ=0.0010, CI95%=[-0.0215, 0.0253], W/L/T=9/10/81, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0075, CI95%=[-0.0080, 0.0259], W/L/T=6/6/88, n=100)
- **hybrid_k10_vs_k60**: MIXED (meanΔ=0.0080, CI95%=[-0.0002, 0.0218], W/L/T=6/3/91, n=100)
- **hybrid_k30_vs_k60**: MIXED (meanΔ=0.0025, CI95%=[-0.0081, 0.0148], W/L/T=4/2/94, n=100)

### scifact-cloud

- **hybrid_k1_vs_dense**: MIXED (meanΔ=-0.0161, CI95%=[-0.0504, 0.0200], W/L/T=14/24/62, n=100)
- **hybrid_k2_vs_dense**: MIXED (meanΔ=-0.0124, CI95%=[-0.0473, 0.0228], W/L/T=14/22/64, n=100)
- **hybrid_k5_vs_dense**: MIXED (meanΔ=-0.0054, CI95%=[-0.0408, 0.0289], W/L/T=15/21/64, n=100)
- **hybrid_k10_vs_dense**: MIXED (meanΔ=-0.0030, CI95%=[-0.0414, 0.0339], W/L/T=15/22/63, n=100)
- **hybrid_k30_vs_dense**: MIXED (meanΔ=-0.0089, CI95%=[-0.0514, 0.0320], W/L/T=16/23/61, n=100)
- **hybrid_k60_vs_dense**: MIXED (meanΔ=-0.0199, CI95%=[-0.0628, 0.0189], W/L/T=15/23/62, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0036, CI95%=[-0.0154, 0.0059], W/L/T=4/2/94, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=0.0070, CI95%=[-0.0047, 0.0211], W/L/T=6/6/88, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=0.0094, CI95%=[-0.0081, 0.0275], W/L/T=12/9/79, n=100)
- **hybrid_k30_vs_k2**: MIXED (meanΔ=0.0035, CI95%=[-0.0185, 0.0260], W/L/T=14/11/75, n=100)
- **hybrid_k60_vs_k2**: MIXED (meanΔ=-0.0075, CI95%=[-0.0314, 0.0166], W/L/T=13/11/76, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=0.0038, CI95%=[-0.0231, 0.0294], W/L/T=10/14/76, n=100)
- **hybrid_k2_vs_k60**: MIXED (meanΔ=0.0075, CI95%=[-0.0166, 0.0314], W/L/T=11/13/76, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0145, CI95%=[-0.0062, 0.0362], W/L/T=11/10/79, n=100)
- **hybrid_k10_vs_k60**: MIXED (meanΔ=0.0169, CI95%=[-0.0003, 0.0359], W/L/T=12/8/80, n=100)
- **hybrid_k30_vs_k60**: B_BETTER (meanΔ=0.0110, CI95%=[0.0021, 0.0234], W/L/T=7/1/92, n=100)

### miracl-local

- **hybrid_k1_vs_dense**: A_BETTER (meanΔ=-0.0473, CI95%=[-0.0705, -0.0239], W/L/T=15/40/45, n=100)
- **hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0465, CI95%=[-0.0708, -0.0234], W/L/T=16/40/44, n=100)
- **hybrid_k5_vs_dense**: A_BETTER (meanΔ=-0.0510, CI95%=[-0.0762, -0.0253], W/L/T=17/42/41, n=100)
- **hybrid_k10_vs_dense**: A_BETTER (meanΔ=-0.0603, CI95%=[-0.0889, -0.0327], W/L/T=17/43/40, n=100)
- **hybrid_k30_vs_dense**: A_BETTER (meanΔ=-0.0694, CI95%=[-0.1019, -0.0382], W/L/T=15/44/41, n=100)
- **hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.0626, CI95%=[-0.0953, -0.0324], W/L/T=17/41/42, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0008, CI95%=[-0.0059, 0.0039], W/L/T=5/5/90, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=-0.0045, CI95%=[-0.0160, 0.0059], W/L/T=9/12/79, n=100)
- **hybrid_k10_vs_k2**: A_BETTER (meanΔ=-0.0138, CI95%=[-0.0271, -0.0009], W/L/T=6/17/77, n=100)
- **hybrid_k30_vs_k2**: A_BETTER (meanΔ=-0.0229, CI95%=[-0.0417, -0.0065], W/L/T=8/20/72, n=100)
- **hybrid_k60_vs_k2**: A_BETTER (meanΔ=-0.0161, CI95%=[-0.0338, -0.0012], W/L/T=7/17/76, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=0.0153, CI95%=[-0.0010, 0.0336], W/L/T=20/8/72, n=100)
- **hybrid_k2_vs_k60**: B_BETTER (meanΔ=0.0161, CI95%=[0.0012, 0.0338], W/L/T=17/7/76, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0116, CI95%=[-0.0023, 0.0267], W/L/T=14/4/82, n=100)
- **hybrid_k10_vs_k60**: MIXED (meanΔ=0.0023, CI95%=[-0.0092, 0.0149], W/L/T=12/5/83, n=100)
- **hybrid_k30_vs_k60**: A_BETTER (meanΔ=-0.0068, CI95%=[-0.0164, -0.0001], W/L/T=1/4/95, n=100)

### miracl-cloud

- **hybrid_k1_vs_dense**: A_BETTER (meanΔ=-0.0837, CI95%=[-0.1147, -0.0515], W/L/T=17/63/20, n=100)
- **hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0799, CI95%=[-0.1129, -0.0465], W/L/T=18/60/22, n=100)
- **hybrid_k5_vs_dense**: A_BETTER (meanΔ=-0.0785, CI95%=[-0.1152, -0.0405], W/L/T=19/57/24, n=100)
- **hybrid_k10_vs_dense**: A_BETTER (meanΔ=-0.0872, CI95%=[-0.1254, -0.0482], W/L/T=17/59/24, n=100)
- **hybrid_k30_vs_dense**: A_BETTER (meanΔ=-0.1159, CI95%=[-0.1644, -0.0677], W/L/T=16/59/25, n=100)
- **hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.1307, CI95%=[-0.1817, -0.0791], W/L/T=16/59/25, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0038, CI95%=[-0.0142, 0.0037], W/L/T=10/12/78, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=0.0014, CI95%=[-0.0132, 0.0164], W/L/T=17/26/57, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=-0.0073, CI95%=[-0.0238, 0.0099], W/L/T=20/34/46, n=100)
- **hybrid_k30_vs_k2**: A_BETTER (meanΔ=-0.0360, CI95%=[-0.0622, -0.0108], W/L/T=25/36/39, n=100)
- **hybrid_k60_vs_k2**: A_BETTER (meanΔ=-0.0508, CI95%=[-0.0817, -0.0219], W/L/T=24/39/37, n=100)
- **hybrid_k1_vs_k60**: B_BETTER (meanΔ=0.0470, CI95%=[0.0155, 0.0797], W/L/T=37/26/37, n=100)
- **hybrid_k2_vs_k60**: B_BETTER (meanΔ=0.0508, CI95%=[0.0219, 0.0817], W/L/T=39/24/37, n=100)
- **hybrid_k5_vs_k60**: B_BETTER (meanΔ=0.0522, CI95%=[0.0271, 0.0785], W/L/T=40/14/46, n=100)
- **hybrid_k10_vs_k60**: B_BETTER (meanΔ=0.0435, CI95%=[0.0223, 0.0666], W/L/T=35/9/56, n=100)
- **hybrid_k30_vs_k60**: B_BETTER (meanΔ=0.0148, CI95%=[0.0047, 0.0271], W/L/T=15/3/82, n=100)

## Comparison against previously committed k=2/k=60 reports

Only compared against a prior report on the same corpus/query set with
a compatible provider configuration. Deltas between incompatible runs
are not "drift" and are never reported as numbers. Where a real
comparison is made: local drift should be investigated. Cloud drift may
reflect hosted-model/service changes on Qdrant's side — reported as a
fact, not silently treated as equivalent to the prior run.

| Scope | Mode | Prior nDCG@10 | New nDCG@10 | Delta | Comparable |
|---|---|---:|---:|---:|---|
| scifact-local | hybrid_k2 | 0.6976 | 0.6976 | 0.0000 | yes |
| scifact-local | hybrid_k60 | 0.6931 | 0.6966 | 0.0036 | yes |
| scifact-cloud | hybrid_k2 | n/a | n/a | n/a | no — No compatible prior report exists: the local-only RRF mini benchmark never ran the cloud profile, and the full 300-query/5183-doc SciFact report uses a different-sized corpus than this sweep's 100-query/1000-doc mini subset. |
| scifact-cloud | hybrid_k60 | n/a | n/a | n/a | no — No compatible prior report exists: the local-only RRF mini benchmark never ran the cloud profile, and the full 300-query/5183-doc SciFact report uses a different-sized corpus than this sweep's 100-query/1000-doc mini subset. |
| miracl-local | hybrid_k2 | n/a | n/a | n/a | no — Execution provider differs: prior MIRACL local used dml, current sweep used cuda. |
| miracl-local | hybrid_k60 | n/a | n/a | n/a | no — Execution provider differs: prior MIRACL local used dml, current sweep used cuda. |
| miracl-cloud | hybrid_k2 | 0.7613 | 0.7621 | 0.0008 | yes |
| miracl-cloud | hybrid_k60 | 0.7130 | 0.7113 | -0.0017 | yes |

## Answers

### 1. Observed RRF curve per scope

- **scifact-local**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.6991, k2=0.6976, k5=0.7041, k10=0.7046, k30=0.6991, k60=0.6966. best: k10 (0.7046), worst: k60 (0.6966).
- **scifact-cloud**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.7164, k2=0.7200, k5=0.7271, k10=0.7294, k30=0.7236, k60=0.7126. best: k10 (0.7294), worst: k60 (0.7126).
- **miracl-local**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.8522, k2=0.8530, k5=0.8485, k10=0.8392, k30=0.8301, k60=0.8369. best: k2 (0.8530), worst: k30 (0.8301).
- **miracl-cloud**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.7583, k2=0.7621, k5=0.7635, k10=0.7548, k30=0.7261, k60=0.7113. best: k5 (0.7635), worst: k60 (0.7113).

### 2. Does any k make hybrid match or beat dense on MIRACL?

- **miracl-local**: FACT — hybrid is bootstrap-significantly WORSE than dense at: k1, k2, k5, k10, k30, k60.
- **miracl-cloud**: FACT — hybrid is bootstrap-significantly WORSE than dense at: k1, k2, k5, k10, k30, k60.

### 3. Is one k stable across all four scopes, or dataset/provider-dependent?

- FACT — no single k is a best (or tied-best) point on every scope; the best-k sets differ by scope.
  - scifact-local: best k = k10
  - scifact-cloud: best k = k10
  - miracl-local: best k = k2
  - miracl-cloud: best k = k5
- HYPOTHESIS — even where one k happens to be best (or tied-best) in this run, that does not establish it as the correct default: a bootstrap-insignificant best point (small margin, wide CI) is not real evidence of superiority over neighboring k values. See the per-scope bootstrap comparisons above before treating "best observed" as "best".

### 4. How do rescue/harm counts change as k increases?

- **scifact-local**: FACT — k1: 19R/15H/66T, k2: 21R/16H/63T, k5: 22R/13H/65T, k10: 22R/11H/67T, k30: 24R/12H/64T, k60: 23R/11H/66T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **scifact-cloud**: FACT — k1: 14R/24H/62T, k2: 14R/22H/64T, k5: 15R/21H/64T, k10: 15R/22H/63T, k30: 16R/23H/61T, k60: 15R/23H/62T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **miracl-local**: FACT — k1: 15R/40H/45T, k2: 16R/40H/44T, k5: 17R/42H/41T, k10: 17R/43H/40T, k30: 15R/44H/41T, k60: 17R/41H/42T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **miracl-cloud**: FACT — k1: 17R/63H/20T, k2: 18R/60H/22T, k5: 19R/57H/24T, k10: 17R/59H/24T, k30: 16R/59H/25T, k60: 16R/59H/25T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).

### 5. Is k=2 or k=60 consistently preferable?

- **scifact-local**: FACT — no significant difference — real per-query wins on both sides, net effect not significant (MIXED) (meanΔ=k2−k60=0.0010, W/L/T=9/10/81).
- **scifact-cloud**: FACT — no significant difference — real per-query wins on both sides, net effect not significant (MIXED) (meanΔ=k2−k60=0.0075, W/L/T=11/13/76).
- **miracl-local**: FACT — k2 is bootstrap-significantly better than k60 (meanΔ=k2−k60=0.0161, W/L/T=17/7/76).
- **miracl-cloud**: FACT — k2 is bootstrap-significantly better than k60 (meanΔ=k2−k60=0.0508, W/L/T=39/24/37).
- INFERENCE — a per-scope winner between k=2 and k=60 is not the same claim as "one of these two constants is consistently preferable across scopes"; see whether the per-scope labels above agree before drawing that conclusion.

### 6. What evidence is still required before changing production RRF_K?

- HYPOTHESIS — this exploratory sweep alone is not sufficient: it covers
  4 scopes at fixed 100-query/1000-document subsets, not the full corpora
  or Semidex's actual production document mix (chunked Markdown/code,
  not SciFact abstracts or MIRACL passages).
- Before changing the production `RRF_K` default, additional evidence
  would need to include: (a) confirmation the observed best-k pattern
  replicates on a held-out query sample, not just this run's 100 queries;
  (b) a full, non-mini SciFact and non-mini MIRACL run at the same k
  values, to rule out subset-selection artifacts; (c) evaluation on
  Semidex's own indexed content (chunked technical documents), since
  neither SciFact nor MIRACL is representative of that domain; (d) repeat
  runs to establish whether cloud-side hosted-model variance (see the
  prior-comparison section above) changes the outcome run to run.
- This report does not recommend changing the production RRF_K default,
  and does not recommend disabling sparse retrieval globally.

## Operations

| Scope | Indexed | Index wall ms | Query errors | Retries | Cleanup | Scope peak RSS |
|---|---:|---:|---:|---:|---|---:|
| scifact-local | 1000 | 65293 | 0 | 0 | deleted | 1174618112 |
| scifact-cloud | 1000 | 53799 | 0 | 0 | deleted | 1155026944 |
| miracl-local | 1000 | 42972 | 0 | 0 | deleted | 1205882880 |
| miracl-cloud | 1000 | 44528 | 0 | 0 | deleted | 1212928000 |

Peak process RSS (whole run): 1213829120 bytes

## Per-scope provenance

| Scope | Commit | SDK | ONNX EP | Dense model | Sparse model | Corpus/queries | Manifest seed |
|---|---|---|---|---|---|---|---|
| scifact-local | d7cf6ac3203e | 1.18.0 | cuda | aapot/bge-m3-onnx | bge-m3-onnx-lexical | 1000/100 | semidex-beir-scifact-rrf-mini-v1 |
| scifact-cloud | d7cf6ac3203e | 1.18.0 | n/a | intfloat/multilingual-e5-small | qdrant/bm25 | 1000/100 | semidex-beir-scifact-rrf-mini-v1 |
| miracl-local | d7cf6ac3203e | 1.18.0 | cuda | aapot/bge-m3-onnx | bge-m3-onnx-lexical | 1000/100 | semidex-miracl-ru-pooled-subset-v1 |
| miracl-cloud | d7cf6ac3203e | 1.18.0 | n/a | intfloat/multilingual-e5-small | qdrant/bm25 | 1000/100 | semidex-miracl-ru-pooled-subset-v1 |

## Interpretation limits

- FACT: every hybrid_k row was produced by a real Qdrant hybrid query,
  prefetch=200/lane, final limit 100 — never a local RRF reconstruction.
- FACT: SciFact and MIRACL qrels/metrics are never merged.
- FACT: SciFact scope here is the LOCAL MINI pooled subset (100q/1000d),
  not the full 300-query SciFact test split.
- This exploratory sweep does not by itself justify changing the
  production RRF_K default, and does not justify disabling sparse globally.
- No single k should be called a universal winner merely because it has
  the largest aggregate average on one or two scopes.
