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
