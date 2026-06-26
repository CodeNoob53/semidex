# Natural-Language Structural Retrieval Benchmark

**Date:** 2026-06-26
**Collection:** `fullstack-python-web`
**Source:** `<private-fullstack-python-source>` (91 files, skeleton-chunked)
**Data:** existing indexed collection, no reindex performed
**Embedding:** `bge-m3-onnx`, hybrid dense+sparse RRF, `top=10`
**Filter:** `point_kind = retrieval_content` (structural + prose chunks, no skeleton nav)
**Smoke:** existing pass (1268 assertions); no production code changed
**Verdict:** NL_STRUCTURAL_RETRIEVAL_PARTIAL

---

## Context

Prior benchmark (`2026-06-26-structural-chunk-retrieval-vs-node-resolver.md`) established:
- exact-token queries → tables 5/5 rank 1, code blocks 8/8 rank 1
- verdict: `qdrant_search` is the default evidence path for structural content

This benchmark tests the **natural-language** case: can a user retrieve structural chunks
(table, code_block) by asking a semantic question without using exact tokens from the chunk?

---

## Test Design

For each of 5 table nodes and 8 code block nodes, two query types were tested:

- **Exact-token control:** contains column names, row values, identifiers, or code symbols
  copied from the actual chunk content
- **Natural-language (NL):** describes what the structure is about semantically, without
  copying exact unique tokens

Both queries target the same `node_id`. Rank is measured in `top=10`.
Target identification is by `node_id` match in result payload.

---

## Table Results

| Case | Exact rank | NL rank | NL query |
|------|-----------|---------|----------|
| table-case-1 | 1 | 1 | "which table shows the result of creating a record in the database" |
| table-case-2 | 1 | 5 | "show the notes table with creation timestamps from the migration example" |
| table-case-3 | 1 | MISS | "which table tracks completion status of items linked to notes" |
| table-case-4 | 1 | MISS | "table of tag categories used to label notes" |
| table-case-5 | 1 | 6 | "which table represents the many-to-many relationship between notes and tags" |

**Table recall (NL):** @3: 1/5 · @5: 2/5 · @10: 3/5

### Table failure analysis

**table-case-3 (MISS):** Top-3 are code blocks from an "application architecture" section.
The table's context is about a "records" entity in a migration — semantically thin. The NL
query ("completion status of items linked to notes") is semantically correct but doesn't
match the table's stored context string. The surrounding code blocks about `notes`-related
functions dominate because they are semantically richer and match the same topic area.
Failure reason: **structural context too weak / displaced by architecture code blocks**.

**table-case-4 (MISS):** Same pattern — `code_block ci=38` (architecture section) ranks
first. The tags table context is "table — tags" with only two rows (groceries, food).
The NL query "tag categories used to label notes" matches prose and code about the `notes`
model more than the sparse table node. Failure reason: **structural context too weak /
semantic too vague for a 2-row table**.

**table-case-5 (rank 6):** Target table found but displaced — `table-case-4` (tags table)
ranks first because "notes and tags" matches its context. The junction table context is
"many-to-many" which is conceptually correct but below the score cliff (0.0318 vs 0.0167).
Failure reason: **score cliff between RRF fusion tiers**.

---

## Code Block Results

| Case | Exact rank | NL rank | NL query |
|------|-----------|---------|----------|
| code-case-1 | 1 | MISS | "how to simulate email verification in tests" |
| code-case-2 | 1 | MISS | "how to assemble a FastAPI application with multiple routers" |
| code-case-3 | 3 | 10 | "how to read environment variables in Python using dotenv" |
| code-case-4 | 2 | 1 | "example of managing a SQLite database connection with context manager" |
| code-case-5 | 1 | 3 | "which docstring format is recommended for large Python projects" |
| code-case-6 | 2 | 3 | "description of the OSI networking model and its history" |
| code-case-7 | 2 | 3 | "how to replace a method during testing using mock patch" |
| code-case-8 | 1 | 6 | "how to view installed Python versions with uv" |

**Code block recall (NL):** @3: 4/8 · @5: 4/8 · @10: 6/8

### Code block failure analysis

**code-case-1 (MISS):** Target is a test mock for email confirmation. Top 7 results are
all from an "email verification" file — but they are different code blocks (the actual
service implementation, HTML template, route handlers). The right chunk is displaced because
the NL query matches the section broadly and other code blocks in that section score higher.
Failure reason: **section-level hub effect — multiple code blocks in same section compete**.

