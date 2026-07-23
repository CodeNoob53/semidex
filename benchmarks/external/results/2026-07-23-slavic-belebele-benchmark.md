# Slavic dense vs sparse benchmark — mteb/belebele

Verdict: **SLAVIC_BELEBELE_HARNESS_ACCEPT**

Isolates the LANGUAGE factor: local BGE-M3 ONNX dense+learned-sparse
only, one fixed equal-RRF hybrid mode (k=60), no Qdrant Cloud E5/BM25.
Qrels are MRC-derived (one relevant passage per question, synthesized
from mteb/belebele exactly as MTEB's own BelebeleRetrieval task does) —
never pooled IR judgments. See the companion feasibility report for the
full dataset contract and limitations.

## Retrieval quality per language

| Language | Script | Mode | nDCG@10 | MAP@100 | MRR@10 | Recall@10 | Recall@100 |
|---|---|---|---:|---:|---:|---:|---:|
| ukr_Cyrl | Cyrillic | dense | 0.9372 | 0.9217 | 0.9212 | 0.9856 | 0.9989 |
| ukr_Cyrl | Cyrillic | sparse | 0.8596 | 0.8381 | 0.8364 | 0.9311 | 0.9700 |
| ukr_Cyrl | Cyrillic | hybrid | 0.9274 | 0.9143 | 0.9134 | 0.9700 | 0.9967 |
| rus_Cyrl | Cyrillic | dense | 0.9466 | 0.9330 | 0.9327 | 0.9889 | 0.9967 |
| rus_Cyrl | Cyrillic | sparse | 0.8873 | 0.8709 | 0.8695 | 0.9422 | 0.9733 |
| rus_Cyrl | Cyrillic | hybrid | 0.9354 | 0.9232 | 0.9223 | 0.9744 | 0.9956 |
| bul_Cyrl | Cyrillic | dense | 0.9333 | 0.9192 | 0.9181 | 0.9800 | 0.9978 |
| bul_Cyrl | Cyrillic | sparse | 0.8789 | 0.8632 | 0.8617 | 0.9322 | 0.9678 |
| bul_Cyrl | Cyrillic | hybrid | 0.9287 | 0.9159 | 0.9150 | 0.9700 | 0.9967 |
| pol_Latn | Latin | dense | 0.9401 | 0.9285 | 0.9275 | 0.9789 | 0.9967 |
| pol_Latn | Latin | sparse | 0.8507 | 0.8317 | 0.8304 | 0.9133 | 0.9478 |
| pol_Latn | Latin | hybrid | 0.9057 | 0.8942 | 0.8921 | 0.9478 | 0.9978 |
| ces_Latn | Latin | dense | 0.9403 | 0.9253 | 0.9248 | 0.9878 | 0.9978 |
| ces_Latn | Latin | sparse | 0.8868 | 0.8728 | 0.8715 | 0.9344 | 0.9733 |
| ces_Latn | Latin | hybrid | 0.9289 | 0.9174 | 0.9162 | 0.9678 | 0.9967 |
| slk_Latn | Latin | dense | 0.9441 | 0.9324 | 0.9317 | 0.9822 | 0.9956 |
| slk_Latn | Latin | sparse | 0.8803 | 0.8649 | 0.8635 | 0.9322 | 0.9678 |
| slk_Latn | Latin | hybrid | 0.9249 | 0.9140 | 0.9126 | 0.9622 | 0.9956 |
| eng_Latn | Latin | dense | 0.9555 | 0.9448 | 0.9443 | 0.9889 | 0.9978 |
| eng_Latn | Latin | sparse | 0.9222 | 0.9099 | 0.9090 | 0.9633 | 0.9811 |
| eng_Latn | Latin | hybrid | 0.9519 | 0.9434 | 0.9426 | 0.9800 | 0.9967 |

## Dense vs sparse vs hybrid comparisons (paired bootstrap, sign = comparison − baseline)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000.

### ukr_Cyrl (Ukrainian)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0776, CI95%=[-0.0975, -0.0600], W/L/T=56/160/684, n=900)
- **hybrid_vs_dense**: MIXED (meanΔ=-0.0098, CI95%=[-0.0230, 0.0034], W/L/T=73/64/763, n=900)
- rescue/harm/tie (hybrid vs dense): 73/64/763

### rus_Cyrl (Russian)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0592, CI95%=[-0.0765, -0.0429], W/L/T=49/127/724, n=900)
- **hybrid_vs_dense**: MIXED (meanΔ=-0.0112, CI95%=[-0.0231, 0.0005], W/L/T=60/61/779, n=900)
- rescue/harm/tie (hybrid vs dense): 60/61/779

### bul_Cyrl (Bulgarian)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0544, CI95%=[-0.0717, -0.0376], W/L/T=57/130/713, n=900)
- **hybrid_vs_dense**: MIXED (meanΔ=-0.0046, CI95%=[-0.0174, 0.0077], W/L/T=67/61/772, n=900)
- rescue/harm/tie (hybrid vs dense): 67/61/772

### pol_Latn (Polish)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0895, CI95%=[-0.1098, -0.0711], W/L/T=42/158/700, n=900)
- **hybrid_vs_dense**: A_BETTER (meanΔ=-0.0344, CI95%=[-0.0504, -0.0192], W/L/T=49/84/767, n=900)
- rescue/harm/tie (hybrid vs dense): 49/84/767

### ces_Latn (Czech)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0535, CI95%=[-0.0709, -0.0376], W/L/T=57/127/716, n=900)
- **hybrid_vs_dense**: MIXED (meanΔ=-0.0115, CI95%=[-0.0248, 0.0011], W/L/T=67/68/765, n=900)
- rescue/harm/tie (hybrid vs dense): 67/68/765

### slk_Latn (Slovak)

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0638, CI95%=[-0.0826, -0.0447], W/L/T=52/134/714, n=900)
- **hybrid_vs_dense**: A_BETTER (meanΔ=-0.0192, CI95%=[-0.0333, -0.0060], W/L/T=55/72/773, n=900)
- rescue/harm/tie (hybrid vs dense): 55/72/773

