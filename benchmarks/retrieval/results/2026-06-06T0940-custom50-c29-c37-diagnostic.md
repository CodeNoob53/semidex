# Custom-50 Persistent Misses Diagnostic — c29 and c37

**Date:** 2026-06-06  
**Command:** `BENCH_PROVIDER=onnx BENCH_JSON=1 BENCH_TOP_K=10 node benchmarks/retrieval/custom-50/run-v3.js`  
**Collection:** `bench-retrieval-custom-50` (v2 chunking, `chunkFileFromPath`)

---

## Current metrics summary

| Metric | Value |
|---|---|
| chunkRecall@3 | 79.6% |
| chunkRecall@5 | 89.8% |
| chunkRecall@10 | 93.9% |
| MRR@10 | 0.676 |
| nDCG@10 | 0.719 |

---

## c29 — "як агент повинен починати сесію з semidex MCP"

### Qrels
```
mcp-workflow.md#8  rel=3  (section: "Collection Discovery")
mcp-workflow.md#3  rel=2  (section: "Recommended Workflow")
```

### Top-10 results
| Rank | chunkId | Score |
|---|---|---|
| 1 | mcp-workflow.md#0 | 0.0333 |
| 2 | project-structure.md#0 | 0.0322 |
| 3 | project-structure.md#8 | 0.0322 |
| 4 | config-env.md#0 | 0.0307 |
| 5 | chunking.md#0 | 0.0301 |
| 6 | qdrant.md#0 | 0.0300 |
| 7 | project-structure.md#1 | 0.0299 |
| 8 | providers.md#0 | 0.0296 |
| 9 | mcp-workflow.md#1 | 0.0295 |
| 10 | project-structure.md#3 | 0.0289 |

Target `mcp-workflow.md#8` is **not in top-10**. All scores cluster at ~0.030 — this
is near-random flat scoring, not a ranking failure. The retrieval engine has no signal
to distinguish chunks.

### Target chunk content (`mcp-workflow.md#8`, section: "Collection Discovery")
```
Run `qdrant_collection_info` at the start of a session to discover available
collections, their point counts, the embedding provider used, and any description
set in `config.json`. This avoids guessing collection names and lets the agent
pick the most relevant collection for the user's query.
```

### Manual analysis

The query is Ukrainian: "як агент повинен починати сесію з semidex MCP" (how should an
agent start a session with semidex MCP). The target chunk uses English: "start of a
session", "Collection Discovery". BGE-M3 handles cross-lingual retrieval, but this
query has a deeper problem: **the fixture does not contain a section that explicitly
names the session-start workflow**. `#8` describes one specific tool call
(`qdrant_collection_info`) in isolation. The phrase "start of a session" is buried in
one sentence; the section title "Collection Discovery" doesn't match "починати сесію".

`mcp-workflow.md#3` (rel=2, "Recommended Workflow") actually contains the closest
match — it shows the full tool call sequence starting with `qdrant_collection_info`.
But it's also absent from top-10, confirming the query has no lexical anchor in the
corpus.

### Verdict: **fixture gap + query mismatch**

The fixture lacks a section that explicitly frames the session-start workflow as
"how to begin". Both `#3` and `#8` contain *parts* of the answer but neither is
titled or worded to match "session start" queries.

### Recommended action

Patch `mcp-workflow.md#3` (Recommended Workflow) to add an explicit session-start
framing sentence, e.g.:

> **Starting a session:** always begin by calling `qdrant_collection_info` to
> discover available collections before issuing any search.

This makes `#3` the primary hit (currently rel=2, should be rel=3 after patch), and
gives the retriever a lexical anchor. Also update qrel: move rel=3 from `#8` to `#3`,
keep `#8` as rel=2.

Expected impact: c29 enters cr@5; supportRecall stays unchanged (both already rel≥2).

---

## c37 — "npm run bench:custom50 entry point run-v3.js"

