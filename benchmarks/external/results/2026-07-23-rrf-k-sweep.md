# Live Qdrant RRF-k sweep — SciFact and MIRACL Russian

Verdict: **RRF_SWEEP_HARNESS_ACCEPT**

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
| scifact-local | hybrid_k1 | 0.6917 | 0.6580 | 0.8005 | 0.9580 | 0.0950 | 0.6677 |
| scifact-local | hybrid_k2 | 0.6920 | 0.6563 | 0.8055 | 0.9580 | 0.0960 | 0.6647 |
| scifact-local | hybrid_k5 | 0.7003 | 0.6644 | 0.8155 | 0.9580 | 0.0970 | 0.6730 |
| scifact-local | hybrid_k10 | 0.7084 | 0.6756 | 0.8155 | 0.9580 | 0.0970 | 0.6834 |
| scifact-local | hybrid_k30 | 0.6917 | 0.6532 | 0.8155 | 0.9580 | 0.0970 | 0.6613 |
| scifact-local | hybrid_k60 | 0.6966 | 0.6600 | 0.8155 | 0.9580 | 0.0970 | 0.6685 |
| scifact-cloud | dense | 0.7325 | 0.6939 | 0.8550 | 0.9700 | 0.1030 | 0.7048 |
| scifact-cloud | sparse | 0.6610 | 0.6210 | 0.7870 | 0.9000 | 0.0910 | 0.6255 |
| scifact-cloud | hybrid_k1 | 0.7275 | 0.6928 | 0.8430 | 0.9600 | 0.1010 | 0.6944 |
| scifact-cloud | hybrid_k2 | 0.7274 | 0.6929 | 0.8430 | 0.9600 | 0.1010 | 0.6952 |
| scifact-cloud | hybrid_k5 | 0.7234 | 0.6844 | 0.8530 | 0.9600 | 0.1020 | 0.6846 |
| scifact-cloud | hybrid_k10 | 0.7147 | 0.6689 | 0.8630 | 0.9600 | 0.1030 | 0.6706 |
| scifact-cloud | hybrid_k30 | 0.7199 | 0.6721 | 0.8730 | 0.9600 | 0.1040 | 0.6750 |
| scifact-cloud | hybrid_k60 | 0.7163 | 0.6756 | 0.8505 | 0.9600 | 0.1010 | 0.6779 |
| miracl-local | dense | 0.8995 | 0.8385 | 0.9851 | 1.0000 | 0.2830 | 0.9163 |
| miracl-local | sparse | 0.7526 | 0.6794 | 0.8898 | 0.9817 | 0.2590 | 0.7466 |
| miracl-local | hybrid_k1 | 0.8442 | 0.7695 | 0.9756 | 1.0000 | 0.2790 | 0.8333 |
| miracl-local | hybrid_k2 | 0.8471 | 0.7735 | 0.9769 | 1.0000 | 0.2800 | 0.8317 |
| miracl-local | hybrid_k5 | 0.8447 | 0.7692 | 0.9769 | 1.0000 | 0.2800 | 0.8312 |
| miracl-local | hybrid_k10 | 0.8409 | 0.7640 | 0.9769 | 1.0000 | 0.2800 | 0.8308 |
| miracl-local | hybrid_k30 | 0.8327 | 0.7587 | 0.9652 | 1.0000 | 0.2770 | 0.8228 |
| miracl-local | hybrid_k60 | 0.8350 | 0.7600 | 0.9652 | 1.0000 | 0.2770 | 0.8294 |
| miracl-cloud | dense | 0.8420 | 0.7630 | 0.9802 | 1.0000 | 0.2810 | 0.8323 |
| miracl-cloud | sparse | 0.5696 | 0.4779 | 0.7373 | 0.8554 | 0.2150 | 0.5766 |
| miracl-cloud | hybrid_k1 | 0.7576 | 0.6647 | 0.9522 | 1.0000 | 0.2690 | 0.7172 |
| miracl-cloud | hybrid_k2 | 0.7584 | 0.6665 | 0.9522 | 1.0000 | 0.2690 | 0.7163 |
| miracl-cloud | hybrid_k5 | 0.7628 | 0.6665 | 0.9571 | 1.0000 | 0.2700 | 0.7372 |
| miracl-cloud | hybrid_k10 | 0.7586 | 0.6597 | 0.9571 | 1.0000 | 0.2700 | 0.7345 |
| miracl-cloud | hybrid_k30 | 0.7212 | 0.6380 | 0.8879 | 1.0000 | 0.2550 | 0.7200 |
| miracl-cloud | hybrid_k60 | 0.7069 | 0.6252 | 0.8604 | 1.0000 | 0.2470 | 0.7176 |

