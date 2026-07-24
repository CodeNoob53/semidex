# Slavic Belebele weighted-RRF fusion matrix

Verdict: **SLAVIC_WEIGHTED_RRF_HARNESS_ACCEPT**

Goal: determine whether sparse/equal-weight RRF regressions correlate
with individual Slavic languages or script groups. Uses the SAME six
fusion modes and rho -> sparseWeight conversion already validated by the
live SciFact/MIRACL weighted-RRF benchmark — real Qdrant
`query.rrf.weights` requests only, never `prefetch.weight`, never a
local RRF reconstruction. Local BGE-M3 ONNX only — no Qdrant Cloud
E5/BM25 profile, isolating the language factor under one fixed provider.

CUDA is an execution ACCELERATOR ONLY. It is never interpreted as
affecting retrieval quality, and CPU/DML/CUDA quality is never compared
anywhere in this report.

Script and language are confounded in this dataset — findings are
reported as observed associations requiring further validation, never
as a causal claim that script itself causes a difference.

Fusion modes: dense, sparse, equal_k2, equal_k60, k2_rho0.10, k2_rho0.25

## Retrieval quality per language

| Language | Script | Mode | nDCG@10 | MAP@100 | MRR@10 | Recall@10 | Recall@100 | Queries | Errors |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| ukr_Cyrl | Cyrillic | dense | 0.9378 | 0.9225 | 0.9220 | 0.9856 | 0.9989 | 900 | 0 |
| ukr_Cyrl | Cyrillic | sparse | 0.8596 | 0.8381 | 0.8364 | 0.9311 | 0.9700 | 900 | 0 |
| ukr_Cyrl | Cyrillic | equal_k2 | 0.9428 | 0.9281 | 0.9277 | 0.9878 | 0.9956 | 900 | 0 |
| ukr_Cyrl | Cyrillic | equal_k60 | 0.9249 | 0.9109 | 0.9101 | 0.9700 | 0.9967 | 900 | 0 |
| ukr_Cyrl | Cyrillic | k2_rho0.10 | 0.9387 | 0.9229 | 0.9224 | 0.9878 | 0.9989 | 900 | 0 |
| ukr_Cyrl | Cyrillic | k2_rho0.25 | 0.9406 | 0.9248 | 0.9245 | 0.9889 | 0.9978 | 900 | 0 |
| rus_Cyrl | Cyrillic | dense | 0.9466 | 0.9330 | 0.9327 | 0.9889 | 0.9967 | 900 | 0 |
| rus_Cyrl | Cyrillic | sparse | 0.8873 | 0.8709 | 0.8695 | 0.9422 | 0.9733 | 900 | 0 |
| rus_Cyrl | Cyrillic | equal_k2 | 0.9479 | 0.9342 | 0.9339 | 0.9900 | 0.9956 | 900 | 0 |
| rus_Cyrl | Cyrillic | equal_k60 | 0.9360 | 0.9241 | 0.9232 | 0.9744 | 0.9956 | 900 | 0 |
| rus_Cyrl | Cyrillic | k2_rho0.10 | 0.9473 | 0.9336 | 0.9333 | 0.9900 | 0.9967 | 900 | 0 |
| rus_Cyrl | Cyrillic | k2_rho0.25 | 0.9491 | 0.9355 | 0.9352 | 0.9911 | 0.9967 | 900 | 0 |
| bul_Cyrl | Cyrillic | dense | 0.9336 | 0.9197 | 0.9186 | 0.9800 | 0.9978 | 900 | 0 |
| bul_Cyrl | Cyrillic | sparse | 0.8789 | 0.8632 | 0.8617 | 0.9322 | 0.9678 | 900 | 0 |
| bul_Cyrl | Cyrillic | equal_k2 | 0.9445 | 0.9323 | 0.9316 | 0.9844 | 0.9967 | 900 | 0 |
| bul_Cyrl | Cyrillic | equal_k60 | 0.9300 | 0.9177 | 0.9168 | 0.9700 | 0.9967 | 900 | 0 |
| bul_Cyrl | Cyrillic | k2_rho0.10 | 0.9351 | 0.9204 | 0.9195 | 0.9833 | 0.9978 | 900 | 0 |
| bul_Cyrl | Cyrillic | k2_rho0.25 | 0.9378 | 0.9228 | 0.9221 | 0.9856 | 0.9978 | 900 | 0 |
| pol_Latn | Latin | dense | 0.9401 | 0.9285 | 0.9275 | 0.9789 | 0.9967 | 900 | 0 |
| pol_Latn | Latin | sparse | 0.8507 | 0.8317 | 0.8304 | 0.9133 | 0.9478 | 900 | 0 |
| pol_Latn | Latin | equal_k2 | 0.9339 | 0.9181 | 0.9174 | 0.9833 | 0.9978 | 900 | 0 |
| pol_Latn | Latin | equal_k60 | 0.9084 | 0.8977 | 0.8956 | 0.9478 | 0.9978 | 900 | 0 |
| pol_Latn | Latin | k2_rho0.10 | 0.9414 | 0.9291 | 0.9281 | 0.9822 | 0.9967 | 900 | 0 |
| pol_Latn | Latin | k2_rho0.25 | 0.9440 | 0.9308 | 0.9301 | 0.9867 | 0.9967 | 900 | 0 |
| ces_Latn | Latin | dense | 0.9403 | 0.9253 | 0.9248 | 0.9878 | 0.9978 | 900 | 0 |
| ces_Latn | Latin | sparse | 0.8868 | 0.8728 | 0.8715 | 0.9344 | 0.9733 | 900 | 0 |
| ces_Latn | Latin | equal_k2 | 0.9454 | 0.9331 | 0.9323 | 0.9844 | 0.9967 | 900 | 0 |
| ces_Latn | Latin | equal_k60 | 0.9298 | 0.9187 | 0.9174 | 0.9678 | 0.9967 | 900 | 0 |
| ces_Latn | Latin | k2_rho0.10 | 0.9412 | 0.9260 | 0.9255 | 0.9889 | 0.9978 | 900 | 0 |
| ces_Latn | Latin | k2_rho0.25 | 0.9429 | 0.9281 | 0.9276 | 0.9889 | 0.9978 | 900 | 0 |
| slk_Latn | Latin | dense | 0.9441 | 0.9324 | 0.9317 | 0.9822 | 0.9956 | 900 | 0 |
| slk_Latn | Latin | sparse | 0.8803 | 0.8649 | 0.8635 | 0.9322 | 0.9678 | 900 | 0 |
| slk_Latn | Latin | equal_k2 | 0.9481 | 0.9352 | 0.9349 | 0.9878 | 0.9967 | 900 | 0 |
| slk_Latn | Latin | equal_k60 | 0.9256 | 0.9150 | 0.9135 | 0.9622 | 0.9956 | 900 | 0 |
| slk_Latn | Latin | k2_rho0.10 | 0.9454 | 0.9330 | 0.9324 | 0.9856 | 0.9967 | 900 | 0 |
| slk_Latn | Latin | k2_rho0.25 | 0.9483 | 0.9356 | 0.9352 | 0.9878 | 0.9967 | 900 | 0 |
| eng_Latn | Latin | dense | 0.9555 | 0.9448 | 0.9443 | 0.9889 | 0.9978 | 900 | 0 |
| eng_Latn | Latin | sparse | 0.9223 | 0.9100 | 0.9090 | 0.9633 | 0.9811 | 900 | 0 |
| eng_Latn | Latin | equal_k2 | 0.9642 | 0.9551 | 0.9549 | 0.9922 | 0.9967 | 900 | 0 |
| eng_Latn | Latin | equal_k60 | 0.9507 | 0.9417 | 0.9409 | 0.9800 | 0.9967 | 900 | 0 |
| eng_Latn | Latin | k2_rho0.10 | 0.9561 | 0.9452 | 0.9447 | 0.9900 | 0.9978 | 900 | 0 |
| eng_Latn | Latin | k2_rho0.25 | 0.9589 | 0.9472 | 0.9470 | 0.9944 | 0.9978 | 900 | 0 |

