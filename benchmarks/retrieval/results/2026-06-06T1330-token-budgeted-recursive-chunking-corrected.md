# Token-Budgeted Recursive Chunking — Corrected Benchmark

**Date:** 2026-06-06
**Command:** `node .tmp/recursive-budget-bench-v2.mjs`
**Corpus:** 20 .md files (deduplicated by filename across 3 dirs)
  - `benchmarks/retrieval/fixtures/docs` (4 files)
  - `benchmarks/retrieval/custom-50/fixtures/docs` (6 files; shared deduplicated)
  - `docs/en` (13 files; shared deduplicated)
**Token counter:** BGE-M3 (real tokenizer via `getTokenCounter`)
**Production baseline:** `chunkFileFromPath()` called directly — not reimplemented.
**No production code changed.**

> **Supersedes `2026-06-06T1200-token-budgeted-recursive-chunking.md`.**
> That report had two correctness problems:
> 1. Baseline was a local reimplementation that produced 354 chunks instead of
>    the production 358. Not the same code path.
> 2. `takeLastTokens()` was used directly for overlap without word-boundary
>    snapping. It binary-searches character offsets and can return a suffix
>    starting mid-word (e.g. `"kenizer-aware chunking..."`). The T1200 report
>    claimed word-boundary safety without verifying it.
>
> Do not use the T1200 report as production evidence.

---

## Word-boundary safety

The previous benchmark used `takeLastTokens()` (from `src/core/token-count.js`)
which does a binary search on char offsets. This can return a suffix starting
mid-word when the token boundary falls inside a word.

This benchmark uses a local helper `safeTakeLastTokens()` that:
1. Does the same binary search to find a suffix with count ≤ cap.
2. Checks whether the char at `start` is a non-whitespace continuation of a word
   that started before `start` (i.e. prev char is `\S` and cur char is `\S`).
3. If mid-word: snaps start forward to the next `\s` match (regex whitespace —
   handles `\t`, `\r`, `\n`, non-breaking space, not just `' '` or `'\n'`).
4. If no whitespace exists after that point: omits overlap entirely (counted as
   `omitted`, not truncated mid-word).

**Handcrafted unit tests (5 cases, including `\t` and `\r\n`):**
All 5 passed — no mid-word overlap produced.

**Corpus-wide verification — every generated overlap checked against its source:**

| Variant | Overlap candidates | Adjusted | Omitted | Corpus violations |
|---|---|---|---|---|
| candA | 72 | 39 | 0 | 0 |
| candB | 43 | 21 | 0 | 0 |
| candC | 40 | 15 | 0 | 0 |
| candD | 21 | 8 | 0 | 0 |

**Key finding:** 39/72 (54%) of candA overlap candidates required word-boundary
adjustment. This confirms `takeLastTokens()` alone is not safe for overlap without
snapping. Zero corpus violations across all variants — the snap-forward logic
worked correctly on all 176 generated overlaps.

---

## Production baseline sanity check

`chunkFileFromPath()` is called directly. Per-file chunk counts:

| File | Chunk count |
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

Matches expected sanity target (358). T1200 had 354 — a 4-chunk shortfall from
the reimplementation divergence.

**Baseline body/overlap not separable:** `chunkFileFromPath()` returns final `text`
only. Overlap-caused oversize cannot be counted directly from baseline output without
adding instrumentation to `chunkFileAsync`. Baseline overlap stats are `n/a` below.

---

## Budget model (candidates)

**Conservative model used in this benchmark:**

```
maxBody = MAX_CHUNK_TOKENS - CHUNK_OVERLAP_TOKENS
```

Every body chunk is split to fit within `maxBody` regardless of how much overlap
is actually selected at that boundary. This guarantees `finalTokens ≤ MAX` in
all cases but **underfills chunks** when actual overlap < cap — body was already
capped at MAX-64=336 even if the previous chunk only produces 20 tokens of overlap.

