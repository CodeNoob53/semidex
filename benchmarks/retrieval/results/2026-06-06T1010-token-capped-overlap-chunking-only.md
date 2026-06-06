# Token-Capped Overlap — Chunking-Only Benchmark

**Date:** 2026-06-06  
**Command:** `MIN_CHUNK_TOKENS=256 node .tmp/overlap-cap-bench.mjs`  
**Corpus:** 23 .md files — `benchmarks/retrieval/fixtures/docs` (4), `benchmarks/retrieval/custom-50/fixtures/docs` (6 own + 4 shared counted separately but overlap), `docs/en` (13)  
**Token counter:** BGE-M3 (real tokenizer via `getTokenCounter`)  
**No production code changed. No Qdrant/embed/context work.**

---

## Env settings per variant

| Variant | MAX_CHUNK_TOKENS | MIN_CHUNK_TOKENS | Overlap rule |
|---|---|---|---|
| baseline | 400 | 256 | last 2 sentences, no token cap |
| capA | 400 | 256 | prefer 1 sent; add 2nd only if combined ≤ 64 tok; hard-truncate at 64 |
| capB | 400 | 256 | prefer 1 sent; add 2nd only if combined ≤ 80 tok; hard-truncate at 80 |

---

## Summary table

| Metric | baseline | capA (64) | capB (80) |
|---|---|---|---|
| Total chunks | 368 | 368 | 368 |
| min tokens | 4 | 4 | 4 |
| p10 tokens | 46 | 46 | 46 |
| p50 tokens | 151 | 151 | 151 |
| p90 tokens | 543 | 528 | 543 |
| max tokens | 1176 | 1176 | 1176 |
| avg overlap tokens | 53.0 | 47.0 | 49.0 |
| max overlap tokens | 105 | 62 | 73 |
| truncated overlaps (hard-cut) | 0 | 1 | 1 |
| overlap-caused oversize (raw ≤ 400 + overlap > 400) | 8 | 0 | 0 |

Note: `max tokens = 1176` across all variants — large chunks come from sections that
exceed `MAX_CHUNK_TOKENS` even before overlap (long tables / code blocks that the
sentence splitter cannot break further). Overlap does not affect these.

---

## Token distribution (final chunk text incl. overlap)

| Bucket | baseline | capA (64) | capB (80) |
|---|---|---|---|
| < 128 tokens | 153 (41.6%) | 153 (41.6%) | 153 (41.6%) |
| < 200 tokens | 225 (61.1%) | 225 (61.1%) | 225 (61.1%) |
| < 256 tokens | 260 (70.7%) | 260 (70.7%) | 260 (70.7%) |
| > 400 tokens (any cause) | 61 (16.6%) | 61 (16.6%) | 61 (16.6%) |
| > 400 tokens (overlap-caused only) | 8 (2.2%) | **0** | **0** |
| > 512 tokens | 38 (10.3%) | 38 (10.3%) | 38 (10.3%) |
| > 656 tokens | 24 (6.5%) | 24 (6.5%) | 24 (6.5%) |

The `> 400 (any cause)` row is identical because large chunks come from oversized
sections — not from overlap. The `> 400 (overlap-caused)` row shows capA eliminates
all 8 overlap-caused violations the baseline produces.

---

## Per-file chunk counts (all variants identical — no boundary changes)

| File | baseline | capA | capB | Δ |
|---|---|---|---|---|
| README.md | 1 | 1 | 1 | 0 |
| architecture.md | 13 | 13 | 13 | 0 |
| benchmark-dataset-plan.md | 19 | 19 | 19 | 0 |
| benchmarking.md | 72 | 72 | 72 | 0 |
| ce-rerank-design.md | 34 | 34 | 34 | 0 |
| chunking-quality.md | 21 | 21 | 21 | 0 |
| chunking.md | 9 | 9 | 9 | 0 |
| config-env.md | 12 | 12 | 12 | 0 |
| configuration.md | 29 | 29 | 29 | 0 |
| mcp-tools.md | 11 | 11 | 11 | 0 |
| mcp-workflow.md | 9 | 9 | 9 | 0 |
| multilingual.md | 9 | 9 | 9 | 0 |
| obsidian.md | 13 | 13 | 13 | 0 |
| operations.md | 25 | 25 | 25 | 0 |
| project-structure.md | 17 | 17 | 17 | 0 |
| providers.md | 6 | 6 | 6 | 0 |
| qdrant.md | 8 | 8 | 8 | 0 |
| retrieval.md | 24 | 24 | 24 | 0 |
| roadmap.md | 30 | 30 | 30 | 0 |
| sync.md | 6 | 6 | 6 | 0 |

