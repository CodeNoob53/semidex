# Link-Phase Dense-Reuse Equivalence Design — 2026-05-17

**Purpose:** define the safety harness for Tier 2 optimization: reusing the dense
vector produced in phase 4 (embed+upsert) as the query vector in phase 5 (link
building), instead of calling `embedForSearch()` again for each chunk.

**Optimization not implemented yet.** This document defines the harness design and
records the pre-conditions that must hold before the patch is safe to merge.

---

## 1. The problem

### Current code — two separate embed calls per chunk

**Phase 4** (`src/indexer/index.js:99-101`):
```js
const embedText = `${chunk.context}\n\n${chunk.text}`;
const { dense, sparse, meta } = await embedForIndex(collection, embedText);
```

**Phase 5** (`src/indexer/phases/link.js:14`):
```js
const { dense } = await embedForSearch(sourceCollection, chunk.context + '\n' + chunk.text);
```

Each chunk goes through a full ONNX inference call in both phases. On a 30-chunk
file with ONNX provider this is 30 extra `session.run()` calls, each ~100–125 ms →
~3–4 s wasted per file in phase 5 alone.

### Why not just pass the phase-4 vector?

Two obstacles:

1. **Embed-text format differs.** Phase 4 uses `\n\n`; phase 5 uses `\n`. For
   BGE-M3 these produce different token sequences and therefore different dense
   vectors. Cosine similarity is typically ≥ 0.999 for short chunks, but it is
   non-zero: links are determined by cosine threshold (`LINK_MIN_SCORE`, default
   0.75), so a tiny vector shift could — in edge cases — cross the threshold and
   produce different link decisions.

2. **`buildLinks()` API does not accept a pre-computed vector.** Phase 5 calls
   `embedForSearch()` internally; there is no parameter to inject a dense vector.

Both must be resolved before the optimization is safe.

---

## 2. Pre-conditions for the patch

### Pre-condition A — Unify embed-text format

Change phase 5 embed text from `chunk.context + '\n' + chunk.text` to
`chunk.context + '\n\n' + chunk.text` — matching phase 4 exactly.

This makes both phases use the same text, so the phase-4 dense vector and a fresh
phase-5 dense vector would be bit-identical. Only after this change is it correct
to claim "reuse = no change."

**Where:** `src/indexer/phases/link.js:14`.

**Risk:** low. The change from `\n` to `\n\n` adds one token (blank line). For
BGE-M3 / bge-m3-onnx with max_length=8192, this is negligible for typical chunk
sizes. Still must be verified by the equivalence test.

### Pre-condition B — Extend `buildLinks()` API

Add an optional `precomputedDense` parameter:

```js
export async function buildLinks(chunk, collections, graph, sourceCollection, precomputedDense = null) {
  const { dense } = precomputedDense
    ? { dense: precomputedDense }
    : await embedForSearch(sourceCollection, chunk.context + '\n\n' + chunk.text);
  ...
}
```

When `precomputedDense` is null (default), behavior is identical to today.
When provided, the ONNX call is skipped entirely.

### Pre-condition C — Pass dense from phase 4 to phase 5

In `src/indexer/index.js`, thread the phase-4 dense vectors through to the
`buildLinks()` call in phase 5.

**⚠ Do NOT use a callback index to correlate chunks to dense vectors.**
`runBatched` in `src/indexer/batch.js` calls `batch.map(fn)`, so the callback
receives the element only — no global index. On the second batch, `i` resets to 0,
meaning `points[i].dense` on batch 2 would return the dense vector for chunk 0,
not chunk `batchSize`. This produces silently wrong links.

**Safe approach — zip before phase 5:**

```js
// phase 4 — carry dense forward alongside each point
const pointsWithDense = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
  const embedText = `${chunk.context}\n\n${chunk.text}`;
  const { dense, sparse, meta } = await embedForIndex(collection, embedText);
  return { point: { id: randomUUID(), vector: { dense, sparse }, payload: { ... } }, dense };
});

// extract points for upsert
const points = pointsWithDense.map(({ point }) => point);
await upsertPoints(collection, points);

// phase 5 — zip chunk + its dense vector before entering runBatched
const chunksWithDense = taggedChunks.map((chunk, i) => ({ chunk, dense: pointsWithDense[i].dense }));
const linkedChunks = await runBatched(chunksWithDense, BATCH_SIZE, ({ chunk, dense }) =>
  buildLinks(chunk, allCollections, graph, collection, dense));
```

The zip (`taggedChunks.map((chunk, i) => ...)`) is done outside `runBatched` using
a plain array map, where `i` is a correct global index. The callback then receives
the paired object directly — no index arithmetic inside `runBatched`.

---

## 3. Equivalence test design

### Can we test dense reuse without modifying production code?

**Partially.** The baseline capture (current behavior) runs today with no
production changes. The candidate capture requires Pre-conditions A+B+C to be
implemented first — there is no clean way to simulate dense reuse from outside
the production code without patching it.

The approach is therefore a two-phase harness:

| Phase | When runnable | What it does |
|-------|--------------|-------------|
| Baseline capture | Now | Index fixture corpus, snapshot links/backlinks/graph |
| Candidate capture | After patch | Index same corpus with patched code, snapshot again |
| Diff | After both | Compare normalized snapshots, PASS if empty diff |

### Corpus

**Fixture files** (all 6 from `benchmarks/retrieval/custom-50/fixtures/docs/`):
- `config-env.md`
- `mcp-workflow.md`
- `project-structure.md`
- `benchmarking.md`
- `multilingual.md`
- `obsidian.md`