## Per-k comparisons (deterministic paired bootstrap, vs dense; sign = comparison − baseline)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000.

### scifact-local

- **hybrid_k1_vs_dense**: MIXED (meanΔ=0.0170, CI95%=[-0.0217, 0.0547], W/L/T=18/16/66, n=100)
- **hybrid_k2_vs_dense**: MIXED (meanΔ=0.0172, CI95%=[-0.0223, 0.0562], W/L/T=20/17/63, n=100)
- **hybrid_k5_vs_dense**: MIXED (meanΔ=0.0255, CI95%=[-0.0144, 0.0637], W/L/T=21/13/66, n=100)
- **hybrid_k10_vs_dense**: MIXED (meanΔ=0.0336, CI95%=[-0.0080, 0.0740], W/L/T=22/10/68, n=100)
- **hybrid_k30_vs_dense**: MIXED (meanΔ=0.0169, CI95%=[-0.0246, 0.0539], W/L/T=23/13/64, n=100)
- **hybrid_k60_vs_dense**: MIXED (meanΔ=0.0219, CI95%=[-0.0174, 0.0583], W/L/T=23/11/66, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0002, CI95%=[-0.0075, 0.0095], W/L/T=1/7/92, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=0.0083, CI95%=[-0.0037, 0.0232], W/L/T=9/6/85, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=0.0164, CI95%=[-0.0008, 0.0365], W/L/T=12/6/82, n=100)
- **hybrid_k30_vs_k2**: MIXED (meanΔ=-0.0003, CI95%=[-0.0162, 0.0165], W/L/T=9/8/83, n=100)
- **hybrid_k60_vs_k2**: MIXED (meanΔ=0.0046, CI95%=[-0.0179, 0.0264], W/L/T=11/8/81, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=-0.0049, CI95%=[-0.0273, 0.0176], W/L/T=8/11/81, n=100)
- **hybrid_k2_vs_k60**: MIXED (meanΔ=-0.0046, CI95%=[-0.0264, 0.0179], W/L/T=8/11/81, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0037, CI95%=[-0.0135, 0.0232], W/L/T=6/7/87, n=100)
- **hybrid_k10_vs_k60**: B_BETTER (meanΔ=0.0118, CI95%=[0.0005, 0.0275], W/L/T=7/2/91, n=100)
- **hybrid_k30_vs_k60**: MIXED (meanΔ=-0.0049, CI95%=[-0.0173, 0.0050], W/L/T=3/3/94, n=100)

### scifact-cloud

- **hybrid_k1_vs_dense**: MIXED (meanΔ=-0.0050, CI95%=[-0.0407, 0.0316], W/L/T=14/22/64, n=100)
- **hybrid_k2_vs_dense**: MIXED (meanΔ=-0.0050, CI95%=[-0.0413, 0.0309], W/L/T=14/21/65, n=100)
- **hybrid_k5_vs_dense**: MIXED (meanΔ=-0.0091, CI95%=[-0.0446, 0.0260], W/L/T=15/22/63, n=100)
- **hybrid_k10_vs_dense**: MIXED (meanΔ=-0.0178, CI95%=[-0.0558, 0.0213], W/L/T=15/25/60, n=100)
- **hybrid_k30_vs_dense**: MIXED (meanΔ=-0.0126, CI95%=[-0.0543, 0.0290], W/L/T=16/24/60, n=100)
- **hybrid_k60_vs_dense**: MIXED (meanΔ=-0.0162, CI95%=[-0.0589, 0.0224], W/L/T=15/22/63, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=0.0000, CI95%=[-0.0130, 0.0126], W/L/T=5/2/93, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=-0.0041, CI95%=[-0.0198, 0.0101], W/L/T=5/8/87, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=-0.0128, CI95%=[-0.0303, 0.0047], W/L/T=9/12/79, n=100)
- **hybrid_k30_vs_k2**: MIXED (meanΔ=-0.0076, CI95%=[-0.0311, 0.0159], W/L/T=13/13/74, n=100)
- **hybrid_k60_vs_k2**: MIXED (meanΔ=-0.0112, CI95%=[-0.0347, 0.0109], W/L/T=12/11/77, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=0.0112, CI95%=[-0.0164, 0.0385], W/L/T=12/14/74, n=100)
- **hybrid_k2_vs_k60**: MIXED (meanΔ=0.0112, CI95%=[-0.0109, 0.0347], W/L/T=11/12/77, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0071, CI95%=[-0.0145, 0.0293], W/L/T=10/11/79, n=100)
- **hybrid_k10_vs_k60**: MIXED (meanΔ=-0.0016, CI95%=[-0.0193, 0.0163], W/L/T=9/10/81, n=100)
- **hybrid_k30_vs_k60**: MIXED (meanΔ=0.0036, CI95%=[-0.0149, 0.0221], W/L/T=8/4/88, n=100)

