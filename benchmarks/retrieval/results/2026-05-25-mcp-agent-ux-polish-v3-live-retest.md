# MCP Agent UX Polish v3 Live Retest

## Scope

- Collection: a large music production knowledge base (13,195 points, 5 top-level directories)
- Task: music release planning/promotion discovery
- Code changes: none
- Docs under test:
  - `AGENTS.md`
  - `docs/en/mcp-tools.md`
  - `plugin/skills/semidex/SKILL.md`

---

## Tool Usage Summary

| Tool | Calls | Purpose |
|------|-------|---------|
| `qdrant_collection_info` | 1 | Identify available collections and select target |
| `qdrant_list_directories` | 5 | Depth-1 survey of top-level dirs; depth-2 drill into `skills/`, `reference/`, `templates/` |
| `qdrant_list_files` | 3 | Enumerate files scoped to `templates/...`, `reference/...` subdirs |
| `qdrant_search` | 2 | Topical discovery: release workflow + social/hashtag content |
| `qdrant_list_tags` | 3 | Tag enumeration scoped to `reference/...` and `skills/...` subdirs |
| `qdrant_find_by_tag` | 1 | Breadth expansion via `promotion-strategy`, `release-workflow`, `release-timeline`, `social-media-promotion` |
| `qdrant_related` | 2 | Graph outlinks from `reference/... promotion workflow docs` and `skills/... release workflow docs` |
| `qdrant_backlinks` | 1 | Incoming links to `reference/... promotion workflow docs` |
| `qdrant_get_chunk` | 1 | Full content calendar table (compact window truncated the table mid-row) |

**Total tool calls:** 19

---

## Workflow Trace

```
qdrant_collection_info
  -> identified target collection (13k points, named match)
  -> qdrant_list_directories(depth=1)
      -> 5 dirs: docs/, genres/, reference/, skills/, templates/
  -> qdrant_list_directories(depth=2, source_prefix=skills/)    [parallel]
  -> qdrant_list_directories(depth=2, source_prefix=reference/) [parallel]
  -> qdrant_list_directories(depth=2, source_prefix=templates/) [parallel]
      -> identified relevant subdirs within skills/..., reference/..., templates/...
  -> qdrant_search("music release planning promotion workflow checklist", top=3, window=1, compact)
      -> top hit: reference/... promotion workflow docs (campaign planning template)
      -> tags extracted: pre-release-promotion, video-generation, track-selection, schedule-post
      -> skills/... release workflow docs (release checklist)
  -> qdrant_list_tags(contains="promo", source_prefix=reference/...) [parallel]
  -> qdrant_list_tags(contains="release", source_prefix=reference/...) [parallel]
  -> qdrant_list_tags(contains="release", source_prefix=skills/...) [parallel]
      -> rich tag inventory: 28 promo tags, 12 release tags, 32 release-director tags
  -> qdrant_find_by_tag(["promotion-strategy","release-workflow","release-timeline","social-media-promotion"])
      -> breadth expansion: 6 files across reference/... and skills/...
      -> surfaced: reference/... override docs, reference/... social guidance
  -> qdrant_related(reference/... promotion workflow docs) [parallel]
  -> qdrant_related(skills/... release workflow docs) [parallel]
  -> qdrant_list_files(source_prefix=templates/...) [parallel]
      -> related: skills/... promo skill docs
        templates/... campaign templates
        reference/... promotion example output, platform specs
  -> qdrant_backlinks(reference/... promotion workflow docs)
      -> reference/... promo override docs
      -> reference/... social best practices
      -> reference/... platform comparison
  -> qdrant_search("social media posting schedule hashtags engagement indie artist", top=3, window=1, compact)
      -> reference/... social best practices (content calendar table -- truncated)
  -> qdrant_list_files(source_prefix=reference/...) [parallel x2]
      -> reference/... workflow phase docs, release procedure docs
      -> reference/... distributor guide, platform comparison, metadata
  -> qdrant_get_chunk(reference/... social best practices, chunk_index=45)
      -> full 2-week content calendar table
```

**Final material inventory (sanitized):**

