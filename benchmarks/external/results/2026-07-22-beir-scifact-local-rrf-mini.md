# Local RRF fusion-constant mini sensitivity check (k=2 vs k=60)

Verdict: **LOCAL_RRF_MINI_K2_BETTER**

This is a small, LOCAL-ONLY, deterministic SciFact pooled subset — not the
full BEIR SciFact benchmark and not a change to the production `RRF_K`
default. It exists only to check whether the RRF fusion constant matters
for the current local BGE-M3 dense+sparse provider before touching
production defaults.

## Provenance

- Commit: 53eb2c89b9a66ce8d04ae26a30413d4674bfc0bb
- SciFact dataset MD5: 5f7d1de60b170fc8027bb7898e2efca1
- Hard-negative source .runs\local-common-512-dense.trec: sha256 76e522f620a565becf163a7752033a686ca2f77c1057fb94e92349ed3e42c8c4
- Hard-negative source .runs\local-common-512-sparse.trec: sha256 9b0b495ae06e5cc4bc181a72e7324710c716431506dadccffeb28b4decb52e6a
- Mini-set selection seed: `semidex-beir-scifact-rrf-mini-v1` (schema v2)
- Local dense model: aapot/bge-m3-onnx (size 1024), sparse: bge-m3-onnx-lexical
- Qdrant SDK: 1.18.0
- Index batch size: 24

## Mini-set construction

- Queries: 100 (SHA-256-seeded deterministic shuffle of all 300 test
  queries, not a lexicographic-order slice — see build-rrf-mini-set.mjs).
- Relevant documents: 108 (union of qrels for the selected queries).
- Hard negatives: 892 (round-robin from existing local-common-512 dense/sparse TREC runs).
- Total corpus: 1000 documents (requested 1000, shortfall 0).
- Dangling qrels references: 0.

## Retrieval quality (local BGE-M3, common-512)

| Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| dense | 0.6748 | 0.6285 | 0.8260 | 0.9600 | 0.6324 |
| sparse | 0.6836 | 0.6478 | 0.7980 | 0.9480 | 0.6573 |
| hybrid_k2 | 0.6976 | 0.6662 | 0.8005 | 0.9580 | 0.6747 |
| hybrid_k60 | 0.6931 | 0.6552 | 0.8155 | 0.9580 | 0.6635 |

### k=2 -> k=60 delta (positive = k=60 better)

| Metric | k=2 | k=60 | delta |
|---|---:|---:|---:|
| nDCG@10 | 0.6976 | 0.6931 | -0.0045 |
| MAP@100 | 0.6662 | 0.6552 | -0.0110 |
| Recall@10 | 0.8005 | 0.8155 | +0.0150 |
| Recall@100 | 0.9580 | 0.9580 | +0.0000 |
| MRR@10 | 0.6747 | 0.6635 | -0.0112 |

## Operations

- Indexed: 1000 / 1000
- Indexing wall time: 1090273 ms
- Query errors: 0, retries: 0
- hybrid_k2 latency ms: p50=54 p95=65 max=68
- hybrid_k60 latency ms: p50=56 p95=65 max=167
- Peak process RSS: 3272798208 bytes
- Cleanup: deleted

## Interpretation limits

- FACT: values above are measured on a 1000-document / 100-query pooled
  subset of the official English SciFact test split, not the full corpus.
- FACT: this checks fusion-constant sensitivity only for the current local
  BGE-M3 provider — it says nothing about the Qdrant Cloud profile.
- HYPOTHESIS: any k preference seen here is not verified against the full
  5183-document corpus or against multilingual/Ukrainian content.
- The production `RRF_K` default is intentionally left unchanged by this
  script; any default change is a separate, explicit decision.
