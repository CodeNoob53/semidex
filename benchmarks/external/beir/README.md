# BEIR SciFact — local vs Qdrant Cloud retrieval-provider benchmark

This directory holds a **retrieval-provider capability/quality benchmark**,
not an end-to-end RAG evaluation and not a Semidex chunker evaluation. It
compares two locked provider configurations on the official BEIR SciFact
test split:

- **local** — current Semidex `bge-m3-onnx` dense + learned sparse
  (`src/local/core/onnx-embed.js`), fused via Qdrant RRF `k=60` (Semidex's own
  production default).
- **cloud** — Qdrant Cloud Inference hosted `intfloat/multilingual-e5-small`
  dense (384, Cosine) + server-side `qdrant/bm25` sparse
  (`language:none, tokenizer:multilingual, modifier:idf`), fused via Qdrant
  RRF at both `k=2` (Qdrant's own default) and `k=60` (Semidex's default).

SciFact has **document-level** qrels, so every document is indexed as one
atomic point — this harness never chunks documents, never converts the
corpus to Markdown, and never invokes Semidex's production indexer.

## Why SciFact, why this is only a first step

SciFact is English-only. It does **not** test Semidex's primary
multilingual/Ukrainian retrieval goal. A result here is evidence about the
*mechanics* of the two provider configurations (do dense/sparse/hybrid all
work, how do they compare on a well-understood English IR benchmark) — it is
**not** a claim about which is better for Ukrainian content. MIRACL itself
does not include Ukrainian (see `../miracl/README.md` for the exact languages
it does cover and why a Russian/Cyrillic run there is multilingual evidence,
not a Ukrainian-quality claim). A Ukrainian-quality claim can only be made
after a separate, dedicated Ukrainian dataset runs with the same rigor.

## Files

| File | Purpose |
|---|---|
| `fetch-scifact.mjs` | Downloads (MD5-verified against the official BEIR wiki checksum), extracts, loads, and structurally validates the SciFact test split. |
| `profiles.mjs` | The **locked** profile/regime/RRF-k definitions — the single source of truth for what gets run. Nothing in `run-scifact.mjs` picks a configuration that isn't enumerated here. |
| `metrics.mjs` | Pure, dependency-free implementations of nDCG@10, MAP@100, Recall@10/100, Precision@10, MRR@10, plus BEIR qrels TSV parsing and TREC run serialization. |
| `prepare-inputs.mjs` | One-time, cached preparation of provider-neutral native/common-512 bodies with bounded tokenizer memory. |
| `harness-core.mjs` | Shared Qdrant client, retry, redaction, percentile, and point-ID plumbing used by both runners. |
| `run-scifact.mjs` | The harness: fetches the dataset, builds both input regimes, indexes each profile/regime into its own temporary Qdrant collection, runs all 300 test queries (dense-only, sparse-only, hybrid at every locked `k`), computes metrics, writes TREC runs, and cleans up. |
| `build-rrf-mini-set.mjs` | Builds the seeded 100-query/1000-document local sensitivity set from SciFact qrels and generated full-run TREC outputs. |
| `run-rrf-mini.mjs` | Indexes that mini-set once and compares local hybrid RRF `k=2` vs `k=60` without changing production defaults. |
| `prepare-inputs.test.mjs` | Targeted tests for provider lane formatting, bounded token counting, word-boundary truncation, and one-time preparation. |
| `metrics.test.mjs` | Targeted `node:test` unit tests for `metrics.mjs`, verified against `fixtures/metrics-small.json` — a small **hand-calculated** fixture (the expected values were computed by hand, not derived from the module under test). |
| `fixtures/metrics-small.json` | The hand-calculated fixture above. |

