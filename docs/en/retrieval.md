# Retrieval

semidex retrieval is hybrid by default. It combines semantic similarity with exact lexical matching and exposes the result through MCP.

## Hybrid Search

Every `qdrant_search` call runs two parallel searches:

- **Dense leg** - semantic similarity over 1024-dimensional neural vectors.
- **Sparse leg** - lexical weight matching for exact terms, identifiers, and rare tokens.

Qdrant merges both result lists with **Reciprocal Rank Fusion (RRF)**.

Dense search helps with:

- paraphrases
- vague natural-language questions
- cross-language and mixed-language queries
- concept similarity

Sparse search helps with:

- function names
- env vars
- file names
- config keys
- technical identifiers like `embedding_schema_version`

## Search Pipeline Layers

For agents, `qdrant_search` remains a single MCP tool. Additional ranking
methods are internal pipeline layers, not separate agent-facing tools.

The intended shape is:

```text
qdrant_search
  -> hybrid dense+sparse candidate retrieval
  -> optional deterministic rerank
  -> optional cross-encoder rerank
  -> future optional ColBERT / late-interaction rerank
  -> final top-K chunks returned to the agent
```

The first stage finds a candidate pool. Later stages reorder that pool so the
best chunks are more likely to appear in `top=3` or `top=5`. They should not be
enabled globally until benchmarks show they improve quality without hurting
recall, negative queries, or watched query classes.

## RRF

Dense and sparse scores live on different scales, so semidex does not add raw scores. RRF works by rank position:

```text
rrf(d) = 1 / (k + rank_dense(d)) + 1 / (k + rank_sparse(d))
```

Relevant environment variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `RRF_K` | `60` | RRF smoothing constant |
| `HYBRID_PREFETCH_LIMIT` | `2` | Per-leg candidate multiplier: prefetch = max(top × mult, top + 1) |

## Interpreting Scores

`qdrant_search` returns RRF scores for each result. These scores are **not confidence percentages** and should not be compared against a fixed threshold.

Typical hybrid RRF score range: **0.016–0.033**. A result at `0.033` is the top-ranked hit; a result at `0.016` may still be the only chunk in the corpus that answers the question. Both can be correct answers.

**What causes this range:**

RRF works by rank position, not by raw vector similarity:

```text
rrf(d) = 1/(k + rank_dense) + 1/(k + rank_sparse)
```

With `RRF_K=60`, rank 1 contributes `1/(60+1) ≈ 0.0164` per retrieval leg. If
dense and sparse both rank the same chunk first, the combined score is about
`0.033`. All returned scores fall inside this narrow band regardless of how well
the query matched.

**What to compare instead of absolute scores:**

- **Rank order within the result set** — rank 1 is better than rank 3, even if
  both scores look "low"
- **`source_file` and `section`** — does the hit come from the expected file?
- **Exact-token overlap** — does the matched chunk contain the query identifiers?
- **`context` field** — does the LLM-generated summary confirm the chunk is on topic?
- **`window=1` neighbors** — is the surrounding context consistent with the query?

**Debugging apparent misses:** if results look wrong despite reasonable scores,
check provider metadata (`qdrant_collection_info`), section scope, and exact token
overlap before assuming the retrieval system is broken. A provider mismatch
(dense/sparse indexed with a different model than the query embedding) will cause
silent quality degradation that looks like "low scores" but is actually a schema
mismatch. Run `npm run sync` to verify.

## Providers

| `denseProvider` | `sparseProvider` | Dense model | Notes |
|-----------------|------------------|-------------|-------|
| `ollama` | `hashed-tf` | `bge-m3`, `snowflake-arctic-embed2`, ... | Default. Requires Ollama. Sparse is zero-dependency hashed TF. |
| `bge-m3-onnx` | `bge-m3-onnx` | `aapot/bge-m3-onnx` | Set `ONNX_EMBED=1`. Downloads about 2.3 GB once. Best current option for Ukrainian and mixed-language text. |

Invalid mixed combinations are rejected at runtime.

## Provider Metadata

Provider config is stored in:

- `config.json`
- each Qdrant point payload

Changing provider, model, schema version, or vector size forces reindexing so query embeddings cannot silently mismatch indexed vectors.

## Dense-only Fallback

Old collections without sparse vectors still work. Hybrid search falls back to dense-only behavior when sparse support is missing.

Run:

```bash
npm run sync
```