### miracl-local

- **hybrid_k1_vs_dense**: A_BETTER (meanΔ=-0.0553, CI95%=[-0.0797, -0.0308], W/L/T=15/43/42, n=100)
- **hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0524, CI95%=[-0.0768, -0.0274], W/L/T=15/43/42, n=100)
- **hybrid_k5_vs_dense**: A_BETTER (meanΔ=-0.0547, CI95%=[-0.0810, -0.0293], W/L/T=15/43/42, n=100)
- **hybrid_k10_vs_dense**: A_BETTER (meanΔ=-0.0585, CI95%=[-0.0864, -0.0314], W/L/T=16/44/40, n=100)
- **hybrid_k30_vs_dense**: A_BETTER (meanΔ=-0.0667, CI95%=[-0.1000, -0.0365], W/L/T=15/43/42, n=100)
- **hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.0644, CI95%=[-0.0967, -0.0344], W/L/T=16/42/42, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0029, CI95%=[-0.0131, 0.0061], W/L/T=5/7/88, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=-0.0024, CI95%=[-0.0162, 0.0117], W/L/T=8/14/78, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=-0.0062, CI95%=[-0.0214, 0.0096], W/L/T=7/17/76, n=100)
- **hybrid_k30_vs_k2**: MIXED (meanΔ=-0.0143, CI95%=[-0.0329, 0.0028], W/L/T=7/20/73, n=100)
- **hybrid_k60_vs_k2**: MIXED (meanΔ=-0.0120, CI95%=[-0.0298, 0.0043], W/L/T=8/19/73, n=100)
- **hybrid_k1_vs_k60**: MIXED (meanΔ=0.0091, CI95%=[-0.0098, 0.0308], W/L/T=21/10/69, n=100)
- **hybrid_k2_vs_k60**: MIXED (meanΔ=0.0120, CI95%=[-0.0043, 0.0298], W/L/T=19/8/73, n=100)
- **hybrid_k5_vs_k60**: MIXED (meanΔ=0.0097, CI95%=[-0.0042, 0.0236], W/L/T=14/5/81, n=100)
- **hybrid_k10_vs_k60**: MIXED (meanΔ=0.0059, CI95%=[-0.0056, 0.0174], W/L/T=14/5/81, n=100)
- **hybrid_k30_vs_k60**: MIXED (meanΔ=-0.0023, CI95%=[-0.0087, 0.0047], W/L/T=2/5/93, n=100)

### miracl-cloud