### eng_Latn (English (control))

- **dense_vs_sparse**: A_BETTER (meanΔ=-0.0332, CI95%=[-0.0486, -0.0184], W/L/T=52/91/757, n=900)
- **hybrid_vs_dense**: MIXED (meanΔ=-0.0036, CI95%=[-0.0144, 0.0062], W/L/T=51/42/807, n=900)
- rescue/harm/tie (hybrid vs dense): 51/42/807

## Sparse diagnostics per language

| Language | Mean non-zero sparse (docs) | Mean non-zero sparse (queries) | Mean query sparse-index coverage in relevant doc | Dense-only hits | Sparse-only hits | Both hits | Neither hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| ukr_Cyrl | 80.2111 | 14.5044 | 0.3847 | 54 | 5 | 833 | 8 |
| rus_Cyrl | 77.2971 | 13.6500 | 0.3954 | 46 | 4 | 844 | 6 |
| bul_Cyrl | 73.0082 | 13.9756 | 0.4337 | 52 | 9 | 830 | 9 |
| pol_Latn | 77.8074 | 13.8633 | 0.3632 | 69 | 10 | 812 | 9 |
| ces_Latn | 76.8053 | 14.2178 | 0.3780 | 52 | 4 | 837 | 7 |
| slk_Latn | 77.9857 | 14.3700 | 0.3829 | 51 | 6 | 833 | 10 |
| eng_Latn | 65.0082 | 11.9878 | 0.4701 | 27 | 4 | 863 | 6 |

HYPOTHESIS ONLY: these counts describe WHAT happened, not WHY. No
morphological or linguistic causal conclusion is drawn from sparse
token counts or overlap alone — any such explanation in this report is
explicitly labeled as a hypothesis, never a proven mechanism.

## Largest sparse wins / failures per language (sparse nDCG@10 − dense nDCG@10)

### ukr_Cyrl

Wins (sparse beat dense):
- q-f97a0337e9b538b7: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-6f1d46bb64c6823b: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-8396605267df538e: dense=0.0000 sparse=1.0000 Δ=1.0000
Failures (sparse lost to dense):
- q-fc206bdf1387dcb1: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-adf266cd116453df: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-0c17055b17bd0c7e: dense=1.0000 sparse=0.0000 Δ=-1.0000

### rus_Cyrl

Wins (sparse beat dense):
- q-8dd5c408ea4369ff: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-f33071e7f8b05c41: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-bdf2bc7754ca8aa5: dense=0.2891 sparse=1.0000 Δ=0.7109
Failures (sparse lost to dense):
- q-c781e80dced683a3: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-b473cb0cceb79e82: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-a5a11f62ed2fd577: dense=1.0000 sparse=0.0000 Δ=-1.0000

