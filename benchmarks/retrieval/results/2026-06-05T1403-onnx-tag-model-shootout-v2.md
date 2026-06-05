# ONNX Tag Model Shootout v2 — Non-Qwen Candidates

**Date:** 2026-06-05T14:03  
**Task:** Isolated quality + speed — not a pipeline benchmark  
**Fixture:** `benchmarks/retrieval/fixtures/combined-live` (20 chunks, 5 files)  
**Prompt:** Plain user prompt, single-turn (no system role)  
**Decoding:** `max_new_tokens=28`, `repetition_penalty=1.3`, `do_sample=false`, `dtype=q4`  
**Runtime:** Node v25.2.1 / @huggingface/transformers 4.2.0 / onnxruntime-node (CPU)  
**Models loaded from local cache** (`allowRemoteModels=false`)  
**Granite-3.0-2B:** not tested — not in local cache; skipped per task constraints

## Model / cache setup

| Model | HF id | Size (dir) | Cached |
|---|---|---:|---|
| Gemma-3-270M | `onnx-community/gemma-3-270m-it-ONNX` | 328 MB | yes |
| Gemma-3-1B | `onnx-community/gemma-3-1b-it-ONNX` | 840 MB | yes |
| SmolLM2-1.7B | `HuggingFaceTB/SmolLM2-1.7B-Instruct` | 1.4 GB | yes |

Note: Gemma model_q4.onnx is a stub (~300KB); main weights are in model_q4.onnx_data.

## Timing results

| Model | Load | Warmup | avg/chunk | p50 | p95 | Speed vs Qwen-1.5B |
|---|---:|---:|---:|---:|---:|---:|
| Gemma-3-270M | 1 341 ms | 350 ms | **1 170 ms** | 1 179 ms | 1 237 ms | **3.6× faster** |
| Gemma-3-1B | 2 488 ms | 1 099 ms | 3 553 ms | 3 523 ms | 3 822 ms | 1.2× faster |
| SmolLM2-1.7B | 3 205 ms | 1 089 ms | 1 426 ms | 1 096 ms | 2 268 ms | **3.0× faster** |
| *Qwen-1.5B (R2 ref)* | *2 216 ms* | *959 ms* | *4 272 ms* | *4 177 ms* | *4 957 ms* | *1×* |
| *Qwen-0.5B (R2 ref)* | *1 046 ms* | *326 ms* | *1 379 ms* | *1 385 ms* | *1 552 ms* | *3.1× faster* |

## Quality metrics

| Model | Fill | Valid 3-6 | Leakage | Repetition | ID hit rate |
|---|---:|---:|---:|---:|---:|
| Gemma-3-270M | 11/20 | 2/20 | **0/20** | 6/20 | **0/31** |
| Gemma-3-1B | 9/20 | 3/20 | 2/20 | 1/20 | **0/31** |
| SmolLM2-1.7B | **1/20** | 1/20 | **0/20** | **0/20** | 2/31 |
| *Qwen-1.5B (R2 ref)* | *19/20* | *15/20* | *9/20* | *0/20* | *18/31* |
| *Qwen-0.5B (R2 ref)* | *20/20* | *16/20* | *9/20* | *0/20* | *3/31* |

## Quality table — representative outputs

### Gemma-3-270M

| Chunk | Expected IDs | Raw output | Assessment |
|---|---|---|---|
| C01 | `ONNX_EMBED`, `bge-m3-onnx` | `# # # # # # # #...` | garbage — markdown hash symbols |
| C04 | `QDRANT_URL`, `QDRANT_KEY` | `# # Tags # # Tags # # Tags` | garbage repetition |
| C05 | `MAX_CHUNK_TOKENS`... | `"Keywords", "Hashesels", Tags".` | hallucinated words (`Hashesels`) |
| C13 | — | `tags_are_stored_in_payload # # tags_are_used_for_tag_filter` | echoes chunk text as tag names |
| C20 (UA) | `COMBINED_LLM`... | `[GMAREFT] Приклад того, що [GAMAREF]` | hallucinated bracketed refs |
| C18 (UA) | — | `# # # # # # # # # # # # # #` | pure garbage on Ukrainian input |

**Pattern:** Complete failure of instruction-following. Model has not learned the tag-generation format. Outputs markdown syntax (`#`), invented words, and echoes its own partial training on tagging.

### Gemma-3-1B

| Chunk | Expected IDs | Raw output | Assessment |
|---|---|---|---|
| C01 | `ONNX_EMBED`, `bge-m3-onnx` | `Output all possible tag combinations in a single string of commas` | instruction paraphrase, no tags |
| C03 | `CONTEXT_MODEL`, `TAG_MODEL` | `` `TANGES_5`: Controls what tag generation process `` | hallucinated identifier `TANGES_5` |
| C05 | `MAX_CHUNK_TOKENS`... | `` `RUN_BATCHED_COUNT` default is 1 `` | hallucinated identifier `RUN_BATCHED_COUNT` |
| C17 | `npm run doctor`... | ` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` `` | pure code fence repetition |
| C18 (UA) | — | `a - означає "AI" агент. l - означає "пошук"` | attempts Ukrainian acronym expansion instead of tags |
| C04 | `QDRANT_URL`, `QDRANT_KEY` | `` `TENDEXT` is required in all cases `` | hallucinated `TENDEXT` — not in chunk |

**Pattern:** Model generates plausible-sounding but completely hallucinated identifier names (`TANGES_5`, `TENDEXT`, `RUN_BATCHED_COUNT`). Particularly dangerous for a tagger — worse than empty output because downstream search would trust these fake env vars. Ukrainian triggers Ukrainian prose response, not tags.

### SmolLM2-1.7B

