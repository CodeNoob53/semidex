# Structural Window Recall for Natural-Language Structural Retrieval

**Date:** 2026-06-26
**Collection:** `fullstack-python-web`
**Source:** `<private-fullstack-python-source>` (91 files, skeleton-chunked)
**Data:** existing indexed collection, no reindex performed
**Embedding:** `bge-m3-onnx`, hybrid dense+sparse RRF, `top=10`
**Filter:** `point_kind = retrieval_content` (structural + prose, no skeleton nav)
**Smoke:** existing pass (1268 assertions); no production code changed
**Verdict:** STRUCTURAL_WINDOW_RECALL_PARTIAL

---

## Context

Three prior benchmarks established the NL structural retrieval picture:

1. **Exact-token control** (`2026-06-26-structural-chunk-retrieval-vs-node-resolver.md`):
   tables 5/5 rank 1, code blocks 8/8 rank 1.

2. **NL direct** (`2026-06-26-natural-language-structural-retrieval.md`):
   tables direct@10 = 3/5, code direct@10 = 6/8.

3. **Anchor-aware** (`2026-06-26-anchor-aware-structural-retrieval.md`):
   anchor-aware@10 added +1 over direct (code @5: 5/8 vs 4/8).

This benchmark tests the **structural window** layer: when the standard agent workflow
expands each search result with `window=1` (adjacent chunks in the same file), does the
target structural node fall within a returned window even if not directly in top-K?

---

## Definitions

**Direct hit:** target structural `node_id` appears in top-K results.

**Placeholder hit:** a top-K result contains `[code block node: <target_path>]` or
`[table node: <target_path>]` in its text payload.

**Window-1 hit:** for at least one top-K result in the same `source_file` as the target,
the target node (or a placeholder chunk for it) appears at chunk_index ± 1.

**Window-2 hit (diagnostic):** same, but chunk_index ± 2. Reported separately; not
part of the primary agent workflow.

Adjacency requires `source_file` match. Section/heading match was checked where
available but is not required given the ±1 local window constraint.

---

## Per-Case Results

Same NL queries as prior benchmarks.

| Case | NL query | Direct rank | Placeholder rank | Window-1 rank | Window-1 trigger | Classification |
|------|----------|-------------|-----------------|---------------|-----------------|----------------|
| table-case-1 | "which table shows the result of creating a record in the database" | 1 | 7 | 1 | (self) | direct_hit |
| table-case-2 | "show the notes table with creation timestamps from the migration example" | 4 | MISS | 4 | (self) | direct_hit |
| table-case-3 | "which table tracks completion status of items linked to notes" | MISS | MISS | 8 | target_in_window | window1_hit |
| table-case-4 | "table of tag categories used to label notes" | MISS | MISS | MISS | — | miss |
| table-case-5 | "which table represents the many-to-many relationship between notes and tags" | 6 | 7 | 1 | placeholder_in_window | direct_hit |
| code-case-1 | "how to simulate email verification in tests" | MISS | MISS | 8 | target_in_window | window1_hit |
| code-case-2 | "how to assemble a FastAPI application with multiple routers" | MISS | MISS | MISS | — | miss |
| code-case-3 | "how to read environment variables in Python using dotenv" | MISS* | 8 | 8 | placeholder_in_window | placeholder_hit |
| code-case-4 | "example of managing a SQLite database connection with context manager" | 1 | 4 | 1 | (self) | direct_hit |
| code-case-5 | "which docstring format is recommended for large Python projects" | 3 | 5 | 2 | target_in_window | direct_hit |
| code-case-6 | "description of the OSI networking model and its history" | 3 | 1 | 1 | placeholder_in_window | direct_hit |
| code-case-7 | "how to replace a method during testing using mock patch" | 3 | 2 | 2 | placeholder_in_window | direct_hit |
| code-case-8 | "how to view installed Python versions with uv" | 6 | 8 | 1 | placeholder_in_window | direct_hit |

*code-case-3 direct rank: borderline — target appears at rank 10 in some runs,
MISS in others (RRF score at the precision boundary: ~0.0161 vs rank-10 cutoff).
Treated conservatively as MISS for direct; placeholder at rank 8 is stable.

### Notable window-1 cases

**table-case-3 (window1_hit, rank 8):**
The query returns `table-case-2` (the sibling table, ci=23) at rank 8 in
`source-B`. Target (ci=24) is the next chunk in the same file (Δ+1). When the
agent expands the window around rank-8 result, it retrieves ci=24 — the target.

**code-case-1 (window1_hit, rank 8):**
The query returns a different code block (ci=16) from `source-A` at rank 8.
Target (ci=17) is the next chunk in the same file (Δ+1). Same expansion pattern
as table-case-3.

**code-case-8 (placeholder_in_window, rank 1):**
The top-1 result is a prose paragraph. Its window (ci+1) contains a prose chunk
with a `[code block node: <target_path>]` placeholder. The agent would encounter
the placeholder and could call `qdrant_get_node(node_path=...)` to retrieve the
full original code block.

**table-case-5 (placeholder_in_window, rank 1):**
Top-1 result is a table (sibling). Its window contains a placeholder prose chunk.
The placeholder resolves to the target junction table.

---

## Aggregate Metrics