to backfill collection config and ensure required indexes/sparse support where possible.

## Reranking

Reranking is optional and off by default.

When `RERANK_ENABLED=1`, semidex fetches more Qdrant candidates, scores them locally, then returns the best final results.

Signals:

| Signal | Default boost |
|--------|---------------|
| query token in `source_file` | `0.08` |
| query token in `section` | `0.06` |
| query token in `tags` | `0.05` |
| query token in `text` | `0.01` |
| incoming backlink | `0.04` |

Technical tokens such as `snake_case`, `ACRONYM`, `camelCase`, and long identifiers are weighted higher than prose words. Common Ukrainian and English stopwords are ignored.

The reranker also applies:

- original RRF rank prior, weighted by `RERANK_BASE_WEIGHT`
- source diversity penalty
- top-1 protection via `RERANK_PROTECT_TOP1_DELTA`
- intro-chunk penalty via `RERANK_PENALTY_INTRO_CHUNK` (default `0.02`): demotes `chunk_index=0` results when the query contains ≥2 technical tokens, discouraging overview/intro chunks from outranking specific content

**custom-50 (ONNX, 49 positive queries):** reranking improves MRR@10 by ~0.005 and chunkRecall@5 by ~2 pp over hybrid-only.

**custom-150 Tier B (ONNX, 75 queries, 2026-05-15):** deterministic rerank is not promotable as a global default. MRR@10 is flat (+0.001), chunkRecall@5 drops −4.2 pp, chunkRecall@10 drops −5.6 pp, nDCG drops −0.013. The `cross-lingual-ua-en` class regresses most sharply (MRR 0.520→0.438, cR@5 75%→50%); the reranker systematically pushes UA-query/EN-chunk pairs down. The only class that benefits is `provider-activation` (4 queries — too small to justify global enablement). Full result files: `benchmarks/retrieval/results/2026-05-15-custom150-onnx-hybrid.txt` and `benchmarks/retrieval/results/2026-05-15-custom150-onnx-rerank.txt`.

**Decision:** keep `RERANK_ENABLED=0`. Class-specific routing (e.g. skip rerank for Cyrillic-script queries) is a candidate future path but requires validation on a larger dataset.

## Literal and Exact-Token Queries

For exact-token queries — error strings, env var key=value pairs, function
names, config identifiers, log line fragments — use the standard hybrid
`qdrant_search` with verbatim terms in the query string.

BGE-M3 sparse (`bge-m3-onnx` provider) encodes technical tokens as neural
lexical units and retrieves them reliably. Benchmark evidence
(`bench-retrieval-custom-raw`, 2026-05-12, bge-m3-onnx): **100% tokenHit@5**
on all 7 exact-token queries including `ONNX_EMBED=1`,
`Error: OOM killed at /src/indexer.js:42`, and `WARN: Qdrant timeout after 5000ms`.

**hashed-TF (ollama default) is weaker on rare tokens.** For raw-log or
config-dump corpora where literal recall matters, use `ONNX_EMBED=1`.

**No separate literal search mode is implemented.** Full-text / literal search
is deferred — hybrid sparse covers all confirmed exact-token use cases and
Qdrant payload `match: { text: "..." }` filters are still tokenized, not true
verbatim substring search. See audit and trigger criteria in
`benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md`.

## MMR Diversity Evaluation

Qdrant MMR is available for nearest-neighbor queries and improves result
diversity when many candidates are redundant. In semidex it is currently exposed
as a benchmark search mode, not as an MCP retrieval option:

```bash
BENCH_SEARCH_MODE=dense-mmr npm run bench:retrieval
npm run bench:retrieval:mmr
```

**MMR is dense-only.** It uses Qdrant's `nearest + mmr` query on the `dense`
vector. There is no sparse leg and no RRF fusion. This is a fundamental property
of the Qdrant MMR query, not a configuration choice.

The production default remains hybrid dense+sparse RRF because the sparse leg is
critical for exact technical tokens — env vars, function names, config keys,
schema field names. Dense-only retrieval misses these when they are not
paraphrase-reachable.

**Benchmark conclusions (2026-05-10, 21 queries):**

| Variant | Recall@1 | dupSourceRate | Notes |
|---------|----------|---------------|-------|
| ollama-rrf | 90.5% | 61.9% | RRF baseline |
| ollama-mmr0.3 | 90.5% | 50.5% | Best tradeoff: same recall, −11.4pp duplicates |
| onnx-rrf | **95.2%** | — | RRF dominates |
| onnx-mmr0.3 | 90.5% | — | −4.8pp Recall@1 at all tested diversity values |

