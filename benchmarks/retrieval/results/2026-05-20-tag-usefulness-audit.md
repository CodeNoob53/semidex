# Tag Usefulness Audit — Do Tags Justify Indexing Cost?

Date: 2026-05-20
Corpus: semidex self-docs (custom-50, custom-150), sql-cursova, soft-seq
Scope: Audit-only. No production code changes.

## Executive Summary

LLM-generated tags add **low direct retrieval value** under the current default MCP search
path but provide a meaningful secondary surface (`qdrant_find_by_tag`, agent-readable output
display). The cost is **MEDIUM** and spiky: one Ollama call per batch under normal conditions
but one call per chunk when batch parsing fails — a common failure mode with `gemma3:4b`.

**Recommendation: retain tags enabled by default, but add a `TAG_GEN=0` disable flag and
document the opt-out path prominently.** The cost is justified for interactive agent use
cases; it is not justified for automated pipelines where only default hybrid search is used.

---

## 1. Current Tag Dataflow

```
chunk text
    │
    ▼
[phase 3: tag.js]
    addTagsBatch(chunks, model)
        → prompt: "Generate 3-7 topic tags for each chunk…"
        → Ollama call (TAG_MODEL, default: 'gemma3:4b')
        → parse JSON array of arrays
        → on parse failure: fallback to addTagsWithModel() per chunk (N individual calls)
    │
    ▼
chunk.tags = ["tag1", "tag2", ...]   ← stored in Qdrant payload only
                                      ← NOT in embedding prefix (confirmed: embeddings.js)
    │
    ▼
[Qdrant point payload]
    {
      text: "...",
      context: "...",   ← IS embedded (prepended to text)
      tags: [...],      ← payload-only, NOT embedded
      file: "...",
      ...
    }
```

Tags are **payload metadata**. The embedded text is `"context\n\nchunk_text"`. Tags play no
role in vector similarity — they are filterable labels only.

---

## 2. Current User/Agent-Facing Value

### 2a. `qdrant_find_by_tag` (MCP tool)
- Scroll-based tag filter: no vector similarity, pure metadata lookup.
- Useful for "show me everything tagged `authentication`" queries.
- Registered in MCP server (`server.js`). Available to Claude agents.
- **Concrete value**: agents can enumerate topic coverage without forming a query vector.

### 2b. `qdrant_search` tag filter parameter
- `tags?: string[]` parameter — applied as an OR filter (`should` clause in Qdrant).
- Narrows the search space before vector ranking.
- **Actual usage in benchmarks**: zero. Neither `run-v3.js` (custom-50) nor any custom-150
  run passes a `tags` filter. All benchmark queries use unfiltered hybrid search.
- **Actual usage by agents**: sporadic. Agents invoke `qdrant_find_by_tag` occasionally;
  `qdrant_search` tag filtering is rarely set in recorded sessions.

### 2c. Output display
- `search.js` includes `**Tags:** tag1, tag2` in each result block shown to the agent.
- Helps agents understand topic scope of retrieved chunks at a glance.
- **Value**: low-overhead display signal; does not require tags to affect retrieval.

### 2d. `RERANK_BOOST_TAGS` (deterministic reranker path)
- `RERANK_BOOST_TAGS=0.05` — boosts deterministic reranker score when a query token matches a tag.
- The deterministic reranker is **default-off** (ADR 0003). This boost is dormant in production.
- **Value**: effectively zero under current defaults.

---

## 3. Retrieval Impact Analysis

| Retrieval path | Tag involvement | Impact |
|---|---|---|
| Default hybrid RRF (`qdrant_search`, no filter) | None | Zero |
| `qdrant_search` with `tags=[]` filter | OR filter on payload | Reduces candidate set |
| `qdrant_find_by_tag` | Scroll filter only | Direct topic lookup |
| Deterministic reranker + `RERANK_BOOST_TAGS` | Score boost | Dormant (reranker off) |

**Bottom line**: Tags have zero impact on the default retrieval path used in all benchmarks
and in the majority of production agent sessions. They add value only when an agent
explicitly invokes `qdrant_find_by_tag` or passes a `tags` filter to `qdrant_search`.

### Quality benchmark evidence
No benchmark run has ever compared retrieval quality with vs. without tags in the payload.
The custom-50 and custom-150 benchmark suites use hybrid RRF with no tag filters. This means
all MRR/Recall@k numbers in the results directory are measured on a tag-agnostic path.