**code-case-2 (MISS):** Top results are "Вступ" (introduction) paragraphs and a different
architecture code block. The target chunk (FastAPI app assembly with routers) is in a
"Додаємо авторизацію" section, not an "architecture" section, so its context doesn't
match "assemble a FastAPI application". Failure reason: **section label mismatch — chunk
lives in auth section not architecture section**.

**code-case-3 (rank 10):** Top results are from a "package manager" section (`uv`) which
also covers environment variables. The target dotenv chunk is displaced to rank 10.
Failure reason: **topic collision — `uv` section also discusses environment variables**.

**code-case-8 (rank 6):** Top-5 are prose paragraphs from the same `uv` section. Target
code block appears at rank 6 — the prose explaining `uv python list` ranks higher than
the code block showing its output. Failure reason: **prose-first ordering within same section**.

---

## Aggregate

| Metric | Exact | NL |
|--------|-------|----|
| Table recall@3 | 5/5 (100%) | 1/5 (20%) |
| Table recall@5 | 5/5 (100%) | 2/5 (40%) |
| Table recall@10 | 5/5 (100%) | 3/5 (60%) |
| Code recall@3 | 8/8 (100%) | 4/8 (50%) |
| Code recall@5 | 8/8 (100%) | 4/8 (50%) |
| Code recall@10 | 8/8 (100%) | 6/8 (75%) |

---

## Failure Pattern Summary

| Pattern | Cases | Node types affected |
|---------|-------|---------------------|
| Section-level hub effect — competing chunks in same section | C1, C2, C8 | code_block |
| Structural context too weak (sparse table, no prose anchor) | T3, T4 | table |
| Score cliff between RRF fusion tiers | T5, C3 | table, code_block |
| Topic collision across sections | C3 | code_block |
| Section label mismatch | C2 | code_block |

The structural content node's embedded vector is built from:
```
{context_string}\n\n{raw_table_or_code_text}
```
The `context_string` for tables is typically short (`"section — table — [one-line description]"`),
and for code blocks it is the surrounding prose snippet that was the label.
For short, sparse tables (2–5 rows) and code blocks embedded inside named sections,
NL queries frequently match the **prose or other structural nodes in the same section**
rather than the specific structural node.

---

## Implications for Agent Workflow

The existing agent decision rule remains correct and **does not change**:

```text
Structural content (table, code_block) in query scope:
  -> qdrant_search with exact tokens from the structure (rank 1-2 expected)
  -> qdrant_get_node only if:
       (a) raw display of full original content is needed, OR
       (b) node_path is already known from skeleton navigation
```

NL recall@10 of 60% (tables) and 75% (code) is acceptable for exploration but not for
reliable evidence retrieval. The gap confirms that structural nodes need either richer
context or a two-step workflow (prose first → structural node second) for NL queries.

`qdrant_get_node` is **not** the remedy for weak NL recall — it requires a known
`node_id` or `node_path`, which presupposes the node was already found.

---

## Improvement Candidates

Ranked by expected impact, without prescribing implementation:

1. **Richer deterministic context for structural nodes**
   Tables and code blocks currently embed a short one-line context string. Adding the
   surrounding prose paragraph (the sentences that introduce the table/code) would
   dramatically improve NL recall without any query-side changes.

2. **Section/prose → structure linking in retrieval**
   A two-step pattern: NL query → prose/paragraph chunk → follow `chunk_index ± 1`
   to find adjacent structural chunks. This already works for the `window=1` case
   in `qdrant_get_chunk`, but is not yet an explicit agent recommendation.

3. **LLM-generated summary for structural nodes**
   Similar to `summary_kind: llm_short` for skeleton nav nodes: generate a one-sentence
   semantic summary of what each table/code block represents and embed it as part of
   the structural node's context. Would lift NL recall for sparse tables especially.

4. **Query expansion with structural type hint**
   The agent could reformulate: "which table..." → add `node_type:table` filter or
   boost, narrowing candidates before RRF fusion.

5. **Benchmark/qrel expansion**
   Current test uses one collection and one NL query per node. A wider qrel set
   (multiple NL phrasings per node, multiple collections) is needed before drawing
   firm conclusions about overall NL recall rates.

---

## Known Limitations

- One collection tested; results are collection-specific.
- One NL query per node — different phrasings may perform differently.
- No `checklist` or `image` nodes present in this collection.
- NL queries were designed in English; collection content is in Ukrainian.
  Cross-lingual semantic distance may penalize NL queries relative to exact-token
  queries that match Ukrainian text via BM25 sparse component.
