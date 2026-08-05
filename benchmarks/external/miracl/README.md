# MIRACL Russian — local vs Qdrant Cloud retrieval-provider benchmark

This directory holds a **retrieval-provider capability/quality benchmark**
on the official MIRACL Russian (`ru`) development split — not an
end-to-end RAG evaluation, not a Semidex chunker evaluation, and **not a
Ukrainian-language validation**.

It compares two locked provider configurations:

- **local** — current Semidex `bge-m3-onnx` dense + learned sparse
  (`src/local/core/onnx-embed.js`).
- **cloud** — Qdrant Cloud Inference hosted `intfloat/multilingual-e5-small`
  dense (384, Cosine) + server-side `qdrant/bm25` sparse, with the same
  E5 asymmetric prefix contract and BM25 options the BEIR SciFact spike
  already validated (see `../beir/README.md`).

Both profiles are measured at **both** RRF `k=2` and `k=60` (unlike the
BEIR SciFact harness, where only the cloud profile got both — this run
checks the fusion constant for both providers, since it's also comparing
local vs cloud at the same `k`).

MIRACL has **document-level** (passage-level) qrels, so every passage is
indexed as one atomic point — this harness never chunks passages, never
converts the corpus to Markdown, and never invokes Semidex's production
indexer.

## Scope and limits — read this before citing any result from this directory

**MIRACL does not include Ukrainian.** MIRACL covers 18 languages (Arabic,
Bengali, English, German, Spanish, Farsi, Finnish, French, Hindi,
Indonesian, Japanese, Korean, Russian, Swahili, Telugu, Thai, Yoruba,
Chinese) — Ukrainian is not one of them. A result on the Russian split is
**multilingual/Cyrillic evidence only**. It is never a Ukrainian-language
validation, and Russian is never treated as a substitute for a dedicated
Ukrainian dataset. Ukrainian retrieval quality still requires a separate,
independently sourced Ukrainian dataset with its own qrels — see
`../beir/README.md` and the repo roadmap docs for the same caveat applied
to BEIR SciFact.

## Dataset contract (verified against official sources before any code was written)

