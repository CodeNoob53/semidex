# MIRACL Russian pooled-subset provider comparison

Verdict: **MIRACL_RU_HARNESS_ACCEPT**

This is a document-level retrieval-provider benchmark on a Russian
(Cyrillic) pooled subset of the official MIRACL dev split. MIRACL does
**not** include Ukrainian — this run is multilingual/Cyrillic evidence
only, never a Ukrainian-language validation and never a substitute for a
dedicated Ukrainian dataset.

## Provenance

- Commit: 50c11608d4458c9e3edf228b44ffc80cdc8aa691
- Working tree dirty: true
- MIRACL topics/qrels revision: 5be20db9509754dadad47689368639fcec739c00
- MIRACL corpus revision: d921ec7e349ce0d28daf30b2da9da5ee698bef0d
- Mini-set selection seed: `semidex-miracl-ru-pooled-subset-v1` (schema v1)
- Qdrant SDK: 1.18.0
- Requested ONNX execution provider: `dml`
  (performance provenance only; the configured provider list may allow operator-level CPU fallback).
- File hashes (SHA-256):
  - `/benchmarks/external/miracl/run-miracl.mjs`: 28d3d6b451d97aff055ee9d9531f3916b59cc728285fb0228f09c163bf62f21b
  - `/benchmarks/external/miracl/build-miracl-subset.mjs`: 0bc7778bcc1c44163393360c708cc31917b04a2cfd949278301abc09716af2c0
  - `/benchmarks/external/miracl/miracl-profiles.mjs`: b5d6434b440390be37fffb9913a062f7ac5fa36283daf3eae134a9b0cbf560a9
  - `/benchmarks/external/miracl/fetch-miracl.mjs`: 4f74261b3ec48d7ea2ee417df11fb74119190a1b99af299d9f1c25be5bb1f208
  - `/benchmarks/external/miracl/bootstrap.mjs`: 3267bf573cd223ba3702d7bba9aea44e7a1e72edfd9790c36cc81de1a5cef949
  - `/benchmarks/external/beir/harness-core.mjs`: 5f67ae1ab6916d34a0b002ec86faafa7463e62e2705852a6db231398d315bab5
  - `/benchmarks/external/beir/metrics.mjs`: 08a33cd14365755141689bfe34a4dada661f5ffd6c4ba907bcc242f501095bc6
  - `/benchmarks/external/beir/prepare-inputs.mjs`: 65e2498b0bdcf48ca72bb4ce5e480c13831a39b01719a9f03520ad8576a48c89
  - `/src/core/onnx-embed.js`: 2a2394c64ca91d457f80a5b8fa5108b32b98ff48ab136115c6b163dee7f40a68

## Subset construction

- Queries: 100 (SHA-256-seeded deterministic shuffle of all 1252
  Russian dev queries, canonical-sorted before shuffling — see build-miracl-subset.mjs).
- Positive passages: 289.
- Annotated negatives: 711 (MIRACL's own human-annotated
  non-relevant qrels rows, NOT retrieval-mined hard negatives — see README.md.
  Selected round-robin across the selected queries.)
- Total corpus: 1000 passages (requested 1000, shortfall 0).
- Dangling qrels references: 0.

## Retrieval quality

| Profile | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |
|---|---|---:|---:|---:|---:|---:|---:|
| local | dense | 0.8995 | 0.8385 | 0.9851 | 1.0000 | 0.2830 | 0.9163 |
| local | sparse | 0.7526 | 0.6794 | 0.8898 | 0.9817 | 0.2590 | 0.7466 |
| local | hybrid_k2 | 0.8460 | 0.7705 | 0.9802 | 1.0000 | 0.2810 | 0.8283 |
| local | hybrid_k60 | 0.8346 | 0.7602 | 0.9652 | 1.0000 | 0.2770 | 0.8278 |
| cloud | dense | 0.8420 | 0.7630 | 0.9802 | 1.0000 | 0.2810 | 0.8323 |
| cloud | sparse | 0.5696 | 0.4779 | 0.7373 | 0.8554 | 0.2150 | 0.5766 |
| cloud | hybrid_k2 | 0.7613 | 0.6703 | 0.9522 | 1.0000 | 0.2690 | 0.7213 |
| cloud | hybrid_k60 | 0.7130 | 0.6328 | 0.8604 | 1.0000 | 0.2470 | 0.7276 |

## Statistical comparisons (deterministic paired bootstrap)

Seed: `semidex-miracl-ru-bootstrap-v1`, iterations: 2000. A configuration is called
"better" only when the 95% CI excludes zero — otherwise MIXED/INCONCLUSIVE.

- **local_k2_vs_k60**: MIXED (meanΔ=-0.0115, CI95%=[-0.0323, 0.0065], W/L/T=8/17/75, n=100)
- **local_hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0534, CI95%=[-0.0779, -0.0282], W/L/T=15/43/42, n=100)
- **local_hybrid_k2_vs_sparse**: B_BETTER (meanΔ=0.0935, CI95%=[0.0629, 0.1293], W/L/T=58/5/37, n=100)
- **local_hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.0649, CI95%=[-0.0977, -0.0348], W/L/T=17/43/40, n=100)
- **local_hybrid_k60_vs_sparse**: B_BETTER (meanΔ=0.0820, CI95%=[0.0525, 0.1118], W/L/T=60/5/35, n=100)
- **cloud_k2_vs_k60**: A_BETTER (meanΔ=-0.0483, CI95%=[-0.0787, -0.0196], W/L/T=25/38/37, n=100)
- **cloud_hybrid_k2_vs_dense**: A_BETTER (meanΔ=-0.0806, CI95%=[-0.1140, -0.0470], W/L/T=18/60/22, n=100)
- **cloud_hybrid_k2_vs_sparse**: B_BETTER (meanΔ=0.1917, CI95%=[0.1537, 0.2288], W/L/T=73/7/20, n=100)
- **cloud_hybrid_k60_vs_dense**: A_BETTER (meanΔ=-0.1289, CI95%=[-0.1793, -0.0781], W/L/T=16/59/25, n=100)
- **cloud_hybrid_k60_vs_sparse**: B_BETTER (meanΔ=0.1434, CI95%=[0.1115, 0.1759], W/L/T=66/6/28, n=100)
- **local_vs_cloud_hybrid_k2**: A_BETTER (meanΔ=-0.0847, CI95%=[-0.1278, -0.0432], W/L/T=22/55/23, n=100)
- **local_vs_cloud_hybrid_k60**: A_BETTER (meanΔ=-0.1216, CI95%=[-0.1756, -0.0699], W/L/T=22/59/19, n=100)

## Operations

| Profile | Indexed | Index wall ms | Query errors | Retries | Cleanup |
|---|---:|---:|---:|---:|---|
| local | 1000 | 66127 | 0 | 0 | deleted |
| cloud | 1000 | 44492 | 0 | 0 | deleted |

Peak process RSS: 1187807232 bytes

## Interpretation limits

- FACT: values above are measured on a 1000-passage / 100-query pooled
  subset of the official MIRACL Russian dev split, not the full 9.5M-passage corpus.
- FACT: this validates non-English multilingual/Cyrillic retrieval only.
- FACT: MIRACL does not include Ukrainian. This result is never Ukrainian-
  language validation and Russian is never a substitute for a dedicated
  Ukrainian dataset.
- FACT: negatives are MIRACL's own human-annotated non-relevant passages,
  not retrieval-mined hard negatives (no official MIRACL baseline run file
  is available to mine from).
- No general Semidex-wide winner should be inferred from this benchmark alone.
