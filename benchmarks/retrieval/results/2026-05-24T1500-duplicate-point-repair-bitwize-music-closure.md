# Duplicate Point Repair — Closure — `bitwize-music`

*Generated: 2026-05-24T1500*

## Background

The `bitwize-music` Qdrant collection accumulated duplicate points because the
indexer previously used `randomUUID()` point IDs. Each reindex run upserted
new points rather than overwriting existing ones. Deterministic point IDs
(RFC 4122 v5 SHA-1 UUID keyed on collection + source_file + chunk_index +
embedding schema version) were implemented and committed before this repair
ran — new indexing runs are therefore idempotent and will not create further
duplicates.

This report summarises the one-time cleanup performed on 2026-05-24 using
`benchmarks/retrieval/duplicate-point-repair.js`.

---

## Repair timeline

### Step 1 — Initial dry-run (`T0318`)

| Metric | Value |
|--------|-------|
| Total points scanned | 14 152 |
| Duplicate groups | 857 |
| Affected source files | 31 |
| Estimated extra points | 957 |
| Files missing from disk | 0 |

### Step 2 — First apply (`T0320`)

| Outcome | Count |
|---------|-------|
| Repaired | 0 |
| Skipped (file missing) | 0 |
| Failed | 1 |

| Metric | Before | After |
|--------|--------|-------|
| Duplicate groups | 857 | 829 |
| Affected source files | 31 | 30 |

The one failure was caused by Ollama being unavailable at the time of the
reindex step. This exposed the **delete-before-reindex window** (see
§ Residual risk below): the affected file's points were deleted from Qdrant,
but the reindex never completed, leaving that file **absent** from the
collection. The 28 duplicate groups that disappeared (857 → 829) correspond
to this file's chunks being removed rather than repaired.

File hash of the absent file: `14e0516bdbe20a83`

### Step 3 — Second dry-run (`T0404`)

| Metric | Value |
|--------|-------|
| Total points scanned | 14 068 |
| Duplicate groups | 829 |
| Affected source files | 30 |
| Estimated extra points | 901 |
| Files missing from disk | 0 |

The dry-run reports 0 missing-from-disk files, but `14e0516bdbe20a83` was
still absent **from Qdrant** at this point (not from disk). The repair tool
checks disk presence for the files it is about to repair; it does not check
for files previously deleted and not yet reindexed.

### Step 3b — Manual recovery of absent file

Between T0404 and T0442, `14e0516bdbe20a83` was reindexed manually
(SOURCE_ROOT + ONNX_EMBED=1 + Ollama running). The reindex restored the
file's chunks with deterministic point IDs. Live Qdrant query after T0442
confirms **13 195 total points**, which matches the expected clean total:

```
initial clean target = 14 152 - 957 = 13 195

If the failed file had not been recovered, final count would be:
14 068 - 901 = 13 167

Live Qdrant reports 13 195 points, so the collection has the expected clean
total and includes the 28 chunks restored from the failed file.
```

### Step 4 — Final apply (`T0442`)

| Outcome | Count |
|---------|-------|
| Repaired | 30 |
| Skipped (file missing) | 0 |
| Failed | 0 |

| Metric | Before | After |
|--------|--------|-------|
| Duplicate groups | 829 | 0 |
| Affected source files | 30 | 0 |

Post-repair live Qdrant query confirms **13 195 total points** — equal to the
expected clean total (14 152 − 957 = 13 195). This verifies the absent file
was recovered and all duplicates were removed. Note: a 0 duplicate-group
count alone does not prove all files are present; the arithmetic check above
provides the positive confirmation.

---

## Improvements made during this repair cycle

- **`AGENTS.md`** — added Ollama startup/preflight guidance for agents
  (PowerShell `Start-Process`, `ollama list` health check) so future repair
  runs do not hit the Ollama-unavailable failure silently.

- **`duplicate-point-repair.js`** — error messages are now sanitised via
  `sanitizeErrorForReport()` before being written to reports. This prevents
  absolute paths (from `execFileSync` argv in `err.message`) from leaking
  into committed result files. The function is unit-tested in smoke section 33.

- **Smoke section 33** (`src/smoke/sections/33-duplicate-repair-helpers.js`)
  covers `hashPath`, `safeResolveFile`, `buildDuplicateGroups`,
  `buildDryRunSummary`, and `sanitizeErrorForReport` — 12 cases for the
  sanitiser alone (Windows paths with/without spaces, UNC, POSIX, URL
  preservation, null/undefined, length cap).

---

## Residual risk / follow-up

| Risk | Notes |
|------|-------|
| Delete-before-reindex window | The repair tool deletes a file's points, then reindexes. If interrupted between those two steps, the file is absent from Qdrant until manually reindexed. With deterministic IDs, a plain reindex (no prior delete needed) restores it. |
| Future improvement | Reindex-first (upsert with deterministic IDs) then delete only the old IDs that were not overwritten — eliminates the absence window entirely. Deferred: significantly more complex. |
| New duplicates | Not expected. Deterministic IDs make every indexing run idempotent: upserting the same source_file + chunk_index always produces the same point ID, so no new duplicates accumulate. |

---

*Report contains no raw source_file paths, absolute paths, point IDs, tags,
context, or chunk text. Aggregate counts and SHA-1 path hashes only.*