The underfill examples section below shows this concretely: the smallest candB
body chunks are 4–14 tokens (section stubs like ` ``` ` fences), well under
maxBody=432. These could fit more body text under a dynamic model.

**A dynamic model** (split body to MAX first, then select overlap only if
`overlap + body ≤ MAX`, else reduce/omit overlap) would pack chunks more densely
but is more complex to implement correctly and verify. That is future work; not
implemented here.

---

## Variant settings

| Variant | MAX_CHUNK_TOKENS | MIN_CHUNK_TOKENS | CHUNK_OVERLAP_TOKENS | maxBody (conservative) |
|---|---|---|---|---|
| production baseline | 400 | 30 | OVERLAP_SENTENCES=2, post-boundary | n/a |
| candA | 400 | 256 | 64 | 336 |
| candB | 512 | 160 | 80 | 432 |
| candC | 512 | 128 | 64 | 448 |
| candD | 656 | 128 | 96 | 560 |

`MAX_CHUNK_TOKENS` is the hard budget for `finalText = overlap + body`. With the
conservative model, `maxBody = MAX - CHUNK_OVERLAP_TOKENS` is the effective body cap.
No separate `HARD_MAX` field is needed — `MAX_CHUNK_TOKENS` already acts as the hard
ceiling and is verified by the corpus-wide check above.

---

## Summary metrics

| Metric | production baseline | candA | candB | candC | candD |
|---|---|---|---|---|---|
| total chunks | 358 | 373 | 344 | 341 | 322 |
| min tokens | 4 | 4 | 4 | 4 | 4 |
| p10 tokens | 55 | 58 | 56 | 55 | 46 |
| p50 tokens | 152 | 160 | 156 | 151 | 147 |
| p90 tokens | 349 | 317 | 383 | 397 | 460 |
| max tokens | 576 | 391 | 477 | 502 | 645 |
| < 128 tok | 147 (41.1%) | 144 (38.6%) | 138 (40.1%) | 142 (41.6%) | 138 (42.9%) |
| < 200 tok | 220 (61.5%) | 221 (59.2%) | 209 (60.8%) | 210 (61.6%) | 203 (63.0%) |
| < 256 tok | 260 (72.6%) | 271 (72.7%) | 244 (70.9%) | 247 (72.4%) | 234 (72.7%) |
| > MAX tok (any) | 8 (2.2%) | **0** | **0** | **0** | **0** |
| > 512 tok | 3 (0.8%) | 0 | 0 | 0 | 16 (5.0%) |
| > 656 tok | 0 (0.0%) | 0 | 0 | 0 | 0 |
| avg overlap tok | n/a | 62 | 78 | 61 | 92 |
| max overlap tok | n/a | 64 | 80 | 64 | 96 |
| chunks with overlap | n/a | 72 | 43 | 40 | 21 |
| no-safe-overlap boundaries | 0 | 0 | 0 | 0 | 0 |
| word-boundary adjusted | n/a | 39 | 21 | 15 | 8 |
| word-level fallback splits | 0 | 0 | 0 | 0 | 0 |
| pathological chunks | 18 | 22 | 21 | 22 | 19 |

### Observations

**Baseline 8 chunks > MAX=400:** Body/overlap separation is not available from
`chunkFileFromPath()` output. Some of these 8 may be overlap-caused (body ≤ 400,
overlap pushes over); others may be body-alone oversize from unsplittable table
sections. Without instrumentation, this cannot be confirmed. All 8 have
`finalTokens > 400`.

**All candidates: 0 chunks > MAX.** The conservative budget model enforces this
structurally. candD has 16 chunks between 512–645 (within its MAX=656).

**candA (400/256/64):** Most chunks (+15 vs baseline). MIN=256 prevents merging
short section stubs that baseline merges at MIN=30. The 39 word-boundary adjustments
confirm `takeLastTokens` alone is not safe.

**candB (512/160/80):** 344 chunks, 14 fewer than baseline. maxBody=432 is large
enough to avoid splitting sections that baseline splits. No oversize, no omitted
overlaps. candB and candC differ only by MIN (160 vs 128) which shows a small
effect: candC=341 vs candB=344.

**candD (656/128/96):** Lowest chunk count (322). The 16 chunks between 512–645
are large table/code-block sections that cannot be split further. All within MAX=656.
Only 21 overlap candidates (fewer section boundaries within budget for overlap).

---

## Per-file chunk counts

| File | production baseline | candA | candB | candC | candD |
|---|---|---|---|---|---|
| README.md | 3 | 3 | 2 | 2 | 1 |
| architecture.md | 15 | 16 | 14 | 14 | 14 |
| benchmark-dataset-plan.md | 25 | 28 | 23 | 24 | 22 |
| benchmarking.md | 21 | 21 | 21 | 21 | 21 |
| ce-rerank-design.md | 44 | 44 | 41 | 41 | 38 |
| chunking-quality.md | 21 | 22 | 21 | 21 | 21 |
| chunking.md | 9 | 9 | 9 | 9 | 9 |
| config-env.md | 12 | 12 | 12 | 12 | 12 |
| configuration.md | 36 | 38 | 35 | 34 | 31 |
| mcp-tools.md | 14 | 14 | 13 | 12 | 11 |
| mcp-workflow.md | 9 | 9 | 9 | 9 | 9 |
| multilingual.md | 9 | 9 | 9 | 9 | 9 |
| obsidian.md | 7 | 7 | 7 | 7 | 7 |
| operations.md | 32 | 34 | 31 | 30 | 28 |
| project-structure.md | 10 | 10 | 10 | 10 | 9 |
| providers.md | 6 | 6 | 6 | 6 | 6 |
| qdrant.md | 8 | 8 | 8 | 8 | 8 |
| retrieval.md | 38 | 42 | 36 | 35 | 30 |
| roadmap.md | 33 | 35 | 31 | 31 | 30 |
| sync.md | 6 | 6 | 6 | 6 | 6 |

`benchmarking.md` is identical across all variants (21). Its sections are already
at stable split points that no MIN/MAX combination tested can change.

---

## Pathological chunk inventory (production baseline)

| File | Section | Flags | Tokens |
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

18 pathological blocks. Many are in `retrieval.md` (benchmark result tables with
pipe-separated metric values — no whitespace around pipes, hence `long-no-whitespace`).
These are within finalTokens bounds. Skeleton/entity handling is out of scope here.

The two largest blocks (`retrieval.md/Relevant Environment Variables` = 576,
`benchmark-dataset-plan.md/3. Query Taxonomy` = 525) are in the production
baseline at 576 and 525 tokens — both above 400 MAX. These are unsplittable
table bodies. All candidates cap overlap so they do not grow further, but the
body itself cannot be reduced without splitting within a table row.

---

## Examples

### 5 boundary examples (candB, overlap present, within budget)

Body and overlap are stored separately. `overlap:` shows only the overlap prefix;
`body start:` shows only the body text beginning.

**B1** — project-structure.md / Source Tree
  finalTok=434  bodyTok=356  overlapTok=80  level=sentence
  overlap: `"embedding phase │   │       ├── link.js        # Semantic linking phase │   │       └── tag.js"`
  body start: `json with live Qdrant collections ├── benchmarks/ │   ├── retrieval/ │   │   ├── run.js ...`
  Note: overlap is a tree-diagram line — readable, correctly bounded.

**B2** — benchmark-dataset-plan.md / `custom-150`
  finalTok=161  bodyTok=83  overlapTok=80  level=paragraph
  overlap: `"| Must include at least 5 completely off-domain queries | | window-dependent | 5 | Lower priority;"`
  body start: `If annotating 150 queries is too costly in one session, prioritize: exact-token, config-env...`
  Note: body is prose, overlap is prior table row — gives context for the recommendation.

**B3** — benchmark-dataset-plan.md / 9. Implementation Plan
  finalTok=377  bodyTok=299  overlapTok=80  level=paragraph
  overlap: `"a custom-150 runner. Either extend run-v3.js with a BENCH_DATASET env var, or copy cr"`
  body start: `5. Run and record custom-150 baseline. Run hybrid-true and det-rerank on custom-150 with...`
  Note: word-boundary adjustment occurred (overlap was snapped off `cr` → `custom-150`). Body continues the plan.

**B4** — ce-rerank-design.md / 2. Env/Config Proposal
  finalTok=459  bodyTok=381  overlapTok=80  level=sentence
  overlap: `"warn and use text+meta. | | RERANK_CE_TOP_N | 40 | 1–500 | Candidates from the RRF pool pa"`
  body start: `Must be >= top; if not, warn and clamp to top. | | RERANK_CE_TIMEOUT_MS | 10000 | 100–120000 |`
  Note: table continuation — overlap gives column context for the next row.

**B5** — ce-rerank-design.md / Full candidate flow
  finalTok=293  bodyTok=215  overlapTok=80  level=paragraph
  overlap: `"ceRerank(candidates.slice(0, RERANK_CE_TOP_N), query, { finalLimit: top }) [Stage 3 — slice] resu"`
  body start: `CE reranks the det-rerank output when RERANK_ENABLED=1 RERANK_CE_ENABLED=1. Det-rerank applies...`

### 5 largest chunks (production baseline)

Body/overlap n/a — production baseline returns final text only.

**W1** — retrieval.md / Relevant Environment Variables
  finalTok=576 — full env-var reference table; unsplittable (one table body section).

**W2** — operations.md / Troubleshooting
  finalTok=548 — troubleshooting table with long rows; overlap from previous section
  prepended, pushing this above 400.

**W3** — benchmark-dataset-plan.md / 3. Query Taxonomy
  finalTok=525 — full query taxonomy table (header + 10 rows in one section).

**W4** — operations.md / Troubleshooting
  finalTok=458 — second troubleshooting table chunk; similar pattern.

**W5** — configuration.md / ONNX_EXECUTION_PROVIDER
  finalTok=442 — execution provider option table + prose.

### 5 examples of conservative budget underfill (candB)

These show where maxBody=432 wastes token budget on section stubs.

**U1** — operations.md / (section stub)
  finalTok=4  bodyTok=4  overlapTok=0
  Body is a lone ```` ``` ```` fence line. Cannot be merged across section boundary.
  Budget waste: 428 tokens of maxBody unused.

**U2–U4** — benchmarking.md / (command-only sections)
  finalTok=5–11  bodyTok=5–11  overlapTok=0
  Single `npm run ...` lines that are the entire section content.
  Cannot merge across section boundaries; not first chunks (first chunks of section).

**U5** — benchmarking.md / Comparison: ollama vs onnx
  finalTok=14  bodyTok=14  overlapTok=0

These are structural: single-line code sections created intentionally in the docs.
A dynamic budget model would not fix this — the issue is that short sections cannot
be merged across headings.

---

## Empty / overlap-only chunk check

| Variant | Empty | Overlap-only (bodyTokens=0) |
|---|---|---|
| production baseline | 0 | 0 |
| candA | 0 | 0 |
| candB | 0 | 0 |
| candC | 0 | 0 |
| candD | 0 | 0 |

No empty or overlap-only chunks in any variant.

---

## Known limitations

1. **Conservative budget model underfills chunks.** `maxBody = MAX - cap` is
   applied uniformly. Chunks where actual overlap < cap leave token budget on
   the table. Extent: visible in U1–U5 above (stub sections), and in any
   boundary where the previous chunk is short.

2. **Production baseline body/overlap not separable.** `chunkFileFromPath()`
   returns final `text` only. The 8 chunks > 400 in the baseline may be
   overlap-caused, body-alone oversize, or a mix — not distinguishable without
   adding body/overlap tracking to `chunkFileAsync`.

3. **Corpus is 20 files / ~350 chunks.** MIN_CHUNK_TOKENS differences (128 vs
   160) show only small effects (341 vs 344 chunks). A larger corpus with more
   short-paragraph sections would differentiate these better.

4. **No retrieval validation.** MRR/recall impact of candidates is unknown.
   Production adoption requires running `npm run bench:custom50` after reindexing.

5. **Word-boundary snapping reduces effective overlap.** 39/72 candA candidates
   were adjusted. The adjustment discards some tokens (moved to next whitespace),
   so actual overlap may be slightly shorter than the cap. This is correct behaviour
   but means `avg overlap tok` (62 for candA) is lower than cap (64) on this corpus.

---

## Recommendation

**Directionally promising, not production-ready.**

| Step | Action |
|---|---|
| 1. Design dynamic budget model | Replace `maxBody=MAX-cap` with: pack body to MAX, then select `min(cap, MAX-bodyTok)` overlap. More complex but eliminates underfill. |
| 2. Instrument production baseline | Expose `bodyText` + `overlapText` from `chunkFileAsync` (or add a separate measurement run) to count overlap-caused oversize directly. |
| 3. Validate word-boundary helper | The corpus showed 0 omitted overlaps, but 39 adjustments on candA. Verify `safeTakeLastTokens` on a corpus with more long-no-whitespace content (e.g. dense code/URL blocks). |
| 4. Retrieval benchmark | Index custom-50 with candB settings (512/160/80), run `npm run bench:custom50`, compare MRR and chunkRecall@5 against current production baseline. No production default change before this. |
| 5. Defer skeleton work | Long table/code blocks remain unsplit. This is the dominant source of large chunks and is a separate architectural concern. |

---

## git diff --check

```
(clean — no whitespace errors)
```
