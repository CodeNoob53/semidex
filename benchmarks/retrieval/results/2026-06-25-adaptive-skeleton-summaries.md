# Adaptive Skeleton LLM Summaries — Implementation Report

**Date:** 2026-06-25
**Collection validated:** `fullstack-python-web` (91 files, Python web dev course)
**Model:** `gemma3:4b` via Ollama at `http://127.0.0.1:11434`
**Embedding:** ONNX BGE-M3

---

## What Changed

`skeleton-summary.js` now selects a summary tier based on the token count of the node's content
instead of applying a single prompt to every node.

| Tier | Token range (default) | `summary_kind` | Output shape |
|------|----------------------|----------------|--------------|
| short | < 300 | `llm_short` | 1 sentence, ≤ 30 words |
| medium | 300 – 1499 | `llm_medium` | 2-3 sentences, ≤ 60 words |
| structured | ≥ 1500 | `llm_structured` | JSON: summary + key_topics + notable_terms + child_overview |
| rollup | parts/batched mode | `rollup` | plain text rollup from section parts |
| inventory | no LLM | `inventory` | structural count string (always preserved) |

Thresholds are overridable via `SUMMARY_SMALL_TOKENS` / `SUMMARY_MEDIUM_TOKENS`.

New payload fields (additive — absent on inventory-only nodes):

```
summary_kind:    'llm_short' | 'llm_medium' | 'llm_structured' | 'rollup' | 'inventory'
summary_version: 2
key_topics:      string[]   (max 6, structured tier only)
notable_terms:   string[]   (max 8, structured tier only)
child_overview:  string[]   (max 10, file nodes only, structured tier only)
inventory:       string     (always preserved when differs from summary)
```

---

## Live Validation Results

All 91 files received `summary_kind: llm_structured` — expected, since fullstack-python-web
files are technical course documents averaging 1500–4000+ tokens each.

### Payload sample — file node

```
source_file:    Тема 1. .../2. Еволюція_менеджерів_пакетів.md
summary_kind:   llm_structured
summary_version: 2
key_topics:     ["Python dependency management","Pipenv","Poetry","Lockfile concept","uv manager","Virtual environment tools"]
notable_terms:  ["pip","venv","requirements.txt","Pipfile","Pipfile.lock","Poetry","uv","pyproject.toml"]
child_overview: ["Lockfile: Ensures consistent dependency versions.",
                 "Pipenv: Combines pip and virtualenv for simplified management.",
                 "Poetry: Introduces pyproject.toml and streamlines publishing.",
                 "uv: Rust-based manager offering faster performance.",
                 ...]
summary:        "The document outlines the evolution of Python dependency management tools,
                 starting with pip, venv, and requirements.txt..."
inventory:      "Еволюція менеджерів пакетів — 1 section, 77 paragraphs, 45 code_blocks, 4 lists"
```

### Inventory preserved

`inventory` is stored separately from `summary` after LLM generation. Agents can:
- read `summary` for semantic orientation;
- read `inventory` to know the structural cost (chunks, sections) before drilling in.

This prevents context overload: an agent can decide whether to open a 122-code-block file
before fetching its content.

### Collection-level summary

```
summary: "This collection teaches web development with Python using FastAPI and other tools
          like Docker. It covers HTTP, templating, REST APIs, authentication, and backend
          security principles for building modern applications."
summary_kind: rollup
```

---

## Failure Modes Observed

None during this run. Previous known failure modes:

- **Structured JSON not returned by model**: `sanitizeStructured` rejects and falls back to
  retry → `llm_medium` rollup → inventory. The `summary_kind` field records which fallback
  fired so reindexing can be targeted.
- **parts/batched mode + structured tier**: when content exceeds model budget, structured JSON
  over multiple parts is unreliable. The implementation falls back to `rollup` plain text for
  this path — logged as `summary_kind: 'rollup'` in payload.
- **Preamble rejection**: `sanitizeSummary` rejects conversational openers
  ("Okay, here is...") and triggers retry before falling back to inventory.

---

## Backfill Note

Existing nav nodes in collections indexed before this change have no `summary_kind` field.
Selective backfill is not implemented — full `FORCE_REINDEX=1 SKELETON_SUMMARY=llm` reindex
is required to upgrade a collection. Detection: `summary === inventory` → LLM was never run
or failed for that node.

---

## Smoke Test Coverage

Section `54-adaptive-skeleton-summaries.js` added (62 assertions):

- `summaryTierThresholds` defaults and env overrides
- `chooseTier` boundary conditions (0, 299, 300, 1499, 1500, custom thresholds)
- `sanitizeStructured`: valid JSON, markdown-wrapped JSON, array capping (6/8/10),
  bad summary rejection, plain-text → null, null → null
- `generateAdaptiveSummary` with stub LLM for each tier (short/medium/structured)
- Structured tier: file node gets `child_overview`, section node does not
- Error → null (caller keeps inventory)
- `generateNavSummaries`: `summary_kind` and `summary_version` stamped on all enriched nodes
- `buildCollectionSummary`: `summary_kind: 'inventory'` vs `'rollup'`
- `buildNavPointPayload`: all 5 new fields pass through; absent fields not present in payload

All 1132 smoke tests pass (0 failures).

---

## MCP Exposure (2026-06-25, follow-up)

Adaptive fields were stored in Qdrant but not returned by MCP skeleton tools. Fixed in the
same session.

**`qdrant_get_skeleton_node`** now returns full adaptive metadata for a single node:
`summary_kind`, `summary_version`, `key_topics`, `notable_terms`, `child_overview`.
Fields are absent (not null) when the node has no LLM summary.

**`qdrant_get_skeleton_children`** returns compact orientation hints per child:
`summary_kind`, `key_topics`, `notable_terms`. `child_overview` is omitted from the
children list (too verbose for a directory listing).

**`qdrant_get_skeleton`** returns `summary_kind` and `summary_version` on the collection
root node, and `summary_kind` per direct child for quick orientation.

**Smoke coverage** extended in section 53 (22 new assertions):
- `formatNode` returns adaptive fields when present; fields absent on inventory-only nodes.
- `formatChildren` returns compact adaptive fields per child; `child_overview` absent from
  children output by design.
- `formatSkeleton` returns `summary_kind`/`summary_version` on collection root; `summary_kind`
  per child when present; fields absent when undefined on node.

All 1154 smoke tests pass (0 failures) after this fix.

**Existing collections**: fields are already in Qdrant for collections indexed with
`SKELETON_SUMMARY=llm`. No reindex needed to expose them — the formatter change takes
effect immediately.

---

## Next Steps

1. **Directory LLM summaries**: `buildDirectoryNavPoints` generates inventory-only summaries.
   LLM rollup for directory nodes (from child file summaries) is an open gap.
2. **Short/medium tier validation**: `fullstack-python-web` had no nodes below 1500 tokens.
   Short and medium tiers are covered by smoke stubs but not live-validated on real content.
   A collection with shorter notes/glossary files would exercise them.
3. **Backfill command**: `SKELETON_SUMMARY=llm FORCE_REINDEX=1` works but re-embeds all
   content. A targeted nav-only backfill pass (skip stageA/stageB, only run nav summaries
   for nodes where `summary === inventory`) would reduce cost significantly.
