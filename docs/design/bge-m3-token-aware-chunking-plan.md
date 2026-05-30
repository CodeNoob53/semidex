# BGE-M3 Tokenizer-Aware Chunking — Design Plan

> Status: **implemented decision record**. Production default is now the real BGE-M3
> tokenizer; `TOKEN_COUNT=heuristic` is an explicit opt-out. Validated against the current
> codebase (2026-05-30). Supersedes the raw checklist items B/P0 and B/P1 from
> `docs/design/bge-m3-alignment-checklist.md` for the purpose of implementation planning.
> The checklist remains as a backlog tracker; items CE reranker (P1) and MCLS/domain-
> adaptive (P2) are **out of scope** for this plan.
>
> The sections below retain the original planning analysis. The final implementation
> intentionally differs from the preliminary fallback proposal: tokenizer files may be
> downloaded on first use, heuristic fallback is never silent, and old payloads are
> reindexed through `chunking_schema_version` + `token_count_mode`.

---

## 1. Original state — where `length/4` was used

Three sites in the codebase apply the character-based heuristic `Math.ceil(text.length / 4)`:

| File | Location | Role |
|------|----------|------|
| `src/indexer/phases/chunk.js` | line 27 (`const countTokens`) | Guards `MAX_CHUNK_TOKENS=400` in `_splitLevel`, `chunkBySentences`, `chunkSections` |
| `src/core/length-bucket.js` | line 15 (`estimateTokens`) | Groups texts into size buckets for ONNX batch embedding |
| `src/indexer/index.js` | line 246 (`tokensEst`) | Profiler-only metric; not a correctness gate |

`chunk.js` is the only site where the heuristic controls chunking decisions. `length-bucket.js` uses it for batching only, so it is not a retrieval correctness gate; however, its current "acceptable overestimate" comment is not true for every script and should be revisited when token counting work starts. `index.js` is telemetry.

---

## 2. Why `length/4` is risky for Cyrillic and multilingual corpora

The `chars/4` approximation was designed for ASCII-heavy text. BGE-M3 uses an XLM-RoBERTa SentencePiece vocabulary (250k tokens, multilingual). Token density varies significantly by script:

| Script | Approx chars per token | Consequence of `chars/4` |
|--------|------------------------|--------------------------|
| ASCII prose | ~4 | matches heuristic |
| Ukrainian/Russian Cyrillic | ~2–2.5 | heuristic **underestimates** tokens; real chunk is 1.6–2× over `MAX_CHUNK_TOKENS` |
| Mixed Markdown (tables, code) | varies | unpredictable; code identifiers often 1 token each |
| Chinese/Japanese/Korean | ~1–1.5 | also underestimates |

**Concrete impact on a `MAX_CHUNK_TOKENS=400` limit:**

A 1600-character Ukrainian prose section measures `Math.ceil(1600/4) = 400` tokens by the heuristic and is treated as exactly at the limit. The real BGE-M3 tokenization of the same text is closer to 650–800 tokens — 60–100% over the 512-token model limit. BGE-M3 internally truncates at 8192 tokens (as set in `onnx-embed.js` line 167), but dense+sparse quality degrades for chunks substantially exceeding the intended retrieval window of 400–512 tokens.

**For `length-bucket.js`:** the estimate affects batching efficiency, not chunking correctness. For Cyrillic it can under-estimate real token count and place text in a smaller bucket than ideal, but this does not change retrieval behavior. Bucketing does not need to change in the first implementation; its comment should be corrected if token counting work touches the file.

**For `index.js` line 246:** `tokensEst` is a profiler metric only, not used in any correctness gate. No change needed.

---

## 3. Proposed token counter API

### 3.1 Module: `src/core/token-count.js`

```js
/**
 * Returns a token counter function bound to the BGE-M3 tokenizer.
 * Loads the tokenizer lazily on first call (AutoTokenizer.from_pretrained).
 * Does NOT load the ONNX model or create an inference session.
 *
 * @param {{ mode?: 'bge-m3' | 'heuristic' }} [options]
 * @returns {Promise<(text: string) => number>}
 */
export async function getTokenCounter(options = {})

/**
 * Count tokens in a single text using the BGE-M3 tokenizer.
 * Equivalent to: (await getTokenCounter())(text)
 * Cached tokenizer is reused across calls.
 *
 * @param {string} text
 * @param {{ mode?: 'bge-m3' | 'heuristic' }} [options]
 * @returns {Promise<number>}
 */
export async function countTokens(text, options = {})

/**
 * Truncate text to at most maxTokens BGE-M3 tokens, returning the suffix.
 * Used for overlap: takeLastTokens(prevText, OVERLAP_TOKENS) gives the tail
 * of the previous chunk by real token count.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @param {{ mode?: 'bge-m3' | 'heuristic' }} [options]
 * @returns {Promise<string>}
 */
export async function takeLastTokens(text, maxTokens, options = {})
```