## Paired bootstrap comparisons (sign = comparison − baseline)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000.

### ukr_Cyrl (Ukrainian)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0781, CI95%=[-0.0977, -0.0604], W/L/T=55/160/685, n=900)
- **equal_k2_vs_dense**: MIXED (meanΔ=0.0050, CI95%=[-0.0038, 0.0135], W/L/T=58/58/784, n=900)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0128, CI95%=[-0.0263, 0.0002], W/L/T=70/69/761, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0009, CI95%=[0.0001, 0.0020], W/L/T=7/0/893, n=900)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=-0.0041, CI95%=[-0.0122, 0.0044], W/L/T=58/58/784, n=900)
- **k2_rho0.10_vs_equal_k60**: B_BETTER (meanΔ=0.0137, CI95%=[0.0009, 0.0272], W/L/T=69/70/761, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0028, CI95%=[0.0013, 0.0047], W/L/T=22/7/871, n=900)

### rus_Cyrl (Russian)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0592, CI95%=[-0.0765, -0.0429], W/L/T=49/127/724, n=900)
- **equal_k2_vs_dense**: MIXED (meanΔ=0.0013, CI95%=[-0.0068, 0.0094], W/L/T=50/56/794, n=900)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0105, CI95%=[-0.0224, 0.0008], W/L/T=61/61/778, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0007, CI95%=[0.0002, 0.0016], W/L/T=10/0/890, n=900)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=-0.0006, CI95%=[-0.0084, 0.0073], W/L/T=56/50/794, n=900)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=0.0113, CI95%=[-0.0001, 0.0232], W/L/T=61/61/778, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0026, CI95%=[0.0010, 0.0043], W/L/T=21/9/870, n=900)