Sources consulted: the MIRACL paper (Zhang et al., TACL 2023,
[arXiv:2210.09984](https://arxiv.org/abs/2210.09984)), the official
[project-miracl/miracl](https://github.com/project-miracl/miracl) GitHub
repository, and the two official Hugging Face dataset repos below (fetched
directly via their public HTTP API — no `trust_remote_code` Python loading
script was used; see "Why plain TSV/JSONL, not the Python `datasets`
library" below).

| | |
|---|---|
| Topics + qrels repo | [`miracl/miracl`](https://huggingface.co/datasets/miracl/miracl), pinned to commit `5be20db9509754dadad47689368639fcec739c00`, config `miracl-v1.0-ru` |
| Corpus repo | [`miracl/miracl-corpus`](https://huggingface.co/datasets/miracl/miracl-corpus), pinned to commit `d921ec7e349ce0d28daf30b2da9da5ee698bef0d`, config `miracl-corpus-v1.0-ru` |
| License | Apache-2.0 on both repos (`gated: false` — public, no redistribution restriction beyond attribution). This harness never redistributes raw dataset content; the cache is gitignored. |
| Split used | `dev` (the official development split — MIRACL's `test` split's qrels are not publicly released, per the paper's evaluation protocol) |
| Dev query count | 1,252 (verified live: `fetch-miracl.mjs` downloads and counts the real file) |
| Dev judgment count | 13,100 total (3,560 relevance=1, 9,540 relevance=0 — verified live) |
| Topics format | `topics.miracl-v1.0-ru-dev.tsv`: `qid\tquery_text`, no header |
| Qrels format | `qrels.miracl-v1.0-ru-dev.tsv`: standard 4-column TREC qrels `qid Q0 docid relevance`, no header, binary 0/1 |
| Corpus format | 20 gzip JSONL shards, `{"docid": "<wikipedia_page_id>#<passage_index>", "title", "text"}`, ~9,543,918 Russian Wikipedia passages total |

### Why plain TSV/JSONL, not the Python `datasets` library

The Hugging Face dataset card's example code (`datasets.load_dataset('miracl/miracl', 'ru', use_auth_token=True)`)
suggests a gated, Python-only path. Direct inspection of the repo's file
listing via the Hugging Face Hub API shows this is not actually required:
the repo is public (`gated: false`) and contains the topics/qrels as plain
TSV files under `miracl-v1.0-ru/{topics,qrels}/`, fetchable over HTTPS with
no authentication and no Python loading script. `fetch-miracl.mjs`
downloads these files directly.

### What "negative_passages" means, and why this harness calls them "annotated negatives," never "hard negatives"

The Python `datasets` library's loading script synthesizes a
`negative_passages` field per query from qrels rows with `relevance=0`. The
dataset card is explicit about what these actually are:

> "negative_passages are annotated by native speakers as well, **instead
> of the non-positive passages from top-k retrieval results**."

This is the opposite of what "hard negatives" usually means in the IR
literature (and the opposite of what this repo's own BEIR SciFact mini
benchmark does — see `../beir/build-rrf-mini-set.mjs`, which pools
negatives from a real TREC run's top-k). MIRACL's `relevance=0` passages
are ones a human annotator looked at and judged non-relevant during the
pooling/annotation process — not passages a retrieval model ranked highly
but got wrong.

MIRACL publishes **no downloadable official baseline run file** for the
Russian dev split to mine retrieval-based hard negatives from. The only
official reproduction path
([Pyserini's 2-click-reproduction page](https://castorini.github.io/pyserini/2cr/miracl.html))
is a *command* (`python -m pyserini.search.lucene ... --bm25`) that
requires indexing the full ~9.5M-passage corpus with Anserini/Lucene — a
Java/Python toolchain wholly outside this repo's Node.js/Qdrant harness,
and out of scope for this benchmark.

Given that constraint, this harness uses MIRACL's own annotated
`relevance=0` qrels rows as the corpus-padding pool, and calls them
**"annotated negatives"** throughout — deliberately never "hard
negatives" — to keep the distinction honest. Verified live against the
real dev split: the annotated-negative pool for a seeded 100-query
selection provides enough unique passages to reach the fixed 1000-passage
corpus with zero shortfall (see `build-miracl-subset.mjs`'s live-verified
stats: 289 positives + 711 annotated negatives = 1000, shortfall 0, on the
first real run against the pinned dataset revision).

## Files

| File | Purpose |
|---|---|
| `fetch-miracl.mjs` | Downloads (revision-pinned) topics + qrels TSVs and streams corpus shards, filtering to exactly the docids a subset needs without ever materializing the full 9.5M-passage corpus in memory. |
| `miracl-profiles.mjs` | The **locked** profile definitions — both profiles at both `k=2`/`k=60`, `common-512` regime only. Reuses `../beir/profiles.mjs`'s shared constants (E5 model ID, prefix contract, BM25 options) rather than re-declaring them. |
| `build-miracl-subset.mjs` | Builds the seeded 100-query/1000-passage global pooled subset: canonical-sort + SHA-256-seeded shuffle for query selection, all positives, round-robin annotated-negative padding, fatal on any shortfall or dangling qrels reference. |
| `bootstrap.mjs` | Deterministic paired bootstrap (seeded SHA-256 stream, never `Math.random()`) for k=2-vs-k=60, hybrid-vs-dense/sparse, and local-vs-cloud comparisons. A configuration is "better" only when the 95% CI excludes zero. |
| `run-miracl.mjs` | The harness: builds the subset, indexes each profile **once**, runs dense/sparse/hybrid (both `k`) per query, computes metrics + bootstrap comparisons, writes TREC runs, cleans up. Supports `--smoke`. |
| `fetch-miracl.test.mjs`, `build-miracl-subset.test.mjs`, `miracl-profiles.test.mjs`, `bootstrap.test.mjs`, `run-miracl.test.mjs` | Targeted `node:test` unit tests — see "Required tests" below for what each file proves. |

Not committed (gitignored — see the repo root `.gitignore`): `.cache/`
(downloaded topics/qrels/corpus shards, subset cache), `.runs/` (generated
TREC run files). This directory reuses `../beir/harness-core.mjs`,
`../beir/metrics.mjs`, and `../beir/prepare-inputs.mjs` directly — no
Qdrant client, retry, redaction, ID-mapping, metric, or input-preparation
logic is duplicated here.

## Locked configuration (do not tune post-hoc)

- **Regime**: `common-512` only for this first MIRACL run — no
  native/full-text regime (a deliberate, narrower scope than the BEIR
  harness; see `miracl-profiles.mjs`).
- **E5 asymmetric retrieval contract**: identical to the BEIR harness —
  `passage: ` on corpus documents, `query: ` on queries, dense lane only.
  BM25 always receives raw, unprefixed provider-neutral text.
- **RRF**: both profiles run at `k=2` and `k=60`. Each profile is indexed
  **exactly once**; the two hybrid requests per profile differ ONLY in
  `rrf.k` — same collection, same vectors, same prefetch specification,
  same limits (verified by a direct unit test on the actual request
  payloads, not just by code inspection).
- **Retrieval depth**: `top=100`, hybrid prefetch `200` per lane.
- **Subset selection seed**: `semidex-miracl-ru-pooled-subset-v1`, published
  in `build-miracl-subset.mjs` and recorded in every report.
- **Bootstrap seed**: `semidex-miracl-ru-bootstrap-v1`, 2000 iterations,
  published in `bootstrap.mjs` and recorded in every report.

## Running

```bash
# 1. Fetch + validate topics/qrels only (no corpus download, no Qdrant calls):
node benchmarks/external/miracl/fetch-miracl.mjs

# 2. Build and cache the full deterministic 1000-passage/100-query subset
#    (downloads corpus shards as needed — a few GB one-time transfer,
#    cached under the gitignored .cache/ directory). No Qdrant calls.
node benchmarks/external/miracl/build-miracl-subset.mjs

# 3. Tiny end-to-end smoke run (8 passages, 2 queries, cloud profile only)
#    — validates the full create/index/query/metrics/cleanup pipeline
#    cheaply, using a SEPARATE gitignored report path
#    (.miracl-smoke-report.json) that never overwrites the real result.
node benchmarks/external/miracl/run-miracl.mjs --smoke

# 4. The full, locked benchmark (both profiles, both k values — real time,
#    real Qdrant Cloud API calls):
node benchmarks/external/miracl/run-miracl.mjs
```

Requires `QDRANT_URL` / `QDRANT_KEY` in the environment or `.env` (read via
Semidex's own `bootstrapEnv()`). Never run two copies of `run-miracl.mjs`
concurrently — each creates live temporary Qdrant collections.

### Resource safety

- One profile at a time, profiles never interleaved; one Node process.
- No workers, no background benchmark processes.
- Corpus shards are streamed and filtered line-by-line — the full
  9.5M-passage corpus is never materialized in memory; each shard's
  matching passages are kept, the rest discarded immediately.
- Indexing batch size: 24 documents (within the required ≤24 range).
- Query execution is strictly sequential (concurrency 1) — no
  `Promise.all` over queries or batches.
- Cloud requests use bounded retry (max 5 attempts) with `Retry-After`
  honored when present, exponential backoff otherwise. Only 429/5xx/network
  failures are retried.
- `embedOnnxBatch()`/`embedOnnx()` (`src/local/core/onnx-embed.js`) request only
  `dense_vecs`/`sparse_vecs` by name from the ONNX session — the ColBERT
  output tensor is never materialized (verified by a unit test in this
  directory and by the existing `tests/unit/core/onnx-embed-output-selection.test.js`).
- The peak-RSS sampling interval is `unref()`-ed so it never keeps the
  process alive on its own.
- Every temporary collection name starts with `semidex-miracl-ru-` and is
  deleted in a `finally` block guarded to that exact prefix, whether the
  run succeeded, partially failed, or hit a fatal error.
- Cleanup, kills, and process management during development/testing touch
  only the exact benchmark process/collection this harness created — never
  unrelated Node, MCP, Ollama, or IDE processes.

## Metrics and statistics

Standard document-level TREC metrics (`../beir/metrics.mjs`, reused
directly): **nDCG@10** (primary), **MAP@100**, **Recall@10**,
**Recall@100**, **Precision@10**, **MRR@10**.

**Statistical comparisons** (`bootstrap.mjs`): deterministic paired
bootstrap (seeded SHA-256 stream, 2000 iterations) for k=2-vs-k=60,
hybrid-vs-dense, hybrid-vs-sparse (each profile, each k), and
local-vs-cloud at each shared k. Every comparison reports the mean paired
delta, win/loss/tie counts, and a 95% confidence interval. **A
configuration is called "better" only when the 95% CI excludes zero** —
otherwise the comparison verdict is `MIXED` (both directions occur, CI
straddles zero) or `INCONCLUSIVE` (no valid paired queries). This harness
never uses an arbitrary epsilon as statistical evidence.

## Report

`benchmarks/external/results/2026-07-22-miracl-ru-provider-comparison.md`
(human-readable) and the matching `.json` (full machine-readable data).

Every report includes **provenance**: current commit hash,
`workingTreeDirty`, SHA-256 hashes of the runner/builder/profiles/bootstrap/
shared-harness files and `src/local/core/onnx-embed.js`, the pinned dataset
revisions, the subset selection seed, provider/model IDs, vector
dimensions, Qdrant SDK version, batch size, retrieval limits, and
start/finish timestamps. Reports never contain API keys, cluster IDs,
absolute local paths, environment dumps, or raw dataset passage text
(verified by a redaction unit test on `renderMarkdownReport()`).

## Verdicts

- `MIRACL_RU_HARNESS_ACCEPT` — both profiles completed, zero request
  errors, every temporary collection was confirmed deleted, and at every
  locked `k` mode (`dense`, `sparse`, `hybrid_k2`, `hybrid_k60`) the
  reported `queryCount` matches the run's actual query count,
  `skippedForRecallMap === 0`, and **every** metric field
  (`ndcgAt10`, `mapAt100`, `recallAt10`, `recallAt100`, `precisionAt10`,
  `mrrAt10`) is a finite number — not just `ndcgAt10` (see
  `metricsAreFullyValid()` in `run-miracl.mjs`). This is a deliberately
  strict gate: `build-miracl-subset.mjs`'s `validateSubset()` requires
  every selected query to have at least one positive (relevance > 0)
  passage before the subset is ever accepted. A retrieval miss (wrong or
  empty results for a query that DOES have a positive passage) still
  yields a finite `0`, never `null` — `recallAtK`/`averagePrecisionAtK`
  only return `null` when a query has zero relevant passages, which
  `validateSubset()` has already ruled out. So a `null`/non-finite metric
  field on an ACCEPT-eligible run means the metrics computation itself hit
  corrupted or malformed data (e.g. a query missing from the qrels/run map
  it was computed against) — not poor retrieval quality, and not the
  legitimate "zero-relevant-docs" case `../beir/metrics.mjs` otherwise
  tolerates.
- `MIRACL_RU_HARNESS_PARTIAL` — at least one profile produced valid
  metrics, but not all of them, or cleanup/error conditions weren't fully
  clean.
- `MIRACL_RU_HARNESS_BLOCKED` — the run matrix itself couldn't complete
  (e.g. a profile never ran).
- `MIRACL_RU_HARNESS_REJECT` — nothing in the run matrix produced valid
  metrics.
- Smoke runs use a separate `MIRACL_RU_SMOKE_*` verdict namespace, apply
  the identical `metricsAreFullyValid()` gate (the 2-query smoke subset
  goes through the same `validateSubset()` check as the real subset), and
  never overwrite the real report's verdict.

**ACCEPT means the harness and its locked configuration ran cleanly and
produced valid measurements — it is not a statement that either provider
is better for Semidex's actual Ukrainian-language use case. See "Scope and
limits" above.**

## Required tests — what each file proves

- **Deterministic, order-independent query selection**
  (`build-miracl-subset.test.mjs`): `selectQueryIds()` produces the same
  100 query IDs regardless of the input array's order, is a real shuffle
  (not a lexicographic slice), and the default seed selects exactly 100
  distinct IDs from the 1252-ID pool.
- **No missing positives** (`build-miracl-subset.test.mjs`): every positive
  passage for a selected query is included in the subset regardless of the
  corpus-size target.
- **No dangling qrels** (`build-miracl-subset.test.mjs`): the assembled
  subset's qrels are scoped to exactly the docids present in the subset
  corpus — a query's full qrels can reference more docids than the
  round-robin padding actually selected, and those extra rows are dropped
  from the subset's qrels rather than left dangling.
- **Exact 1000-document enforcement** (`build-miracl-subset.test.mjs`,
  `run-miracl.test.mjs`): `selectSubsetDocIds()`/`buildAndCacheMiraclSubset()`
  either reach the exact requested corpus size or throw — never silently
  return a smaller corpus.
- **Cache invalidation and corrupt-cache rebuilding**
  (`build-miracl-subset.test.mjs`): the subset cache path changes when the
  topics/qrels revision, corpus revision, or selection seed changes; a
  cached file whose manifest doesn't match the current inputs is rebuilt,
  not blindly trusted.
- **One collection and one indexing pass per profile**
  (`run-miracl.test.mjs`): `executeProfileRun()` asserts exactly one
  `createCollection` and exactly one `upsert` batch call for a
  single-document fixture.
- **k=2/k=60 requests differ only by `rrf.k`** (`run-miracl.test.mjs`):
  both hybrid request payloads are asserted structurally identical except
  for `query.rrf.k`.
- **Cleanup on success and failure** (`run-miracl.test.mjs`): cleanup is
  attempted and the temporary collection deleted even when embedding
  throws mid-run; a cleanup failure is recorded with its error message.
- **Invalid verdict on errors or failed cleanup** (`run-miracl.test.mjs`):
  `computeVerdict()` never returns ACCEPT when any run recorded errors or
  cleanup failed, even if metrics were otherwise valid.
- **Invalid verdict on incomplete metrics, full harness and smoke alike**
  (`run-miracl.test.mjs`): a nonzero `skippedForRecallMap`, or a `null`
  `mapAt100`/`recallAt10`/`recallAt100`/`precisionAt10`/`mrrAt10` on any
  mode, blocks both `MIRACL_RU_HARNESS_ACCEPT` and
  `MIRACL_RU_SMOKE_ACCEPT` — not just a `null`/`NaN` `nDCG@10`.
- **Every selected query has qrels with at least one positive**
  (`build-miracl-subset.test.mjs`): `validateSubset()` flags a query
  entirely missing from qrels, a query whose qrels are all
  relevance-0, and a query with an empty qrels `Map` — the invariant that
  makes the metric-completeness check above meaningful (a subset that
  passes this can never legitimately produce a `null` Recall/MAP for a
  reason other than a real run failure).
- **Paired bootstrap deterministic under a fixed seed** (`bootstrap.test.mjs`):
  identical inputs + seed + iteration count reproduce byte-identical
  results across repeated calls.
- **Confidence interval crossing zero produces MIXED** (`bootstrap.test.mjs`):
  an alternating-sign paired-delta fixture (equal wins and losses) produces
  a CI that straddles zero and a `MIXED` verdict, never a spurious winner.
- **Provenance and redaction fields** (`run-miracl.test.mjs`):
  `renderMarkdownReport()` surfaces commit hash, dataset revisions,
  selection seed, file hashes, and SDK version, and never emits an API key
  pattern or an absolute local path.
- **No ColBERT output requested** (`run-miracl.test.mjs`): the runner
  never accesses a `colbert` output field directly, and
  `src/local/core/onnx-embed.js` (the actual embedding implementation) is
  verified to request only `dense_vecs`/`sparse_vecs` by name.