For ONNX, hybrid RRF wins at every tested diversity level. For ollama,
`diversity=0.3` preserves recall while reducing duplicate sources.

**When MMR is appropriate (exploratory/broad queries):**
- "Find me a variety of documents about topic X" — source diversity matters more
  than exact recall.
- Exploratory overview queries where results from the same file are redundant.

**When to stay on hybrid RRF (all other cases):**
- Any query involving exact identifiers: env vars, function names, field names,
  model names, provider strings.
- Config lookups, error message matching, code search.
- Any query where the answer is a specific value rather than a broad topic.

**MCP opt-in (Stage 2) — deferred:**

```json
"search_mode": "hybrid"        // default — hybrid dense+sparse RRF
"search_mode": "dense_mmr"     // planned opt-in — dense-only MMR, diversity trading recall
"mmr_diversity": 0.3           // recommended starting value (0.0–1.0)
"mmr_candidates_limit": 100    // candidate pool size before MMR selection
```

The `"hybrid"` default is permanent. Stage 2 requires: (a) live broad-query
`dupSourceRate` ≥ 60% for ≥ 3 exploratory queries, (b) confirmed agent answer
quality degradation, (c) smoke tests for argument routing. The 61.9% baseline
`dupSourceRate` comes from exact/technical queries — not from broad queries
where the problem is hypothesised to occur. See
`benchmarks/retrieval/results/2026-05-14-duplicate-source-pressure-audit.md`
and `benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`.

Useful MMR knobs (benchmark mode only):

| Variable | Default | Description |
|----------|---------|-------------|
| `MMR_DIVERSITY` | `0.5` | Balance between relevance (`0.0`) and diversity (`1.0`) |
| `MMR_CANDIDATES_LIMIT` | `100` | Candidate pool size before MMR selection |
| `MMR_DIVERSITIES` | `0.3,0.5,0.7` | Matrix values for `bench:retrieval:mmr` |

Evaluate MMR by checking whether `dupSourceRate` decreases and
`sourceDiversity` increases without unacceptable drops in `Recall@1`, `MRR`, or
`nDCG@K`.

## Entity Boost (Opt-In)

Entity boost is an optional post-RRF rerank stage that improves retrieval
for **source-navigation queries** — queries that name specific file paths,
function symbols, env vars, or npm commands.

When enabled, the indexer extracts structured entity tokens from each chunk
at index time (`entities.paths`, `entities.symbols`, `entities.env_vars`,
`entities.commands`). At query time, the same extractor runs on the query
string and scores each candidate by entity token overlap:

```text
finalScore = rrfScore + ENTITY_BOOST_WEIGHT × |queryEntities ∩ chunkEntities|
```

**Default: off.** Set `ENTITY_BOOST_ENABLED=1` to enable. Queries with no
entity tokens are unaffected (overlap = 0, boost = 0).

**Backward compatibility:** collections indexed before entity support was added
have no `entities` field in their payloads. The boost produces overlap = 0 for
those points — the result list is unchanged and no reindexing is required to
safely enable the flag. Run `APPLY=1 COLLECTION=<name> npm run backfill:entities` to gain the
quality benefit on an existing collection.

**Benchmark evidence (custom-50, ONNX, 3 fresh reindexes):**

| Weight | c35 | c36 | c37 | new hard reg | chunkRecall@5 |
|--------|-----|-----|-----|-------------|---------------|
| 0 (off) | ✓ | ✓ | ✗ | 0 | 89.8% |
| 0.0015 | ✓ | ✓ | ✓ | 0 | 91.8% (+2.0pp) |

Source-navigation cliff cases (c35, c36, c37) are stable 3/3 across all 3
reindexes at weight 0.0015. No new regressions at any tested weight
(0.001–0.005). Full evidence: `benchmarks/retrieval/results/2026-05-27T2000-entity-boost-benchmark.md`,
ADR 0005.

**Known tradeoff:** c36 (symbols query, 3 overlapping tokens) sees the Source
Tree chunk promoted above the Key Modules subsection — MRR drops 0.500 → 0.333.
Both chunks are rel=3 and cr@5 remains ✓. Monitor if rank-1 selection quality
matters for your use case.