### bul_Cyrl (Bulgarian)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0547, CI95%=[-0.0725, -0.0378], W/L/T=56/130/714, n=900)
- **equal_k2_vs_dense**: B_BETTER (meanΔ=0.0109, CI95%=[0.0017, 0.0204], W/L/T=57/54/789, n=900)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0036, CI95%=[-0.0167, 0.0090], W/L/T=68/61/771, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0015, CI95%=[0.0005, 0.0030], W/L/T=12/0/888, n=900)
- **k2_rho0.10_vs_equal_k2**: A_BETTER (meanΔ=-0.0094, CI95%=[-0.0180, -0.0006], W/L/T=54/57/789, n=900)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=0.0052, CI95%=[-0.0069, 0.0176], W/L/T=61/68/771, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0041, CI95%=[0.0020, 0.0065], W/L/T=26/5/869, n=900)

### pol_Latn (Polish)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0895, CI95%=[-0.1098, -0.0711], W/L/T=42/158/700, n=900)
- **equal_k2_vs_dense**: MIXED (meanΔ=-0.0062, CI95%=[-0.0152, 0.0028], W/L/T=43/75/782, n=900)
- **equal_k60_vs_dense**: A_BETTER (meanΔ=-0.0318, CI95%=[-0.0476, -0.0166], W/L/T=51/80/769, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0012, CI95%=[0.0003, 0.0026], W/L/T=8/0/892, n=900)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=0.0075, CI95%=[-0.0013, 0.0161], W/L/T=75/43/782, n=900)
- **k2_rho0.10_vs_equal_k60**: B_BETTER (meanΔ=0.0330, CI95%=[0.0180, 0.0488], W/L/T=80/51/769, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0039, CI95%=[0.0019, 0.0060], W/L/T=22/7/871, n=900)

### ces_Latn (Czech)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0535, CI95%=[-0.0709, -0.0376], W/L/T=57/127/716, n=900)
- **equal_k2_vs_dense**: MIXED (meanΔ=0.0050, CI95%=[-0.0042, 0.0142], W/L/T=59/63/778, n=900)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0106, CI95%=[-0.0239, 0.0015], W/L/T=65/64/771, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0008, CI95%=[0.0003, 0.0017], W/L/T=10/0/890, n=900)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=-0.0042, CI95%=[-0.0132, 0.0047], W/L/T=63/59/778, n=900)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=0.0114, CI95%=[-0.0006, 0.0247], W/L/T=64/65/771, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0026, CI95%=[0.0009, 0.0042], W/L/T=26/9/865, n=900)

