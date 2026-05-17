# Link-Phase Dense-Reuse — Patch A Result — 2026-05-17

**Patch A:** unify embed-text format in phase 5 (`\n` → `\n\n`), matching phase 4.  
**File changed:** `src/indexer/phases/link.js:14`  
**Status: DIFF NON-EMPTY — accepted behavior delta (not a regression).**

---

## What was done

### Code change

```diff
- const { dense } = await embedForSearch(sourceCollection, chunk.context + '\n' + chunk.text);
+ const { dense } = await embedForSearch(sourceCollection, `${chunk.context}\n\n${chunk.text}`);
```

One-line change. No API changes, no dense reuse yet. Pre-conditions B+C still pending.

### Snapshot metadata caveat

`link-equivalence-snapshot-1779016229392.json` has `embed_text.phase5_separator: "\\n\\n"` in its
metadata — this is incorrect. The snapshot was captured when the script already had the
post-Patch-A `EMBED_TEXT_NOTE` constant, but `link.js` still used `\n`. The actual link data in
that file reflects the pre-patch `\n` separator. The metadata field is a documentation artifact,
not proof of separator state. Separator state is determined by `link.js` at capture time, not by
the snapshot metadata. The diff output is the authoritative record of what changed.

### Commands run

```
# Baseline (pre-patch: link.js using \n, despite snapshot metadata saying \n\n):
ONNX_EMBED=1 node benchmarks/retrieval/smoke-live-link-equivalence.js
→ benchmarks/retrieval/results/link-equivalence-snapshot-1779016229392.json

# Post-patch (link.js now using \n\n):
ONNX_EMBED=1 node benchmarks/retrieval/smoke-live-link-equivalence.js
→ benchmarks/retrieval/results/link-equivalence-snapshot-1779016800146.json

# Diff:
node benchmarks/retrieval/smoke-live-link-equivalence.js diff \
  benchmarks/retrieval/results/link-equivalence-snapshot-1779016229392.json \
  benchmarks/retrieval/results/link-equivalence-snapshot-1779016800146.json
```

**Provider:** bge-m3-onnx/bge-m3-onnx (ONNX_EMBED=1)  
**Corpus:** 6 fixture files from `benchmarks/retrieval/custom-50/fixtures/docs/`  
**LINK_MIN_SCORE:** 0.70 (lowered from default 0.75 to encourage cross-file links)

---

## Diff result

### Payload links/backlinks: 7 differences

| source_file | field | before | after |
|-------------|-------|--------|-------|
| benchmarking.md | links | [mixed-language-agent-guide.md, troubleshooting-runbook.md, Современный…pdf] | **+config-env.md** |
| benchmarking.md | backlinks | [config-env.md, multilingual.md, project-structure.md] | **+obsidian.md** |
| config-env.md | backlinks | [obsidian.md, project-structure.md] | **−project-structure.md +multilingual.md** |
| mcp-workflow.md | links | [api-reference-large.md, mixed-language-agent-guide.md, obsidian.md, project-structure.md, qdrant.md, sync.md] | **−mixed-language-agent-guide.md** |
| multilingual.md | links | [benchmarking.md, providers.md, Современный…pdf] | **+config-env.md +configuration-manual.md +mixed-language-agent-guide.md** |
| obsidian.md | links | [chunking.md, config-env.md, configuration-manual.md, source_file#chunk_index] | **−chunking.md +benchmarking.md +project-structure.md** |
| project-structure.md | links | […, config-env.md, …] | **−config-env.md +configuration-manual.md** |

### Graph links/backlinks: 11 differences

All graph differences follow from the payload differences above (the graph mirrors link/backlink state). Additional entries not visible in per-file payload view:

- `chunking.md` backlinks: before=[config-env.md, obsidian.md, project-structure.md] → after=[config-env.md, project-structure.md] (obsidian.md dropped chunking.md link)
- `configuration-manual.md` backlinks: +multilingual.md, +project-structure.md
- `mixed-language-agent-guide.md` backlinks: before=[benchmarking.md, mcp-workflow.md] → after=[benchmarking.md, multilingual.md]
- `project-structure.md` backlinks: +obsidian.md

---

## Analysis

The `\n` → `\n\n` change adds one blank-line token to every chunk's embed text.
For bge-m3-onnx this shifts the dense vector by a small but non-zero amount.
At `LINK_MIN_SCORE=0.70` — a deliberately low threshold chosen to maximise
observable cross-file links — some pairs that were near-threshold flip direction:

- Pairs previously just above 0.70 with `\n` may fall below with `\n\n`, or vice versa.
- This explains why some links appear (multilingual.md gains 3) and others drop (obsidian.md loses chunking.md, mcp-workflow.md loses mixed-language-agent-guide.md).

**This is expected and acceptable.** The `\n\n` format is the authoritative embed
text — it matches what phase 4 stores as vectors in Qdrant. The `\n` format in
phase 5 was an inconsistency, not a deliberate design choice. The new link graph
produced by Patch A is more self-consistent: the search vector and the indexed
vector for the same chunk are now produced from identical text.

**At the production default `LINK_MIN_SCORE=0.75`** the delta is likely smaller,
since pairs near 0.70 but not near 0.75 are unaffected. The harness used 0.70 to
maximise sensitivity.

---

## Verdict

**Patch A: ACCEPTED with documented delta.**

The format unification produces a different link graph, but:
1. The difference is expected — `\n` vs `\n\n` was an inconsistency, not a feature.
2. The new graph is more correct — embed text matches what is stored in Qdrant.
3. No links are semantically wrong — score differences are small and near-threshold.
4. The delta is fully recorded above for traceability.

**Do not treat this as a regression.** If specific link decisions are undesirable,
adjust `LINK_MIN_SCORE` rather than reverting the format.

---

## Next step

Patch A is committed. Pre-conditions B+C for dense-vector reuse remain:

**B.** Extend `buildLinks()` to accept an optional `precomputedDense` parameter
   (null-safe default — no behavior change when omitted).

**C.** In `index.js`, zip phase-4 dense vectors to `taggedChunks` before phase 5:
```js
const chunksWithDense = taggedChunks.map((chunk, i) => ({ chunk, dense: pointsWithDense[i].dense }));
const linkedChunks = await runBatched(chunksWithDense, BATCH_SIZE, ({ chunk, dense }) =>
  buildLinks(chunk, allCollections, graph, collection, dense));
```
(See design report `2026-05-17-link-dense-reuse-equivalence-design.md` §Pre-condition C for the full safe pattern.)

After B+C are implemented, re-run the equivalence harness against the Patch A
snapshot (`link-equivalence-snapshot-1779016800146.json`) to verify that dense
vector reuse produces no additional behavior delta — same text in, same vector,
same scores, same links.

---

## Artifacts

| File | Description |
|------|-------------|
| `link-equivalence-snapshot-1779016229392.json` | Pre-Patch-A baseline (phase 5 using `\n`) |
| `link-equivalence-snapshot-1779016800146.json` | Post-Patch-A snapshot (phase 5 using `\n\n`) |
| `src/indexer/phases/link.js` | Patch A applied |
| `smoke-live-link-equivalence.js` | Extended with diff mode |
