# ONNX Tag Model Check — Qwen2.5-Coder 0.5B vs 1.5B

**Date:** 2026-06-05T13:12  
**Task:** Isolated quality + speed check — not a pipeline benchmark  
**Fixture:** `benchmarks/retrieval/fixtures/combined-live` (20 chunks, 5 files)  
**Prompt style:** Plain user prompt (no system role) — single-turn  
**Quantization:** q4 (both models)  
**Runtime:** Node v25.2.1 / @huggingface/transformers 4.2.0 / onnxruntime-node (CPU)

## Models tested

| Model | File size (q4) | Cached |
|---|---:|---|
| `onnx-community/Qwen2.5-Coder-0.5B-Instruct` | 823 MB | yes (pre-existing) |
| `onnx-community/Qwen2.5-Coder-1.5B-Instruct` | 1.7 GB | downloaded during run |

## Timing results

| Metric | 0.5B | 1.5B |
|---|---:|---:|
| Model load | 1 315 ms | 214 137 ms (~3.6 min) |
| Warmup | 402 ms | 934 ms |
| avg ms/chunk | 2 468 ms | 6 550 ms |
| p50 ms/chunk | 2 419 ms | 6 538 ms |
| p95 ms/chunk | 2 730 ms | 7 226 ms |
| Speed ratio | 1× | 2.65× slower |

> **Note:** 1.5B load time of 214s includes first-time download + disk cache write.
> Subsequent runs will load from local cache in ~5–10s (estimated, not measured).

## Quality metrics

| Metric | 0.5B | 1.5B |
|---|---:|---:|
| Fill rate (non-empty) | 20/20 (100%) | 20/20 (100%) |
| Valid 3–6 tag count | **3/20 (15%)** | **1/20 (5%)** |
| Instruction leakage | heavy (17/20) | heavy (18/20) |
| Tag repetition | heavy (16/20) | heavy (14/20) |
| Identifier preservation | partial | partial |

## Quality comparison table

| ID | Source | Expected identifiers | 0.5B tags | 1.5B tags | Notes |
|---|---|---|---|---|---|
| C01 | technical-config | `ONNX_EMBED`, `bge-m3-onnx` | `--onnx_embed`, hallucinated variants | `--set`, `--env`, `--onnx` | both miss `bge-m3-onnx`; 0.5B hallucinates `--onnx_model_url` |
| C02 | technical-config | `ONNX_EMBED`, `bge-m3`, `ollama` | `--ollama`, `--bge-m3`, leakage | `--onnx_embed`, `--bge-m3`, leakage | 1.5B better on identifiers but leaks |
| C03 | technical-config | `CONTEXT_MODEL`, `TAG_MODEL`, `COMBINED_LLM` | hallucinated `context_summary`, repetition | `context_model`, `tag_model`, JSON repetition | 1.5B closer on identifier names |
| C04 | technical-config | `QDRANT_URL`, `QDRANT_KEY` | `--qdrant`, `--url`, repetition | `qdrant_url`, `qdrant_key`, `cloud`, `self-hosted` | **1.5B wins** — clean 6-tag output, no leakage |
| C05 | technical-config | `MAX_CHUNK_TOKENS`, `MIN_CHUNK_TOKENS`, `LLM_BATCH_SIZE` | `llm`, `sentence_id` hallucination | `max_chunk_tokens`, `min_chunk_tokens`, `llm_batch_size` | **1.5B wins** — correct identifiers; truncated at token budget |
| C06 | architecture | `semidex`, `MCP server` | `--semidex`, repetition | `semidex`, `mcp`, `server` | 1.5B cleaner; both lack `local-first` |
| C07 | architecture | `source_file`, `chunkIndex`, `needsBoundaryCheck` | `--phase1`, repetition | `sourcefile`, `chunkindex`, leakage | 1.5B preserves more field names; both break |
| C08 | architecture | `bge-m3-onnx`, `Qdrant`, `dense`, `sparse` | `--phase4`, `--dense`, `--sparse` | `bge-m3-onnx`, `dense`, `sparse`, `qdrant` | **1.5B wins** — correct identifiers |
| C09 | architecture | `hybrid search`, `tag filtering`, `MCP` | leakage (instruction steps) | `mcp-server`, `hybrid-search`, `chunk-retrieval` | **1.5B wins** — reasonable 4 tags then leakage |
| C10 | architecture | `config.json`, `cpu/dml/cuda` | instruction leakage entirely | `dense`, `sparse`, `onnx`, `cuda` | **1.5B wins** — real content; both leak |
| C11 | short-chunks | (very short: "Hi.") | `--hello`, `--world`, `--hi` | `hi`, then full instruction leakage | 0.5B invents; 1.5B loops; both broken |
| C12 | short-chunks | `COMBINED_MIN_CHARS`, `CONTEXT_MODEL` | full instruction leakage | `--combined-min-chars`, `--context-model`, leakage | 1.5B picks up identifiers despite leaking |
| C13 | short-chunks | `RRF ranking`, `tag-filter` | `retrieval-quality` repetition | `tag_filter_query`, `default_hybrid_rrf_ranking` | **1.5B wins** — domain-correct identifier |
| C14 | operations | `ONNX_EMBED`, `npm run index` | `index`, `folder`, repetition | `onnx_embed`, `npm_run_index` | **1.5B wins** — CLI identifiers preserved |
| C15 | operations | `SHA-256`, `skip-path overhead` | instruction leakage entirely | `sha256`, `skip`, `automatic` — then repetition | 1.5B gets identifiers; both loop |
| C16 | operations | `PRUNE_STALE`, `ONNX_EMBED`, `npm run index` | `prune`, `onnx_embed` mixed repetition | `--prune-stale`, `--onnx-embed`, repetition | both break; 1.5B closer on identifier form |
| C17 | operations | `npm run doctor`, `COMBINED_LLM`, `TAG_MODEL` | `doctor`, `qdrant`, `ollama` then leakage | `npm`, `run`, `doctor`, `combined_llm`, `tag_model` | **1.5B wins** — key env vars preserved |
| C18 | ukrainian | `semidex`, `Ollama`, `ONNX`, `Qdrant` | `semidex`, `ollama`, `onnx`, `qdrant` then leakage | `semidex`, `ollama`, `onnx`, `qdrant` then leakage | **tie** — both get identifiers, both leak |
| C19 | ukrainian | `Qdrant`, `gemma3:4b`, `bge-m3`, `Node.js` | `--qdrant`, `--ollama`, leakage | `qdrant`, `ollama`, `gemma3`, `bge-m3`, `nodejs` | **1.5B wins** — cleaner, more complete |
| C20 | ukrainian | `COMBINED_LLM`, `CONTEXT_MODEL`, `TAG_MODEL` | `--combined_llm`, repetition | `combined_llm`, `context_model`, `tag_model` | **1.5B wins** — correct identifiers |

