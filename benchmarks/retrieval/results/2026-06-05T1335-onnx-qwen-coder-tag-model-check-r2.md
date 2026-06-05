# ONNX Tag Model Check — Round 2 (fixed decoding params)

**Date:** 2026-06-05T13:35  
**Follows:** `2026-06-05T1312-onnx-qwen-coder-1_5b-tag-model-check.md`  
**Task:** Isolated quality + speed — not a pipeline benchmark  
**Fixture:** `benchmarks/retrieval/fixtures/combined-live` (20 chunks, 5 files)  
**Prompt:** Plain user prompt, single-turn (no system role)  
**Decoding:** `max_new_tokens=28`, `repetition_penalty=1.3`, `do_sample=false`  
**Runtime:** Node v25.2.1 / @huggingface/transformers 4.2.0 / onnxruntime-node (CPU)  
**Models:** both loaded from local cache (`allowRemoteModels=false`)

## Summary

| Metric | 0.5B | 1.5B |
|---|---:|---:|
| Warm-cache load | 1 046 ms | 2 216 ms |
| Warmup | 326 ms | 959 ms |
| avg ms/chunk | 1 379 ms | 4 272 ms |
| p50 ms/chunk | 1 385 ms | 4 177 ms |
| p95 ms/chunk | 1 552 ms | 4 957 ms |
| Speed ratio | **1×** | **3.1× slower** |
| Fill rate | 20/20 | 19/20 |
| Valid 3–6 tags (parsed) | 16/20 | 15/20 |
| Instruction leakage (raw) | 9/20 | 9/20 |
| Repetition (raw) | **0/20** | **0/20** |
| Identifier hit rate (raw) | **3/31** | **18/31** |

`repetition_penalty=1.3` eliminated all repetition loops — confirmed in both models.  
`max_new_tokens=28` cut per-chunk time: 0.5B 2468→1379ms (−44%), 1.5B 6550→4272ms (−35%).

## Speed regression note

Round 1 used `max_new_tokens=48`. Round 2 uses `28`.  
Speed ratio 1.5B/0.5B went from 2.65× to **3.1×** — larger model scales worse with token budget.  
This is expected: autoregressive decode cost is linear in tokens generated.

## Quality findings

### Identifier preservation — decisive win for 1.5B

Raw identifier hit rate: **18/31** (58%) vs **3/31** (10%).

| Chunk | Expected | 0.5B found | 1.5B found |
|---|---|---|---|
| C01 | `ONNX_EMBED`, `bge-m3-onnx` | — | `ONNX_EMBED` |
| C02 | `ONNX_EMBED`, `bge-m3` | — | `ONNX_EMBED` |
| C03 | `CONTEXT_MODEL`, `TAG_MODEL`, `COMBINED_LLM` | — | `CONTEXT_MODEL`, `TAG_MODEL` |
| C04 | `QDRANT_URL`, `QDRANT_KEY` | — | `QDRANT_URL`, `QDRANT_KEY` ✓ |
| C05 | `MAX_CHUNK_TOKENS`, `MIN_CHUNK_TOKENS`, `LLM_BATCH_SIZE`, `OVERLAP_SENTENCES` | — | all four ✓ |
| C07 | `chunkIndex`, `source_file` | — | `source_file` |
| C08 | `bge-m3-onnx`, `bge-m3` | `bge-m3` | — |
| C12 | `COMBINED_MIN_CHARS`, `CONTEXT_MODEL` | — | both ✓ |
| C14 | `ONNX_EMBED`, `npm run index` | — | `ONNX_EMBED` |
| C15 | `SHA-256` | — | — |
| C16 | `PRUNE_STALE`, `ONNX_EMBED`, `npm run index` | `ONNX_EMBED` | `PRUNE_STALE`, `ONNX_EMBED` |
| C17 | `npm run doctor`, `COMBINED_LLM`, `TAG_MODEL` | — | — |
| C20 | `COMBINED_LLM`, `TAG_MODEL`, `CONTEXT_MODEL` | `COMBINED_LLM` | `COMBINED_LLM`, `CONTEXT_MODEL` |

**C05 is the strongest signal:** 1.5B outputs all four env vars verbatim (`MAX_CHUNK_TOKENS, MIN_CHUNK_TOKENS, OVERLAP_SENTENCES, LLM_BATCH_SIZE`) — raw output is immediately usable as-is. 0.5B produces `model_name`, `max_tokens` — wrong identifiers.

### Leakage — tie (9/20 each), different patterns

Both models still leak at same rate, but differently:

**0.5B leakage patterns:**
- Starts numbered lists: `1) env_var 2) cli_flag` — generic placeholders, not from chunk
- Falls into code generation: ` ```python import torch def load_model()` — completely wrong modality
- Hallucinates `semidisect`, `indexerserver`, `mcpserver` (C06) — invented compound words
- Short chunk "Hi." (C11) → `1) env_var 2) cli_flag 3) model_name` — generic template output regardless of input

**1.5B leakage patterns:**
- Appends `Explanation:` / `Explanation of each tag:` after valid tags — structural, trimable
- Starts JSON blocks after tags: `{"tags": [...]}` — then truncates mid-JSON
- C11 ("Hi.") → starts generating a new fictional chunk: `Chunk: This is a test environment variable named TEST_VAR` — more coherent but wrong

**Key difference:** 1.5B leakage follows valid tags — trim at first `\n\nExplanation` recovers good output. 0.5B leakage often *replaces* valid tags with generic placeholders.

### Format differences

| Pattern | 0.5B | 1.5B |
|---|---|---|
| Comma-separated on one line | 3/20 | 8/20 |
| Numbered list `1) ... 2)` | 6/20 | 0/20 |
| Code block ` ``` ` | 5/20 | 4/20 |
| Backtick-wrapped tags | 1/20 (C14) | 0/20 |
| Mixed (tags then leak) | 5/20 | 8/20 |

1.5B is closer to the target format (comma-separated) in 8/20 cases vs 3/20 for 0.5B.

### Ukrainian text (C18–C20)

Both models handle Ukrainian as trigger but respond in English tags — acceptable.  
1.5B C20: outputs `COMBINED_LLM, INDEXER, ONE_LLMS_CALL_PER_CHUNK, CONTEXT_MODEL` — invents `ONE_LLMS_CALL_PER_CHUNK` but captures `COMBINED_LLM` and `CONTEXT_MODEL` correctly.  
0.5B C20: generates Python code checking `COMBined_LLM` — completely wrong.

### Garbage / hallucination examples

| Source | 0.5B | 1.5B |
|---|---|---|
| C06 (semidex arch) | `semidisect`, `indexerserver` | `two_runtime_entry_points` (verbose but correct) |
| C11 ("Hi.") | `env_var`, `cli_flag`, `model_name` | generates fictional chunk content |
| C15 (SHA-256) | Python hashlib code | `sha_256_hash` (correct but underscore form) |
| C17 (npm doctor) | `Doctor - Command-line tool used by developers` | `check-qdrant-connectivity`, `ollama-reachability` |
| C19 (Ukrainian deps) | Docker compose command | `gemmaversion`, `bgemversion` (mangled model names) |

## Leakage trimming potential

1.5B leakage is structurally recoverable. Adding a post-process trim in `parseTags()`:

```js
// trim everything after first blank line or "Explanation"
const cleanRaw = raw.split(/\n\n|Explanation/i)[0].trim();
```

Applied to round-2 1.5B output, estimated improvement: leakage 9→3/20, valid 3-6 tags 15→17/20.  
0.5B leakage is not recoverable this way — it starts with generic placeholders before any real content.

## Recommendation

**Use 1.5B as the target model for tag generation.**

Rationale:
- Identifier hit rate 18/31 vs 3/31 — 6× better preservation of the exact names that matter for `qdrant_find_by_tag`
- Leakage pattern is structurally recoverable (appears after valid tags)
- Format closer to target (8/20 clean comma-separated vs 3/20)
- Speed cost (3.1×) is acceptable given context: tags run in parallel ONNX CPU lane while GPU runs Ollama context — the extra ~3s is hidden under Ollama latency

**Required before production use:**

1. Add leakage trimmer in `parseTags` in `tag-onnx-worker.js`:
   ```js
   raw.split(/\n\n|\bExplanation\b/i)[0]
   ```

2. Add `repetition_penalty: 1.3` to worker inference call (already validated here)

3. Reduce `max_new_tokens` from current 48 → 28 (already validated here, −35% speed)

4. Set `TAG_ONNX_MODEL` default to `onnx-community/Qwen2.5-Coder-1.5B-Instruct` in `tag-onnx.js`

**Keep 0.5B available via `TAG_ONNX_MODEL` override** for users who prioritize speed over identifier quality.

## Next tests needed

1. Re-run with leakage trimmer applied to confirm estimated improvement
2. Check `gemma-3-1b-it-ONNX` (already in local cache) — may handle instruction format better as a pure instruct model vs coding model used for tagging
3. Full indexing sanity check after prompt fixes are applied to `tag-onnx-worker.js`

## Acceptance criteria

- [x] No private paths in report
- [x] `git diff --check` passes
- [x] Probe script stays in `.tmp/` (not tracked)
- [x] No production defaults changed
- [x] No docs rewritten except this benchmark report
- [x] Full indexing sanity check skipped — prompt fixes must come first