The script copies exactly these 6 files into a temp directory and runs the indexer
against that temp dir. `SOURCE_ROOT` is set to the temp dir, so `source_file`
paths in Qdrant payloads are just the filenames — consistent between baseline and
candidate runs regardless of where the script is executed.

Rationale: all 6 files are used so that the indexed corpus and the `FIXTURE_FILES`
constant in the script are always identical. Using a subset created a metadata
mismatch (script said 3 files, indexer saw 6). More files also increases the
probability of cross-file links being produced at `LINK_MIN_SCORE=0.70`.

### Collections

| Collection | Purpose |
|-----------|---------|
| `_equiv-baseline-<stamp>` | current production code |
| `_equiv-candidate-<stamp>` | patched production code (TODO) |

Both are temporary and deleted in the `finally` / cleanup block.

### Fields compared

| Field | Source | Normalization |
|-------|--------|--------------|
| `links` per source_file | Qdrant point payload, all chunks for that file | Union across chunks; sort alphabetically |
| `backlinks` per source_file | Qdrant point payload, all chunks | Union; sort alphabetically |
| `graph.<col>.json` links | graph file on disk | Sort links/backlinks per node; sort node keys |

### Normalization — what is stripped

| Stripped | Why |
|---------|-----|
| Point UUIDs | Random; differ per run |
| Collection names | Differ between baseline and candidate |
| Chunk-level duplicates | Links are unioned at file level; chunk order is not semantically meaningful |
| Graph key ordering | JSON key order is not semantically meaningful |

### Pass / fail criterion

**PASS** — baseline and candidate produce identical normalized snapshots:
- `payloads` diffs empty (same links/backlinks for every source_file)
- `graph` diffs empty (same graph structure)

**FAIL** — any difference in normalized links, backlinks, or graph structure.
Print a compact diff (source_file, field, baseline value, candidate value).

### Expected pre-patch diff (format only)

Before Pre-condition A lands, running baseline with `\n\n` vs candidate with `\n`
will show a diff if any link decision changes near the score threshold. After Pre-
condition A (both use `\n\n`), and before Pre-condition B (reuse disabled by
default), baseline and candidate should produce identical link decisions — same text
produces the same vector, same scores, same threshold outcomes.

**Note:** Patch A itself produced a non-empty diff vs the pre-A baseline (7 payload +
11 graph differences at LINK_MIN_SCORE=0.70). That diff is an **accepted behavior
delta**: the `\n` format in phase 5 was an inconsistency. The post-Patch-A snapshot
(`link-equivalence-snapshot-1779016800146.json`) is the new reference. Vector reuse
(B+C) must produce zero additional delta vs this reference — same text, same vector,
same scores, same links.

---

## 4. Script

**`benchmarks/retrieval/smoke-live-link-equivalence.js`**

- Baseline capture runs now.
- Candidate capture is a TODO block in the script, documented inline.
- Saves normalized snapshot to `benchmarks/retrieval/results/link-equivalence-baseline-<stamp>.json`.
- Usage: `ONNX_EMBED=1 node benchmarks/retrieval/smoke-live-link-equivalence.js`
- NOT part of `npm run smoke` (requires live Qdrant + ONNX model).

---

## 5. Safe production patch — recommended sequence

1. Run baseline capture. Save snapshot.
2. Implement Pre-condition A (unify `\n` → `\n\n` in `link.js:14`).
3. Run candidate capture with A only. Diff against baseline.
   - If diff empty → format change is safe, proceed.
   - If diff non-empty → investigate which links changed; decide whether to adjust
     `LINK_MIN_SCORE` or accept the delta.
4. Implement Pre-conditions B + C (API change + index.js threading).
5. Run candidate capture with A+B+C. Diff against A-only candidate (not baseline).
   - Diff must be empty — same text, same vector, same scores, same links.
6. Merge only after step 5 passes.

---

## 6. What this harness does NOT test

- **Ordering within `links` array per chunk** — order is implementation-defined;
  we normalize by sorting. If callers depend on link order, that is a separate issue.
- **Score values** — we compare link presence/absence, not cosine similarity.
- **Multi-collection scenarios** — fixture corpus is single-collection for simplicity.
  After single-collection passes, re-run with `LINK_COLLECTIONS` spanning two
  collections if the production use case includes cross-collection links.
- **Performance** — this is a correctness harness. Latency measurement is done
  separately via `INDEX_PROFILE=1`.

---

## 7. Runability status (2026-05-17)

| Part | Status |
|------|--------|
| Baseline capture script | ✅ done |
| Snapshot diff mode | ✅ done (`diff <before.json> <after.json>`) |
| Pre-condition A (unify `\n` → `\n\n`) | ✅ **implemented and verified** — 2026-05-17 |
| Pre-condition B (buildLinks optional dense param) | ⏳ pending |
| Pre-condition C (zip phase-4 dense in index.js) | ⏳ pending |
| Candidate capture (B+C) | ⏳ blocked on B+C |
| Full PASS/FAIL diff (A vs A+B+C) | ⏳ after B+C |

**Patch A result:** diff non-empty at `LINK_MIN_SCORE=0.70` — 7 payload and 11 graph
differences. Accepted: format unification is correct; the delta is near-threshold
variance from the `\n` inconsistency, not a semantic regression. See
`2026-05-17-link-dense-reuse-patch-a-result.md` for full diff.

**Reference snapshot for B+C diff:** `link-equivalence-snapshot-1779016800146.json`
(post-Patch-A, phase 5 using `\n\n`). The B+C candidate must be diffed against
this snapshot, not the original pre-A baseline.

The baseline can be recaptured any time by running the script against the current
production code.