### 3.2 Sync vs async decision

`countTokens` **must be async** because `AutoTokenizer.from_pretrained` is async (fetches
tokenizer files from HuggingFace cache on first call). Subsequent calls reuse the cached
`tokenizer` module-level singleton and are fast (pure JS, no ONNX inference).

The existing `countTokens` constant in `chunk.js` (line 27) is sync. Migrating `chunk.js`
to async token counting requires either:

- (a) Making `recursiveChunkText` / `chunkBySentences` / `chunkSections` async, or
- (b) Pre-computing a text → token-count map before calling the chunker.

**Implemented resolution:** `chunkFile` remains synchronous for legacy benchmark callers,
while the production `chunkFileFromPath` path is async and uses the real tokenizer by
default. The approach is not to make a sync function secretly wait on async tokenizer
loading:

- load the tokenizer once before chunking starts;
- pass a `countFn` / `truncateFn` into the chunking helpers;
- keep legacy `chunkFile(...)` callers on the heuristic path until they are migrated.

Implementation note: verify whether the tokenizer object exposes a synchronous encode path.
If it does not, `TOKEN_COUNT=bge-m3` must use async chunking helpers end-to-end rather than
wrapping async calls inside sync chunking code.

### 3.3 Lazy loading — tokenizer only, not the ONNX model

The current `load()` function in `onnx-embed.js` (line 114) loads both the tokenizer and
the ~2.3 GB ONNX model in one call. For token counting at index time, **only the tokenizer
is needed** — the ONNX session is not required.

`src/core/token-count.js` must initialize only:
```js
tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
// NOT: ort.InferenceSession.create(...)
```

This avoids downloading the 2.3 GB ONNX data file when `ONNX_EMBED` is not set.

The tokenizer JSON files are small (~5 MB, cached in `./models/` by `env.cacheDir`).
Loading them takes ~100–300 ms cold, effectively instant on warm cache.

### 3.4 Fallback behavior (non-ONNX mode)

When `ONNX_EMBED` is not set, semidex uses Ollama for embeddings. In this configuration,
the BGE-M3 tokenizer files may not be cached.

Fallback policy:

| Condition | Token counter used | Behavior |
|-----------|-------------------|----------|
| Default, tokenizer cache exists | Real BGE-M3 tokenizer | Accurate counts |
| Default, tokenizer cache absent | Real BGE-M3 tokenizer | Download tokenizer files; hard-fail if unavailable |
| `TOKEN_COUNT=heuristic` | Heuristic | Explicit compatibility/offline opt-out |
| `TOKEN_COUNT=bge-m3` | Real BGE-M3 tokenizer | Explicit spelling of the default |

Real-tokenizer failures are explicit, not silent:
```
Unable to load BGE-M3 tokenizer. Check network/cache access or set TOKEN_COUNT=heuristic.
```

---

## 4. How the old `MAX_CHUNK_TOKENS=400` heuristic mapped to real tokenizer tokens

Before the production switch, `MAX_CHUNK_TOKENS=400` was a character-heuristic limit. It meant
"allow roughly 1600 characters before splitting", not "allow 400 BGE-M3 tokens".

In real BGE-M3 tokens:

- For English-heavy text, 1600 characters is often close to 400 real tokens, so the heuristic is usually tolerable.
- For Ukrainian/Russian Cyrillic, 1600 characters can be closer to 650–800 real BGE-M3 tokens, depending on morphology and punctuation.

Concrete example:

- Heuristic: `ceil(1600 / 4) = 400` → treated as exactly at the limit, no split.
- Real tokenizer: approximately 650–800 tokens → the chunk is **1.6–2× over** the intended 400-real-token budget.

So the bug is: the heuristic can pass a chunk as "within budget" when it is actually far over budget in real BGE-M3 tokens. The effective max chunk size for Cyrillic text can drift toward 700–900 real tokens when `MAX_CHUNK_TOKENS=400` is enforced via `chars/4`.

**Implemented migration:**

Keep `MAX_CHUNK_TOKENS=400`, but enforce it with the real tokenizer. Offline comparison
showed the old heuristic left 30 `docs/en/` chunks above 512 real tokens; the production
tokenizer path left none. Positional benchmark qrels are regenerated separately.

