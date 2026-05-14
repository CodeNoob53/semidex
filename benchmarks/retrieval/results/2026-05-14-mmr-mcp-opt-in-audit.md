# Audit: MMR / Diversity as Opt-In MCP Search Mode

Date: 2026-05-14

## Summary

`mmrSearch()` exists, is benchmarked, and shows a consistent tradeoff: improved
source diversity at the cost of exact-token recall — especially for the ONNX
provider where the regression is 4.8 pp Recall@1 at all tested diversity values.
Adding it as an MCP opt-in is low-risk architecturally (one new enum parameter,
one import), but it requires clear agent-facing guardrails to prevent misuse on
technical/config queries. A docs-only Stage 1 is safe to ship now; the runtime
opt-in (Stage 2) requires a smoke test for argument parsing and a live benchmark
confirmation before merging.

---

## Q1 — How does mmrSearch() work?

**Source:** `src/core/qdrant.js:91`

```js
export async function mmrSearch(collection, denseVector, limit = 5, filter = null, opts = {}) {
  const diversity = opts.diversity ?? 0.5;
  const candidatesLimit = Math.max(opts.candidatesLimit ?? 100, limit);
  const body = {
    query: { nearest: denseVector, mmr: { diversity, candidates_limit: candidatesLimit } },
    using: 'dense',
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;
  // posts to /collections/{collection}/points/query
}
```

Key facts:

| Property | Value |
|----------|-------|
| Vector used | **Dense only** — `using: 'dense'`. No sparse leg. |
| Qdrant endpoint | `/points/query` with `query.nearest + query.mmr` |
| Default diversity | `0.5` |
| Default candidatesLimit | `max(100, limit)` |
| Filter support | Yes — passed through as Qdrant filter |
| Sparse/RRF fusion | **None** — MMR is inherently single-vector |

MMR reranks candidates fetched by dense nearest-neighbor, penalising results
that are too similar to already-selected ones. It is not a replacement for
hybrid RRF — it trades keyword recall for source diversity.

---

## Q2 — How does MCP qdrant_search() work?

**Source:** `src/mcp/tools/search.js`

Current call path:

```
handle({ query, collection, top, tags, source_file, window, window_format })
  → embedForSearch(collection, query)          → { dense, sparse }
  → if RERANK_ENABLED:
      hybridSearch(collection, dense, sparse, top * RERANK_PREFETCH_MULT, filter)
      → rerankResults(candidates, query, { finalLimit: top })
    else:
      hybridSearch(collection, dense, sparse, top, filter)
  → for each result: optional fetchWindowChunks + assembleWindowChunks
  → format as Markdown
```

Current parameters accepted by the tool:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `query` | string | required | Natural language |
| `collection` | string | required | |
| `top` | integer | 5 | |
| `tags` | string[] | none | OR filter |
| `source_file` | string | none | exact match filter |
| `window` | integer | 0 | 0–2 |
| `window_format` | enum | `"full"` | `"full"` or `"compact"` |

There is no `search_mode`, `diversity`, or MMR-related parameter today.
`hybridSearch` is the only search path in the tool.

---

## Q3 — API design options

### Option A: `search_mode` enum (recommended)

```json
"search_mode": { "type": "string", "enum": ["hybrid", "dense_mmr"], "default": "hybrid" }
```

- Explicit, self-documenting in the MCP schema.
- Agents can see the enum values in tool introspection.
- Easy to add `mmr_diversity` as a companion float with a sensible default.
- Default `"hybrid"` is backward-compatible — existing calls unchanged.

### Option B: `diversity: true` boolean

- Less expressive — no way to tune the diversity value.
- Implies diversity is the goal, not "different search mode" — subtly misleading.
- Would require a hidden default (0.3? 0.5?) that isn't visible to the agent.

### Option C: Separate `qdrant_search_diverse` tool

