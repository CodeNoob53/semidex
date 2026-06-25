# Hierarchical Skeleton Summaries — Directory Rollups + Collection Overview

**Date:** 2026-06-25
**Scope:** `skeleton-summary.js`, `index.js` (collection nav phase)
**Smoke:** 1204 passed, 0 failed

---

## What Changed

### 1. Single-child propagation (`summary_kind: 'propagated'`)

A new rule: when a file or directory nav node has exactly one semantic child,
its summary is copied from the child — no LLM call. This intentionally does
**not** apply to the collection root.

| Level | Trigger | Effect |
|-------|---------|--------|
| File ← Section | file has 1 section node and section has semantic summary | file.summary = section.summary; no extra LLM call |
| Directory ← File/Subdir | directory has 1 child with semantic summary | dir.summary = child.summary |
| Collection ← Dir/File | not used | collection root gets its own overview |

"Semantic" means `summary_kind` is present and not `'inventory'`. If the only child
failed LLM generation and kept its inventory, propagation does not fire — the parent
also keeps its inventory, consistent with the "LLM failure must never break indexing"
contract.

Propagated nodes carry `summary_kind: 'propagated'`, `summary_version`, and optionally
`key_topics` / `notable_terms` from the source child. `child_overview` is not propagated
(it describes sub-sections, which is irrelevant at the parent level).

### 2. `generateDirectorySummaries()` — new function

`src/indexer/phases/skeleton-summary.js` exports a new function:

```js
generateDirectorySummaries(directoryNodes, childSummaryByPath, opts)
```

- `childSummaryByPath`: `Map<node_path, enriched nav node>` — file and subdir summaries
- Processes leaf-first (deepest dirs first) so parent dirs see enriched child summaries
- 1 child (semantic) → `propagated`; 1 child (inventory) → keep inventory; N children → `rollup`
- LLM failure at any directory → keeps inventory; indexing continues
- `summary_version` stamped when LLM or propagation fires

### 3. `buildCollectionSummary()` — dedicated collection overview

Previously: flat list of all file summaries.
Now: accepts `opts.topLevelNodes` — enriched directory (or root file) nav nodes —
and always generates a dedicated collection-level overview when LLM summaries
are enabled.

When top-level directory summaries exist, the collection overview is built from
them, not from a flat file list. For a 91-file collection organized in 15
directories, the prompt starts from those 15 top-level nodes.

Important correction: collection-level single-child propagation was removed. The
collection node is the agent's entry point into the whole map, so it must explain
the collection itself instead of copying the only top-level directory/file summary.
When the top-level map is a directory rollup, file-level notes are included as
supporting detail so the overview does not collapse into a too-short copy of the
directory summary.

### 4. Collection payload bug fix

`buildCollectionSummary` returned `summary_kind` and `summary_version` but `index.js`
was ignoring them — the collection nav point always stored neither field.

Fixed: `index.js` now spreads `collResult.summary_kind` and `collResult.summary_version`
into `buildNavPointPayload` for the collection node.

### 5. Directory summaries wired into index.js

`index.js` now runs `generateDirectorySummaries` when `SKELETON_SUMMARY=llm` before
upserting directory points. Enriched directory nodes are passed into
`buildCollectionSummary` as `topLevelNodes`.

---

## LLM Call Reduction

| Case | Before | After |
|------|--------|-------|
| File with 1 section | 2 calls (section + file) | 1 call (section only; file propagated) |
| Dir with 1 file | 0 (inventory) | 0 (propagation, no LLM) |
| Collection with 1 top dir | 1 rollup call | 1 collection-overview call |
| Collection with N dirs | 1 rollup from all files | 1 collection-overview call from top-level map + file notes when needed |

For `fullstack-python-web` (91 files, 15 directories): if most files have 1 section,
~50% of file-level LLM calls would be saved by propagation. Directory rollups add 15
new calls but give the collection overview better top-level input. The collection
root still pays one LLM call by design because it is the agent-facing map summary.

---

## `summary_kind` Vocabulary

| Value | Meaning |
|-------|---------|
| `'inventory'` | No LLM — structural count string only |
| `'llm_short'` | Direct content, 1-sentence tier |
| `'llm_medium'` | Direct content, 2-3 sentence tier |
| `'llm_structured'` | Direct content, JSON with key_topics/notable_terms/child_overview |
| `'rollup'` | LLM rollup from multiple child summaries |
| `'collection_overview'` | Dedicated LLM overview for the collection root |
| `'propagated'` | Copied from the only child; no LLM call |

---

## Known Limitations

- **Directory nodes are inventory-only before this change** — existing collections need
  `FORCE_REINDEX=1 SKELETON_SUMMARY=llm` to get directory semantic summaries.
- **Nav-only backfill not implemented** — reindex re-embeds all content. A targeted
  directory-summary-only pass would be cheaper for large collections.
- **Section→file propagation requires section to have non-inventory summary** — if section
  LLM failed, the file runs its own LLM call (correct fallback behavior).
- **Collection overview is still summary-only** — it stores `summary`,
  `key_topics`, and `notable_terms`, but not a full long-form project brief.
  If we need a richer agent onboarding document later, that should be a separate
  nav artifact or a larger structured field, not the compact root summary.
- **Collection `topLevelNodes` requires caller to pass enriched dirs** — if `index.js` fails
  to build the dir summary map, collection falls back to file summaries.

---

## Smoke Coverage

Section `55-hierarchical-skeleton-summaries.js` added:

**`generateNavSummaries` — single-section propagation:**
- 1 section: file summary = section summary; `summary_kind = 'propagated'`; only 1 LLM call
- 2 sections: file calls LLM independently; `summary_kind != 'propagated'`
- Section LLM failure: file does NOT propagate (keeps inventory)

**`generateDirectorySummaries`:**
- 1 file child (semantic): propagated; `summary_version` stamped; `key_topics` carried; 0 LLM calls
- 1 file child (inventory-only): no propagation; keeps inventory
- Multiple file children: rollup; `summary_kind = 'rollup'`; LLM called
- No resolvable children: inventory kept; no new fields
- LLM failure: inventory kept; no `summary_version`

**`buildCollectionSummary`:**
- 1 top dir (semantic): NOT propagated; collection overview generated; file notes included
- 1 top dir (inventory): collection overview generated; LLM called
- Multiple top dirs: collection overview; `summary_version` stamped
- 1 file (no dirs): collection overview generated, not copied from file summary
- `llm: false`: always inventory
- Empty files: inventory

**Payload:**
- `summary_kind: 'propagated'` passes through `buildNavPointPayload`

---

## Validation Commands

```bash
# Smoke (pure, no Ollama)
node src/smoke/index.js

# Live reindex with hierarchical summaries
FORCE_REINDEX=1 SKELETON_SUMMARY=llm SKELETON_CHUNKING=1 SKELETON_NAV=1 \
  ONNX_EMBED=1 OLLAMA_URL=http://127.0.0.1:11434 COLLECTION=<col> \
  node src/indexer/index.js <path>
```