### slk_Latn (Slovak)

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0638, CI95%=[-0.0826, -0.0447], W/L/T=52/134/714, n=900)
- **equal_k2_vs_dense**: MIXED (meanΔ=0.0040, CI95%=[-0.0058, 0.0139], W/L/T=53/64/783, n=900)
- **equal_k60_vs_dense**: A_BETTER (meanΔ=-0.0185, CI95%=[-0.0329, -0.0052], W/L/T=56/72/772, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0013, CI95%=[0.0002, 0.0027], W/L/T=9/1/890, n=900)
- **k2_rho0.10_vs_equal_k2**: MIXED (meanΔ=-0.0027, CI95%=[-0.0120, 0.0068], W/L/T=64/53/783, n=900)
- **k2_rho0.10_vs_equal_k60**: B_BETTER (meanΔ=0.0198, CI95%=[0.0068, 0.0340], W/L/T=72/56/772, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0041, CI95%=[0.0021, 0.0064], W/L/T=26/3/871, n=900)

### eng_Latn (English (control))

- **sparse_vs_dense**: A_BETTER (meanΔ=-0.0332, CI95%=[-0.0485, -0.0184], W/L/T=52/91/757, n=900)
- **equal_k2_vs_dense**: B_BETTER (meanΔ=0.0088, CI95%=[0.0012, 0.0167], W/L/T=48/36/816, n=900)
- **equal_k60_vs_dense**: MIXED (meanΔ=-0.0048, CI95%=[-0.0159, 0.0052], W/L/T=53/47/800, n=900)
- **k2_rho0.10_vs_dense**: B_BETTER (meanΔ=0.0006, CI95%=[0.0001, 0.0015], W/L/T=7/1/892, n=900)
- **k2_rho0.10_vs_equal_k2**: A_BETTER (meanΔ=-0.0082, CI95%=[-0.0157, -0.0008], W/L/T=36/48/816, n=900)
- **k2_rho0.10_vs_equal_k60**: MIXED (meanΔ=0.0054, CI95%=[-0.0043, 0.0164], W/L/T=47/53/800, n=900)
- **k2_rho0.25_vs_dense**: B_BETTER (meanΔ=0.0035, CI95%=[0.0017, 0.0055], W/L/T=20/1/879, n=900)

## Per-language decision classification

A weighted candidate is never promoted merely because it wins a group
average — MIXED is reported unless the per-language bootstrap evidence
is both directionally consistent and statistically significant.

"Restores dense quality" is a pre-registered non-inferiority test
(margin=0.02 nDCG@10, fixed before any result was inspected): **restored**
means the 95% CI on meanΔ (candidate − dense) excludes any regression
worse than the margin; **regressed** means the entire CI is a regression
beyond the margin; **inconclusive** means the CI straddles the margin
boundary or is unavailable — an absence of significant regression is NOT
by itself evidence of restoration.

| Language | Sparse vs dense | Equal k=2 vs dense | Equal k=60 vs dense | rho=0.10 vs dense | rho=0.25 vs dense |
|---|---|---|---|---|---|
| ukr_Cyrl | sparse_significantly_hurts | equal_hybrid_neutral_mixed | equal_hybrid_neutral_mixed | restored | restored |
| rus_Cyrl | sparse_significantly_hurts | equal_hybrid_neutral_mixed | equal_hybrid_neutral_mixed | restored | restored |
| bul_Cyrl | sparse_significantly_hurts | equal_hybrid_helps | equal_hybrid_neutral_mixed | restored | restored |
| pol_Latn | sparse_significantly_hurts | equal_hybrid_neutral_mixed | equal_hybrid_hurts | restored | restored |
| ces_Latn | sparse_significantly_hurts | equal_hybrid_neutral_mixed | equal_hybrid_neutral_mixed | restored | restored |
| slk_Latn | sparse_significantly_hurts | equal_hybrid_neutral_mixed | equal_hybrid_hurts | restored | restored |
| eng_Latn | sparse_significantly_hurts | equal_hybrid_helps | equal_hybrid_neutral_mixed | restored | restored |