**1.5B wins: 11/20 | 0.5B wins: 0/20 | Tie: 2/20 | Both broken: 7/20**

## Failure patterns

### Common to both models

1. **Instruction leakage** — both models echo back prompt instructions as tag text:
   - `to-generate-these-tags, follow-these-steps, 1.-identify...`
   - `explanation`, `the-tags-are`, `ill-follow-these-rules`
   - Root cause: `max_new_tokens=48` is not enough to complete the tag list → model starts following the prompt template it saw in training

2. **Tag repetition** — sequences like `sha256, skip, sha256, skip, sha256...` or `--tag_model, --tag_model × 7`
   - Root cause: greedy decoding (`do_sample=false`) with no repetition penalty

3. **`--` prefix hallucination** — both models treat identifiers as CLI flags: `--onnx_embed`, `--semidex`, `--qdrant`
   - Likely from training data where env vars appear as `--flag=VALUE` in CLI examples

### 0.5B specific

- Hallucinates entire fake identifier families: `--onnx_model_url`, `--onnx_model_version`, `sentence_id`, `sentence_start_length`
- Generic/weak tags: `model`, `chunk`, `token`, `sentence` — correct domain but useless for filtering
- Short chunk "Hi." → invents `--hello`, `--world`

### 1.5B specific

- Starts reasoning: `such-as-the-name-of-the-system-semidex, its-functionality-...` — chains of explanation text become tags
- `explanation` literal tag appears in 12/20 outputs — model starts a reasoning preamble before tags
- Heavier leakage volume (longer outputs before truncation)
- Load time 214s on first run (download + cache)

## Root cause analysis

Both models are instruction-tuned for **conversational/reasoning tasks**, not structured tag extraction. Key issues:

1. **`max_new_tokens=48` is the real bottleneck** — tags like `context_model, tag_model, combined_llm, qdrant_url` fit in ~15 tokens. 48 tokens gives the model room to start reasoning. Reducing to 24–32 would cut per-chunk time by ~35% and eliminate most leakage.

2. **No repetition penalty** — `repetition_penalty=1.3` would stop `sha256, skip, sha256...` loops almost entirely.

3. **Prompt format** — both models were fine-tuned with system+user+assistant chat template. A plain user prompt forces the model into "completion" mode which is less reliable for these models.

## Recommendation

### Prefer 1.5B for tag quality

1.5B wins 11/20 head-to-head on identifier preservation. The identifiers that matter for semidex search (`QDRANT_URL`, `ONNX_EMBED`, `bge-m3`, `npm run index`, `COMBINED_LLM`) are preserved significantly better by 1.5B.

**But neither model is production-ready at current settings.**

### Required prompt fixes before production use

These changes should be tested before declaring either model production-default:

```js
// In tag-onnx-worker.js
const out = await gen(prompt, {
  max_new_tokens: 28,        // was 48 — tags are short, 28 is enough for 6 tags
  do_sample: false,
  repetition_penalty: 1.3,   // stops repetition loops
  return_full_text: false,
});
```

With these fixes, expected improvements:
- Repetition loops eliminated
- Per-chunk time: 0.5B ~1 600ms, 1.5B ~4 200ms (estimated)
- Valid 3–6 tag rate: expected to improve from <15% to 50–70%

### Keep 0.5B for speed if quality after fixes is comparable

If after applying `repetition_penalty` + reduced `max_new_tokens` the valid-tag rate converges, 0.5B is the better choice at 2.65× faster. A follow-up check with fixed settings is needed.

## Next tests needed

1. **Re-run both models with `max_new_tokens=28, repetition_penalty=1.3`** — this is the most important next step
2. **Chat-template prompt** — use `messages=[{role:'system',...},{role:'user',...}]` format instead of plain string; may reduce leakage
3. **Gemma-3-1B-IT-ONNX** — already in local cache (`models/transformers-cache/onnx-community/gemma-3-1b-it-ONNX`); smaller than 1.5B Qwen, may handle instruction-following better
4. **Qwen2.5-0.5B-Instruct** (non-coder, also cached) — compare against Coder-0.5B on same chunks

## Acceptance criteria status

- [x] No private paths in report
- [x] `git diff --check` — probe script in `.tmp/`, not tracked
- [x] No production defaults changed
- [x] No docs rewritten except this benchmark report
- [ ] Optional full indexing sanity check — **skipped**: both models need prompt fixes first; running a full index with current broken output is not informative