Not committed (gitignored — see the repo root `.gitignore`):
`.cache/` (downloaded dataset + zip), `.runs/` (generated TREC run files).
`.cache/` and `.runs/` live under this directory so they're trivially
git-ignorable as a unit; nothing under them is ever part of a commit.
The mini RRF runner requires `.runs/local-common-512-dense.trec` and
`.runs/local-common-512-sparse.trec` from a completed full benchmark. These
inputs are generated artifacts, not committed fixtures; the mini-set cache
and report record their SHA-256 hashes for reproducibility.

## Locked configuration (do not tune post-hoc)

Every knob below is fixed **before** running and is not adjusted based on
results — see `profiles.mjs` for the executable source of truth.

- **E5 asymmetric retrieval contract**: corpus documents get `passage: `
  prepended, queries get `query: ` prepended — the official instruction
  prefix contract for `intfloat/multilingual-e5-small`. No raw/unprefixed
  variant is run, and no variant is picked after seeing results.
- **BM25 options**: `{ language: 'none', tokenizer: 'multilingual',
  ascii_folding: true }`, identical between indexing and querying.
- **`modifier: idf`** is applied only to the BM25 sparse lane (Qdrant's own
  BM25 convention). It is deliberately **not** applied to the local
  `bge-m3-onnx` sparse lane — that model's sparse output is already a set of
  learned per-token weights, not raw term frequencies, matching Semidex's
  own production schema (`src/core/qdrant/schema.js`).
- **Input regimes** — run separately, never mixed:
  - `common-512`: one provider-neutral word-boundary prefix derived from the
    first 512 decoded tokens of both tokenizers, with a two-word safety
    margin and a final bounded validation pass. The stored body contains no
    E5 prefix and is reused byte-for-byte by both profiles. BGE-M3 validates
    the raw body; E5 validates `passage: ` / `query: ` plus that body.
  - `native`: the full `title + "\n\n" + text`, uncapped — each provider's
    own real context limit/truncation applies downstream (BGE-M3 ONNX:
    8192-token sequencer `max_length`; E5-small: 512-token model context
    window, truncated server-side by Qdrant Cloud Inference).
- **Retrieval depth**: `top=100` for every query, every mode, every
  profile. Hybrid prefetch limit: `200` per lane.
- **Fusion**: `local` runs only `RRF k=60`. `cloud` runs both `RRF k=2` and
  `RRF k=60` — indexed **once** per (profile, regime); only the hybrid
  query's fusion constant differs between the two `k` runs, so indexing is
  never repeated just to change `k`.

## Running

```bash
# 1. Fetch + validate the dataset only (no Qdrant calls):
node benchmarks/external/beir/fetch-scifact.mjs

# 2. Tiny end-to-end smoke run (cloud profile, native regime, 2 queries,
#    8 docs) — validates the full pipeline cheaply before the real run.
#    Writes to a SEPARATE output path, never the real report.
node benchmarks/external/beir/run-scifact.mjs --smoke

# 3. Prepare and validate all inputs without Qdrant calls. The generated
#    cache is reused by the full benchmark.
node benchmarks/external/beir/run-scifact.mjs --prepare-inputs-only

# 4. The full, locked benchmark (all profiles/regimes/k — takes real time
#    and makes real Qdrant Cloud API calls):
node benchmarks/external/beir/run-scifact.mjs

# Continue an interrupted full benchmark. Completed, validated runs are
# skipped; an incomplete run starts again from its first document.
node benchmarks/external/beir/run-scifact.mjs --resume

# Validate the checkpoint and print completed/pending runs without Qdrant
# calls or modifying the report.
node benchmarks/external/beir/run-scifact.mjs --resume-check

# Explicitly discard the checkpoint and start the full matrix again.
node benchmarks/external/beir/run-scifact.mjs --restart

# Compare local RRF k=2 vs k=60 on the seeded mini-set. Run only after the
# full benchmark has produced the two local-common-512 TREC files above.
# This takes roughly 15-20 minutes on the reference Windows CPU system and
# overwrites only the dated local RRF mini report.
node benchmarks/external/beir/run-rrf-mini.mjs
```