## Group summaries (descriptive only)

DESCRIPTIVE ONLY — never a statistical claim about script/language effects, and never used by itself to promote a fusion candidate. Script and language are confounded in this dataset; see per-language results and classifyLanguageDecisions() for the actual evidence.

| Group | Languages present | dense | sparse | equal_k2 | equal_k60 | k2_rho0.10 | k2_rho0.25 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cyrillic Slavic | 3/3 | 0.9393 | 0.8753 | 0.9451 | 0.9303 | 0.9404 | 0.9425 |
| Latin Slavic | 3/3 | 0.9415 | 0.8726 | 0.9425 | 0.9212 | 0.9427 | 0.9451 |
| English control | 1/1 | 0.9555 | 0.9223 | 0.9642 | 0.9507 | 0.9561 | 0.9589 |

These macro averages never replace or outweigh per-language results,
and are never presented as statistical evidence of a script effect.

## CUDA provenance (execution accelerator only — not a quality variable)

| Language | Requested | Effective | Strict configured | Fell back to CPU | Verified |
|---|---|---|---|---|---|
| ukr_Cyrl | cuda | cuda | true | false | yes |
| rus_Cyrl | cuda | cuda | true | false | yes |
| bul_Cyrl | cuda | cuda | true | false | yes |
| pol_Latn | cuda | cuda | true | false | yes |
| ces_Latn | cuda | cuda | true | false | yes |
| slk_Latn | cuda | cuda | true | false | yes |
| eng_Latn | cuda | cuda | true | false | yes |

## Truncation

| Language | Documents truncated | Queries truncated |
|---|---:|---:|
| ukr_Cyrl | 0/488 | 0/900 |
| rus_Cyrl | 0/488 | 0/900 |
| bul_Cyrl | 0/488 | 0/900 |
| pol_Latn | 0/488 | 0/900 |
| ces_Latn | 0/488 | 0/900 |
| slk_Latn | 0/488 | 0/900 |
| eng_Latn | 0/488 | 0/900 |

## Operations

| Language | Indexed | Index wall ms | Query errors | Retries | Cleanup | Peak RSS |
|---|---:|---:|---:|---:|---|---:|
| ukr_Cyrl | 488 | 16603 | 0 | 0 | deleted | 1346375680 |
| rus_Cyrl | 488 | 17090 | 0 | 0 | deleted | 1490432000 |
| bul_Cyrl | 488 | 15366 | 0 | 0 | deleted | 1482424320 |
| pol_Latn | 488 | 15576 | 0 | 0 | deleted | 1472647168 |
| ces_Latn | 488 | 14398 | 0 | 0 | deleted | 1507438592 |
| slk_Latn | 488 | 15734 | 0 | 0 | deleted | 1483800576 |
| eng_Latn | 488 | 15106 | 0 | 0 | deleted | 1476272128 |

Peak process RSS (whole run): 1513140224 bytes

## Interpretation limits

- FACT: every hybrid row was produced by a real Qdrant `query.rrf.weights`
  request, prefetch=200/lane, final limit 100 — never a local RRF
  reconstruction, never `prefetch.weight`.
- FACT: qrels are MRC-derived (one relevant passage per question),
  never pooled IR judgments — see fetch-belebele.mjs's module header.
- FACT: only the local BGE-M3 provider was measured — no Qdrant Cloud
  E5/BM25 comparison in this run, by design.
- FACT: CUDA is an execution accelerator only; this report never compares
  CPU/DML/CUDA retrieval quality.
- FACT: script and language are confounded in this 7-language matrix —
  no per-script causal claim is made anywhere in this report.
- This benchmark does not implement or recommend production
  language-aware fusion, and does not change any production fusion
  default from this run alone.
