# Tag Batch Fallback — Post-Fix Comparison Report (qwen2.5:3b-instruct)

## Purpose

Verify that the `extractJsonArray` empty-array fix reduces `wrong_shape` failures for
qwen2.5:3b-instruct. This report compares pre-fix (2026-05-22T0039 diagnostic run) against
post-fix (2026-05-22T0129 diagnostic run) on the same private 6-file corpus.

## Fix Applied

`src/indexer/phases/tag.js` — `extractJsonArray` Object.values recovery loop:

```js
// Before:
if (v.every(Array.isArray)) flat.push(...v);
else if (v.every(s => typeof s === 'string')) flat.push(v);

// After:
if (v.length > 0 && v.every(Array.isArray)) flat.push(...v);
else if (v.length === 0 || v.every(s => typeof s === 'string')) flat.push(v);
```

**Root cause fixed**: qwen2.5 produces numbered-key objects `{"tags0": [...], "tags1": [], "tags2": [...]}`.
Empty inner arrays `[]` were vacuously caught by `[].every(Array.isArray)` → spread as nothing →
`flat.length` fell short → length check failed → null returned. The guard `v.length > 0` prevents
the vacuous spread; `v.length === 0 ||` in the else-if catches empty arrays as valid empty tag groups.

## Corpus

| Metric | Count |
|--------|-------|
| Files | 6 private markdown files |
| Normal chunks probed | 197 (41 empty-section skipped) |
| batchSize=3 batches | 66 |
| batchSize=2 batches | 99 |

## Comparison Table

| Metric | Pre-fix | Post-fix | Delta |
|--------|---------|----------|-------|
| batchSize=3 failures | 22/66 (33.3%) | 10/66 (15.2%) | **−18.1 pp** |
| batchSize=3 wrong_shape | 19/22 (86%) | 7/10 (70%) | −12 absolute |
| batchSize=3 non_json | 1/22 | 2/10 | +1 |
| batchSize=3 generate_error | 2/22 | 1/10 | −1 |
| batchSize=2 failures | 20/99 (20.2%) | 16/99 (16.2%) | **−4.0 pp** |
| batchSize=2 wrong_shape | 19/20 (95%) | 10/16 (63%) | −9 absolute |
| batchSize=2 non_json | 0/20 | 3/16 | +3 |
| batchSize=2 generate_error | 4/20 (20%) | 3/16 (19%) | −1 |

## Failure Reason Breakdown — Post-fix

### batchSize=3

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 7 | 70% |
| non_json | 2 | 20% |
| generate_error | 1 | 10% |

### batchSize=2

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 10 | 63% |
| generate_error | 3 | 19% |
| non_json | 3 | 19% |

## Timeout Analysis

`generate_error` failures are Ollama timeouts (~307s). These are infrastructure-level —
qwen2.5 occasionally hangs on requests longer than Ollama's default timeout. The fix
has no effect on timeouts.

- Pre-fix: 6 timeouts across both batch sizes (2 at batchSize=3, 4 at batchSize=2)
- Post-fix: 4 timeouts across both batch sizes (1 at batchSize=3, 3 at batchSize=2)

Variation is within noise — timeouts are not systematically reduced by the parser fix.

## Residual wrong_shape Analysis

7 remaining `wrong_shape` failures at batchSize=3 all occur on list-heavy chunks (100%).
These match the gemma3:4b over-generation pattern: qwen2.5 also over-generates when
list-marker text (`- `, `* `, `1.`) appears in the batch. The count (7 vs 19 pre-fix)
confirms the fix resolved the empty-array sub-pattern; the remaining failures are a
distinct structural problem not addressable at the parser level.

## Verdict

**PARTIAL_FIX_TIMEOUTS_REMAIN**

The empty-array fix is confirmed effective:

- batchSize=3 failure rate dropped from 33.3% → 15.2% (−18.1 pp). `wrong_shape` count
  dropped from 19 → 7 (−63%).
- batchSize=2 failure rate dropped from 20.2% → 16.2% (−4.0 pp). `wrong_shape` count
  dropped from 19 → 10 (−47%).

Remaining failures are dominated by:
1. **wrong_shape (residual)**: list-heavy chunks triggering over-generation — not parser-fixable
2. **generate_error**: Ollama-level timeouts unrelated to JSON parse quality

qwen2.5:3b-instruct at batchSize=3 still fails 15% of batches, each falling back to 3
individual calls. This is not a regression but is insufficient for recommended production
use. `TAG_GEN=0` remains correct for automated pipelines; `TAG_MODEL=gemma3:4b` (batchSize=3,
21.2% fail rate) is similar in reliability but without the timeout risk.

No production defaults were changed. `TAG_MODEL` default remains `gemma3:4b`.

*Generated: 2026-05-22*