- **hybrid_k1_vs_dense**: A_BETTER (meanΔ=-0.0843, CI95%=[-0.1152, -0.0520], W/L/T=15/63/22, n=100)
- **hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0836, CI95%=[-0.1168, -0.0496], W/L/T=18/61/21, n=100)
- **hybrid_k5_vs_dense**: A_BETTER (meanΔ=-0.0791, CI95%=[-0.1156, -0.0413], W/L/T=18/58/24, n=100)
- **hybrid_k10_vs_dense**: A_BETTER (meanΔ=-0.0834, CI95%=[-0.1221, -0.0449], W/L/T=17/58/25, n=100)
- **hybrid_k30_vs_dense**: A_BETTER (meanΔ=-0.1207, CI95%=[-0.1687, -0.0713], W/L/T=16/60/24, n=100)
- **hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.1351, CI95%=[-0.1848, -0.0837], W/L/T=16/60/24, n=100)
- **hybrid_k1_vs_k2**: MIXED (meanΔ=-0.0008, CI95%=[-0.0062, 0.0045], W/L/T=11/13/76, n=100)
- **hybrid_k5_vs_k2**: MIXED (meanΔ=0.0044, CI95%=[-0.0084, 0.0180], W/L/T=17/25/58, n=100)
- **hybrid_k10_vs_k2**: MIXED (meanΔ=0.0002, CI95%=[-0.0167, 0.0178], W/L/T=23/32/45, n=100)
- **hybrid_k30_vs_k2**: A_BETTER (meanΔ=-0.0371, CI95%=[-0.0631, -0.0119], W/L/T=26/36/38, n=100)
- **hybrid_k60_vs_k2**: A_BETTER (meanΔ=-0.0515, CI95%=[-0.0820, -0.0230], W/L/T=24/39/37, n=100)
- **hybrid_k1_vs_k60**: B_BETTER (meanΔ=0.0507, CI95%=[0.0194, 0.0833], W/L/T=38/25/37, n=100)
- **hybrid_k2_vs_k60**: B_BETTER (meanΔ=0.0515, CI95%=[0.0230, 0.0820], W/L/T=39/24/37, n=100)
- **hybrid_k5_vs_k60**: B_BETTER (meanΔ=0.0559, CI95%=[0.0326, 0.0805], W/L/T=39/11/50, n=100)
- **hybrid_k10_vs_k60**: B_BETTER (meanΔ=0.0517, CI95%=[0.0308, 0.0741], W/L/T=38/8/54, n=100)
- **hybrid_k30_vs_k60**: B_BETTER (meanΔ=0.0144, CI95%=[0.0058, 0.0260], W/L/T=16/2/82, n=100)

## Comparison against previously committed k=2/k=60 reports

Only compared against a prior report on the same corpus/query set with
a compatible provider configuration. Deltas between incompatible runs
are not "drift" and are never reported as numbers. Where a real
comparison is made: local drift should be investigated. Cloud drift may
reflect hosted-model/service changes on Qdrant's side — reported as a
fact, not silently treated as equivalent to the prior run.

| Scope | Mode | Prior nDCG@10 | New nDCG@10 | Delta | Comparable |
|---|---|---:|---:|---:|---|
| scifact-local | hybrid_k2 | 0.6976 | 0.6920 | -0.0056 | yes |
| scifact-local | hybrid_k60 | 0.6931 | 0.6966 | 0.0036 | yes |
| scifact-cloud | hybrid_k2 | n/a | n/a | n/a | no — No compatible prior report exists: the local-only RRF mini benchmark never ran the cloud profile, and the full 300-query/5183-doc SciFact report uses a different-sized corpus than this sweep's 100-query/1000-doc mini subset. |
| scifact-cloud | hybrid_k60 | n/a | n/a | n/a | no — No compatible prior report exists: the local-only RRF mini benchmark never ran the cloud profile, and the full 300-query/5183-doc SciFact report uses a different-sized corpus than this sweep's 100-query/1000-doc mini subset. |
| miracl-local | hybrid_k2 | n/a | n/a | n/a | no — Execution provider differs: prior MIRACL local used dml, current sweep used cpu. |
| miracl-local | hybrid_k60 | n/a | n/a | n/a | no — Execution provider differs: prior MIRACL local used dml, current sweep used cpu. |
| miracl-cloud | hybrid_k2 | 0.7613 | 0.7584 | -0.0029 | yes |
| miracl-cloud | hybrid_k60 | 0.7130 | 0.7069 | -0.0062 | yes |

## Answers

### 1. Observed RRF curve per scope

- **scifact-local**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.6917, k2=0.6920, k5=0.7003, k10=0.7084, k30=0.6917, k60=0.6966. best: k10 (0.7084), worst: k30 (0.6917).
- **scifact-cloud**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.7275, k2=0.7274, k5=0.7234, k10=0.7147, k30=0.7199, k60=0.7163. best: k1 (0.7275), worst: k10 (0.7147).
- **miracl-local**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.8442, k2=0.8471, k5=0.8447, k10=0.8409, k30=0.8327, k60=0.8350. best: k2 (0.8471), worst: k30 (0.8327).
- **miracl-cloud**: FACT — non-monotonic (has an interior peak or trough). Values: k1=0.7576, k2=0.7584, k5=0.7628, k10=0.7586, k30=0.7212, k60=0.7069. best: k5 (0.7628), worst: k60 (0.7069).

