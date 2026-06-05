# ONNX Tag Model Shootout

**Date:** 2026-06-05  
**Fixture:** `benchmarks/retrieval/fixtures/combined-live`  
**Probe:** 14 representative chunks, CPU, `@huggingface/transformers`, `dtype=q4`, deterministic generation  
**Prompt contract:** 3-6 concise lowercase hyphenated tags, comma-separated, no explanation

## Summary

| Model | Mean ms/chunk | Non-empty | Count OK | Bad tags | Notes |
|---|---:|---:|---:|---:|---|
| `onnx-community/Qwen2.5-0.5B-Instruct` | 1654 | 14/14 | 14/14 | 0 | Fast enough, but raw output contains garbled tags such as `onnxyebedging` and `ollamocastra` |
| `HuggingFaceTB/SmolLM2-360M-Instruct` | 1698 | 13/14 | 11/14 | 1 | Often emits numbered lists and sometimes repeats instruction text |
| `onnx-community/Qwen2.5-Coder-0.5B-Instruct` | **1221** | 14/14 | 12/14 | 0 | Best practical candidate: fastest and strongest technical identifier handling |
| `onnx-community/Qwen2.5-1.5B-Instruct` | 5258 | 14/14 | 14/14 | 0 | Better formatted than baseline, but too slow for the CPU tag lane; still has odd terms like `chuckling` |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` | 6312 | 14/14 | 14/14 | 1 | Too slow and still produces generic/odd tags like `ai-agnent` and over-specific generated phrases |

## Live Indexing Check

`Qwen2.5-Coder-0.5B-Instruct` was also run through the full indexing benchmark.
Observed wall-clock depends heavily on Ollama warm state:

| Run | Ollama tags | ONNX Coder tags | Files | Chunks | Fill rate |
|---|---:|---:|---:|---:|---:|
| Cold-ish / slower Ollama run | 88.0s | **48.9s** | 5 | 24 | 100% |
| Warm Ollama run | **41.8s** | 47.4s | 5 | 24 | 100% |

ONNX Coder is stable around 47-49s on this fixture. Ollama tag speed varies more
with model warm-up and runtime state.

Reports:

- `benchmarks/retrieval/results/2026-06-05-02-39-44-onnx-tag-provider-indexing-bench.md`
- `benchmarks/retrieval/results/2026-06-05-02-43-59-onnx-tag-provider-indexing-bench.md`

## Decision

**Prefer `onnx-community/Qwen2.5-Coder-0.5B-Instruct` as the current ONNX tag-model candidate.**

Keep `TAG_PROVIDER=onnx` opt-in. This is not proven as a universal speed default:
it is useful when a separate CPU tag lane improves resource utilisation or avoids
Ollama model-swap pressure, but warm Ollama tagging can be faster on small runs.

Rationale:

- It is faster than the current `Qwen2.5-0.5B-Instruct` ONNX baseline.
- It preserves technical identifiers better (`ONNX_EMBED`, `QDRANT_URL`, `qdrant_search`, etc.).
- It avoids the baseline model's obvious garbled tags in the inspected sample.
- Heavier 1.5B/1.7B models are not good enough to justify a 4-5x per-chunk slowdown.

## Implementation Notes

During the shootout, the ONNX tag parser was tightened:

- trim leading/trailing hyphens;
- collapse repeated hyphens;
- dedupe tags;
- cap output to 6 tags;
- split common model separators such as `#` and spaced `/`.

This is a parser contract fix, not a model-specific tuning rule.

## Caveats

- This is a tag quality and indexing-speed probe, not a retrieval benchmark.
- Tags are payload metadata and do not affect default hybrid retrieval.
- `TAG_PROVIDER=onnx` should remain opt-in until tested on a larger mixed-language corpus and profiled across cold/warm Ollama states.