The existing checklist item "pack to ~512 not ~400" (for skeleton-first section merging)
should also be driven by real token counts once the counter is available.

---

## 5. Token-based overlap design

### 5.1 Current overlap

`OVERLAP_SENTENCES=2` (`chunk.js` line 25) adds 2 sentences from the previous sub-chunk.
This is applied in `context.js` overlap phase, not in the chunker itself. The comment in
`chunk.js` line 57-58 confirms: "No overlap here; indexing overlap is applied after
merge/split boundary decisions."

`context.js:45` (referenced in the checklist): overlap is reset at heading boundaries.

### 5.2 Proposed `CHUNK_OVERLAP_TOKENS`

New env: `CHUNK_OVERLAP_TOKENS` (default: `0` initially, preserving current behavior).

The overlap applies at the sub-chunk boundary level (where `needsBoundaryCheck: true`
is set). The implementation uses `takeLastTokens(prevChunkText, CHUNK_OVERLAP_TOKENS)` to
take the real-token tail of the previous chunk and prepend it to the current one.

```
prevChunk: "...sentence A. Sentence B. Sentence C."
overlap    = takeLastTokens(prevChunk, 75)  // e.g. "Sentence B. Sentence C."
nextChunk  = overlap + "\n\n" + nextChunk
```

**Token budget:** 75 real tokens ≈ 15% of 512, matching the checklist recommendation of
50–100 tokens for 512-token chunks.

### 5.3 Interaction with the post-merge overlap phase

After the overlap/merge duplication fix, the current pipeline has one overlap phase:

1. `chunk.js` marks split boundaries with `needsBoundaryCheck: true`, but does not
   prepend overlap text.
2. `context.js` decides merge vs split first, then applies `OVERLAP_SENTENCES=2` only
   to chunks that remain split. It resets overlap at heading/source boundaries.

If `CHUNK_OVERLAP_TOKENS` is introduced, it replaces the sentence-tail logic in
`context.js`, not a pre-merge overlap inside `chunk.js`. Merge/boundary behavior is not
changed in this design. The heading-boundary reset remains: overlap does not bleed
across structural section boundaries. This is correct behavior (different sections
should not overlap).

**Risk:** both `OVERLAP_SENTENCES` and `CHUNK_OVERLAP_TOKENS` being non-zero would
double-apply overlap. The implementation should treat them as alternatives: if
`CHUNK_OVERLAP_TOKENS > 0`, the sentence-based overlap is disabled. Document this clearly.

---

## 6. Interaction with skeleton-first chunking

### 6.1 Where token counting occurs in the skeleton pipeline

`skeleton-first-chunking-impl-spec.md` §3.4 specifies that `chunkFromSkeleton` reuses
`recursiveChunkText` from `chunk.js` for prose splitting. Therefore, if `recursiveChunkText`
is updated to accept a real token counter, `chunkFromSkeleton` inherits accurate token
sizing automatically.

### 6.2 Implications for `boundedRaw` (table/code excerpts)

`skeleton-first-chunking.md` §8 specifies:
```
boundedRaw: default=200 tokens, table=300, code_block=400
```

These are currently estimated in "token" units but the design doc uses the word "tokens"
without specifying heuristic vs real. When the real token counter is available, `boundedRaw`
should be enforced by real token count — the `takeLastTokens` equivalent for prefix truncation.

### 6.3 `isContentBearing` threshold

`MIN_CONTENT_TOKENS` (default 4, `skeleton-first-chunking-impl-spec.md` §3.3) controls
whether a prose node emits a retrieval point. This threshold is small enough that
heuristic vs real tokenizer makes no practical difference. Keep as-is.

### 6.4 Skeleton-first does not change the token counter migration risk

The skeleton pipeline is behind `SKELETON_CHUNKING=1`. Token counting is behind
`ONNX_EMBED=1` (or lazy load). These are independent feature flags. No coupling needed.

---

## 7. Migration risk for existing benchmarks and qrels

### 7.1 Chunk index renumbering

The current Qdrant point ID scheme is:
```
makePointId({ collection, sourceFile, chunkIndex, embeddingSchemaVersion })
```
(`src/core/point-id.js`, used in `index.js` line 193–197)

Changing `countTokens` changes split points → changes chunk count → changes `chunkIndex` →
changes point IDs → **all points for a file are orphaned and re-created on next index**.

This is expected behavior (the `deleteTrailingChunks` + `deleteBySourceFile` mechanism
handles it). However:

- **qrels using `source_file#chunk_index`** become invalid after the first re-index with
  the new token counter, because chunk boundaries shift.