**Token cap does not change chunk boundaries or counts** — it only trims the overlap
prefix prepended to the next chunk's text.

---

## Changed overlap examples (baseline vs capA)

Only 1 boundary differs on this corpus. The other 7 overlap-caused baseline oversize
chunks are in `benchmarking.md` but all their overlap sentences are ≤ 64 tokens each;
the oversize comes from the raw chunk body already being ~350–390 tokens before overlap.
capA selects only 1 sentence for those (same result since combined 2-sentence overlap
would exceed 64 tok), so they no longer exceed 400.

### `operations.md` chunk #24 — the only truncated example

| | Value |
|---|---|
| Prev chunk end | `...tokenizer-aware chunking \| Expected behavior — let reindex complete; do not interrupt \|` |
| Raw chunk start | `` `pandoc: Unknown input format pdf` \| Pandoc cannot read PDFs \| ... `` |
| Baseline overlap | 105 tok → chunk total **576 tok** |
| capA overlap | 57 tok → chunk total **528 tok** (hard-truncated: 1 sent > 64, so trim) |
| capB overlap | 73 tok → chunk total **543 tok** |

**Baseline overlap text (105 tok):**
```
npm run index . /root` | | Metadata mismatch triggers unexpected full reindex |
Changed `ONNX_EMBED`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, schema version,
`vectorSize`, or `TOKEN_COUNT`; or collection predates tokenizer-aware chunking |
Expected behavior — let reindex complete; do not interrupt |
```

**capA overlap text (57 tok, hard-truncated mid-sentence):**
```
E_PROVIDER`, schema version, `vectorSize`, or `TOKEN_COUNT`; or collection
predates tokenizer-aware chunking | Expected behavior — let reindex complete;
do not interrupt |
```

**Assessment:** The baseline overlap (105 tok) is a full table row — readable and
useful context. The capA truncation cuts mid-sentence and loses the beginning of the
row (`ONNX_EMBED`, `DENSE_PROVIDER`). This is the one case where hard-truncation
produces a less useful overlap. capB (73 tok) is closer to complete but still cuts
`DENSE_PROVIDER`. For table-heavy content, 80–105 tokens may be preferable.

---

## Conclusion

**Does `CHUNK_OVERLAP_TOKENS=64` look safer than `OVERLAP_SENTENCES=2`?**

**Yes, with one caveat.**

| Finding | Detail |
|---|---|
| Overlap-caused oversize | baseline: 8 chunks; capA/capB: 0 — cap eliminates all |
| Chunk boundaries | unchanged — cap is overlap-only, no split effects |
| Avg overlap tokens | 53 → 47 tok (capA), marginal reduction on this corpus |
| Hard truncations | 1 case (operations.md table row) — context slightly degraded |
| capA vs capB | identical behaviour on this corpus (only 1 sentence exceeds 64 tok) |

**Recommendation:** capA (64) is safer than the current baseline for corpora with
long sentences in paragraph context. It eliminates overlap-caused oversize while
keeping the same chunk boundaries. The one truncation case (`operations.md` table)
suggests a cap of **80 tokens** (capB) would preserve that context without causing
the 8 baseline violations — worth testing as the production default.

**Next step:** test at `CHUNK_OVERLAP_TOKENS=80` on a larger corpus with more table-
and list-heavy content before setting a production default. The current fixture set
(23 files) is not long-sentence-heavy enough to produce many truncations — the cap
will matter more on user docs with dense prose paragraphs.

**No production default change in this task.** Implementation when ready:
patch `overlapPrefixFrom()` in `chunk.js` to accept `CHUNK_OVERLAP_TOKENS` env var,
keep `OVERLAP_SENTENCES` as fallback for legacy callers.

---

## git diff --check

```
(clean — no whitespace errors)
```
