# MCP Agent UX Polish v2 Live Retest

Date: 2026-05-25
Collection: private large music collection (13,195 points, bge-m3-onnx/bge-m3-onnx)
Purpose: Validate agent workflow improvements after navigation/tag UX polish v2.

## Summary

**Verdict: PASS**

Both Test A and Test B completed without friction. The agent followed the
intended navigation funnel (collection_info → list_directories → list_files →
search → tags → find_by_tag → get_chunk) cleanly and without blind guesses.
Tag discovery via `contains=` produced accurate, scoped results. The
`find_by_tag` density grouping surfaced additional skill/template areas that
plain search did not return. `get_chunk` output correctly
reported raw `chunk_index` alongside display position (e.g., chunk_index 26 →
display 27/30).

---

## Tool Call Counts

| Test | collection_info | list_directories | list_files | list_tags | search | find_by_tag | get_chunk | total |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| A — Unknown Structure / Release Promotion | 1 | 2 | 2 | 0 | 1 | 0 | 0 | 6 |
| B — Tag Discovery / Breadth Expansion | 0 | 0 | 0 | 3 | 0 | 2 | 1 | 6 |
| **Total** | **1** | **2** | **2** | **3** | **1** | **2** | **1** | **12** |

---

## Test A: Unknown Structure / Release Promotion

### What Claude Did

1. Called `qdrant_collection_info()` — confirmed the target collection exists,
   has 13,195 points, and uses the bge-m3-onnx provider.
2. Called `qdrant_list_directories(depth=2)` — discovered top-level split:
   a small documentation area and a large genre taxonomy area.
3. Called `qdrant_list_files(source_prefix="<documentation area>/")` —
   confirmed that area was not the primary release-promotion content source.
4. Called `qdrant_search("music release promotion plan marketing strategy",
   top=5, window=1, window_format="compact")` — immediately surfaced
   the reference promotion area with high-relevance hits: social media
   guidance, promotion workflow, platform comparison, and a reference index.
5. Called `qdrant_list_directories(source_prefix="<reference area>/", depth=2)`
   — mapped promotion, release, workflow, and related subareas.
6. Called `qdrant_list_files(source_prefix="<reference promotion area>/")` —
   confirmed several promotion-focused files without recording private file
   names in this report.

### Friction

- None observed. No blind prefix attempts, no guessed source_file paths.
- Search results already named the reference promotion area, so list_directories
  step 5 was confirmatory rather than exploratory — an acceptable pattern.

### Result

Agent correctly identified a 2–4 week release promotion plan anchored in:
- A 2-week content calendar template (T-14 to T+14) in a social-media
  best-practices guide
- Campaign planning checklist (pre-release / release week / post-release) in a
  promotion workflow guide
- Platform-specific tips (Spotify editorial 4+ weeks ahead, SoundCloud tags,
  Bandcamp bonus content) in a release platform comparison guide

No raw private chunk text captured in report. Answer quality was well-grounded.

---

## Test B: Tag Discovery / Breadth Expansion

### What Claude Did

1. Called `qdrant_list_tags(contains="release", limit=30)` — returned 278 tags
   matching the substring; showed top 30 by chunk count. Key tags:
   `album-release` (45 chunks, 28 files), `release-strategy` (6 chunks, 3
   files), `release-workflow`, `release-management`.
2. Called `qdrant_list_tags(contains="social", limit=20)` — 45 matching tags.
   Key: `social-media` (41 chunks, 25 files), `social-media-strategy` (4
   chunks, 3 files), `social-media-copy`, `social-media-engagement`.
3. Called `qdrant_list_tags(contains="promo", limit=20)` — 76 matching tags.
   Key: `promotion` (14/11), `promo-video` (11/11), `music-promotion` (7/6),
   `album-promotion` (6/6), `pre-release-promotion`.
4. Called `qdrant_find_by_tag(tags=["release-strategy","social-media-strategy"],
   limit=50)` — 9 chunks across 5 files, density-sorted:
   a quick-start release workflow file (3 chunks), a social-media guide (2
   chunks), and a promotion-writing skill file (2 chunks).
