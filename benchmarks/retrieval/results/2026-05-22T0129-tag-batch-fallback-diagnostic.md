# Tag Batch Fallback Diagnostic — 2026-05-22

## Purpose

Diagnose why tag batch phase still falls back to per-chunk calls after the
empty-section fix. Corpus = private files; report contains no file paths or
raw chunk content.

## Corpus Summary

| Metric | Count |
|--------|-------|
| Files | 6 (0 skipped) |
| Raw chunks | 250 |
| Merged chunks | 238 |
| Normal chunks (probed) | 197 |
| Empty-section skipped | 41 |

## Matrix: model × batchSize

| model | batchSize | batches | failures | failRate | meanMs | p50Ms |
|-------|-----------|---------|----------|----------|--------|-------|
| qwen2.5:3b-instruct | 3 | 66 | 10 | 15.2% | 7535 | 2488 |
| qwen2.5:3b-instruct | 2 | 99 | 16 | 16.2% | 13308 | 2247 |

## Failure Reasons — batchSize=3

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 7 | 70% |
| non_json | 2 | 20% |
| generate_error | 1 | 10% |

## Failure Reasons — batchSize=2

| reason | count | share |
|--------|-------|-------|
| wrong_shape | 10 | 63% |
| generate_error | 3 | 19% |
| non_json | 3 | 19% |

## Failed Batch Metadata — batchSize=3

| Metric | Value |
|--------|-------|
| Failed batches | 10 |
| With list-heavy chunks | 10 (100%) |
| Mean chunk chars (failed batches) | 582 |
| Max chunk chars (failed batches) | 1559 |

## Verdict

**PARSER_FIX_FIRST**

7/10 failures (70%) are wrong_shape / wrong_length — JSON parsed but structure did not match expected array-of-arrays. Improving extractJsonArray recovery logic may fix these before reducing batch size.

*Generated: 2026-05-22*