## Relevant Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_EMBED` | `0` | Shorthand for `bge-m3-onnx + bge-m3-onnx` |
| `DENSE_PROVIDER` | unset | Explicit dense provider |
| `SPARSE_PROVIDER` | unset | Explicit sparse provider |
| `DENSE_MODEL` | unset | Dense model override for Ollama |
| `RRF_K` | `60` | RRF smoothing |
| `HYBRID_PREFETCH_LIMIT` | `2` | Per-leg candidate multiplier: prefetch = max(top × mult, top + 1) |
| `ENTITY_BOOST_ENABLED` | `0` | Enable post-RRF entity overlap boost (opt-in; see Entity Boost section) |
| `ENTITY_BOOST_WEIGHT` | `0.0015` | Additive score bonus per overlapping entity token |
| `ENTITY_BOOST_PREFETCH` | `20` | Candidate pool size for entity rerank; if ≤ top, no extra Qdrant call |
| `RERANK_ENABLED` | `0` | Enable local reranker |
| `RERANK_PREFETCH_MULT` | `4` | Candidate multiplier before reranking |
| `RERANK_DEBUG` | `0` | Print reranker scoring details |
| `RERANK_BASE_WEIGHT` | `1.00` | Weight applied to the original RRF rank prior before local boosts |
| `RERANK_PENALTY_INTRO_CHUNK` | `0.02` | Score penalty for `chunk_index=0` when query has ≥2 technical tokens |
| `RERANK_INTRO_CHUNK_TECH_MIN` | `2` | Minimum technical token count to activate the intro-chunk penalty |
| `RERANK_BOOST_TEXT_LEAD` | `0.00` | Bonus per token hit in the first `RERANK_TEXT_LEAD_CHARS` chars of text; off by default |
| `RERANK_TEXT_LEAD_CHARS` | `200` | Window size for `RERANK_BOOST_TEXT_LEAD` |
| `MMR_DIVERSITY` | `0.5` | Dense MMR diversity balance for benchmark mode |
| `MMR_CANDIDATES_LIMIT` | `100` | Dense MMR candidate pool size |

## Cross-Encoder Reranking (Benchmark Only)

Cross-encoder reranking is implemented as a standalone benchmark
(`npm run bench:custom50:ce`, [benchmarks/retrieval/custom-50/cross-encoder-bench.js](../../benchmarks/retrieval/custom-50/cross-encoder-bench.js)).
It is **not wired into the MCP runtime or `src/`**. The pipeline is:

1. Hybrid RRF fetch — `TOP_K × RERANK_PREFETCH_MULT` candidates from Qdrant
2. Cross-encoder scoring — `AutoModelForSequenceClassification` raw logits for each `(query, passage)` pair
3. Return top-K by CE score

The benchmark compares four candidates on every run: `hybrid-true`, `hybrid-prefetch`, `det-rerank`, and `cross-encoder`.

### Candidate models evaluated (2026-05-15, custom-50, ONNX provider)

**`cross-encoder/ms-marco-MiniLM-L-6-v2` — failed, not promotable**

English-only 6-layer model (~22 MB). Structurally floods Ukrainian queries with
`multilingual.md#4` at rank #1 regardless of input mode. Three hard regressions
(c16, c23, c46 — Ukrainian operational queries) cannot be recovered by any
threshold or input format. The post-correction `text` run achieved MRR@10
`0.552` (vs hybrid-true `0.665`); earlier input variants also failed the
promotion gate.

**`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` — gate passed**

Multilingual 12-layer model (~120 MB). Resolves the Ukrainian flooding entirely.
Best configuration: `CE_INPUT=text+meta` (passage prefixed with `[source_file § section]`).

| Metric | hybrid-true | det-rerank | mmarco text+meta |
|--------|-------------|------------|------------------|
| MRR@10 | 0.665 | 0.663 | **0.760** (+0.095) |
| rank1 exact | 25 | 24 | **29** |
| nDCG@10 | 0.712 | 0.712 | **0.796** |
| chunkRecall@3 | 77.6% | 79.6% | **93.9%** |
| chunkRecall@5 | 87.8% | 89.8% | **95.9%** |
| chunkRecall@10 | 93.9% | 98.0% | **98.0%** |
| windowRecall@5 | 95.9% | 98.0% | **100.0%** |
| negativePass | 100% | 100% | **100%** |
| p50 latency | 49 ms | 51 ms | **3 497 ms** |

