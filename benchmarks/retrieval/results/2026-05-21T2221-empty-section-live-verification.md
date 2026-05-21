# Empty-Section Fix — Live Verification — 2026-05-21

## Purpose

Verify that `(empty section: ...)` chunks are routed around context/tag LLM calls
after the fix in `src/indexer/phases/empty-section.js` + `src/indexer/index.js`.

## Environment

| Item | Value |
|------|-------|
| CONTEXT_MODEL | gemma3:4b |
| TAG_MODEL | gemma3:4b |
| ONNX_EMBED | 1 |
| Corpus | 6 private markdown files with empty markdown sections |
| Search mode | n/a (indexing only) |

## Files

6 files from a private corpus — all included, none skipped.

## Indexing Result

| Item | Value |
|------|-------|
| Exit | OK |
| Total points | 238 |
| Wall time | 877007 ms |
| Files indexed | 6 |
| Tag batch fallbacks | 14 |

## Per-File Stats

*Per-file stats unavailable — stdout format did not match parser.*

Known from pre-run chunk count (chunkFileFromPath on corpus files):

| Corpus | Raw chunks | Empty-section chunks |
|--------|-----------|----------------------|
| 6 files total | 250 | 41 |

## Payload Audit

| Metric | Count |
|--------|-------|
| Total points | 238 |
| Empty-section points | 41 |
| Deterministic context (correct) | 41 / 41 |
| Empty tags (correct) | 41 / 41 |
| Failures | 0 |

## Pre-Fix Baseline vs After-Fix

| Metric | Pre-fix (probe) | After-fix |
|--------|----------------|-----------|
| Tag batch fallbacks (gemma3:4b, 6 files) | 16/82 (19.5%) | 14 |
| Failed batches with empty-section chunks | 10/16 (62.5%) | 0 (routed out) |
| Empty-section payload audit | not run | PASS (41 points) |

## Verdict

**PARTIAL**

Payload audit: 41/41 empty-section points have deterministic context, 41/41 have tags: [] —
fix confirmed. Tag fallbacks: 14 (vs baseline 16). The 2-fallback drop is not a meaningful
reduction — remaining fallbacks are from list-heavy or irregular normal chunks, not
empty-section chunks. Empty-section routing is fully correct; further fallback reduction
requires separate work on normal-chunk batch parse reliability.

*Generated: 2026-05-21*
