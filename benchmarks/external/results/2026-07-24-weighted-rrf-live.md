# Live Qdrant weighted-RRF validation — SciFact and MIRACL Russian

Harness verdict: **WEIGHTED_RRF_LIVE_HARNESS_ACCEPT**
Candidate verdict: **WEIGHTED_RRF_MIXED**

This offline analysis narrows candidates only. Final acceptance requires
real Qdrant 1.17+ weighted-RRF queries using `query.rrf.weights` — which is
exactly what this report is. Every hybrid row below was produced by a live
`query: { rrf: { k, weights: [dense, sparse] } }` request with
prefetch=200/lane, never `prefetch.weight`, never a local RRF
reconstruction. SciFact and MIRACL scopes are kept strictly separate.

MIRACL has already influenced the offline candidate selection this run
validates — this is validation/diagnostic evidence, not a blind
confirmatory holdout, and the primary candidate is never called globally
optimal on the strength of this report alone.

Fusion modes: dense, sparse, equal_k2, equal_k60, k2_rho0.10, k2_rho0.25

## Candidate verdict reasons

- scifact-local vs scifact-cloud: primary candidate's direction vs dense diverges between local (meanΔ=-0.0038) and cloud (meanΔ=0.0026).

## Retrieval quality

| Scope | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 |
|---|---|---:|---:|---:|---:|---:|
| scifact-local | dense | 0.6748 | 0.6285 | 0.8260 | 0.9600 | 0.6324 |
| scifact-local | sparse | 0.6836 | 0.6478 | 0.7980 | 0.9480 | 0.6573 |
| scifact-local | equal_k2 | 0.6994 | 0.6663 | 0.8055 | 0.9580 | 0.6747 |
| scifact-local | equal_k60 | 0.6931 | 0.6552 | 0.8155 | 0.9580 | 0.6635 |
| scifact-local | k2_rho0.10 | 0.6709 | 0.6300 | 0.8110 | 0.9600 | 0.6324 |
| scifact-local | k2_rho0.25 | 0.6788 | 0.6354 | 0.8230 | 0.9600 | 0.6382 |
| scifact-cloud | dense | 0.7325 | 0.6939 | 0.8550 | 0.9700 | 0.7048 |
| scifact-cloud | sparse | 0.6610 | 0.6210 | 0.7870 | 0.9000 | 0.6255 |
| scifact-cloud | equal_k2 | 0.7242 | 0.6887 | 0.8430 | 0.9600 | 0.6902 |
| scifact-cloud | equal_k60 | 0.7200 | 0.6806 | 0.8505 | 0.9600 | 0.6829 |
| scifact-cloud | k2_rho0.10 | 0.7351 | 0.6948 | 0.8600 | 0.9700 | 0.7059 |
| scifact-cloud | k2_rho0.25 | 0.7328 | 0.6957 | 0.8500 | 0.9600 | 0.7052 |
| miracl-local | dense | 0.8995 | 0.8385 | 0.9851 | 1.0000 | 0.9163 |
| miracl-local | sparse | 0.7525 | 0.6792 | 0.8898 | 0.9817 | 0.7466 |
| miracl-local | equal_k2 | 0.8478 | 0.7747 | 0.9769 | 1.0000 | 0.8333 |
| miracl-local | equal_k60 | 0.8356 | 0.7606 | 0.9652 | 1.0000 | 0.8311 |
| miracl-local | k2_rho0.10 | 0.8994 | 0.8381 | 0.9851 | 1.0000 | 0.9167 |
| miracl-local | k2_rho0.25 | 0.8935 | 0.8347 | 0.9740 | 1.0000 | 0.9170 |
| miracl-cloud | dense | 0.8420 | 0.7630 | 0.9802 | 1.0000 | 0.8323 |
| miracl-cloud | sparse | 0.5696 | 0.4779 | 0.7373 | 0.8554 | 0.5766 |
| miracl-cloud | equal_k2 | 0.7582 | 0.6660 | 0.9522 | 1.0000 | 0.7167 |
| miracl-cloud | equal_k60 | 0.7067 | 0.6246 | 0.8604 | 1.0000 | 0.7176 |
| miracl-cloud | k2_rho0.10 | 0.8410 | 0.7637 | 0.9777 | 1.0000 | 0.8322 |
| miracl-cloud | k2_rho0.25 | 0.8396 | 0.7642 | 0.9754 | 1.0000 | 0.8325 |

## Paired bootstrap comparisons (sign = comparison − baseline)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000.

### scifact-local

- **sparse_vs_dense**: MIXED (meanΔ=0.0088, CI95%=[-0.0491, 0.0629], W/L/T=22/20/58, n=100)
- **equal_k2_vs_dense**: MIXED (meanΔ=0.0246, CI95%=[-0.0152, 0.0633], W/L/T=21/16/63, n=100)
- **equal_k60_vs_dense**: MIXED (meanΔ=0.0183, CI95%=[-0.0222, 0.0545], W/L/T=23/12/65, n=100)
- **k2_rho0.10_vs_dense**: MIXED (meanΔ=-0.0038, CI95%=[-0.0113, 0.0013], W/L/T=3/4/93, n=100)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=-0.0284, CI95%=[-0.0677, 0.0115], W/L/T=15/21/64, n=100)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=-0.0221, CI95%=[-0.0592, 0.0183], W/L/T=11/23/66, n=100)
- **k2_rho0.25_vs_dense**: MIXED (meanΔ=0.0040, CI95%=[-0.0095, 0.0177], W/L/T=9/4/87, n=100)