### Promotion gate result

| Criterion | text+section | text+meta |
|-----------|:-----------:|:--------:|
| MRR@10 ≥ baseline +0.030 | ✓ 0.755 | ✓ 0.760 |
| chunkRecall@5 ≥ baseline | ✓ 93.9% | ✓ 95.9% |
| negativePass = 100% | ✓ | ✓ |
| zero regressions (rel≥3, rank ≤3 → >3) | ✓ | ✓ |
| **Verdict** | **PASSED** | **PASSED** |

Both input modes pass. `text+meta` has higher MRR, recall at every depth, and
`windowRecall@5` reaches 100%.

**`ONNX-community/bge-reranker-v2-m3-ONNX` (dtype=q4) — gate failed on c03**

Multilingual BGE reranker v2-m3 in 4-bit quantised ONNX form. Model load ~1 600 ms.
A clean single-process latency probe (`ce-latency-probe.js`, result saved in
`benchmarks/retrieval/results/2026-05-15-bge-q4-ce-latency-probe.txt`) reported
CE-inference-only p50 **~31 700 ms** (40 candidates, 8 reps, CPU-only) —
approximately 9× slower than mmarco fp32 and not suitable for interactive use at
current CPU speed. The checked-in benchmark result files show ~56–57 s latency
because both input-mode runs were executed in parallel, causing CPU contention
between the BGE-M3 ONNX embedder and the CE model; the probe figure is the
authoritative single-process measurement.

Both `text+meta` and `text+section` input modes were evaluated. Both fail the
promotion gate on a single query: **c03** (`"як увімкнути bge-m3-onnx без Ollama"`).

#### c03 regression — root cause

The expected answer is `providers.md#2` (rel=3), which describes how to activate
the BGE-M3 ONNX provider. CE ranking places it at **rank #4**, displaced by
`config-env.md#2` at rank #1–2.

`config-env.md#2` is a flat reference table of every ONNX-related environment
variable (`ONNX_EMBED`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, …). It is **not** a
provider activation guide and is correctly assigned **rel=0** in the qrels. BGE q4
over-scores it (+1.326 logit) while under-scoring the true target (−1.489 logit).

Root cause: BGE q4 conflates dense env-var listing chunks with provider activation
queries. The token overlap is high (`onnx`, `provider`, `ONNX_EMBED` all present),
but the chunk is reference material, not instructional content. This is the same
structural class of failure as ms-marco flooding `multilingual.md#4` for Ukrainian
queries — a model weakness, not a qrel error.

The qrel is correct. `config-env.md#2` remains rel=0 and was verified against the
full chunk text in `c03-diagnostic.js`.

#### BGE q4 gate summary

| Criterion | text+section | text+meta |
|-----------|:-----------:|:--------:|
| MRR@10 ≥ baseline +0.030 | ✓ | ✓ |
| chunkRecall@5 ≥ baseline | ✓ | ✓ |
| negativePass = 100% | ✓ | ✓ |
| zero regressions (rel≥3, rank ≤3 → >3) | ✗ c03 | ✗ c03 |
| **Verdict** | **FAILED** | **FAILED** |

#### Conclusion

BGE q4 requires a lexical guard or query-type routing before promotion:
env-var listing chunks must be suppressed for provider activation queries, or
the model must be replaced with a variant that better distinguishes instructional
from reference content. BGE q4 is not a drop-in replacement for mmarco.

Result files (for reference):
- `benchmarks/retrieval/results/2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-meta.txt`
- `benchmarks/retrieval/results/2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-section.txt`

### qrel correction — c36