### 2. Does any k make hybrid match or beat dense on MIRACL?

- **miracl-local**: FACT — hybrid is bootstrap-significantly WORSE than dense at: k1, k2, k5, k10, k30, k60.
- **miracl-cloud**: FACT — hybrid is bootstrap-significantly WORSE than dense at: k1, k2, k5, k10, k30, k60.

### 3. Is one k stable across all four scopes, or dataset/provider-dependent?

- FACT — no single k is a best (or tied-best) point on every scope; the best-k sets differ by scope.
  - scifact-local: best k = k10
  - scifact-cloud: best k = k1
  - miracl-local: best k = k2
  - miracl-cloud: best k = k5
- HYPOTHESIS — even where one k happens to be best (or tied-best) in this run, that does not establish it as the correct default: a bootstrap-insignificant best point (small margin, wide CI) is not real evidence of superiority over neighboring k values. See the per-scope bootstrap comparisons above before treating "best observed" as "best".

### 4. How do rescue/harm counts change as k increases?

- **scifact-local**: FACT — k1: 18R/16H/66T, k2: 20R/17H/63T, k5: 21R/13H/66T, k10: 22R/10H/68T, k30: 23R/13H/64T, k60: 23R/11H/66T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **scifact-cloud**: FACT — k1: 14R/22H/64T, k2: 14R/21H/65T, k5: 15R/22H/63T, k10: 15R/25H/60T, k30: 16R/24H/60T, k60: 15R/22H/63T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **miracl-local**: FACT — k1: 15R/43H/42T, k2: 15R/43H/42T, k5: 15R/43H/42T, k10: 16R/44H/40T, k30: 15R/43H/42T, k60: 16R/42H/42T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).
- **miracl-cloud**: FACT — k1: 15R/63H/22T, k2: 18R/61H/21T, k5: 18R/58H/24T, k10: 17R/58H/25T, k30: 16R/60H/24T, k60: 16R/60H/24T (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).

### 5. Is k=2 or k=60 consistently preferable?

- **scifact-local**: FACT — no significant difference — real per-query wins on both sides, net effect not significant (MIXED) (meanΔ=k2−k60=-0.0046, W/L/T=8/11/81).
- **scifact-cloud**: FACT — no significant difference — real per-query wins on both sides, net effect not significant (MIXED) (meanΔ=k2−k60=0.0112, W/L/T=11/12/77).
- **miracl-local**: FACT — no significant difference — real per-query wins on both sides, net effect not significant (MIXED) (meanΔ=k2−k60=0.0120, W/L/T=19/8/73).
- **miracl-cloud**: FACT — k2 is bootstrap-significantly better than k60 (meanΔ=k2−k60=0.0515, W/L/T=39/24/37).
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
| scifact-local | 1000 | 1077559 | 0 | 0 | deleted | 3259686912 |
| scifact-cloud | 1000 | 52824 | 0 | 0 | deleted | 3287425024 |
| miracl-local | 1000 | 917643 | 0 | 0 | deleted | 3361681408 |
| miracl-cloud | 1000 | 44414 | 0 | 0 | deleted | 3306823680 |

Peak process RSS (whole run): 3362639872 bytes

## Per-scope provenance

| Scope | Commit | SDK | ONNX EP | Dense model | Sparse model | Corpus/queries | Manifest seed |
|---|---|---|---|---|---|---|---|
| scifact-local | 4b2a0a6eab6c | 1.18.0 | cpu | aapot/bge-m3-onnx | bge-m3-onnx-lexical | 1000/100 | semidex-beir-scifact-rrf-mini-v1 |
| scifact-cloud | 4b2a0a6eab6c | 1.18.0 | cpu | intfloat/multilingual-e5-small | qdrant/bm25 | 1000/100 | semidex-beir-scifact-rrf-mini-v1 |
| miracl-local | 4b2a0a6eab6c | 1.18.0 | cpu | aapot/bge-m3-onnx | bge-m3-onnx-lexical | 1000/100 | semidex-miracl-ru-pooled-subset-v1 |
| miracl-cloud | 4b2a0a6eab6c | 1.18.0 | cpu | intfloat/multilingual-e5-small | qdrant/bm25 | 1000/100 | semidex-miracl-ru-pooled-subset-v1 |

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
