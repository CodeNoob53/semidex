# BEIR SciFact provider comparison

Verdict: **BEIR_SCIFACT_HARNESS_ACCEPT**

This is a document-level retrieval-provider benchmark, not an end-to-end RAG or chunking evaluation.

## Environment

- Dataset: 5183 documents, 300 queries.
- Input preparation: cache hit, wall 69 ms.
- Common-512 truncation: 742/5183 documents; 0/300 queries.
- Peak process RSS: 4921384960 bytes.

## Retrieval quality

| Run | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |
|---|---|---:|---:|---:|---:|---:|---:|
| local-common-512 | dense | 0.6380 | 0.5958 | 0.7718 | 0.9070 | 0.0867 | 0.6044 |
| local-common-512 | sparse | 0.6344 | 0.5921 | 0.7663 | 0.9036 | 0.0853 | 0.6008 |
| local-common-512 | hybrid_k60 | 0.6778 | 0.6423 | 0.7919 | 0.9303 | 0.0890 | 0.6508 |
| local-native | dense | 0.6422 | 0.5982 | 0.7801 | 0.9037 | 0.0877 | 0.6074 |
| local-native | sparse | 0.6363 | 0.5921 | 0.7721 | 0.9002 | 0.0863 | 0.6015 |
| local-native | hybrid_k60 | 0.6822 | 0.6445 | 0.8019 | 0.9370 | 0.0900 | 0.6536 |
| cloud-common-512 | dense | 0.6785 | 0.6371 | 0.8066 | 0.9243 | 0.0903 | 0.6472 |
| cloud-common-512 | sparse | 0.6585 | 0.6169 | 0.7890 | 0.8852 | 0.0870 | 0.6225 |
| cloud-common-512 | hybrid_k2 | 0.7078 | 0.6641 | 0.8459 | 0.9537 | 0.0943 | 0.6717 |
| cloud-common-512 | hybrid_k60 | 0.6977 | 0.6601 | 0.8209 | 0.9550 | 0.0923 | 0.6658 |
| cloud-native | dense | 0.6770 | 0.6351 | 0.8066 | 0.9250 | 0.0903 | 0.6451 |
| cloud-native | sparse | 0.6591 | 0.6176 | 0.7898 | 0.8826 | 0.0870 | 0.6233 |
| cloud-native | hybrid_k2 | 0.7088 | 0.6682 | 0.8391 | 0.9577 | 0.0937 | 0.6746 |
| cloud-native | hybrid_k60 | 0.6967 | 0.6588 | 0.8212 | 0.9583 | 0.0923 | 0.6635 |

## Operations

| Run | Indexed | Index wall ms | Query errors | Retries | Cleanup |
|---|---:|---:|---:|---:|---|
| local-common-512 | 5183 | 5572550 | 0 | 0 | deleted |
| local-native | 5183 | 5677802 | 0 | 1 | deleted |
| cloud-common-512 | 5183 | 277614 | 0 | 0 | deleted |
| cloud-native | 5183 | 302840 | 0 | 0 | deleted |

## Interpretation limits

- FACT: values above are measured on the official English SciFact test split.
- FACT: common-512 uses one provider-neutral body; E5 prefixes only its dense lane, while BM25 receives raw text.
- HYPOTHESIS: multilingual and Ukrainian quality must be tested separately on MIRACL or another external multilingual dataset.
- No general Semidex-wide winner should be inferred from this benchmark alone.