Before final gate runs, `queries.json` c36 was corrected:
`project-structure.md#1` (Source Tree listing) promoted from `relevance: 2` to
`relevance: 3`. Rationale: the Source Tree chunk explicitly lists
`chunk.js # chunkFile(), splitSentences(), parseMarkdown()` — a direct
source-location answer to the query `"chunkFile splitSentences parseMarkdown
location in source"`. The original rel=2 assignment under-valued a chunk that
names all three functions with their file path. `project-structure.md#7`
(description of `chunkFile`'s exports) remains at `relevance: 3`.

The initial pre-correction run with `text+meta` failed the gate on one regression
(c36: target demoted from rank #2 to #9) because the CE model
over-scores `chunking.md#6` for queries containing `parseMarkdown` — a structural
weakness of MS-MARCO-style cross-encoders on source-navigation queries. After the
qrel correction both `project-structure.md#1` (CE rank #2) and `#7` are accepted
answers, eliminating the regression.

### Latency caveat

p50 latency is ~3 500 ms on CPU (67× slower than deterministic reranking at
~52 ms). This is per-query inference over 40 candidate passages on a single CPU
core. GPU acceleration (`ONNX_EXECUTION_PROVIDER=dml` or `cuda`) would reduce
this substantially, but latency has not been measured on GPU. Cross-encoder
reranking is **not suitable for interactive MCP use at CPU speed**.

### CE routing guard — custom-50 result

CE routing is a benchmark-only experiment that combines deterministic query
routing with a lexical guard on top of the mmarco `text+meta` cross-encoder. It
is implemented in
[`benchmarks/retrieval/custom-50/ce-routing-bench.js`](../../benchmarks/retrieval/custom-50/ce-routing-bench.js)
and is **not production behaviour** — it is not wired into `src/` or the MCP
server.

The classifier assigns each query to one of four route classes
(`provider-activation`, `source-navigation`, `exact-token`, `semantic`). For
non-semantic queries, a lexical guard prevents CE from demoting hybrid top-3
candidates that have strong token overlap with the query (or, for
`provider-activation`, come from a provider activation guide). Semantic queries
are passed through to CE without modification.

**Aggregate result (2026-05-15, mmarco text+meta, custom-50, ONNX provider):**

| Metric | hybrid-true | ce-routed |
|--------|:-----------:|:---------:|
| MRR@10 | 0.655 | **0.760** |
| rank1 exact | 24/49 | **29/49** |
| nDCG@10 | 0.710 | **0.799** |
| chunkRecall@5 | 87.8% | **95.9%** |
| negativePass | 100% | 100% |
| regressions (rel≥3, rank ≤3 → >3) | — | **0** |
| p50 latency | ~50 ms | ~3 300 ms |

Gate passed: MRR@10 +0.105, chunkRecall@5 +8.1 pp, zero regressions, c03 not
regressed (hybrid #2 → ce-routed #3).

**Per-class findings:**

| Type | hybrid MRR | ce-routed MRR | Takeaway |
|------|:----------:|:-------------:|----------|
| `source-navigation` | 0.281 | 0.667 | CE helps strongly; guard fires on 2/3 queries |
| `conceptual` | 0.600 | 0.778 | CE helps broadly |
| `config-env` | 0.553 | 0.725 | recall good, top-rank still imperfect |
| `troubleshooting` | 0.833 | 1.000 | small class, strong signal |
| `provider-activation` | 0.500 | 0.333 | c03 stable (no regression) but guard does not lift to rank 1 |
| `cross-lingual-ua-en` | 0.167 | 0.167 | still weak; CE routing does not solve this class |
| `exact-token` | 0.807 | 0.798 | broadly stable; marginal shift |
| `negative` | — | — | negativePass 100% all modes |

The `cross-lingual-ua-en` class (currently one query, c48) remains the main
unresolved weakness: both hybrid and CE produce MRR 0.167 on a Ukrainian query
whose answer document is primarily English. This is a retrieval-coverage gap,
not a reranking failure.

Result file:
`benchmarks/retrieval/results/2026-05-15-custom50-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt`

**v4 update (heuristic-v4, 2026-05-16):** Guard revised through v2/v3/v4
iterations adding a `config-env` route class, `provider-activation` priority
fix, and top-2 preservation lift. Custom-50 gate **passes** (MRR@10 0.764,
zero rank≤3 regressions, all watched queries stable). Remaining ordering loss:
2 exact-token queries (c08, c11) where CE demotes the correct `qdrant.md` chunk
to rank #2 — both are CE-caused and not recoverable by the guard. See
[benchmarking.md — CE Routing Benchmark](benchmarking.md#ce-routing-benchmark)
for ordering-loss detail and the ColBERT benchmark plan.

### CE routing guard — custom-150 validation result

CE routing was validated on the 75-query custom-150 Tier B dataset using the
same `heuristic-v1` guard ported unchanged from custom-50. Script:
[`benchmarks/retrieval/custom-150/ce-routing-bench.js`](../../benchmarks/retrieval/custom-150/ce-routing-bench.js)

**Gate result: FAILED.**

| Metric | hybrid-true | ce-routed | Delta |
|--------|:-----------:|:---------:|------:|
| MRR@10 | 0.522 | 0.531 | +0.009 |
| chunkRecall@5 | 68.1% | 70.8% | +2.7 pp |
| chunkRecall@10 | 76.4% | 80.6% | +4.2 pp |
| negativePass | 100% | 100% | 0 |
| regressions (rel≥3, rank ≤3 → >3) | — | **4** | — |
| p50 latency | 49 ms | 3 345 ms | — |

The MRR lift is only +0.009 (gate requires +0.030), and four rank≤3→>3
regressions remain. Recall and cross-lingual behavior both improve, so the
failure is in guard precision, not in CE quality:

- **`cross-lingual-ua-en`** — improved: MRR 0.572→0.617, cR@5 held at 75%. The
  main weakness from custom-50 does not reproduce here.
- **`config-env`** — worst regression: MRR 0.524→0.387, cR@5 66.7%→50%, 2
  regressions. CE pushes config table chunks to miss on semantic-routed queries;
  the heuristic guard has no signal for this route class.
- **`provider-activation`** — guard misfire on c150-009: guard protects
  `config-env.md#2` (wrong chunk), causing the true target to slip from rank #3
  to #4.

`ce-oracle` (qrel-aware upper bound) reaches MRR 0.541 with zero regressions,
confirming the candidate pool contains the right chunks — the heuristic cannot
identify them reliably yet.

**Decision: CE routing is not promotable.** The custom-50 result was
encouraging but not sufficient as proof of generalization. The guard needs a
`config-env` route class (protecting chunks from `config-env.md` that contain
the query's env-var token) and a fix for provider-activation guard misfires
before re-validation.

Result file:
`benchmarks/retrieval/results/2026-05-15-custom150-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt`

**v4 update (heuristic-v4, 2026-05-16):** Guard iterations v2/v3/v4 reduced
rank≤3 regressions to zero and lifted MRR@10 +0.031, but custom-150 gate still
**fails** — `provider-activation` type MRR drops −0.104 vs hybrid. The
ordering-loss diagnostic found 6 total top-3 ordering losses (3 CE-caused,
1 guard-caused, 2 mixed), total MRR loss 3.500. The CE-caused losses (c150-032, c150-040, c150-042) are
not addressable by further guard iteration — the ranker itself makes the wrong
choice. See
[benchmarking.md — CE Routing Benchmark](benchmarking.md#ce-routing-benchmark)
for the full ordering-loss table and the ColBERT plan as next step.

### Production status

Cross-encoder reranking is benchmark-only. It is not enabled in `src/` or the
MCP server. Promotion to production requires:

- Passing the custom-150 gate (MRR +0.030, zero regressions) with a revised guard
- holdout-50 validation
- GPU latency measurement (target: p50 < 200 ms)
- Smoke tests for the CE rerank path
- Integration into `src/core/rerank.js` or a new `src/core/ce-rerank.js` module
- `RERANK_CE_ENABLED` env guard following the same pattern as `RERANK_ENABLED`

**CE routing v4 is useful as a safety guard** (zero hard regressions on both
corpora, chunkRecall improves, cross-lingual MRR lifts +0.097 on custom-150)
but is **not sufficient as a final technical ranker**. Three out of six top-3
ordering losses on custom-150 are CE-caused — the cross-encoder itself makes the
wrong ranking choice for exact-token and config-env queries where a relevant prose
chunk scores higher than the target env-var chunk. Further guard tuning cannot fix
ranker-level errors. The next investigation is a stronger late-interaction reranker
(ColBERT). See [benchmarking.md — ColBERT Benchmark Plan](benchmarking.md#colbert-benchmark-plan).

Run the benchmark with:

```bash
npm run bench:custom50:ce
BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta npm run bench:custom50:ce
```

## Limitations

- `hashed-tf` is not BM25. It has no corpus statistics or IDF.
- BGE-M3 ONNX sparse output is neural lexical weighting, not SPLADE vocabulary expansion.
- ColBERT / late-interaction retrieval is benchmark-only (deferred). BGE-M3 `colbert_vecs` improved MRR@10 on custom-50 (+0.043–0.055 vs hybrid) but failed the promotion gate due to 3 ordering losses and ~11 s CPU latency. No runtime or MCP support.
- Cross-encoder reranking at CPU speed (~3 500 ms p50) is not suitable for interactive use.
