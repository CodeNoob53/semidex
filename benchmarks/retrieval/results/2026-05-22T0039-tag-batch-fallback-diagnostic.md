# Tag Batch Fallback Diagnostic — 2026-05-22

## Purpose

Diagnose why tag batch phase still falls back to per-chunk calls after the
empty-section fix. Corpus = private files; report contains no file paths or
raw chunk content.

## Environment

| Item | Value |
|------|-------|
| Models probed | gemma3:4b, qwen2.5:3b-instruct |
| Batch sizes | 3, 2, 1 |
| Corpus | 6 private markdown files |
| Normal chunks probed | 198 (41 empty-section skipped) |

## Corpus Summary

| Metric | Count |
|--------|-------|
| Files | 6 (0 skipped) |
| Raw chunks | 250 |
| Merged chunks | 239 |
| Normal chunks (probed) | 198 |
| Empty-section skipped | 41 |

## Matrix: model × batchSize

| model | batchSize | batches | failures | failRate | meanMs | p50Ms |
|-------|-----------|---------|----------|----------|--------|-------|
| gemma3:4b | 3 | 66 | 14 | 21.2% | 1830 | 1783 |
| gemma3:4b | 2 | 99 | 44 | **44.4%** | 1234 | 1102 |
| gemma3:4b | 1 | 198 | 0 | 0.0% | 490 | 489 |
| qwen2.5:3b-instruct | 3 | 66 | 22 | 33.3% | 12512 | 2678 |
| qwen2.5:3b-instruct | 2 | 99 | 20 | 20.2% | 15248 | 2634 |
| qwen2.5:3b-instruct | 1 | 198 | 0 | 0.0% | 1839 | 409 |

Note: batchSize=1 uses the single-chunk comma-list prompt (production-equivalent).
batchSize=2/3 uses the JSON array-of-arrays batch prompt.
qwen2.5 generate_errors are Ollama timeouts (~307s), not model quality failures.

## Failure Reasons — batchSize=3

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 31 | 86% |
| non_json | 3 | 8% |
| generate_error (timeout) | 2 | 6% |

## Failure Reasons — batchSize=2

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 60 | 94% |
| generate_error (timeout) | 4 | 6% |

## Failed Batch Metadata — batchSize=3

| Metric | Value |
|--------|-------|
| Failed batches | 36 |
| With list-heavy chunks | 31 (86%) |
| Mean chunk chars (failed batches) | 672 |
| Max chunk chars (failed batches) | 3171 |

## wrong_shape Root Cause Analysis

Inspection of raw LLM outputs (in `.tmp/`) reveals consistent, structurally distinct
failure modes per model.

### gemma3:4b wrong_shape sub-patterns

| Sub-pattern | Structure observed | `extractJsonArray` behaviour |
|-------------|-------------------|------------------------------|
| Object + correct-count aoa | `{"tags": [["a"],["b"],["c"]]}` for n=3 | **Already recovered** via Object.values path |
| Object + over-generated aoa | `{"tags": [["a"],["b"],["c"],["d"]]}` for n=3, or 11 items for n=3 | Returns null — count mismatch, no safe fix |
| Multi-key object | `{"tags": [[…],[…]], "tags2": [[…]], "tags3": [[…]]}` | Returns null — merging across keys risks chunk↔tag misalignment |
| Hallucinated keys from list markers | `{"[": "value", "[": "value2"}` | Returns null — non-recoverable |

The first sub-pattern (correct-count object) is already handled. The dominant failure is
over-generation of varying counts (not a fixed offset), which cannot be safely recovered
without dropping tags from the wrong chunk. The multi-key case would require merging
across keys, which risks misaligning tags to chunks — not safe for production.

### qwen2.5:3b-instruct wrong_shape sub-pattern

qwen2.5 consistently produces numbered-key objects:
`{"tags0": ["a","b"], "tags1": ["c","d"], "tags2": []}` instead of `[["a","b"],["c","d"],["c","d"]]`.

`extractJsonArray` already has an Object.values recovery path, but it **silently fails when
any inner array is empty `[]`**: `[].every(Array.isArray)` is vacuously true, so the empty
array enters the `every-array` branch and `flat.push(...[])` contributes nothing.
Result: `flat.length` = 1 instead of 3 → length check fails → null returned.

This is a one-line fixable bug: treat empty arrays as string-arrays (push `[]` as a tag
group rather than spreading them) in the Object.values recovery loop.

## Key Observations

1. **batchSize=2 is strictly worse than batchSize=3 for gemma3:4b** (44.4% vs 21.2%).
   Reducing `LLM_BATCH_SIZE` does not help and doubles call count. Do not reduce batch size.

2. **wrong_shape dominates at 86–94%** across both models and batch sizes. Failures are
   structurally consistent, not random noise.

3. **86% of failed batches contain list-heavy chunks**. List-marker text (`- `, `* `, `1.`)
   causes the model to over-generate or produce hallucinated JSON keys. This is the primary
   trigger.

4. **qwen2.5 timeouts** (~307s, 4–6% of batches) are an Ollama infrastructure issue
   separate from JSON parse quality.

5. **Both models succeed 100% at batchSize=1** using the single-chunk comma-list prompt.
   The JSON array-of-arrays format is the failure surface, not the models' tagging ability.

## Recommendations

### Immediate: fix empty-array handling in `extractJsonArray` (PARSER_FIX_FIRST)

One targeted fix in `src/indexer/phases/tag.js` → `extractJsonArray` Object.values loop:

When iterating Object values, treat `[]` as a string-array (push it as an empty tag group)
rather than spreading it as an array-of-arrays. Change the condition from:

```js
if (v.every(Array.isArray)) flat.push(...v);
else if (v.every(s => typeof s === 'string')) flat.push(v);
```

to:

```js
if (v.length > 0 && v.every(Array.isArray)) flat.push(...v);
else if (v.length === 0 || v.every(s => typeof s === 'string')) flat.push(v);
```

This fixes qwen2.5 numbered-key failures when any chunk has zero tags, at zero risk to
currently-passing batches.

### Do not attempt to recover gemma3 over-generated counts

Over-generation varies (4, 8, 11 items for n=3) with no safe truncation point. Dropping
excess items would assign tags to the wrong chunks. The correct fix for gemma3 is at the
prompt level (stricter instruction) or accepting the per-chunk fallback for list-heavy
content.

### Do not reduce batch size

batchSize=2 is worse than batchSize=3 for gemma3:4b. Not recommended.

### TAG_GEN=0 for large automated corpora

With ~21% failure rate at batchSize=3, a 1000-chunk corpus produces ~67 fallback batches
× 3 extra Ollama calls each ≈ 200 additional calls. `TAG_GEN=0` remains the correct
choice for automated pipelines where `qdrant_find_by_tag` is not used.

## Verdict

**PARSER_FIX_FIRST**

86% of failures are `wrong_shape`. The actionable fix is narrow:

- **qwen2.5**: one-line bug in `extractJsonArray` Object.values loop — empty `[]` inner
  arrays are vacuously caught by `every(Array.isArray)` and spread as nothing, causing
  length mismatch. Fix: `v.length > 0 && v.every(Array.isArray)` guards the spread.

- **gemma3**: over-generation of tag count (not a fixed offset) is not safely recoverable
  in the parser. Fallback to per-chunk for these batches is the correct production behavior.

The parser fix is low-risk (purely additive, no behavior change for passing batches) and
specifically targeted at qwen2.5 numbered-key output with empty tag groups.

*Generated: 2026-05-22*