| Chunk | Expected IDs | Raw output | Assessment |
|---|---|---|---|
| C01 | `ONNX_EMBED`, `bge-m3-onnx` | *(empty string)* | complete silence |
| C03 | `CONTEXT_MODEL`, `TAG_MODEL` | `CONTEXT_MODEL = gemma2; TAG_MODEL = georgia tech emily llm` | partially correct ID names, but hallucinated values and wrong format |
| C04–C17 (most) | various | *(empty string)* | 19/20 chunks → empty output |
| C18 (UA) | — | *(empty string)* | silent on Ukrainian |
| C19 (UA) | — | *(empty string)* | silent on Ukrainian |

**Pattern:** Model consistently refuses to generate output. One exception (C03): picked up `CONTEXT_MODEL` and `TAG_MODEL` names but appended hallucinated values. This suggests the model requires chat-template prompt formatting — plain completion prompt is not supported at this size.

## Failure patterns per model

### Gemma-3-270M

- **Hash symbol flood:** 8/20 chunks output chains of `# # # # #` — model's confusion between markdown heading syntax and tag syntax
- **Repetition despite `repetition_penalty=1.3`:** `#tags #tags #tags #tags` (C15) — penalty insufficient for this failure mode
- **Echo-as-tag:** Copies fragment from chunk as underscore-joined tag string (C13: `tags_are_stored_in_payload`)
- **Invented words:** `Hashesels`, `Onex Tags` — portmanteau hallucinations
- **Ukrainian total failure:** Outputs hash symbols or Cyrillic bracket notation `[GMAREFT]`
- **Root cause:** 270M is too small for the instruction-following required. The q4 quantization compounds the problem — the model is likely operating near its capacity floor

### Gemma-3-1B

- **Instruction paraphrase instead of tags:** "Output all possible tag combinations in a single string" — model describes the task instead of doing it
- **Identifier hallucination (dangerous):** `TANGES_5`, `TENDEXT`, `RUN_BATCHED_COUNT` — sounds plausible, completely invented
- **Code fence loops:** C17 outputs 14× ` ``` ` in a row despite `repetition_penalty=1.3`
- **Ukrainian becomes Ukrainian prose:** C18/C19/C20 trigger Ukrainian explanation responses, not English tags
- **Zero identifier preservation:** 0/31 despite being larger than Gemma-270M
- **Root cause:** Model is instruction-tuned but not for structured short-form extraction. The 1B Gemma variant was likely trained with a different chat template and may need `messages=[{role:...}]` format to activate proper instruction-following

### SmolLM2-1.7B

- **Near-total silence:** 19/20 → empty string. The model generates the EOS token immediately
- **Plain prompt incompatibility:** SmolLM2 was trained with a specific chat template; plain completion prompt causes immediate EOS
- **One partial output (C03):** `CONTEXT_MODEL = gemma2; TAG_MODEL = georgia tech emily llm; CODEGENERATION...` — got the identifier names right but appended hallucinated `= value` pairs and wrong identifiers
- **Root cause:** This model requires the `apply_chat_template` / messages format. Plain text prompt → model treats it as already-completed input and emits EOS

## Ranking

### Fastest acceptable
**None of the three candidates** produced acceptable output. Gemma-3-270M is fastest (1170ms/chunk, 3.6× faster than Qwen-1.5B) but its output quality is entirely unusable.

### Best multilingual
**None.** Gemma-3-1B produces Ukrainian prose (not tags) on Ukrainian input. Gemma-270M produces hashes. SmolLM2 is silent. Qwen-1.5B (R2) handles Ukrainian at least partially.

### Best technical identifiers
**SmolLM2-1.7B** — 2/31, barely above zero, but the one hit (C03: `CONTEXT_MODEL`, `TAG_MODEL`) was exact-case correct. Gemma models: 0/31.

### Best overall candidate from this batch
**None qualify.** All three fail the minimum bar of producing coherent tags on at least 50% of chunks.

**Qwen-1.5B-Instruct remains the best candidate tested** with 18/31 identifier hits and 15/20 valid parsed tags (post-trim).

## Root cause summary

| Model | Root cause of failure |
|---|---|
| Gemma-3-270M | Too small for instruction-following at q4; markdown/hash confusion |
| Gemma-3-1B | Trained for different chat format; hallucinates plausible-but-wrong identifiers |
| SmolLM2-1.7B | Requires `messages=[...]` chat template; plain prompt → immediate EOS |

## Recommendation for next local test

**SmolLM2-1.7B with chat-template prompt** is the only candidate worth retesting. It demonstrated identifier awareness (C03) and its silence on other chunks is a format problem, not a capability problem. Estimated fix:

```js
// Instead of plain string prompt:
const messages = [
  { role: 'system', content: 'Generate 3-6 concise comma-separated tags. Lowercase, hyphenated. Preserve exact technical identifiers. No explanation.' },
  { role: 'user',   content: `Chunk:\n${chunk.text}` },
];
const out = await gen(messages, { max_new_tokens: 28, repetition_penalty: 1.3, do_sample: false });
```

Gemma-3-1B may also benefit from chat-template, but its identifier hallucination pattern (`TANGES_5`, `TENDEXT`) is a deeper problem not solvable by prompt format alone — not recommended for retry.

Gemma-3-270M: below minimum viable size — do not retry.

**Granite-3.0-2B** (not tested, not cached) remains an open question. If SmolLM2 chat-template retry also fails, Granite should be downloaded and tested.

## Acceptance criteria

- [x] No production code changes
- [x] No production defaults changed
- [x] No docs rewritten except this report
- [x] Probe script stays in `.tmp/` (not tracked)
- [x] No Qdrant collections created
- [x] `git diff --check` passes