### scifact-cloud

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0714, CI95%=[-0.1291, -0.0143], W/L/T=14/33/53, n=100)
- **equal_k2_vs_dense**: MIXED (meanΔ=-0.0083, CI95%=[-0.0456, 0.0292], W/L/T=14/22/64, n=100)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0125, CI95%=[-0.0560, 0.0282], W/L/T=15/22/63, n=100)
- **k2_rho0.10_vs_dense**: MIXED (meanΔ=0.0026, CI95%=[-0.0002, 0.0070], W/L/T=3/1/96, n=100)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=0.0109, CI95%=[-0.0256, 0.0470], W/L/T=22/14/64, n=100)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=0.0152, CI95%=[-0.0260, 0.0595], W/L/T=22/15/63, n=100)
- **k2_rho0.25_vs_dense**: MIXED (meanΔ=0.0003, CI95%=[-0.0085, 0.0085], W/L/T=6/7/87, n=100)

### miracl-local

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.1470, CI95%=[-0.1979, -0.0972], W/L/T=13/59/28, n=100)
- **equal_k2_vs_dense**: A_BETTER (meanΔ=-0.0516, CI95%=[-0.0760, -0.0267], W/L/T=16/42/42, n=100)
- **equal_k60_vs_dense**: A_BETTER (meanΔ=-0.0639, CI95%=[-0.0962, -0.0343], W/L/T=16/42/42, n=100)
- **k2_rho0.10_vs_dense**: MIXED (meanΔ=-0.0000, CI95%=[-0.0010, 0.0011], W/L/T=1/3/96, n=100)
- **k2_rho0.10_vs_equal_k2**: B_BETTER (meanΔ=0.0516, CI95%=[0.0271, 0.0761], W/L/T=42/16/42, n=100)
- **k2_rho0.10_vs_equal_k60**: B_BETTER (meanΔ=0.0639, CI95%=[0.0345, 0.0960], W/L/T=42/16/42, n=100)
- **k2_rho0.25_vs_dense**: A_BETTER (meanΔ=-0.0060, CI95%=[-0.0117, -0.0006], W/L/T=6/16/78, n=100)

### miracl-cloud

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.2723, CI95%=[-0.3339, -0.2109], W/L/T=15/73/12, n=100)
- **equal_k2_vs_dense**: A_BETTER (meanΔ=-0.0837, CI95%=[-0.1174, -0.0499], W/L/T=18/61/21, n=100)
- **equal_k60_vs_dense**: A_BETTER (meanΔ=-0.1353, CI95%=[-0.1851, -0.0840], W/L/T=16/60/24, n=100)
- **k2_rho0.10_vs_dense**: MIXED (meanΔ=-0.0010, CI95%=[-0.0037, 0.0009], W/L/T=8/9/83, n=100)
- **k2_rho0.10_vs_equal_k2**: B_BETTER (meanΔ=0.0828, CI95%=[0.0491, 0.1160], W/L/T=60/19/21, n=100)
- **k2_rho0.10_vs_equal_k60**: B_BETTER (meanΔ=0.1343, CI95%=[0.0826, 0.1846], W/L/T=59/18/23, n=100)
- **k2_rho0.25_vs_dense**: MIXED (meanΔ=-0.0024, CI95%=[-0.0089, 0.0042], W/L/T=15/21/64, n=100)

## MIRACL regression reduction (primary candidate vs the BETTER equal-RRF control)

The candidate must materially improve on whichever equal-RRF control
regressed LESS — beating only the worse control is not sufficient.

| Scope | Primary meanΔ | Equal k=2 meanΔ | Equal k=60 meanΔ | Reduction vs better control | Materially reduced |
|---|---:|---:|---:|---:|---|
| miracl-local | -0.0000 | -0.0516 | -0.0639 | 0.0516 | yes |
| miracl-cloud | -0.0010 | -0.0837 | -0.1353 | 0.0828 | yes |

## CUDA provenance (local scopes)

| Scope | Requested | Effective | Strict configured | Fell back to CPU | Verified |
|---|---|---|---|---|---|
| scifact-local | cuda | cuda | true | false | yes |
| scifact-cloud | n/a (cloud) | n/a | n/a | n/a | n/a |
| miracl-local | cuda | cuda | true | false | yes |
| miracl-cloud | n/a (cloud) | n/a | n/a | n/a | n/a |

## Operations

| Scope | Indexed | Index wall ms | Query errors | Retries | Cleanup | Scope peak RSS |
|---|---:|---:|---:|---:|---|---:|
| scifact-local | 1000 | 60870 | 0 | 0 | deleted | 1245794304 |
| scifact-cloud | 1000 | 53767 | 0 | 0 | deleted | 1144008704 |
| miracl-local | 1000 | 40212 | 0 | 0 | deleted | 1205583872 |
| miracl-cloud | 1000 | 45132 | 0 | 0 | deleted | 1216765952 |

Peak process RSS (whole run): 1282732032 bytes

## Interpretation limits

- FACT: every hybrid row was produced by a real Qdrant `query.rrf.weights`
  request, prefetch=200/lane, final limit 100 — never a local RRF
  reconstruction, never `prefetch.weight`.
- FACT: SciFact and MIRACL qrels/metrics are never merged.
- FACT: k2_rho0.25 is diagnostic only — never promoted to primary merely
  because it wins one scope in this report.
- FACT: MIRACL already influenced the offline candidate selection this
  run validates — an ACCEPT verdict here is validation/diagnostic evidence,
  not a blind confirmatory holdout, and does not by itself justify calling
  the candidate globally optimal or changing a production default.
- This report does not implement or recommend adaptive/language-specific
  fusion.