| Category | Source family |
|----------|--------------|
| Release workflow skill | `skills/... release workflow docs` |
| Promotion director skill | `skills/... promo director docs` |
| Promo writer/reviewer skills | `skills/... promo writer/reviewer docs` |
| Promotion workflow reference | `reference/... promotion workflow docs` |
| Social media best practices | `reference/... social best practices docs` |
| Platform specs | `reference/... platform specs docs` |
| Promo example output | `reference/... promo example output docs` |
| Release distributor/platform reference | `reference/... release reference docs` |
| Album planning phases | `reference/... workflow phase docs` |
| Release procedures | `reference/... release procedures docs` |
| Per-platform promo templates | `templates/... promo campaign templates` (6 files: campaign + 5 social platform templates) |
| Promo preferences override | `reference/... promo preferences override docs` |

---

## Findings

### What worked

**Directory navigation was smooth.** `qdrant_collection_info` immediately identified the target collection by name. `qdrant_list_directories(depth=1)` gave a clean 5-dir overview in a single call, and the parallel depth-2 drills into `skills/`, `reference/`, `templates/` returned the full substructure with file + chunk counts. The path from `collection_info -> list_directories -> scoped list_files` required no backtracking and no guessing.

**Tag discovery workflow landed correctly.** The sequence `search -> inspect tags from results -> list_tags(contains + source_prefix) -> find_by_tag` worked as documented. Tags observed in search results (`pre-release-promotion`, `social-media-promotion`) informed the `list_tags` filter parameters, which in turn produced a dense, scoped tag inventory. `find_by_tag` then surfaced files that semantic search had not ranked highly (e.g., `reference/... override docs`).

**Related + backlinks were genuinely additive.** `qdrant_related` on the primary promotion workflow doc surfaced 17 connected files including per-platform promo templates and the promo-writer/reviewer skills -- none of which had appeared in the initial semantic search hits. `qdrant_backlinks` then surfaced the promo preferences override doc and the platform comparison reference, which closed the loop on the release reference material. Both graph tools added signal that search alone would have missed.

**Parallel tool use worked well.** The three simultaneous depth-2 directory drills and the three simultaneous `list_tags` calls with different `source_prefix` scopes all returned useful, non-overlapping data. No conflicts.

### Remaining friction

**`qdrant_related` noise.** Among the related files returned for `reference/... promotion workflow docs`, several were clearly off-topic for this task: off-topic documents from unrelated domains appeared alongside relevant results. The agent must filter mentally. The docs don't currently set expectations for related-link noise on cross-domain collections.

**`qdrant_related` descriptions vary in quality.** Some entries had rich summaries that made relevance obvious; others had descriptions like "This section is an empty placeholder" -- not useful for triage. No friction in filtering these out, but worth noting.

**`qdrant_list_tags` scoped to `source_prefix` requires knowing the right prefix in advance.** This was only natural after running `list_directories` first. For an agent that skips the directory step, tag discovery would degrade to unscoped `list_tags` which risks returning a flat list of 100+ tags with no grouping signal.

### Truncation handling

**No truncation was encountered at the directory or file listing level.** All `list_directories` results returned complete sets (5, 54, 12, 2 directories respectively -- all well under the default limit of 100). No `Found N ... showing M` warning appeared, so no narrowing was required.

**Compact window truncation did occur at the content level.** `qdrant_search` with `window=1, window_format="compact"` returned a window chunk for the content calendar table (chunk_index 45) that cut off mid-table with only the first 2 rows visible in the snippet field. The `get_chunk` call was necessary to recover the full 18-row table. The docs correctly say compact snippets may be insufficient for structured data -- but this wasn't called out explicitly as a case where `get_chunk` is needed. **Minor gap.**

### Tag workflow

The `search -> inspect tags -> list_tags(contains + source_prefix) -> find_by_tag` sequence worked exactly as the v3 docs describe. Key observations:

- Tags from the first search result (`pre-release-promotion`, `schedule-post`) directly seeded the `list_tags` `contains` parameter
- Scoping `list_tags` with `source_prefix` kept results manageable (28, 12, 32 tags per scope -- not overwhelming)
- `find_by_tag` with four tags in a single call returned 9 chunks across 6 files -- efficient breadth expansion
- No blind prefix guessing was needed at any stage

**This was the clearest improvement over v2.** The documented workflow is now followable without ambiguity.

