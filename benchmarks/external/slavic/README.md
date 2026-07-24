# Slavic dense vs sparse benchmark — mteb/belebele

Isolates the **language factor** in Semidex's local BGE-M3 dense-vs-sparse
comparison, using a parallel multilingual corpus (Belebele) instead of
comparing across unrelated datasets (BEIR SciFact = English only, MIRACL =
Russian only). Only the local BGE-M3 ONNX dense+learned-sparse provider is
measured — no Qdrant Cloud E5/BM25 profile, no RRF k-sweep. Adding either
would reintroduce a confound this benchmark exists to remove; both are
already covered separately by `../fusion/run-rrf-sweep.mjs`.

## Dataset contract

**Source: `mteb/belebele`, NOT `mteb/BelebeleRetrieval`.** The retrieval-task
repo (`mteb/BelebeleRetrieval`) is gated and returns HTTP 401 without
authentication — confirmed live before any code was written here. MTEB's own
`BelebeleRetrieval` task code (traced from
`embeddings-benchmark/mteb/mteb/tasks/retrieval/multilingual/belebele_retrieval.py`)
does not load that gated repo either — it loads the public, ungated
`mteb/belebele` MRC dataset directly and synthesizes the retrieval task in
Python. This harness replicates that exact synthesis in JavaScript.

- Repo: `mteb/belebele`, pinned revision `979a211276faa22f671e69d096634193567cfd05`
  (main HEAD at verification time, and the exact revision MTEB's own task
  metadata hardcodes).
- License: `cc-by-sa-4.0` (repo README frontmatter + HF API `cardData.license`).
  Underlying paper: Bandarkar et al., ACL 2024, arXiv:2308.16884.
- Format: one plain newline-delimited JSON file per language config
  (`data/{lang}.jsonl`) — **not Parquet**. No parquet-parsing dependency
  needed or added; this was a deliberate architectural check before
  implementation (Node.js has no parquet reader in this project's
  dependencies, and adding one for a benchmark harness would be a real
  decision, not a default).
- Row fields (verified live against all 7 languages this harness uses,
  identical schema in every one): `link`, `question_number`,
  `flores_passage`, `question`, `mc_answer1..4`, `correct_answer_num`,
  `dialect`, `ds`.
- Every language file verified to contain exactly **900 rows, 900 unique
  `question` strings, 488 unique `link` values**.

### Qrels are MRC-derived, not pooled — read this before interpreting results

`mteb/belebele` is a raw multiple-choice reading-comprehension dataset, not
a retrieval dataset with pre-built qrels. `fetch-belebele.mjs`'s
`synthesizeRetrievalTask()` builds the retrieval task **exactly** the way
MTEB's own `BelebeleRetrieval` task does:

- **corpus** = one entry per unique `link`, text = that link's
  `flores_passage`, deduplicated (multiple questions can share a passage).
- **queries** = one entry per unique `question` string.
- **qrels** = for every row, `relevance(question → link) = 1`. **Every
  query has exactly one relevant document.**

This is single-relevant-doc-per-query, MRC-derived — "the passage the
question was written against" — never a pooled/graded IR judgment set with
multiple relevant docs or annotated negatives. No qrels row is invented
beyond this exact construction; `validateRetrievalTask()` enforces the
"exactly 1 relevant doc per query" invariant and rejects anything else.

**Why this complements but does not replace MIRACL**: MIRACL's qrels are
pooled human annotations (positives + explicitly-judged negatives) over a
real retrieval corpus. Belebele's "qrels" are a byproduct of an MRC task —
there is no annotated negative, no graded relevance, and no guarantee that
a passage *other than* the source passage isn't also a reasonable answer to
the question (Belebele was never designed to rule that out). Belebele
brings something MIRACL doesn't have for this project's needs — a genuinely
**parallel** corpus across many languages including several Slavic ones, so
the same underlying content is compared across scripts/languages — but its
qrels are structurally weaker evidence than MIRACL's. Treat Belebele
results as evidence about **language/script effects on ranking a single
known-relevant passage**, not as a general IR-quality benchmark on the same
footing as MIRACL.

### Language matrix and why

Final set (decided by the user directly after live verification of what
Belebele/FLORES-200 actually contains):