### Tables (5 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 1/5 (20%) | 2/5 (40%) | 3/5 (60%) |
| Anchor-aware (direct + placeholder) | 1/5 | 2/5 | 3/5 |
| **Window-1 recall** | **2/5 (40%)** | **3/5 (60%)** | **4/5 (80%)** |
| Window-2 recall (diagnostic) | 2/5 | 3/5 | 4/5 |

Window-1 adds **+1 case at @3** (table-case-3 via window) and overall lifts
table recall from 3/5 to 4/5 at @10. The only persistent miss is table-case-4.

### Code blocks (8 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 4/8 (50%) | 4/8 (50%) | 5/8 (63%) |
| Anchor-aware (direct + placeholder) | 4/8 | 4/8 | 6/8 |
| **Window-1 recall** | **5/8 (63%)** | **5/8 (63%)** | **7/8 (88%)** |
| Window-2 recall (diagnostic) | 5/8 | 5/8 | 7/8 |

Window-1 adds **+1 case at @3/@5** (code-case-1) and lifts @10 from 6/8 to 7/8.

### Combined (13 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 5/13 (38%) | 6/13 (46%) | 8/13 (62%) |
| Anchor-aware | 5/13 (38%) | 6/13 (46%) | 9/13 (69%) |
| **Window-1 recall** | **7/13 (54%)** | **8/13 (62%)** | **11/13 (85%)** |
| Window-2 recall (diagnostic) | 7/13 | 8/13 | 11/13 |

### Hit-kind breakdown (@10, window-1 aware)

| Kind | Count |
|------|-------|
| direct_hit | 8 |
| placeholder_hit | 1 |
| window1_hit | 2 |
| miss | 2 |

Window-2 adds no additional cases beyond window-1 in this collection.

---

## Comparison Across Benchmarks

| Layer | Table @10 | Code @10 | Total @10 |
|-------|-----------|----------|-----------|
| Exact-token control | 5/5 (100%) | 8/8 (100%) | 13/13 (100%) |
| NL direct | 3/5 (60%) | 6/8 (75%) | 9/13 (69%) |
| NL anchor-aware | 3/5 (60%) | 6/8 (75%) | 9/13 (69%) |
| **NL window-1** | **4/5 (80%)** | **7/8 (88%)** | **11/13 (85%)** |

The standard `window=1` agent workflow recovers **+2 cases** over direct-only
NL recall, reaching 85% @10. The remaining 2 misses (table-case-4, code-case-2)
are not reachable at any window size tested.

---

## Persistent Misses Analysis

### table-case-4 ("table of tag categories used to label notes")

A 2-row table (id, name) with minimal context. Its placeholder chunk (none exists
for this case) and adjacent prose chunk (ci=26 in source-B, a section description)
do not appear in top 10 for the NL query. Top-3 results are code blocks from an
unrelated architecture section that semantically overlaps with "notes and tags"
without introducing this specific table.

This case requires either: (a) richer structural context at index time, or
(b) a prior skeleton-navigation step that identifies the source-B migration file.

### code-case-2 ("how to assemble a FastAPI application with multiple routers")

The target code block lives in a section dedicated to authorization, not to
application assembly. NL query returns introduction paragraphs and unrelated
architecture code blocks. Neither direct chunk, placeholder, nor any window
neighbor appears in top-10. This is a section-label mismatch: the embedding
reflects the authorization context, not the assembly pattern.

---

## Implication for Agent Workflow

The `window=1` expansion in the standard agent call:

```text
qdrant_search(query, collection, top=3, window=1, window_format="compact")
```

is already sufficient to recover 85% @10 for NL structural queries in this
collection — without any code changes or new tools. This is +23 percentage
points over direct-only NL recall.

The standard agent instruction remains:

```text
Structural content (table, code_block) in query scope:
  -> qdrant_search with exact tokens from the structure (rank 1-2 expected)
  -> qdrant_get_node only if:
       (a) raw display of full original content is needed, OR
       (b) node_path is already known from skeleton navigation or a placeholder
```

One addendum is now evidence-backed:

```text
  When a search result contains [code block node: <path>] or [table node: <path>],
  the agent may call qdrant_get_node(node_path=<path>) to retrieve the full
  original content of the referenced structural node.
  This is valid placeholder resolution — not a search fallback.
```

---

## Improvement Candidates for the 2 Persistent Misses

1. **Richer structural context at index time** (highest impact for table-case-4):
   embed the introducing prose paragraph together with the structural node's chunk
   to provide semantic anchor beyond the sparse row content.

2. **Skeleton navigation before search** (highest impact for code-case-2):
   navigating to the relevant file via `qdrant_get_skeleton_children` before
   issuing `qdrant_search(source_file=...)` would expose the target section
   and eliminate the mismatch.

3. **LLM-generated summary per structural node** (table-case-4 and code-case-2):
   a one-sentence summary of what the table or code block does, embedded as its
   context, would make both cases reachable via NL.

---

## Known Limitations

- One collection tested; window-1 effectiveness may differ in denser or sparser collections.
- One NL query per node.
- NL queries are in English; collection is in Ukrainian — cross-lingual gap may
  systematically penalize NL over exact-token.
- Window-2 was measured but adds no improvement over window-1 in this collection.
- code-case-3 direct rank is borderline (rank 10 / MISS across runs); treated
  conservatively as placeholder_hit via stable placeholder at rank 8.