### Related/backlinks

**`qdrant_related` was useful.** The 17-file related list for the primary promotion workflow doc contained ~10 directly relevant files, including the per-platform templates and promo skill docs. The graph links made it unnecessary to manually enumerate every file in `skills/...` and `templates/...`.

**`qdrant_backlinks` was useful and distinct.** The 3 backlinks surfaced the promo preferences override doc, which would not have been found through forward traversal or search. The release platform comparison was also surfaced here before `list_files` confirmed it.

**Remaining question:** The docs explain `related` as "outgoing links" and `backlinks` as "incoming links" -- clear enough. But for a first-time agent, it's not obvious when a file is well-connected enough to make `related` worth calling. The docs suggest calling it "once you have at least one useful source_file" -- this worked, but a note that high-chunk-count files in `reference/` or `skills/` tend to be well-connected would reduce hesitation.

### Compact window

`window=1, window_format="compact"` was sufficient for:
- Understanding which chunks were relevant (section names + short snippets)
- Confirming the release checklist content (chunk fully visible)
- Identifying the content calendar table chunk (truncated, but enough to know `get_chunk` was needed)

It was **not** sufficient for structured table content (the 18-row content calendar). One `get_chunk` call recovered it. This is an acceptable tradeoff -- the compact window correctly signaled that the chunk contained a table, even if it couldn't show the full table.

---

## Verdict

**`PASS_WITH_MINOR_FRICTION`**

The core workflow from `collection_info -> list_directories -> search -> tag discovery -> find_by_tag -> related/backlinks` executed without backtracking. All v2 friction points were materially reduced. Remaining friction is minor: related-link noise, compact window limits on structured data, and the implicit dependency of `list_tags` on prior `list_directories` output.

---

## v2 Friction Point Resolution

| v2 Friction Point | Resolved in v3? | Notes |
|-------------------|-----------------|-------|
| Directory truncation awareness | **Yes** | `list_directories` results were complete; no truncation hit; docs correctly set expectation |
| Tag discovery opacity | **Yes** | `search -> inspect tags -> list_tags(contains + source_prefix) -> find_by_tag` worked end-to-end without guessing |
| Related/backlinks mental model | **Mostly** | Both tools added signal; noise in related results is expected but underdocumented |
| Compact snippet limits | **Partially** | Compact window correctly flagged truncated table; one `get_chunk` needed; docs could be more explicit about structured-data cases |

---

## Recommendations

Ranked, docs-first:

1. **`docs/en/mcp-tools.md` -- add note on structured-data `get_chunk` trigger.** The docs say compact window may be insufficient -- add a concrete example: "If a compact snippet shows a table header but no rows, the chunk contains structured data; call `qdrant_get_chunk` directly."

2. **`docs/en/mcp-tools.md` or `SKILL.md` -- add note on `list_tags` + `list_directories` dependency.** Make explicit that `list_tags(source_prefix=...)` is most useful after `list_directories` has identified the right prefix. Without this, agents may attempt unscoped `list_tags` on large collections.

3. **`AGENTS.md` -- add brief note on related-link noise.** On cross-domain or large collections, `qdrant_related` may return off-topic files. Agent should triage by section summary, not assume all returned files are relevant.

4. **`AGENTS.md` -- add heuristic for when to call `qdrant_related`.** "Files with >20 chunks in `reference/` or `skills/` directories tend to have outgoing graph links worth following." This reduces hesitation without changing the documented order of operations.

No tool changes required.

> **Status:** All four recommendations above were addressed in the follow-up docs update (2026-05-25).
> `AGENTS.md`, `docs/en/mcp-tools.md`, and `plugin/skills/semidex/SKILL.md` now include
> the structured-data trigger rule, the `list_tags`/`list_directories` dependency note,
> the related-link noise warning, and the `qdrant_related` heuristic with fallback guidance.

---

## Summary

- **Report path:** `benchmarks/retrieval/results/2026-05-25-mcp-agent-ux-polish-v3-live-retest.md`
- **Verdict:** `PASS_WITH_MINOR_FRICTION`
- **Private strings:** Sanitized. Collection name, specific file paths, and per-platform template names replaced with generalized labels throughout. No private chunk content quoted directly.
