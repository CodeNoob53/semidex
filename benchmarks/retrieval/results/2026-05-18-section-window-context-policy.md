# Section/Window-Aware Context Policy Benchmark — custom-50 — 2026-05-18

## Setup

| Item | Value |
|------|-------|
| Model | qwen2.5:3b-instruct |
| COMBINED_LLM | 1 |
| ONNX_EMBED | 1 |
| Corpus | custom-50 (10 files) |
| Queries | 50 |
| Top-K | 10 |

## Prompt Variants

### A: current-minimal (production default)

```
You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags
Output ONLY valid JSON. File/Section/Chunk metadata provided.
```

### B: identifier-preserving

```
Same as A, plus:
- Preserve exact identifiers verbatim: env vars, function names, file paths, CLI flags,
  error strings, config keys, model names, IDs, numbers.
- Do not paraphrase technical terms.
- Help retrieve this exact chunk — write context a user would search for.
- Do not summarize the whole document. Do not invent scope.
```

### C: section-window-aware

```
Same identifier rules as B, plus:
- Receives previous chunk (last 200 chars) and next chunk (first 200 chars) as context window.
- Context must be specific to this chunk, not the whole document.
- Target 40-90 tokens.
- Do not include tags in the context field.
```

## Indexing

| Policy | Wall time | Fallbacks | Points |
|--------|-----------|-----------|--------|
| current-minimal | 173618 ms | 0 | 101 |
| identifier-preserving | 140978 ms | 0 | 101 |
| section-window-aware | 158630 ms | 0 | 101 |

## Aggregate Metrics

| Metric | current-minimal | identifier-preserving | Δ(B-A) | section-window-aware | Δ(C-A) |
|--------|----------------|----------------------|--------|---------------------|--------|
| chunkRecall@3 | 81.6% | 87.8% | +6.1 pp | 85.7% | +4.1 pp |
| chunkRecall@5 | 89.8% | 89.8% | — | 89.8% | — |
| chunkRecall@10 | 98.0% | 95.9% | -2.0 pp | 93.9% | -4.1 pp |
| windowRecall@5 | 98.0% | 98.0% | — | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — | 98.0% | — |
| supportRecall@10 | 98.0% | 98.0% | — | 98.0% | — |
| nDCG@10 | 0.732 | 0.764 | +0.032 | 0.733 | +0.001 |
| MRR@10 | 0.683 | 0.733 | +0.049 | 0.703 | +0.020 |
| negativePass | 100.0% | 100.0% | — | 100.0% | — |
| fallbacks | 0 | 0 | — | 0 | — |
| wall time | 173618 ms | 140978 ms | — | 158630 ms | — |

## Per-Query Changes vs current-minimal

### vs identifier-preserving

14 queries changed (0 recall gained, 0 recall lost).

| ID | type | base MRR | policy MRR | ΔMRR | base cr@5 | policy cr@5 | change |
|----|------|----------|------------|------|-----------|-------------|--------|
| c01 | exact-token | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c02 | conceptual | 0.100 | 0.000 | -0.100 | ✗ | ✗ | regressed |
| c03 | provider-activation | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c05 | conceptual | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c15 | config-env | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c20 | config-env | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c28 | exact-token | 0.200 | 1.000 | +0.800 | ✓ | ✓ | improved |
| c35 | source-navigation | 0.250 | 1.000 | +0.750 | ✓ | ✓ | improved |
| c36 | source-navigation | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c37 | source-navigation | 0.333 | 1.000 | +0.667 | ✓ | ✓ | improved |
| c39 | exact-token | 0.250 | 0.500 | +0.250 | ✓ | ✓ | improved |
| c41 | conceptual | 0.125 | 0.167 | +0.042 | ✗ | ✗ | improved |
| c43 | config-env | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |

### vs section-window-aware

17 queries changed (0 recall gained, 0 recall lost).

| ID | type | base MRR | policy MRR | ΔMRR | base cr@5 | policy cr@5 | change |
|----|------|----------|------------|------|-----------|-------------|--------|
| c02 | conceptual | 0.100 | 0.000 | -0.100 | ✗ | ✗ | regressed |
| c04 | exact-token | 0.167 | 0.000 | -0.167 | ✗ | ✗ | regressed |
| c05 | conceptual | 0.500 | 0.333 | -0.167 | ✓ | ✓ | regressed |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c13 | exact-token | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c15 | config-env | 0.500 | 0.250 | -0.250 | ✓ | ✓ | regressed |
| c21 | conceptual | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c28 | exact-token | 0.200 | 0.333 | +0.133 | ✓ | ✓ | improved |
| c30 | exact-token | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |
| c32 | config-env | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c33 | conceptual | 0.500 | 1.000 | +0.500 | ✓ | ✓ | improved |
| c35 | source-navigation | 0.250 | 1.000 | +0.750 | ✓ | ✓ | improved |
| c36 | source-navigation | 1.000 | 0.333 | -0.667 | ✓ | ✓ | regressed |
| c37 | source-navigation | 0.333 | 1.000 | +0.667 | ✓ | ✓ | improved |
| c39 | exact-token | 0.250 | 0.500 | +0.250 | ✓ | ✓ | improved |
| c41 | conceptual | 0.125 | 0.143 | +0.018 | ✗ | ✗ | improved |
| c45 | config-env | 1.000 | 0.500 | -0.500 | ✓ | ✓ | regressed |

## Verdict

Hard gate: policy with more hard misses, lower chunkRecall@5, or chunkRecall@10 drop >2 pp vs current-minimal is not promotable.

| Policy | Hard misses | chunkRecall@5 | chunkRecall@10 | MRR@10 | Verdict |
|--------|-------------|---------------|----------------|--------|---------|
| current-minimal | 5 | 89.8% | 98.0% | 0.683 | baseline |
| identifier-preserving | 5 | 89.8% | 95.9% | 0.733 | PROMISING — MRR +0.049, nDCG +0.032, chunkRecall@10 -2.0 pp (needs second run to confirm) |
| section-window-aware | 5 | 89.8% | 93.9% | 0.703 | DEFER — chunkRecall@10 -4.1 pp, exact-token regressions (c04, c12, c30); MRR gain does not offset recall risk |

---

*Generated: 2026-05-18 — model: qwen2.5:3b-instruct — stamp: 1779115859093*
