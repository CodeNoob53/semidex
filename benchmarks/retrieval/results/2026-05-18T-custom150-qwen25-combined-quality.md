# qwen2.5:3b-instruct COMBINED_LLM custom-150

| Item | Value |
|------|-------|
| Collection | bench-c150-qwen-combined-1779105231871 |
| Queries | 75 (72 positive, 3 negative) |
| Search | hybrid top-10 |

| Metric | Value |
|--------|-------|
| chunkRecall@3 | 61.1% |
| chunkRecall@5 | 63.9% |
| chunkRecall@10 | 76.4% |
| windowRecall@5 | 88.9% |
| windowRecall@10 | 95.8% |
| supportRecall@10 | 81.9% |
| nDCG@10 | 0.581 |
| MRR@10 | 0.544 |
| negativePass | 100.0% |

## Misses

| ID | type | MRR | nDCG | top1 |
|----|------|-----|------|------|
| c150-001 | exact-token | 0.000 | 0.000 | qdrant.md#6 |
| c150-002 | exact-token | 0.000 | 0.000 | config-env.md#5 |
| c150-003 | exact-token | 0.000 | 0.000 | mcp-workflow.md#7 |
| c150-004 | exact-token | 0.000 | 0.000 | mcp-workflow.md#6 |
| c150-005 | config-env | 0.000 | 0.000 | config-env.md#9 |
| c150-006 | config-env | 0.000 | 0.000 | multilingual.md#8 |
| c150-007 | config-env | 0.000 | 0.000 | qdrant.md#3 |
| c150-008 | config-env | 0.000 | 0.000 | config-env.md#11 |
| c150-012 | source-navigation | 0.111 | 0.382 | project-structure.md#8 |
| c150-013 | source-navigation | 0.000 | 0.000 | project-structure.md#4 |
| c150-014 | source-navigation | 0.125 | 0.248 | qdrant.md#2 |
| c150-015 | source-navigation | 0.000 | 0.000 | project-structure.md#9 |
| c150-016 | conceptual | 0.100 | 0.334 | chunking.md#4 |
| c150-018 | conceptual | 0.000 | 0.145 | obsidian.md#3 |
| c150-020 | conceptual | 0.000 | 0.145 | providers.md#3 |
| c150-021 | troubleshooting | 0.100 | 0.228 | multilingual.md#2 |
| c150-022 | troubleshooting | 0.000 | 0.000 | benchmarking.md#23 |
| c150-023 | troubleshooting | 0.000 | 0.000 | chunking.md#4 |
| c150-024 | cross-lingual-ua-en | 0.167 | 0.387 | providers.md#2 |
| c150-026 | cross-lingual-ua-en | 0.000 | 0.000 | multilingual.md#9 |
| c150-027 | cross-lingual-ua-en | 0.000 | 0.131 | multilingual.md#2 |
| c150-028 | english | 0.000 | 0.213 | mcp-workflow.md#8 |
| c150-029 | english | 0.111 | 0.406 | obsidian.md#4 |
| c150-051 | source-navigation | 0.125 | 0.361 | qdrant.md#4 |
| c150-057 | troubleshooting | 0.167 | 0.426 | sync.md#4 |
| c150-071 | english | 0.167 | 0.493 | config-env.md#8 |
