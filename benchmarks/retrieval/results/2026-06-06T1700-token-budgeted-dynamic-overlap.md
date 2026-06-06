# Token-Budgeted Dynamic Overlap — Benchmark

**Date:** 2026-06-06
**Command:** `node .tmp/dynamic-overlap-bench.mjs`
**Corpus:** 20 .md files (deduplicated by filename)
  - `benchmarks/retrieval/fixtures/docs`
  - `benchmarks/retrieval/custom-50/fixtures/docs`
  - `docs/en`
**Token counter:** BGE-M3 (real tokenizer via `getTokenCounter`)
**Production baseline:** `chunkFileFromPath()` called directly — not reimplemented.
**No production code changed. No Qdrant/embed/context work.**

---

## Dynamic model design

Conservative model (previous report):
```
maxBody = MAX - overlapCap          // applied before overlap is known
bodyText <= maxBody                 // body undershoots MAX when actual overlap < cap
overlapText = safeSuffix(prev, cap)
finalText = overlap + body <= MAX
```

Dynamic model (this report):
```
bodyText <= MAX                     // body fills up to full MAX
availBudget = MAX - bodyTokens      // computed after body is finalised
if availBudget <= 0: no overlap
effectiveCap = min(OVERLAP_CAP, availBudget)
overlapText = safeSuffix(prev, effectiveCap)   // word-boundary safe
finalText = overlap + body
assert finalTokens <= MAX           // guaranteed by construction
```

Key differences:
- Body budget: MAX (dynamic) vs MAX-cap (conservative) → denser chunks.
- Overlap cap: `min(OVERLAP_CAP, availBudget)` — dynamically bounded.
- Chunks where body exactly fills MAX get no overlap; this is correct, not a bug.

---

## Word-boundary safety

`safeTakeLastTokens()`: binary search → snap to `/\s/` if mid-word. No `indexOf(' ')`.

**Handcrafted unit tests (5 cases, \t and \r\n included):**
All 5 passed.

**Corpus-wide verification (every generated overlap checked against source):**
| Variant | Candidates | Adjusted | Omit-budget | Omit-boundary | Mid-word violations |
|---|---|---|---|---|---|
| conservative candB | 43 | 21 | 0 | 0 | 0 |
| dynA | 55 | 28 | 0 | 0 | 0 |
| dynB | 23 | 13 | 0 | 0 | 0 |
| dynC | 23 | 9 | 0 | 0 | 0 |
| dynD | 14 | 5 | 0 | 0 | 0 |

---

## Variant settings

| Variant | Model | MAX | MIN | OVERLAP_CAP | maxBody |
|---|---|---|---|---|---|
| production baseline | production | 400 | 30 | OVERLAP_SENTENCES=2 | n/a |
| conservative candB | conservative | 512 | 160 | 80 | 432 (MAX-cap) |
| dynA | dynamic | 400 | 256 | 64 | 400 (full MAX) |
| dynB | dynamic | 512 | 160 | 80 | 512 (full MAX) |
| dynC | dynamic | 512 | 128 | 64 | 512 (full MAX) |
| dynD | dynamic | 656 | 128 | 96 | 656 (full MAX) |

---

## Production baseline sanity check

| File | Baseline |
|---|---|
| README.md | 3 |
| architecture.md | 15 |
| benchmark-dataset-plan.md | 25 |
| benchmarking.md | 21 |
| ce-rerank-design.md | 44 |
| chunking-quality.md | 21 |
| chunking.md | 9 |
| config-env.md | 12 |
| configuration.md | 36 |
| mcp-tools.md | 14 |
| mcp-workflow.md | 9 |
| multilingual.md | 9 |
| obsidian.md | 7 |
| operations.md | 32 |
| project-structure.md | 10 |
| providers.md | 6 |
| qdrant.md | 8 |
| retrieval.md | 38 |
| roadmap.md | 33 |
| sync.md | 6 |
| **TOTAL** | **358** |

---

## Summary metrics

