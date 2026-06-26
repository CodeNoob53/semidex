# Structural Carryover Bench

**Date:** 2026-06-26
**Source collection:** `<private-ml-math-source>`
**Bench collection:** `bench-ml-math-structural-carryover`
**Verdict:** STRUCTURAL_CARRYOVER_BENCH_POSITIVE_SYNTHETIC

## What Was Tested

Bench-only experiment: structural chunks (`table`, `code_block`, `checklist`) were re-embedded with deterministic nearby prose carryover.
No production code was changed. No LLM calls were added. Raw content and payload text stayed unchanged.

Carryover query design: for each structural node, the query is the nearby prose anchor text that introduces or neighbors that node.
This tests whether a user phrasing the question like the prose explanation can retrieve the structural node directly.

Important limitation: this is a targeted synthetic test, not an independent user-query benchmark. The query text is intentionally the same signal added to the enriched structural embedding. A positive result proves the mechanism works; it does not prove production promotion by itself.

## Inventory

| Item | Count |
|------|-------|
| content points cloned | 429 |
| table points | 8 |
| code_block points | 145 |
| paragraph points | 276 |
| selected carryover cases | 58 |
| structural vectors recomputed | 58 |

### Baseline

| Type | Cases | direct@3 | direct@5 | direct@10 | window@3 | window@5 | window@10 |
|------|-------|----------|----------|-----------|----------|----------|-----------|
| table | 8 | 1/8 (13%) | 1/8 (13%) | 2/8 (25%) | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) |
| code_block | 50 | 18/50 (36%) | 22/50 (44%) | 31/50 (62%) | 48/50 (96%) | 48/50 (96%) | 49/50 (98%) |
| total | 58 | 19/58 (33%) | 23/58 (40%) | 33/58 (57%) | 56/58 (97%) | 56/58 (97%) | 57/58 (98%) |

### Carryover-Enriched

| Type | Cases | direct@3 | direct@5 | direct@10 | window@3 | window@5 | window@10 |
|------|-------|----------|----------|-----------|----------|----------|-----------|
| table | 8 | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) |
| code_block | 50 | 48/50 (96%) | 50/50 (100%) | 50/50 (100%) | 50/50 (100%) | 50/50 (100%) | 50/50 (100%) |
| total | 58 | 56/58 (97%) | 58/58 (100%) | 58/58 (100%) | 58/58 (100%) | 58/58 (100%) | 58/58 (100%) |

## Case-Level Changes

| Case | Type | direct before | direct after | window@10 before | window@10 after | top type before | top type after |
|------|------|---------------|--------------|------------------|-----------------|-----------------|----------------|
| code_block-case-1 | code_block | 4 | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-3 | code_block | MISS | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-6 | code_block | 2 | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-7 | code_block | MISS | 4 | target_in_window | target_in_window | paragraph | code_block |
| code_block-case-8 | code_block | MISS | 3 | placeholder | target_in_window | paragraph | code_block |
| code_block-case-9 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-10 | code_block | 2 | 1 | target_in_window | direct | paragraph | code_block |
| code_block-case-11 | code_block | MISS | 3 | placeholder | placeholder_in_window | paragraph | code_block |
| code_block-case-12 | code_block | 6 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-13 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-14 | code_block | 3 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-15 | code_block | 2 | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-17 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-18 | code_block | 7 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-19 | code_block | 2 | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-20 | code_block | 7 | 2 | placeholder | placeholder_in_window | paragraph | code_block |
| code_block-case-21 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-22 | code_block | 5 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-24 | code_block | 3 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-25 | code_block | MISS | 1 | target_in_window | direct | paragraph | code_block |
| code_block-case-26 | code_block | 9 | 3 | placeholder | placeholder_in_window | paragraph | code_block |
| code_block-case-27 | code_block | 6 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-28 | code_block | MISS | 4 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-29 | code_block | 2 | 3 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-30 | code_block | MISS | 3 | target_in_window | target_in_window | paragraph | paragraph |
| code_block-case-31 | code_block | 10 | 3 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-32 | code_block | MISS | 1 | target_in_window | direct | paragraph | code_block |
| code_block-case-33 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-34 | code_block | MISS | 3 | MISS | target_in_window | paragraph | paragraph |
| code_block-case-36 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-37 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-38 | code_block | MISS | 3 | target_in_window | target_in_window | paragraph | paragraph |
| code_block-case-40 | code_block | 3 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-41 | code_block | 10 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-42 | code_block | MISS | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-43 | code_block | 7 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-44 | code_block | 4 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-45 | code_block | 3 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-46 | code_block | 2 | 1 | placeholder | direct | paragraph | code_block |
| code_block-case-47 | code_block | 9 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-48 | code_block | 5 | 2 | placeholder | placeholder | paragraph | paragraph |
| code_block-case-49 | code_block | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| table-case-1 | table | 8 | 2 | target_in_window | direct | paragraph | paragraph |
| table-case-2 | table | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| table-case-3 | table | MISS | 1 | placeholder | direct | paragraph | table |
| table-case-4 | table | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| table-case-5 | table | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| table-case-6 | table | MISS | 2 | placeholder | placeholder | paragraph | paragraph |
| table-case-8 | table | MISS | 1 | placeholder | direct | paragraph | table |

## Interpretation

- This is a synthetic but targeted test: queries are derived from nearby prose, not from private raw table/code content.
- A positive result means deterministic carryover helps structural nodes answer natural-language queries phrased like their surrounding explanation.
- Baseline `window=1` can already recover the selected cases because they were selected from nodes with local prose anchors. The meaningful change here is direct structural rank, not window recall.
- A neutral/negative result would mean the current window-based workflow already covers most of the benefit, or the carryover text is not discriminative enough.
- `qdrant_get_node` is not evaluated as a search fallback; it remains a raw/original display resolver after a node is already known.

## Commands

```powershell
node benchmarks/retrieval/structural-carryover-bench.js
git diff --check
```