### bul_Cyrl

Wins (sparse beat dense):
- q-91fbc789f59a5d29: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-606832fd45f2dded: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-75cb38d9ad5ebefe: dense=0.0000 sparse=1.0000 Δ=1.0000
Failures (sparse lost to dense):
- q-45b788762d092fdf: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-29360f04ba5c3f0e: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-af2af2ad3964b76a: dense=1.0000 sparse=0.0000 Δ=-1.0000

### pol_Latn

Wins (sparse beat dense):
- q-c499861d277547d5: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-b98b95ae8f4ca73b: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-93f51e7f07a41d6f: dense=0.0000 sparse=1.0000 Δ=1.0000
Failures (sparse lost to dense):
- q-e7c5c50c3812715b: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-f3ab9521147a0daf: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-4e5d2621c139b069: dense=1.0000 sparse=0.0000 Δ=-1.0000

### ces_Latn

Wins (sparse beat dense):
- q-21eb40e8cf762c71: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-356d408d90d327f4: dense=0.3155 sparse=1.0000 Δ=0.6845
- q-85e540f18cd7c2d9: dense=0.3333 sparse=1.0000 Δ=0.6667
Failures (sparse lost to dense):
- q-b463cdae06e01846: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-8dc4f892f0faa258: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-8580657a1042761f: dense=1.0000 sparse=0.0000 Δ=-1.0000

### slk_Latn

Wins (sparse beat dense):
- q-5df1087719bfc52e: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-0c6aa95e6b073313: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-62fac42ecedfb52f: dense=0.0000 sparse=1.0000 Δ=1.0000
Failures (sparse lost to dense):
- q-b37726b6676328cf: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-9f696213c9f40812: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-0eed4ca9444977a6: dense=1.0000 sparse=0.0000 Δ=-1.0000

### eng_Latn

Wins (sparse beat dense):
- q-3c252d9a313efc96: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-33201c9145df6195: dense=0.0000 sparse=1.0000 Δ=1.0000
- q-b95fde3003208ffb: dense=0.3155 sparse=1.0000 Δ=0.6845
Failures (sparse lost to dense):
- q-161318616c0bbf32: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-433f5a0f0e2e1e8e: dense=1.0000 sparse=0.0000 Δ=-1.0000
- q-aaf983eab2bb4e0a: dense=1.0000 sparse=0.0000 Δ=-1.0000

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

## Macro summary (descriptive only)

DESCRIPTIVE ONLY — never a statistical claim about script/language effects. See per-language results for the actual evidence.

| Group | Languages | nDCG@10 dense | nDCG@10 sparse | nDCG@10 hybrid |
|---|---:|---:|---:|---:|
| Cyrillic average | 3 | 0.9390 | 0.8753 | 0.9305 |
| Latin average | 3 | 0.9415 | 0.8726 | 0.9198 |
| English control | 1 | 0.9555 | 0.9222 | 0.9519 |

These aggregates never replace or outweigh per-language results, and
are never presented as statistical evidence of a script effect.

## Operations

| Language | Indexed | Index wall ms | Query errors | Retries | Cleanup | Peak RSS |
|---|---:|---:|---:|---:|---|---:|
| ukr_Cyrl | 488 | 22712 | 0 | 0 | deleted | 1109241856 |
| rus_Cyrl | 488 | 20482 | 0 | 0 | deleted | 1359740928 |
| bul_Cyrl | 488 | 20053 | 0 | 0 | deleted | 1380732928 |
| pol_Latn | 488 | 20268 | 0 | 0 | deleted | 1388576768 |
| ces_Latn | 488 | 20222 | 0 | 0 | deleted | 1388339200 |
| slk_Latn | 488 | 20221 | 0 | 0 | deleted | 1388896256 |
| eng_Latn | 488 | 19142 | 0 | 0 | deleted | 1379852288 |

Peak process RSS (whole run): 1390870528 bytes

## Interpretation limits

- FACT: qrels are MRC-derived (one relevant passage per question),
  never pooled IR judgments — see fetch-belebele.mjs's module header.
- FACT: only the local BGE-M3 provider was measured — no Qdrant Cloud
  E5/BM25 comparison in this run, by design.
- FACT: bel_Cyrl and srp_Latn are confirmed absent from Belebele/
  FLORES-200 and are not substituted or approximated anywhere here.
- This benchmark does not recommend changing production RRF_K or
  sparse-enablement defaults from this run alone.