| Metric | baseline | conservative candB | dynA | dynB | dynC | dynD |
|---|---|---|---|---|---|---|
| total chunks | 358 | 344 | 356 | 324 | 324 | 315 |
| min finalTok | 4 | 4 | 4 | 4 | 4 | 4 |
| p10 finalTok | 55 | 56 | 56 | 53 | 53 | 46 |
| p50 finalTok | 152 | 156 | 154 | 151 | 151 | 146 |
| p90 finalTok | 349 | 383 | 352 | 441 | 441 | 461 |
| max finalTok | 576 | 477 | 398 | 510 | 510 | 653 |
| < 128 tok | 147 (41.1%) | 138 (40.1%) | 144 (40.4%) | 137 (42.3%) | 137 (42.3%) | 137 (43.5%) |
| < 200 tok | 220 (61.5%) | 209 (60.8%) | 218 (61.2%) | 201 (62.0%) | 203 (62.7%) | 201 (63.8%) |
| < 256 tok | 260 (72.6%) | 244 (70.9%) | 257 (72.2%) | 234 (72.2%) | 235 (72.5%) | 231 (73.3%) |
| > MAX tok | 8 (2.2%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| > 512 tok | 3 (0.8%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 21 (6.7%) |
| > 656 tok | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| — | — | — | — | — | — |
| avg bodyTok | n/a | 178 | 172 | 189 | 189 | 194 |
| p50 bodyTok | n/a | 148 | 146 | 146 | 146 | 144 |
| p90 bodyTok | n/a | 371 | 346 | 432 | 432 | 449 |
| avg unused budget | n/a | 325 | 220 | 319 | 319 | 458 |
| p50 unused budget | n/a | 358 | 246 | 362 | 362 | 510 |
| — | — | — | — | — | — |
| overlap candidates | n/a | 43 | 55 | 23 | 23 | 14 |
| chunks with overlap | n/a | 43 | 55 | 23 | 23 | 14 |
| avg overlapTok | n/a | 78 | 55 | 65 | 54 | 92 |
| max overlapTok | n/a | 80 | 64 | 80 | 64 | 96 |
| omit: no budget | n/a | 0 | 0 | 0 | 0 | 0 |
| omit: no safe boundary | n/a | 0 | 0 | 0 | 0 | 0 |
| word-boundary adjusted | n/a | 21 | 28 | 13 | 9 | 5 |
| — | — | — | — | — | — |
| empty chunks | 0 | 0 | 0 | 0 | 0 | 0 |
| overlap-only chunks | 0 | 0 | 0 | 0 | 0 | 0 |
| mid-word violations | 0 | 0 | 0 | 0 | 0 | 0 |
| word fallback splits | 0 | 0 | 0 | 0 | 0 | 0 |
| emergency (unsplittable) | 0 | 0 | 0 | 0 | 0 | 0 |
| pathological chunks | 18 | 21 | 21 | 20 | 20 | 18 |

---

## Per-file chunk counts

| File | baseline | conservative candB | dynA | dynB | dynC | dynD |
|---|---|---|---|---|---|---|
| README.md | 3 | 2 | 3 | 1 | 1 | 1 |
| architecture.md | 15 | 14 | 15 | 14 | 14 | 13 |
| benchmark-dataset-plan.md | 25 | 23 | 24 | 21 | 21 | 21 |
| benchmarking.md | 21 | 21 | 21 | 21 | 21 | 21 |
| ce-rerank-design.md | 44 | 41 | 43 | 39 | 39 | 38 |
| chunking-quality.md | 21 | 21 | 21 | 21 | 21 | 21 |
| chunking.md | 9 | 9 | 9 | 9 | 9 | 9 |
| config-env.md | 12 | 12 | 12 | 12 | 12 | 12 |
| configuration.md | 36 | 35 | 36 | 31 | 31 | 30 |
| mcp-tools.md | 14 | 13 | 14 | 12 | 12 | 11 |
| mcp-workflow.md | 9 | 9 | 9 | 9 | 9 | 9 |
| multilingual.md | 9 | 9 | 9 | 9 | 9 | 9 |
| obsidian.md | 7 | 7 | 7 | 7 | 7 | 7 |
| operations.md | 32 | 31 | 32 | 28 | 28 | 26 |
| project-structure.md | 10 | 10 | 10 | 9 | 9 | 9 |
| providers.md | 6 | 6 | 6 | 6 | 6 | 6 |
| qdrant.md | 8 | 8 | 8 | 8 | 8 | 8 |
| retrieval.md | 38 | 36 | 38 | 31 | 31 | 28 |
| roadmap.md | 33 | 31 | 33 | 30 | 30 | 30 |
| sync.md | 6 | 6 | 6 | 6 | 6 | 6 |

---

## Pathological chunk inventory (production baseline)

| File | Section | Flags | finalTok |
|---|---|---|---|
| chunking.md | Parameters | long-no-whitespace | 160 |
| qdrant.md | Env tuning | long-no-whitespace | 112 |
| benchmark-dataset-plan.md | 3. Query Taxonomy | long-table-row | 525 |
| configuration.md | Models | long-table-row | 353 |
| configuration.md | ONNX_EXECUTION_PROVIDER | long-table-row | 333 |
| configuration.md | Reranking | long-table-row | 348 |
| configuration.md | config.json — Internal Fields Written by sync | long-table-row | 242 |
| mcp-tools.md | Recommended Agent Workflow | long-code-block | 308 |
| operations.md | Troubleshooting | long-table-row | 332 |
| retrieval.md | Relevant Environment Variables | long-table-row | 576 |
| retrieval.md | Cross-Encoder Reranking (Benchmark Only) | long-no-whitespace | 222 |
| retrieval.md | Conclusion | long-no-whitespace | 170 |
| retrieval.md | CE routing guard — custom-50 result | long-no-whitespace | 262 |
| retrieval.md | CE routing guard — custom-50 result | long-no-whitespace | 259 |
| retrieval.md | CE routing guard — custom-150 validation result | long-no-whitespace | 337 |
| retrieval.md | CE routing guard — custom-150 validation result | long-no-whitespace | 387 |
| retrieval.md | CE routing guard — custom-150 validation result | long-no-whitespace | 259 |
| roadmap.md | Conditional Retrieval Research | long-no-whitespace | 130 |

Note: tables, code blocks, long-no-whitespace are not addressed by overlap/budget changes.
Skeleton/entity chunking is a separate task.

---

## Examples

### 5 examples: dynamic (dynB) uses more body than conservative candB

Dynamic dynB splits body at MAX=512 (not 432). These chunks show where the
extra 80-token body budget makes a difference.

**DB1** — configuration.md / ONNX_EXECUTION_PROVIDER
  conservative candB: bodyTok=426  finalTok=426
  dynB:               bodyTok=487  finalTok=487  overlapTok=0  unused=25
  dynB overlap: (none)
  dynB body start: Controls which hardware backend ONNX Runtime uses for inference. Only relevant when `ONNX_EMBED=1`.↵↵**Execution-provider matrix:**↵↵| Platform | Recommended pr

**DB2** — retrieval.md / Promotion gate result
  conservative candB: bodyTok=423  finalTok=423
  dynB:               bodyTok=479  finalTok=479  overlapTok=0  unused=33
  dynB overlap: (none)
  dynB body start: | Criterion | text+section | text+meta |↵|-----------|:-----------:|:--------:|↵| MRR@10 ≥ baseline +0.030 | ✓ 0.755 | ✓ 0.760 |↵| chunkRecall@5 ≥ baseline | ✓ 

**DB3** — architecture.md / Qdrant Data Model
  conservative candB: bodyTok=418  finalTok=418
  dynB:               bodyTok=462  finalTok=462  overlapTok=0  unused=50
  dynB overlap: (none)
  dynB body start: semidex uses Qdrant as its primary retrieval index and storage backend.↵- **Collection**: Represents a single semidex knowledge base. - **Point**: Represents ex

**DB4** — benchmark-dataset-plan.md / 3. Query Taxonomy
  conservative candB: bodyTok=414  finalTok=414
  dynB:               bodyTok=487  finalTok=487  overlapTok=0  unused=25
  dynB overlap: (none)
  dynB body start: All tiers share the same class taxonomy. Each query in `queries.json` must↵have a `"type"` field matching one of these classes.↵| Class | Description | Examples

**DB5** — README.md / semidex Documentation (English)
  conservative candB: bodyTok=409  finalTok=473
  dynB:               bodyTok=473  finalTok=473  overlapTok=0  unused=39
  dynB overlap: (none)
  dynB body start: This directory contains the detailed English documentation for semidex. The root `README.md` is the short entry point; these files hold the implementation detai

### 5 examples: dynamic omits overlap because body fills MAX

These chunks show the correct dynamic behaviour: body hits MAX, so
availBudget=0 and no overlap is added. Not a failure — body is complete.

No dynB chunks with omit-budget in this corpus (body rarely fills full MAX=512).

### 5 largest pathological chunks (production baseline)

**P1** — retrieval.md / Relevant Environment Variables
  finalTok=576  bodyTok=n/a  overlapTok=n/a  level=undefined
  overlap: (n/a — production)
  body start: | Variable | Default | Description | |----------|---------|-------------| | `ONNX_EMBED` | `0` | Shorthand for `bge-m3-onnx + bge-m3-onnx` | | `DENSE_PROVIDER` | unset | Explicit d [finalText, body not separated]

**P2** — benchmark-dataset-plan.md / 3. Query Taxonomy
  finalTok=525  bodyTok=n/a  overlapTok=n/a  level=undefined
  overlap: (n/a — production)
  body start: | Class | Description | Examples | |-------|-------------|---------| | `exact-token` | function names, env vars, file names, metric IDs | `ONNX_EMBED`, `chunkFile`, `MRR@10`, `hybr [finalText, body not separated]

**P3** — retrieval.md / CE routing guard — custom-150 validation result
  finalTok=387  bodyTok=n/a  overlapTok=n/a  level=undefined
  overlap: (n/a — production)
  body start: Recall and cross-lingual behavior both improve, so the failure is in guard precision, not in CE quality: - **`cross-lingual-ua-en`** — improved: MRR 0.572→0.617, cR@5 held at 75%.  [finalText, body not separated]

**P4** — configuration.md / Models
  finalTok=353  bodyTok=n/a  overlapTok=n/a  level=undefined
  overlap: (n/a — production)
  body start: | Variable | Default | Description | |----------|---------|-------------| | `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL | | `EMBED_MODEL` | `bge-m3` | Dense model for [finalText, body not separated]

**P5** — configuration.md / Reranking
  finalTok=348  bodyTok=n/a  overlapTok=n/a  level=undefined
  overlap: (n/a — production)
  body start: | Variable | Default | Description | |----------|---------|-------------| | `RERANK_ENABLED` | `0` | Enable local reranker | | `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier b [finalText, body not separated]

### 5 examples: baseline oversized → dynB avoids oversize

Production baseline chunks > 400 MAX. dynB chunk in same file/section (if any).
(bodyTokens n/a for baseline; body/overlap not separable from chunkFileFromPath.)

**OS1** — retrieval.md / Relevant Environment Variables
  baseline finalTok=576 (body/overlap n/a)
  dynB chunk: finalTok=472  bodyTok=472  overlapTok=0  unused=40  MAX=512
  dynB chunk: finalTok=184  bodyTok=106  overlapTok=80  unused=328  MAX=512

**OS2** — operations.md / Troubleshooting
  baseline finalTok=548 (body/overlap n/a)
  dynB chunk: finalTok=448  bodyTok=448  overlapTok=0  unused=64  MAX=512
  dynB chunk: finalTok=510  bodyTok=474  overlapTok=38  unused=2  MAX=512
  dynB chunk: finalTok=324  bodyTok=256  overlapTok=70  unused=188  MAX=512

**OS3** — benchmark-dataset-plan.md / 3. Query Taxonomy
  baseline finalTok=525 (body/overlap n/a)
  dynB chunk: finalTok=487  bodyTok=487  overlapTok=0  unused=25  MAX=512
  dynB chunk: finalTok=351  bodyTok=274  overlapTok=79  unused=161  MAX=512

**OS4** — configuration.md / ONNX_EXECUTION_PROVIDER
  baseline finalTok=442 (body/overlap n/a)
  dynB chunk: finalTok=487  bodyTok=487  overlapTok=0  unused=25  MAX=512
  dynB chunk: finalTok=510  bodyTok=490  overlapTok=22  unused=2  MAX=512

**OS5** — ce-rerank-design.md / 2. Env/Config Proposal
  baseline finalTok=427 (body/overlap n/a)
  dynB chunk: finalTok=94  bodyTok=94  overlapTok=0  unused=418  MAX=512
  dynB chunk: finalTok=510  bodyTok=466  overlapTok=46  unused=2  MAX=512
  dynB chunk: finalTok=499  bodyTok=464  overlapTok=37  unused=13  MAX=512
  dynB chunk: finalTok=231  bodyTok=154  overlapTok=79  unused=281  MAX=512

---

## Safety checks

| Check | conservative candB | dynA | dynB | dynC | dynD |
|---|---|---|---|---|---|
| empty chunks | 0 | 0 | 0 | 0 | 0 |
| overlap-only chunks | 0 | 0 | 0 | 0 | 0 |
| mid-word violations | 0 | 0 | 0 | 0 | 0 |
| chunks > MAX | 0 | 0 | 0 | 0 | 0 |
| word fallback splits | 0 | 0 | 0 | 0 | 0 |
| emergency (unsplittable) | 0 | 0 | 0 | 0 | 0 |

---

## Known limitations

1. **Production baseline body/overlap not separable.** `chunkFileFromPath()` returns
   `text` only. Overlap-caused vs body-alone oversize in baseline cannot be distinguished
   without instrumentation. All 8 chunks > MAX are reported as oversized; cause is inferred.

2. **Corpus is 20 files / ~320–375 chunks.** MIN_CHUNK_TOKENS differences may not
   fully differentiate on this corpus. Validate on a larger corpus before production.

3. **No retrieval validation.** Chunking-only benchmark. MRR/recall impact unknown.
   Production adoption requires `npm run bench:custom50` after reindexing.

4. **Dynamic model is a prototype.** Merge pass uses `maxBody=MAX` for section bodies
   but section-boundary constraints are the same as production. No production code changed.

---

## Verdict

**Is dynamic better than conservative?**

Yes on chunk density. Dynamic dynB (MAX=512 MIN=160 OVERLAP=80):
- Body budget = 512 (vs 432 in conservative candB) → body packed up to 80 more tokens.
- avg bodyTok: dynB=189 vs candB=178 — dynB bodies are denser.
- avg unused budget (MAX - finalTok): dynB=319 | candB=325.
  Note: unused is driven by corpus content, not model difference — most chunks are short.
  The structural advantage of dynamic is in p90 bodyTok: dynB=432 vs candB=371.
- Chunk count: 324 (vs conservative candB 344).
- 0 chunks > MAX. 0 mid-word violations. 0 empty/overlap-only chunks.

**Which candidate for retrieval benchmark?**

dynB (MAX=512 MIN=160 OVERLAP=80) is the recommended candidate:
- Same MAX/MIN/OVERLAP as conservative candB but with denser body packing.
- Maintains all safety properties.
- Chunk count close to production baseline (324 vs 358).

**What still requires skeleton/entity chunking?**

The 18 pathological blocks (long table rows, code blocks, long-no-whitespace)
are not addressed by any overlap/budget change. The largest baseline chunk is 576 tokens
— a table body that cannot be split at word/sentence/paragraph level without breaking structure.
This requires a separate skeleton/entity model (out of scope here).

**No production default change without retrieval benchmark.**

---

## Next step: retrieval validation plan

| Step | Command / Action |
|---|---|
| 1. Patch `chunkFileAsync` for dynB | Set `maxBody=MAX` in section splitter; select overlap dynamically after body is finalised. |
| 2. Reindex with dynB settings | `MAX_CHUNK_TOKENS=512 MIN_CHUNK_TOKENS=160 CHUNK_OVERLAP_TOKENS=80 npm run index .` |
| 3. Run retrieval benchmark | `npm run bench:custom50` — compare MRR@10, chunkRecall@5, nDCG@10 vs current baseline. |
| 4. Accept if no regression | If metrics hold or improve, bump `CHUNKING_SCHEMA_VERSION` and promote dynB. |
| 5. Instrument baseline | Add body/overlap split tracking to `chunkFileAsync` to confirm overlap-caused oversize count. |

---

## git diff --check

```
(clean — no whitespace errors)
```