Tags cannot degrade retrieval (they are not in the embedding prefix) but they also cannot
improve it unless explicitly used as a filter.

---

## 4. Cost Analysis

### Normal case (batch parsing succeeds)
- **1 Ollama call per `LLM_BATCH_SIZE` chunks** (default `LLM_BATCH_SIZE=3`, set in `index.js` line 21 and `context.js` line 5)
- For a 100-chunk document: `ceil(100/3)` = ~34 Ollama calls for tags
- Compare: context phase runs ~100 calls (one per chunk via `addContext`, concurrent via `runBatched`)
- Tag cost ≈ one-third of context cost in the happy path

### Failure case (batch parsing fails → per-chunk fallback)
- `extractJsonArray` fails on the batch response
- `addTagsWithModel` is called per chunk: **N individual Ollama calls**
- `gemma3:4b` triggers this frequently (noted in bottleneck audit)
- For a 100-chunk document: up to 100 tag calls vs. 34 expected
- **Tag cost can match context cost (100 calls) in the failure path**

### Root cause: synthetic empty-section chunks in batch
The chunker emits `(empty section: <name>)` placeholder chunks for empty markdown sections
(observed in music-genre docs corpus: 478 of 5662 chunks = 8.4%). When these placeholders
are included in an `addTagsBatch` call, the LLM receives degenerate input (placeholder text
instead of prose) and returns a malformed response (flat object vs. array of arrays).
`extractJsonArray` fails, triggering the per-chunk fallback for the entire batch.

**Fix (2026-05-21):** `src/indexer/phases/empty-section.js` implements `partitionChunks` /
`reassembleChunks`. Both separate and combined paths in `index.js` partition after `mergeChunks`
and before any LLM call (context or tag), routing empty-section chunks around both LLM phases
entirely. Finalized payload: `context` = `Empty section placeholder for "<name>".`, `tags = []`.
Original chunk order preserved via `__origIndex`.
Smoke tests: section 31 (23 cases, all green).

### Source: `2026-05-17-performance-bottleneck-audit.md`
> "Tagging phase: MEDIUM bottleneck. Batch parse failure rate with gemma3:4b is high.
> Individual fallback dominates wall-clock time when model output is irregular."

### Relative to total indexing cost
| Phase | Call count (100 chunks) | Notes |
|---|---|---|
| Context | ~100 | one call per chunk via addContext (concurrent) |
| Tags (happy) | ~34 | batch, ceil(100/LLM_BATCH_SIZE), default LLM_BATCH_SIZE=3 |
| Tags (failure) | up to 100 | per-chunk fallback, matches context phase |
| Embedding (ONNX) | 0 Ollama calls | local inference |
| Embedding (ollama) | ~100 | one per chunk |

Tags represent 25–50% of total Ollama call budget depending on parse success rate.

---

## 5. Alternatives Table

| Alternative | Effect on retrieval | Effect on cost | Risk |
|---|---|---|---|
| **Keep current** (batch + fallback) | Status quo | MEDIUM-HIGH | gemma3 fallback storm |
| **`TAG_GEN=0` skip flag** | Lose find_by_tag, display tags | Eliminate tag phase | Agent capability reduction |
| **Tags only on `TAG_GEN=1`** (opt-in) | Same as current when on | Zero when off | Breaks existing indexed collections |
| **Benchmark qwen2.5:3b as TAG_MODEL** | No retrieval change | Stable batch parse rate if confirmed | New model dependency |
| **Reduce BATCH_SIZE** | No change | More calls, less fallback | Higher call count but predictable |
| **Embed context+tags together** | Tags would affect retrieval | Same as current | Changes embedding semantics (not recommended) |

The `TAG_GEN=0` disable flag is the lowest-risk path: no schema change, no retrieval
regression, agents working with existing indexed collections are unaffected.

---

## 6. Recommendation

### Short-term: add `TAG_GEN=0` disable flag

Add an environment variable `TAG_GEN=0` that skips the tag phase entirely. When set:
- Tags payload field is omitted (or set to `[]`)
- `qdrant_find_by_tag` still works on previously-indexed chunks (returns fewer results)
- Indexing cost drops by the tag-phase fraction (10–50% of Ollama calls)

This is appropriate for:
- Automated pipelines using only default hybrid search
- Large reindex runs where Ollama throughput is the bottleneck
- Collections where topic browsing via `find_by_tag` is not needed