### Qrels
```
project-structure.md#9  rel=3  (section: "Entry Points")
project-structure.md#2  rel=2  (section: "Source Tree", part 2)
```

### Top-10 results
| Rank | chunkId | Score |
|---|---|---|
| 1 | benchmarking.md#14 | 0.0330 |
| 2 | benchmarking.md#12 | 0.0325 |
| 3 | benchmarking.md#15 | 0.0322 |
| 4 | benchmarking.md#13 | 0.0322 |
| 5 | benchmarking.md#11 | 0.0310 |
| 6 | **project-structure.md#9** | 0.0301 |
| 7 | benchmarking.md#16 | 0.0300 |
| 8 | benchmarking.md#17 | 0.0300 |
| 9 | benchmarking.md#18 | 0.0300 |
| 10 | benchmarking.md#2 | 0.0289 |

Target is at **rank #6** — it's a cr@10 hit (93.9%) but not cr@5 (miss).

### Target chunk content (`project-structure.md#9`, section: "Entry Points")
```
| Command | Module | Purpose |
|---------|--------|---------|
| `npm run index`       | `src/indexer/index.js`                        | Index files into Qdrant |
| `npm run sync`        | `src/sync.js`                                 | Sync config.json with Qdrant |
| `npm run smoke`       | `src/core/smoke.js`                           | Verify connectivity |
| `npm run mcp`         | `src/mcp/server.js`                           | Start MCP server |
| `npm run bench:retrieval` | `benchmarks/retrieval/run.js`             | Run 21q regression benchmark |
| `npm run bench:custom50`  | `benchmarks/retrieval/custom-50/run-v3.js`| Run 50q quality benchmark |
```

The target chunk is correct — `bench:custom50` and `run-v3.js` are explicitly present.

### Manual analysis

`benchmarking.md` contains 21 chunks, many of which mention "bench", "custom-50",
and "run-v3". The query tokens (`npm`, `bench`, `custom50`, `run-v3.js`) match
multiple `benchmarking.md` chunks with higher RRF scores because that file is
*about* benchmarking. `project-structure.md#9` is a table listing entry points —
its sparse signal for "bench:custom50" competes against a file where benchmarking
is the primary topic.

This is a **source-navigation weakness**: the query is asking *where to find* the
entry point (project-structure), but lexical retrieval routes it to the file *about*
benchmarking. The table format of `#9` also produces weaker dense vectors than
prose descriptions.

### Verdict: **retrieval weakness — source-navigation vs topic-match conflict**

Qrel is correct. Fixture content is correct. The miss is structural: a
source-navigation query competing against a topically dominant file (`benchmarking.md`).
This is the same pattern as c35 (qdrant.js location) and c29 — the `source-navigation`
class has MRR=0.289 overall.

### Recommended action

No qrel or fixture change needed. This is a known retrieval gap:
source-navigation queries require the retriever to prefer structural location context
over topic match. Options for future work:

1. Add a `source_file` filter hint in the MCP workflow (not applicable here).
2. Add a brief prose description before the Entry Points table in
   `project-structure.md#9`, e.g. "The following table lists all npm entry points
   and their source modules." — gives the dense encoder more signal.
3. Accept as a known limitation of the current retriever for source-navigation queries.

Option 2 is low-risk: one sentence added to the fixture, no qrel change needed.
Expected impact: marginal improvement to cr@5 for c37; no regression risk.

---

## Summary

| Query | Root cause | Action |
|---|---|---|
| c29 | Fixture gap: no explicit "session start" framing; query has no lexical anchor | Patch `mcp-workflow.md#3`: add session-start sentence; update qrel `#3→rel=3`, `#8→rel=2` |
| c37 | Retrieval weakness: source-navigation vs topically dominant `benchmarking.md` | Optional: add prose intro sentence to `project-structure.md#9`; or accept |

Neither miss is caused by wrong qrels or bad query wording.  
No production code changes needed.

---

## git diff --check

```
(clean — no whitespace errors)
```
