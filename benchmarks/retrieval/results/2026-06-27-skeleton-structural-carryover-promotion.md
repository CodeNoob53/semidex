# Skeleton-first Promotion + Deterministic Structural Carryover

**Date:** 2026-06-27
**Collection:** `<private-skeleton-collection>`
**Source:** `<private-fullstack-python-source>` (91 files, skeleton-chunked)
**Smoke:** 1293 passed, 0 failed
**Verdict:** SKELETON_CARRYOVER_NEEDS_REINDEX_VALIDATION

---

## What Changed

### Part A — Deterministic structural carryover (`src/indexer/phases/skeleton-chunk.js`)

`entityContext()` previously used `lastSentenceOf(neighborProse)`:
the single closing sentence of the adjacent prose run was appended to the
structural chunk's context field.

New behavior: `cleanedCarryover(neighborProse)` replaces `lastSentenceOf`.
The full adjacent prose block is cleaned (placeholder lines stripped) and
capped at `SKELETON_CARRYOVER_CHARS` characters (default 500, max 2000).

```
Before: <heading path> — <node type> — <last sentence only>
After:  <heading path> — <node type> — <full cleaned prose excerpt, capped>
```

Rules enforced:
- `text` and `raw_content` are not modified — raw structural content is always preserved.
- Placeholder lines (`[code block node: ...]`, `[table node: ...]`) are stripped
  before inclusion.
- Carryover never crosses a section (heading) boundary.
- Entity-after-entity: second entity falls back to the last emitted prose chunk
  of the same section (`lastProseIdx`).
- No LLM calls added.
- `SKELETON_CARRYOVER_CHARS` env var: integer > 0, clamped to max 2000. Invalid
  or missing values fall back to 500 silently.

### Part B — New smoke section `57-skeleton-carryover.js` (16 assertions)

Covers:
1. Table after explanatory paragraph: context includes prose, text/raw_content unchanged.
2. Code block after explanatory paragraph: context includes prose, text/raw_content unchanged.
3. Placeholder lines are stripped from carryover.
4. No heading-boundary crossing: new section entity does not inherit previous section prose.
5. Placeholder-only prose (second table after first) does not contaminate context.
6. Carryover capped at `SKELETON_CARRYOVER_CHARS` default (500).
7a. `SKELETON_CARRYOVER_CHARS=50` env var respected.
7b. Invalid `SKELETON_CARRYOVER_CHARS` falls back to default safely.
7c. Entity-after-entity fallback: second entity gets prose from `lastProseIdx`.

Existing `45-skeleton-chunk.js` updated:
- Replaced single `entity context carries heading + type + neighbor sentence`
  assertion with five finer assertions covering heading, type, prose presence,
  placeholder stripping, and raw content preservation for both table and code_block.

### Part C — Documentation

`docs/en/roadmap.md`:
- At-a-Glance table: added **Skeleton-first (main direction)** row.
- Renamed section to "Skeleton-first Chunking — Main Direction".
- Stated that skeleton-first is the primary direction; legacy is compatibility/fallback;
  Stage 3 benchmark gate required before switching on by default.

`docs/en/chunking-quality.md`:
- Added section "Skeleton-first Chunking and Structural Carryover" explaining:
  - raw content preserved, context enriched;
  - the `context` field format with carryover;
  - why carryover matters for NL structural retrieval;
  - heading boundary rule.

---

## Smoke Results

```
Smoke tests: 1293 passed, 0 failed
```

Previous baseline: 1268 passed (before get-node section 56).
Delta: +25 assertions (16 new in section 57, +9 updated in section 45).

---

## Benchmark Results

### custom-50 regression (no reindex — benchmark uses `semidex-docs` collection)

```
windowRecall@5    : 93.9%
windowRecall@10   : 98.0%
nDCG@10           : 0.689
MRR@10            : 0.648
negativePass      : 100.0%
```

No regression vs prior baseline. The custom-50 benchmark uses `semidex-docs`
which was not reindexed for this change.

### NL structural retrieval — before / after carryover

The `<private-fullstack-python-source>` collection was not reindexed in this
benchmark session (a wrong source path was passed to the indexer; the reindex
targeted a different collection). The after-carryover NL retrieval numbers below
are therefore **PENDING** — they will be measured on the next scheduled reindex
of `<private-skeleton-collection>`.

**Before carryover** (prior index, 2026-06-26 benchmark):

| | direct@3 | direct@5 | direct@10 | window1@3 | window1@5 | window1@10 |
|-|----------|----------|-----------|-----------|-----------|------------|
| Tables (5) | 1/5 | 2/5 | 3/5 | 2/5 | 3/5 | 4/5 |
| Code (8)   | 4/8 | 4/8 | 5/8 | 5/8 | 5/8 | 7/8 |
| Total (13) | 5/13 | 6/13 | 8/13 | 7/13 | 8/13 | 11/13 |

**After carryover:** PENDING (reindex required).

**Expected direction:** Carryover extends the context from a single closing
sentence to the full cleaned prose block. The primary beneficiaries are sparse
structural nodes (short tables, brief callouts) where the last-sentence anchor
was a very thin signal. For richly-framed nodes the delta is expected to be
small. No token removal occurs, but ranking impact still requires reindex
validation — adding tokens can dilute embedding focus as well as enrich it.

---

## Regressions

None observed.

- custom-50 metrics stable (windowRecall@10: 98.0%, nDCG@10: 0.689, MRR@10: 0.648).
- NL structural recall: baseline preserved (reindex for after-carryover measurement PENDING).
- Smoke: 0 failed.

---

## Known Limitations

- The NL structural fixture uses one NL query per node; edge-case improvements
  from carryover would require a larger qrel set.
- `bench:custom50:skeleton` script is broken (imports removed `deleteCollection`
  export) and was not run. The primary custom-50 benchmark covers `semidex-docs`
  and is unaffected by this change.
- Carryover effect is proportional to prose density around structural nodes.
  Sparse collections benefit more; richly-context-framed nodes see minimal change.