Keep tags enabled by default for interactive/agent use cases where `find_by_tag` and
result display tags add value.

### Medium-term: benchmark qwen2.5:3b-instruct as TAG_MODEL before considering a default change

`qwen2.5:3b` showed more stable batch JSON output in combined-mode benchmarks (ADR 0004),
but those results are for the `COMBINED_LLM=1` path — not the separate `addTagsBatch`
production phase. A dedicated benchmark using `qwen2.5:3b` as `TAG_MODEL` in the default
separate path is needed before recommending it as a default. If confirmed stable, it would
eliminate the parse-failure fallback storm that makes tag cost unpredictable.

### Not recommended: embed tags into retrieval prefix

Tags are short topic labels. Prepending them to the embedding text would mix two content
types with different semantic registers (prose context vs. keyword labels) without a
controlled evaluation showing improvement. The current separation — tags as payload only —
is architecturally clean and matches the design rationale in ADR 0004.

---

## 7. Follow-up Task Proposals

### FT-1: `TAG_GEN=0` flag ✓ implemented (2026-05-20)
`shouldGenerateTags()` helper added to `src/indexer/phases/tag.js`. Separate and combined
paths both branch on it; `tags: []` stored when disabled. Smoke section 30 covers the helper.
Documented in `docs/en/configuration.md` (TAG_GEN subsection) and `AGENTS.md`.

### FT-2: Tag quality benchmark (1 benchmark session)
Design a query set where correct retrieval requires topic filtering (e.g., "show me all
chunks tagged `authentication`") and measure hit rate vs. `qdrant_find_by_tag` vs. unfiltered
hybrid. Establishes whether tag filters help or hurt precision on topic-scoped queries.

### FT-4: TAG_GEN=0 latency + payload benchmark ✓ run (2026-05-21)
See [`2026-05-21T1833-tag-gen-ablation-custom50.md`](2026-05-21T1833-tag-gen-ablation-custom50.md).
Script: `npm run bench:custom50:tag-gen`.

**Latency result:** TAG_GEN=0 saves 34.7% wall-time (195s → 127s); tag phase eliminated entirely.
**Payload audit:** all sampled points confirmed `tags: []` — shouldGenerateTags() works correctly.
**Quality result: inconclusive.** The script indexes the corpus twice with independent LLM context
runs. Context is embedded into the retrieval prefix, so context variance between runs confounds
any quality comparison. The 1 hard regression (c41) and symmetric regressions/improvements are
consistent with LLM noise, not a TAG_GEN effect. A clean quality test would require copying
the same vectors/points into a second collection with tags stripped — not re-running context
generation. This is not needed: tags are not embedded and cannot affect hybrid RRF retrieval
by design (confirmed in code: `src/core/embeddings.js` does not reference tags).

### FT-3: TAG_MODEL benchmark for separate tag path ✓ completed (2026-05-20)
See [`2026-05-20-tag-model-qwen25-separate-path.md`](2026-05-20-tag-model-qwen25-separate-path.md).
**Result: qwen2.5:3b-instruct does NOT improve the separate tag path.** gemma3:4b baseline had
14.3% fallback rate; qwen same-model was 42.9%; split-model qwen-tags 35.7%. Both qwen scenarios
were worse than gemma on fallback rate and tag phase latency. Default unchanged.

---

## Evidence

- `src/indexer/phases/tag.js` — `addTagsBatch`, `addTagsWithModel`, `extractJsonArray`, fallback logic
- `src/mcp/tools/findByTag.js` — scroll-based tag filter MCP tool
- `src/mcp/tools/search.js` — tags OR filter, output display; tags NOT in embed text
- `src/core/embeddings.js` — confirms tags not referenced (not embedded)
- `docs/en/configuration.md` — `RERANK_BOOST_TAGS`, `tags` payload index, `TAG_MODEL`
- `docs/en/mcp-tools.md` — `qdrant_find_by_tag` usage, `tags?[]` param
- [`benchmarks/retrieval/results/2026-05-17-performance-bottleneck-audit.md`](2026-05-17-performance-bottleneck-audit.md) — tagging phase MEDIUM bottleneck
- `benchmarks/retrieval/custom-50/run-v3.js` — no tag filters in any benchmark query
- [ADR 0004: Combined LLM Context+Tags Mode Opt-In](../../../docs/adr/0004-combined-llm-opt-in.md)
- [ADR 0003: Rerankers Default-Off](../../../docs/adr/0003-rerankers-default-off.md)