| Group | Languages |
|---|---|
| Cyrillic | `ukr_Cyrl`, `rus_Cyrl`, `bul_Cyrl` |
| Latin | `pol_Latn`, `ces_Latn`, `slk_Latn` |
| Control | `eng_Latn` |

**Confirmed unavailable — not substituted or approximated anywhere:**

- `bel_Cyrl` (Belarusian) — does not exist in Belebele. Confirmed via a
  live 404 on the direct file URL, and independently confirmed FLORES-200
  (Belebele's source corpus) has no Belarusian variant at all among its 122
  languages — this is a source-corpus gap, not a Belebele-specific omission.
- `srp_Latn` (Serbian, Latin script) — only `srp_Cyrl` exists in Belebele;
  no Latin-script Serbian config is present, even though Serbian is
  genuinely digraphic in real-world use.

**Reserved for a later, explicitly separate expanded run** (exported as
`RESERVED_FOR_LATER_EXPANSION` in `slavic-profiles.mjs`, never silently
added to the active language list): `mkd_Cyrl` (Macedonian), `srp_Cyrl`
(Serbian, Cyrillic), `hrv_Latn` (Croatian), `slv_Latn` (Slovenian). If a
future run pairs `srp_Cyrl` with `hrv_Latn` as a Cyrillic/Latin comparison,
that pairing must **not** be presented as a controlled same-language
script-only experiment — Serbian and Croatian are genuinely distinct (if
closely related) languages, not the same language in two scripts, unlike
what a `srp_Cyrl`/`srp_Latn` pair would have been had it existed.

## Files

| File | Purpose |
|---|---|
| `fetch-belebele.mjs` | Download/cache/validate one language's raw JSONL, synthesize + validate the retrieval task (corpus/queries/qrels). |
| `slavic-profiles.mjs` | Locked config: the 7-language matrix, the single BGE-M3 provider, the single fixed RRF_K=60 hybrid mode, CLI flag parsing. |
| `run-slavic-benchmark.mjs` | The benchmark executor: one Qdrant collection per language, one indexing pass (dense+sparse from the same embed call), dense/sparse/hybrid queries, metrics, sparse diagnostics, checkpoint/resume, cleanup. |
| `slavic-weighted-rrf-config.mjs` | Locked config for the weighted-RRF fusion matrix: the same 7-language matrix, the six fusion modes (imported from `../fusion/weighted-rrf-fusion-modes.mjs`), group definitions, CLI flag parsing. |
| `run-slavic-weighted-rrf.mjs` | The weighted-RRF benchmark executor — see "Live weighted-RRF fusion matrix" below. |
| `*.test.mjs` | Offline, `node:test`-based unit/integration tests — no network, no real Qdrant, no ONNX (fake/injected clients). |

Reused, not duplicated, from the existing BEIR/MIRACL/fusion harnesses:

- `computeMetrics()`, `toTrecRunFormat()` from `../beir/metrics.mjs`.
- `pairedBootstrapByQuery()`, `perQueryMetrics()` from `../miracl/bootstrap.mjs`.
- `makeRedactor()`, `describeEndpoint()`, `buildClient()`, `timed()`,
  `withBoundedRetry()`, `percentile()`, `buildIdMapping()` from
  `../beir/harness-core.mjs`.
- `embedOnnxBatch()` from `../../../src/core/onnx-embed.js` — the single
  source of BGE-M3 dense+sparse embeddings, one call per batch.
- `ONNX_DENSE_MODEL_ID` from `../../../src/core/onnx-paths.js`.
- The atomic-checkpoint-write (`writeJsonAtomic`), pre-flight
  collection-name persistence (closing the orphan-tracking window before
  `createCollection()` runs), 404-as-successful-cleanup
  (`isDeleteResultSuccessful`), and `rebuildReportAggregates()`-on-resume
  patterns are all carried over from `../fusion/run-rrf-sweep.mjs` **after**
  that module's own review-driven fixes — applied here from the start
  rather than re-discovered.

## Execution model

Per language: **one** Qdrant collection, **one** indexing pass. Dense and
sparse vectors for every document come from the **same**
`embedOnnxBatch()` call — BGE-M3 always returns both in one inference pass,
so there is no separate "dense-only" or "sparse-only" embedding step to
avoid; this is the model's own behavior, not something the harness enforces
extra logic for. Then per query: one dense-only Qdrant query, one
sparse-only query, one equal-RRF (`k=60`) hybrid query — three separate
TREC runs per language, never merged.

Languages run strictly sequentially — never `Promise.all()` across
languages, never more than one ONNX embedding call or Qdrant collection in
flight at once.

## Input handling

- Same preparation policy for every language: no stemming, no
  lemmatization, no language-specific normalization, no translation, no
  rewording. `flores_passage`/`question` text is used verbatim.
- Truncation: BGE-M3's own tokenizer `max_length=8192` applies identically
  to every language (see `src/core/onnx-embed.js`) — this harness never
  tunes a per-language token budget. It only **detects and counts** how
  many documents/queries exceed that limit per language (see
  `detectTruncation()` in `run-slavic-benchmark.mjs`), using the same
  tokenizer, and reports the count — it never performs a different
  truncation itself.
- Unicode is never normalized in a way that changes content — text is
  passed through exactly as read from the source JSONL.

## Running

```bash
# Tests only, sequential (required):
node --test --test-concurrency=1 benchmarks/external/slavic/fetch-belebele.test.mjs
node --test --test-concurrency=1 benchmarks/external/slavic/slavic-profiles.test.mjs
node --test --test-concurrency=1 benchmarks/external/slavic/run-slavic-benchmark.test.mjs

# Tiny plumbing smoke (1 language, 3 queries, 10 docs; writes to a separate
# .slavic-belebele-smoke-report.json, never the real report):
node benchmarks/external/slavic/run-slavic-benchmark.mjs --smoke

# Windows DirectML smoke and full run (PowerShell):
$env:ONNX_EXECUTION_PROVIDER='dml'
node benchmarks/external/slavic/run-slavic-benchmark.mjs --smoke
node benchmarks/external/slavic/run-slavic-benchmark.mjs

# Full 7-language benchmark (requires QDRANT_URL/QDRANT_KEY; NOT started
# automatically by any task in this repo — run explicitly after reviewing
# the smoke result and the feasibility report):
node benchmarks/external/slavic/run-slavic-benchmark.mjs

# Resume an interrupted run / restart from scratch / check resume state /
# run a subset of languages:
node benchmarks/external/slavic/run-slavic-benchmark.mjs --resume
node benchmarks/external/slavic/run-slavic-benchmark.mjs --restart
node benchmarks/external/slavic/run-slavic-benchmark.mjs --resume-check
node benchmarks/external/slavic/run-slavic-benchmark.mjs --languages=ukr_Cyrl,bul_Cyrl
```

`ONNX_EXECUTION_PROVIDER` (`cpu`, `dml`, or `cuda`) is read from the environment
the same way every other ONNX-based harness reads it, and is recorded in
the benchmark checkpoint contract and each language's `provenance` block.
Resume rejects a checkpoint created with a different requested execution
provider, so CPU and DML results cannot be mixed in one report.

## Output

- `benchmarks/external/results/2026-07-23-slavic-belebele-benchmark.json`
  (full checkpoint/report) and `.md` (rendered report).
- Per-language TREC runs under `benchmarks/external/slavic/.runs/`
  (`.runs/smoke/` for `--smoke`, gitignored, never overwrites the real run).

Per language, the report includes: nDCG@10/MAP@100/MRR@10/Recall@10/
Recall@100 for dense/sparse/hybrid; dense-vs-sparse and hybrid-vs-dense
paired bootstrap comparisons (sign = comparison − baseline, same
convention as `../fusion/run-rrf-sweep.mjs` after its own sign-bug fix);
rescue/harm/tie counts for hybrid vs dense; sparse diagnostics (mean
non-zero sparse weights for docs/queries, mean coverage of query sparse
indices in the relevant document, dense-only/sparse-only/both/neither relevant-document hit
counts); the 3 largest sparse wins and 3 largest sparse failures relative
to dense, by query ID and score only (no passage text, no local paths); and
a descriptive-only macro summary (Cyrillic average, Latin average, English
control) that never substitutes for or is presented as statistical evidence
about a script effect.

## Interpretation limits

- Sparse diagnostics describe **what** happened (token counts, overlap,
  hit counts) — never **why**. Any morphological or linguistic explanation
  in the report is explicitly labeled a HYPOTHESIS, never a proven
  mechanism.
- This benchmark does not recommend changing the production `RRF_K`
  default or sparse-enablement default from one run alone.
- No production retrieval/indexing code is touched by anything in this
  directory.

## Live weighted-RRF fusion matrix (`slavic-weighted-rrf-config.mjs` / `run-slavic-weighted-rrf.mjs`)

A separate, sibling benchmark to the equal-RRF-only harness above.

**Purpose**: the live SciFact/MIRACL weighted-RRF benchmark
(`../fusion/run-weighted-rrf-live.mjs`,
`../results/2026-07-24-weighted-rrf-live.{json,md}`) showed that
dense-heavy weighted RRF removes most of the MIRACL regression seen under
equal-weight hybrid, but that the effect is dataset/provider-dependent.
This benchmark asks a narrower, LANGUAGE-focused question on the SAME
7-language Slavic Belebele matrix the equal-RRF-only harness already uses:
**do sparse and equal-weight RRF regressions correlate with individual
Slavic languages or script groups?** It is not a new dataset, not a new
provider, and not a k-sweep — only the fusion-mode dimension changes.

**Exact language matrix** (identical to `slavic-profiles.mjs`'s
`LANGUAGES`, re-declared independently so this config has zero dependency
on the other benchmark's module — a dedicated test asserts both matrices
stay byte-for-byte identical):

| Group | Languages |
|---|---|
| Cyrillic Slavic | `ukr_Cyrl` (Ukrainian), `rus_Cyrl` (Russian), `bul_Cyrl` (Bulgarian) |
| Latin Slavic | `pol_Latn` (Polish), `ces_Latn` (Czech), `slk_Latn` (Slovak) |
| English control | `eng_Latn` |

**Fusion modes** — the exact six modes and rho -> sparseWeight conversion
already validated by the live SciFact/MIRACL weighted-RRF benchmark,
imported from a shared pure module (`../fusion/weighted-rrf-fusion-modes.mjs`)
so neither benchmark can silently drift on mode definitions:

| Mode | k | weights (dense, sparse) | Role |
|---|---:|---|---|
| `dense` | — | single-lane, no rrf | baseline |
| `sparse` | — | single-lane, no rrf | — |
| `equal_k2` | 2 | `[1.0, 1.0]` | control (Qdrant default) |
| `equal_k60` | 60 | `[1.0, 1.0]` | control (Semidex default) |
| `k2_rho0.10` | 2 | `[1.0, 0.05263157894736842]` | primary candidate |
| `k2_rho0.25` | 2 | `[1.0, 0.14285714285714285]` | diagnostic (never promoted merely for winning one language/group) |

Real Qdrant weighted-RRF requests only: `query: { rrf: { k, weights: [dense,
sparse] } }`. Weights always live in `query.rrf.weights`, never on a
`prefetch` entry.

**Execution model**: per language, **one** Qdrant collection, **one**
indexing pass (dense+sparse from the same `embedOnnxBatch()` call, exactly
like the equal-RRF-only harness). Per query, dense and sparse query
vectors are computed **once** and reused for all six fusion modes — the
four hybrid modes share the identical prefetch spec (limit 200/lane),
differing only in `query.rrf.k`/`weights`. Local BGE-M3 ONNX only, no
Qdrant Cloud E5/BM25 — same confound-isolation rationale as the equal-RRF
harness.

```bash
# Tests only, sequential (required):
node --test --test-concurrency=1 benchmarks/external/slavic/run-slavic-weighted-rrf.test.mjs

# Tiny plumbing smoke (1 language, 3 queries, 10 docs, all 6 fusion modes;
# writes to a separate .slavic-weighted-rrf-smoke-report.json, never the
# real report):
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --smoke

# Full 7-language benchmark (requires QDRANT_URL/QDRANT_KEY and, for a
# real full run, ONNX_EXECUTION_PROVIDER=cuda + ONNX_CUDA_STRICT=1 — see
# "CUDA's limited role" below. NOT started automatically by any task in
# this repo — run explicitly after reviewing the smoke result and the
# feasibility report):
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs

# Resume an interrupted run / restart from scratch / check resume state /
# run a subset of languages:
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --resume
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --restart
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --resume-check
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --languages=ukr_Cyrl,bul_Cyrl
```

**Resume behavior**: identical contract to every other harness in this
repo — the checkpoint records the exact language/fusion-mode contract, a
`--resume` whose contract doesn't match the current configuration is
rejected (use `--restart`), a language is only considered complete once
every one of the six fusion modes has full metrics for every query, zero
errors, confirmed cleanup, AND (since every language here is a local
scope) a passing CUDA verification. Atomic JSON writes throughout
(temp-file + rename), so a hard kill never leaves a half-written
checkpoint.

**CUDA's limited role — accelerator only, never a quality variable**:
every language in this benchmark uses the local BGE-M3 ONNX provider, so
CUDA strictness is mandatory for a real (non-smoke) run. Before any
collection is created, `verifyStrictCudaConfigured()` (shared with
`../fusion/run-weighted-rrf-live.mjs`, defined once in
`../fusion/weighted-rrf-cuda.mjs`) checks that
`ONNX_EXECUTION_PROVIDER=cuda` and `ONNX_CUDA_STRICT=1` are both set in the
environment and refuses to start otherwise. After indexing, each
language's provenance records BOTH the requested and the **effective**
execution provider (via `core/onnx-embed.js`'s `getOnnxProviderState()`) —
`verifyCudaProvenance()` rejects the language if CUDA was requested but
silently fell back to CPU. **CUDA is never used to compare retrieval
quality anywhere in this harness** — it only ever gates whether a real run
is allowed to proceed and records what actually executed, as operational
metadata. No CPU/DML/CUDA quality comparison is made or implied.

**Custom ONNX Runtime path**: this harness never hardcodes a
user-specific `ONNXRUNTIME_NODE_PATH` or any other machine-specific
runtime location — it reads whatever the existing environment/runtime
configuration already provides, exactly like every other ONNX-based
harness in this repo.

**Metrics and comparisons per language**: nDCG@10, MAP@100, Recall@10/100,
MRR@10, query count, and error/skip count for all six modes; seven
deterministic paired-bootstrap comparisons (seed
`semidex-miracl-ru-bootstrap-v1`, 2000 iterations, reused unchanged from
`../miracl/bootstrap.mjs`): sparse vs dense, equal_k2 vs dense, equal_k60
vs dense, k2_rho0.10 vs dense, k2_rho0.10 vs equal_k2, k2_rho0.10 vs
equal_k60, k2_rho0.25 vs dense — sign is always comparison minus baseline.

**Group summaries** (Cyrillic Slavic / Latin Slavic / English control):
per-language results plus a macro average across each group's languages,
explicitly marked descriptive-only — never a statistical claim about a
script/language effect, and never used by itself to promote a fusion
candidate.

**Per-language decision classification**: every language is classified
for sparse-helps / sparse-neutral-mixed / sparse-significantly-hurts,
equal-hybrid-helps / equal-hybrid-hurts (both k=2 and k=60), and whether
rho=0.10/rho=0.25 restores dense quality. A classification only becomes
"helps"/"hurts" when the paired-bootstrap 95% CI excludes zero
(`B_BETTER`/`A_BETTER`); `MIXED` or `INCONCLUSIVE` verdicts are always
reported as neutral/mixed, never silently upgraded to a directional claim.
A weighted candidate is never promoted merely because it wins a group
average.

**Output**: `benchmarks/external/results/2026-07-24-slavic-weighted-rrf.json`
(full checkpoint/report) and `.md` (rendered report), plus per-language TREC
runs under `benchmarks/external/slavic/.runs-weighted-rrf/`
(`.runs-weighted-rrf/smoke/` for `--smoke`, gitignored).

**Interpretation limits specific to this harness**:

- Script and language are confounded in this 7-language matrix — findings
  are reported as observed associations requiring further validation,
  never as a causal claim that script itself causes a difference.
- This benchmark does not implement or recommend production
  language-aware fusion.
- A group-average win is never sufficient by itself to promote a
  candidate — see the per-language decision classification's explicit
  MIXED-unless-consistent rule.
- Does not change any production fusion default from this run alone.