- The custom-50 benchmark uses qrels. Changing the token counter requires re-running
  the benchmark and verifying that the qrel `chunk_index` values still match actual chunks.
- **Mitigation:** run the benchmark with both old and new counters, compare chunk-level
  retrieval metrics, then decide whether to ship.

### 7.2 Anchor-based qrel alternative

The skeleton-first design introduces `node_id` (stable hash of structural path, not
positional index). `node_id`-based qrels are immune to reordering unless the file
structure changes. This is the long-term solution, but it requires the skeleton pipeline
to be active.

Implemented migration:
1. Production indexing uses the real tokenizer by default.
2. Each point stores `chunking_schema_version` and `token_count_mode`; stale payloads
   trigger a reindex instead of mixing old and new boundaries.
3. Benchmark qrels referencing positional `chunk_index` are regenerated after the
   switch. They do not block the production correctness fix.

### 7.3 Tokenizer loading and indexing startup time

Loading `AutoTokenizer.from_pretrained(MODEL_ID)` on a warm cache takes ~100–300 ms.
This is a one-time cost per process (lazy singleton). For large indexing runs (hundreds
of files), this is negligible. For single-file or smoke runs, it adds a visible but
tolerable delay.

If `ONNX_EMBED=1` is already set, both paths reuse the same cached tokenizer files.
The current modules keep separate in-memory tokenizer singletons, so a small
one-time tokenizer initialization cost may still occur in each path; no second
network download is required.

If `ONNX_EMBED` is not set, tokenizer JSON files may still be downloaded into the
HuggingFace cache directory. This is intentional: production chunking must not silently
degrade based on cache state. Users who need the old approximation can explicitly set
`TOKEN_COUNT=heuristic` (see §3.4).

---

## 8. Benchmark and validation plan

### 8.1 What to measure

Run both counters side by side on each corpus, recording:

| Metric | Description |
|--------|-------------|
| `chunk_count` | Total chunks produced |
| `avg_real_tokens` | Mean real BGE-M3 token count per chunk |
| `oversized_chunks` | Chunks exceeding 512 real tokens |
| `boundary_count` | Number of split boundaries introduced |
| `overlap_token_ratio` | Overlap tokens / chunk tokens (when overlap enabled) |
| `nDCG@5`, `Recall@1`, `MRR@5` | custom-50 retrieval metrics |
| `qrel_validity` | Fraction of qrel entries that still resolve to a valid chunk |

### 8.2 Required corpora

| Corpus | Purpose | Notes |
|--------|---------|-------|
| `benchmarks/retrieval/custom-50/` | Regression baseline | Primary eval set; qrels exist |
| Ukrainian synthetic fixture | Cyrillic token density | Create: short prose paragraphs, mixed headings; no private data |
| Mixed Markdown (tables + code) | Structural edge cases | Use existing semidex `.md` docs |
| Long prose section | Boundary placement | Take a real long section from the semidex design docs |

The Ukrainian synthetic fixture must be **created fresh**, not copied from private corpora.
It should contain: 5–10 paragraphs of Ukrainian prose at various lengths (200–800 chars),
headings in Ukrainian, at least one code block, at least one table.

### 8.3 Comparison strategy

Three counter variants to compare:

1. **Heuristic** — current `Math.ceil(text.length / 4)`. Baseline.
2. **Real BGE-M3 tokenizer** — `AutoTokenizer.from_pretrained('aapot/bge-m3-onnx')`.
3. **Cheap multilingual approximation** (optional) — e.g. `Math.ceil(text.length / 3)`
   for Cyrillic (2.5 chars/token average) or script-detection with per-script divisors.
   Only worth pursuing if the real tokenizer proves too slow for indexing throughput.

For option 3: measure indexing throughput (files/minute) with real tokenizer vs heuristic.
If throughput drops >10% on a representative workload, the cheap approximation is worth
implementing as an intermediate step.

### 8.4 Success criteria before making it default

- `oversized_chunks` (>512 real tokens) reduced by ≥50% on the Cyrillic fixture.
- `nDCG@5` on custom-50 does not decrease (within noise margin ±0.02).
- `qrel_validity` on custom-50 after qrel regeneration: 100% (all entries still resolve).
- No increase in `chunk_count` >20% (over-splitting is its own retrieval quality risk).
- Indexing throughput: no >10% regression on the standard corpus.

---

## 9. Explicit risks summary