5. Called `qdrant_find_by_tag(tags=["music-promotion","album-promotion",
   "pre-release-promotion"], limit=50)` — 13 chunks across 10 files.
   Surfaced additional skill and promo-template areas not visited during Test A.
6. Called `qdrant_get_chunk(source_file="<promotion workflow file>",
   chunk_index=27, window=1)` — correctly returned chunk 26 as display 27/30,
   plus neighbors 26 and 28. Confirmed chunk_index vs display position labeling
   works as expected.

### Friction

- None observed. The agent used `contains=` correctly for all three tag
  lookups — no unfiltered top-100 dump on the full 13K-point collection.
- No confusion between `source_prefix` and `tag_prefix` parameters.
- The 278-tag "release" result set was large but returned correctly truncated
  at limit=30 with a count header, so the agent could pick the relevant subset.

### Result

Tags expanded breadth beyond plain search:
- Plain search (Test A) found reference promotion/release material and a
  reference index.
- Tag path (Test B) additionally found relevant skills and promo-template
  areas.

The density-sorted `find_by_tag` output made the highest-signal files
(multi-chunk files) immediately visible at the top of each result, reducing
scan effort.

---

## Before vs After

| Dimension | Before polish v2 | After polish v2 (this run) |
|-----------|-----------------|---------------------------|
| Directory map | No `list_directories` tool — agent guessed prefixes | `list_directories` used correctly at depth=2; no guessing |
| File discovery | Blind `source_file` guesses or ignored | `list_files(source_prefix=...)` used after directory map |
| Tag listing | No `contains`/`tag_prefix` — unfiltered dumps or skipped | `contains=` used for all 3 tag queries; scoped correctly |
| `source_prefix` vs `tag_prefix` confusion | Documented risk in prior notes | Not observed — parameters used correctly throughout |
| `find_by_tag` output | Flat chunk list — hard to prioritize | Density-grouped by file; highest-coverage files first |
| `get_chunk` position labeling | Ambiguous "chunk N" — unclear if 0-indexed or display | Now shows both: `chunk_index: 26, display: 27/30` — unambiguous |

---

## Remaining Issues

None blocking. Minor observations only:

1. **`list_tags(contains="release")` returns 278 matches** — the `limit=30`
   truncation works, but the count "Found 278 tags" with no frequency sort
   beyond chunk count may tempt agents to page through rather than refine
   further. Consider documenting a best practice: combine `contains=` with
   `source_prefix=` when the directory is already known, to scope tag counts to
   the relevant area.

2. **`list_directories` depth=1 default** — on a collection this large, depth=1
   returns only top-level areas, which is correct. But an agent that doesn't
   know to drill with `source_prefix="<known area>/"` at depth=2 could miss a
   useful subdirectory breakdown. This is acceptable behavior but could be
   noted in the tool description ("use source_prefix to drill into a known
   top-level dir").

3. **The genre taxonomy area is very large** — hundreds of genre
   subdirectories. If an agent's task is genre-specific,
   `list_directories(source_prefix="<genre taxonomy area>/", depth=1)` would
   dump a large list. The `limit=100` default truncates
   silently. Consider whether the truncation message should be more prominent
   ("showing 100 of N — use source_prefix to narrow").

---

## Recommendation

**Keep tools as-is.** The navigation funnel works correctly end-to-end.

Minor docs tweaks worth considering (non-blocking):
- Add a note to `qdrant_list_tags` description: "Combine `contains=` with
  `source_prefix=` when directory scope is already known to reduce result set."
- Add a note to `qdrant_list_directories` description: "Use `source_prefix` to
  drill into a known directory at a finer depth."

No next feature required from this test. The fuzzy `source_file` recovery
feature remains on the roadmap but was not needed here — the navigation tools
provided sufficient orientation without it.

No code or doc changes were made during this retest run.