- Clean separation of concerns.
- Doubles the tool surface the agent must learn.
- Harder to keep the two tools in sync as parameters evolve.
- Appropriate if MMR eventually supports hybrid (it currently doesn't).

**Recommendation: Option A** — `search_mode: "hybrid" | "dense_mmr"` with
optional companion parameters (default 0.3 for mmr_diversity based on benchmark
results; 0.5 is the current code default but regresses onnx at all tested values).

Companion parameters:

```json
"mmr_diversity": { "type": "number", "default": 0.3, "minimum": 0.0, "maximum": 1.0,
                   "description": "MMR diversity weight (0 = relevance-only, 1 = maximum diversity). Only used when search_mode=dense_mmr." },
"mmr_candidates_limit": { "type": "integer", "default": 100, "minimum": 1,
                           "description": "Candidate pool size before MMR selection. Only used when search_mode=dense_mmr." }
```

---

## Q4 — Required guardrails

### In the MCP tool schema description

The `search_mode` field description must include:

> `"dense_mmr"` uses dense-only Qdrant MMR — useful for source diversity across
> a broad topic, not for exact technical, config, or provider recall. Benchmark
> results show Recall@1 is equal or lower than hybrid RRF for all tested
> diversity values (ollama: 0pp delta at diversity=0.3; onnx: −4.8pp at all
> tested values). Use `"hybrid"` (default) for any query where exact token
> matching matters.

### In the tool's handle() logic

- Default must be `"hybrid"` — MMR is never activated unless explicitly requested.
- If `search_mode === "dense_mmr"`, only embed dense vector (no need to call
  sparse embedding). This is a minor efficiency gain and avoids the misleading
  appearance of hybrid input feeding a dense-only retrieval.
- `diversity` parameter ignored (with no error) when `search_mode === "hybrid"`.
- `window` and `window_format` continue to work normally regardless of mode.
- Filters (`source_file`, `tags`) passed through — `mmrSearch` already supports
  the `filter` argument.

### In AGENTS.md

Add a note in the "Search Tactics For Agents" section:

> For technical, config, or provider-specific queries, always use the default
> `search_mode="hybrid"`. Switch to `search_mode="dense_mmr"` only when the
> goal is broad topic coverage across distinct source files and exact recall is
> less critical (e.g. "find five different documents about X" rather than
> "find the exact value of Y").

---

## Q5 — Tests needed

### Stage 2 smoke tests (argument parsing)

Pure unit — no Qdrant:

1. `handle()` with no `search_mode` → calls `hybridSearch` (verify mock call).
   *Note:* the current smoke infrastructure does not mock `hybridSearch`; this
   test requires either a light mock or a separate argument-routing unit.
2. `handle()` with `search_mode="dense_mmr"` → calls `mmrSearch`.
3. `handle()` with `search_mode="dense_mmr"` and explicit `diversity=0.7` →
   `mmrSearch` receives `opts.diversity === 0.7`.
4. `handle()` with `search_mode="dense_mmr"` and `source_file` filter →
   filter is passed through to `mmrSearch`.
5. `handle()` with unknown `search_mode` → falls back to `hybridSearch` or
   throws a clear error (decide before implementing).

### Stage 3 live benchmark

- Run `npm run bench:retrieval:mmr` after implementing runtime opt-in.
- Confirm no regression in `hybrid` mode (existing baseline).
- Confirm MMR results match the 2026-05-10 MMR matrix benchmark numbers
  (or note variance from indexing differences).
- Commit result to `benchmarks/retrieval/results/`.

---

## Q6 — Docs-only first vs immediate runtime opt-in?

**Recommendation: docs-only Stage 1 first.**

Reasons:

1. The benchmark evidence already exists (2026-05-10 MMR matrix). Documenting
   the tradeoff and intended use case does not require code changes.
2. The runtime change is small but touches the hot path of the MCP tool —
   worth a dedicated PR with smoke tests and a benchmark confirmation.
3. Agent-facing guidance in AGENTS.md / mcp-tools.md establishes the right
   mental model before the parameter exists, so agents don't misuse it when
   it ships.
4. No risk of breaking existing searches while the guardrail docs are written.

---

## Recommended Implementation Plan

### Stage 1 — Docs only (safe to do now)

Files: `docs/en/mcp-tools.md`, `AGENTS.md`, `docs/en/benchmarking.md`

- Add a "Search mode" subsection to mcp-tools.md explaining that `qdrant_search`
  uses hybrid RRF by default and that an opt-in dense-MMR mode is planned.
- Add a note in AGENTS.md "Search Tactics For Agents" about when NOT to use MMR.
- Add MMR benchmark results summary to benchmarking.md (the 2026-05-10 numbers
  are already in summary.md but not in the human-readable docs).

### Stage 2 — Runtime opt-in

Files: `src/mcp/tools/search.js`, `src/smoke.js`

Changes:

1. Add `search_mode` (enum, default `"hybrid"`), `mmr_diversity` (float, default
   `0.3`), and `mmr_candidates_limit` (integer, default `100`) to the JSON schema.
2. In `handle()`:
   - if `search_mode === "dense_mmr"`: embed dense only, call `mmrSearch` with
     `diversity` and `candidatesLimit = max(top * 4, top + 5)`.
   - else (default `"hybrid"`): existing path unchanged.
3. Import `mmrSearch` from `../../core/qdrant.js`.
4. Add smoke tests for argument routing (cases 1–5 in Q5).

### Stage 3 — Live smoke and benchmark

- Add a `smoke:mmr-live` script or extend `smoke:retrieval-live` with a
  `search_mode="dense_mmr"` test call.
- Run the full MMR matrix benchmark post-implementation.
- Update `benchmarks/retrieval/results/summary.md`.

---

## Appendix: Benchmark numbers (2026-05-10 MMR matrix, 21 queries)

| Variant | Recall@1 | MRR | dupSourceRate | diversity |
|---------|----------|-----|---------------|-----------|
| ollama-rrf (baseline) | 90.5% | 0.940 | 61.9% | — |
| ollama-mmr0.3 | 90.5% | 0.952 | 50.5% | 2.48 |
| onnx-rrf (baseline) | **95.2%** | 0.976 | — | — |
| onnx-mmr0.3 | 90.5% | 0.952 | — | — |

Key observation: `ollama-mmr0.3` is the only variant where MMR is a net win —
same Recall@1, better MRR, −11.4pp duplicate source rate. For onnx, the hybrid
RRF baseline dominates at all tested diversity values. If only one default MMR
diversity is shipped, `0.3` is the safer choice.