Requires `QDRANT_URL` / `QDRANT_KEY` in the environment or `.env` (read via
Semidex's own `bootstrapEnv()` — no separate credential path). Never run
two copies of `run-scifact.mjs` concurrently — each creates live temporary
Qdrant collections.

The full runner refuses to overwrite an existing report unless `--resume`
or `--restart` is explicit. Resume validates the dataset, prepared-input
cache, Qdrant endpoint fingerprint, provider models, vector sizes, retrieval
depth, BM25 options, regimes, and RRF constants before accepting a
checkpoint. A run is skipped only when its document/query counts, metrics,
zero-error state, and temporary-collection cleanup are all complete.

### Resource safety

- One profile at a time, profiles never interleaved.
- Input preparation runs once before the profile loop and is cached by
  dataset checksum, selected IDs/content, tokenizer IDs, budget, and schema.
- Tokenizer tensors are capped at 513 tokens and built in bounded batches;
  no unbounded tokenizer calls or worker processes are used. References to
  both tokenizers are released after fresh preparation before indexing starts.
- Indexing batch size: 24 documents (within the required 16–32 range).
- Query execution is strictly sequential (concurrency 1) — no
  `Promise.all` over queries or batches.
- Cloud requests use bounded retry (max 5 attempts) with `Retry-After`
  honored when present, exponential backoff otherwise (max 8s between
  attempts). Only 429/5xx/network failures are retried — a real 4xx is
  never retried.
- No background processes; progress and the current profile/run are
  printed as the harness runs.
- Every temporary collection name starts with `semidex-beir-scifact-` and
  is deleted in a `finally` block guarded to that exact prefix, whether the
  run succeeded, partially failed, or hit a fatal error.

## Metrics

Standard document-level TREC metrics (`metrics.mjs`): **nDCG@10** (primary),
**MAP@100**, **Recall@10**, **Recall@100**, **Precision@10**, **MRR@10**.
Semantics documented inline in `metrics.mjs` — notably: a doc in the run but
absent from qrels counts as non-relevant (not an error, not a crash); a
query with zero relevant documents in qrels is excluded from Recall/MAP
averages (undefined, not zero) but still contributes to nDCG/Precision/MRR
(which are 0 there, a well-defined value).

## Report

`benchmarks/external/results/2026-07-21-beir-scifact-provider-comparison.md`
(human-readable) and the matching `.json` (full machine-readable data,
including operational metrics: indexing wall time, query latency
p50/p95/max, peak process RSS, documents indexed, request/retry/error
counts, and per-run cleanup confirmation).

The report explicitly separates: `common-512` vs `native`; dense-only vs
sparse-only vs hybrid; local vs cloud; quality metrics vs operational
metrics; and labels every claim as **FACT** (directly measured this run),
**INFERENCE** (a reasoned conclusion from measured facts), or
**HYPOTHESIS** (would need further testing — e.g. anything about Ukrainian
quality). It never declares a general Semidex-wide winner.

## Verdicts

- `BEIR_SCIFACT_HARNESS_ACCEPT` — every locked profile/regime/k combination
  completed, produced valid metrics (right query count, finite nDCG), zero
  request errors, and every temporary collection was confirmed deleted.
- `BEIR_SCIFACT_HARNESS_PARTIAL` — at least one combination produced valid
  metrics, but not all of them, or cleanup/error conditions weren't fully
  clean.
- `BEIR_SCIFACT_HARNESS_BLOCKED` — the run matrix itself couldn't complete
  (e.g. dataset validation failed, a collection couldn't be created).
- `BEIR_SCIFACT_HARNESS_REJECT` — nothing in the run matrix produced valid
  metrics.

**ACCEPT means the harness and its locked configuration ran cleanly and
produced valid measurements — it is not a statement that either provider is
better for Semidex's actual (multilingual/Ukrainian) use case.**