| Risk | Severity | Mitigation |
|------|----------|-----------|
| qrel `chunk_index` invalidated by re-chunking | High | Re-run benchmark after switch; document regeneration requirement |
| Tokenizer download triggered unexpectedly | Medium | Fallback to heuristic when cache absent; log warning |
| Tokenizer load adds 300ms startup | Low | One-time per process; acceptable |
| Both `OVERLAP_SENTENCES` and `CHUNK_OVERLAP_TOKENS` non-zero | Medium | Treat as mutually exclusive; document and assert |
| Over-splitting: real-token limit is stricter → more chunks | Medium | Monitor `chunk_count` metric; adjust limit if needed |
| Fallback mode silently producing very different chunking | High | Fallback must log explicitly; never silent unless `TOKEN_COUNT=heuristic` set deliberately |

---

## 10. Original implementation sequence (P0 only)

This section preserves the original staged proposal. The final decision promoted the
real tokenizer to production default immediately after smoke coverage and migration
guards were added. CE reranker, MCLS, and domain-adaptive chunk profiles remain out of
scope.

```
Step 1  Create src/core/token-count.js
        - getTokenCounter(options), countTokens(text, options), takeLastTokens(text, n, options)
        - Lazy singleton; tokenizer only, not ONNX session
        - Fallback to heuristic when cache absent, with explicit log
        - Unit-testable without ONNX_EMBED

Step 2  Instrument chunk.js (no behavior change yet)
        - Log real token count alongside heuristic for N% of chunks (sample)
        - Collect data on custom-50 and Ukrainian fixture
        - Do not change split decisions yet

Step 3  Ukrainian synthetic fixture
        - Create benchmarks/retrieval/fixtures/ua-prose-synthetic.md
        - 8–10 paragraphs, mixed headings, one table, one code block
        - Verify no private content

Step 4  Benchmark run — heuristic vs real tokenizer
        - Run custom-50 with both counters
        - Record all metrics from §8.1
        - Decision gate: if oversized_chunks >10% of total on any corpus, proceed
          to Step 5; otherwise document and revisit

Step 5  Wire real counter into chunk.js (initially behind TOKEN_COUNT=bge-m3 flag)
        - Modify _splitLevel / chunkBySentences to accept countFn parameter
        - Default countFn = heuristic (no behavior change without flag)
        - TOKEN_COUNT=bge-m3 injects real counter

Step 6  Overlap: add CHUNK_OVERLAP_TOKENS (behind same flag or separate)
        - takeLastTokens applied at needsBoundaryCheck boundaries
        - Disables OVERLAP_SENTENCES if CHUNK_OVERLAP_TOKENS > 0

Step 7  Re-run full benchmark
        - Regenerate qrels if chunk boundaries changed
        - Confirm success criteria from §8.4

Step 8  Documentation and decision
        - Completed with real BGE-M3 token counting as production default
        - Keep TOKEN_COUNT=heuristic as the explicit compatibility/offline opt-out
        - Update checklist items B/P0 and B/P1 to reflect outcome
```

---

## 11. Relationship to existing checklist

`docs/design/bge-m3-alignment-checklist.md` remains valid as a **backlog tracker**.
This document supersedes the implementation details for items B/P0 (token counter) and
B/P1 (overlap). The following items are deliberately **not addressed** here and remain
in the checklist:

- B/P1 — CE reranker evaluation (`bge-reranker-v2-m3` vs heuristic). Requires separate
  benchmark scope.
- B/P1 — skeleton-first target sizes (512 vs 400 for prose merging). Depends on
  skeleton-first chunking being implemented first.
- B/P1 — `qdrant_get_content` parent context window (~1000–1500 tokens). Part of
  skeleton-first MCP tools, not the token counter.
- B/P2 — MCLS, domain-adaptive chunk profiles. Post-skeleton, low priority.

The checklist item "B/P0 — замінити `length/4` на реальний токенайзер" is complete and
points to this document plus the production-default report.

---

## 12. Implemented file map

| File | Implemented change |
|------|---------------|
| `src/core/token-count.js` | Created: real tokenizer counter, explicit heuristic fallback, bounded memo-cache |
| `src/indexer/phases/chunk.js` | Production async tokenizer-aware path added; legacy sync helper retained |
| `src/core/length-bucket.js` | **No behavior change** — batching only; correct the comment if this file is touched |
| `src/indexer/index.js` | Stores chunking metadata and triggers safe reindex on mismatch |
| `src/core/onnx-embed.js` | **No change** — embedding path keeps its existing tokenizer; both paths reuse cached files |
| `benchmarks/retrieval/fixtures/ua-prose-synthetic.md` | Created public synthetic fixture |
