# Slavic dense vs sparse benchmark on Belebele — feasibility & implementation report

Status: **harness implemented, smoke-verified, and accepted by a full
7-language DirectML run.** Final results:
`2026-07-23-slavic-belebele-benchmark.{json,md}`.

## 1. Goal recap

Isolate the LANGUAGE factor in Semidex's local BGE-M3 dense-vs-sparse
comparison, using one parallel corpus across multiple Slavic-adjacent
languages plus an English control, instead of comparing across unrelated
datasets (BEIR SciFact = English only, MIRACL = Russian only). Only the
local BGE-M3 ONNX provider is measured — no Qdrant Cloud E5/BM25, no RRF
k-sweep (both already covered separately by `benchmarks/external/fusion/`).

## 2. Critical dataset finding: `mteb/BelebeleRetrieval` is gated — use `mteb/belebele` instead

Before writing any code, the exact repo named in the task
(`mteb/BelebeleRetrieval`) was checked directly:

```
curl -I https://huggingface.co/api/datasets/mteb/BelebeleRetrieval
HTTP/1.1 401 Unauthorized
{"error":"Invalid username or password."}
```

This repo requires authentication this project does not have and should
not be given for a benchmark harness. Tracing MTEB's own
`BelebeleRetrieval` task source
(`embeddings-benchmark/mteb/mteb/tasks/retrieval/multilingual/belebele_retrieval.py`)
showed it does **not** load `mteb/BelebeleRetrieval` either — it loads the
public, ungated `mteb/belebele` MRC dataset directly and synthesizes the
retrieval task itself, in Python. This harness replicates that exact
synthesis in JavaScript (`fetch-belebele.mjs`'s `synthesizeRetrievalTask()`),
rather than inventing a different construction or blocking on the gated
repo.

Confirmed live:

```
curl -I https://huggingface.co/api/datasets/mteb/belebele
{"private":false,"gated":false,"sha":"979a211276faa22f671e69d096634193567cfd05",...}
```

## 3. Dataset format: JSONL, not Parquet — no new dependency needed

`mteb/belebele` is distributed as one plain newline-delimited JSON file per
language config (`data/{lang}.jsonl`), **not Parquet**. This project has no
parquet-parsing library in `package.json` (checked before writing any
fetch code — neither `dependencies` nor `devDependencies`). Adding one
would have been a real architectural decision requiring explicit
acknowledgment, not something to do silently for a benchmark harness. It
was not needed: direct HTTP download + line-by-line `JSON.parse` works
today, unauthenticated, confirmed live against all 7 target languages.

## 4. Confirmed dataset configurations

Live-verified (HTTP HEAD + full download + parse) against the pinned
revision `979a211276faa22f671e69d096634193567cfd05`:

| Language | HTTP status | Rows | Unique passages | Unique questions | Fields match |
|---|---|---:|---:|---:|---|
| `ukr_Cyrl` | 307 (exists) | 900 | 488 | 900 | yes |
| `rus_Cyrl` | 307 (exists) | 900 | 488 | 900 | yes |
| `bul_Cyrl` | 307 (exists) | 900 | 488 | 900 | yes |
| `pol_Latn` | 307 (exists) | 900 | 488 | 900 | yes |
| `ces_Latn` | 307 (exists) | 900 | 488 | 900 | yes |
| `slk_Latn` | 307 (exists) | 900 | 488 | 900 | yes |
| `eng_Latn` | 307 (exists) | 900 | 488 | 900 | yes |
| `bel_Cyrl` | **404 — does not exist** | — | — | — | — |
| `srp_Latn` | **404 — does not exist** | — | — | — | — |

Row fields, identical across all 7 usable languages: `link`,
`question_number`, `flores_passage`, `question`, `mc_answer1..4`,
`correct_answer_num`, `dialect`, `ds`.

**`bel_Cyrl` (Belarusian) does not exist anywhere in Belebele.** Confirmed
independently two ways: a direct 404 on the file URL, and a full listing of
all 122 language configs in the repo (via the HF API `siblings` list) —
no Belarusian variant in any script. This traces to FLORES-200 (Belebele's
source corpus), which has no Belarusian variant at all — not a
Belebele-specific omission.

**`srp_Latn` (Serbian, Latin script) does not exist either.** Only
`srp_Cyrl` is present. Serbian is genuinely digraphic in real-world use,
but Belebele/FLORES-200 only includes the Cyrillic variant.

### Final language matrix (user-decided after live verification)

| Group | Languages |
|---|---|
| Cyrillic | `ukr_Cyrl`, `rus_Cyrl`, `bul_Cyrl` |
| Latin | `pol_Latn`, `ces_Latn`, `slk_Latn` |
| Control | `eng_Latn` |

Reserved for a later, explicitly separate expanded run (not part of this
benchmark's scope): `mkd_Cyrl`, `srp_Cyrl`, `hrv_Latn`, `slv_Latn`. If a
future run pairs `srp_Cyrl`/`hrv_Latn`, that pairing must not be presented
as a controlled same-language script-only comparison — Serbian and
Croatian are distinct languages, not one language in two scripts.

## 5. Qrels: MRC-derived, not pooled — the honest limitation

`mteb/belebele` has no pre-built qrels file. This harness synthesizes the
retrieval task exactly as MTEB's own code does:

- corpus = unique `flores_passage` texts, deduplicated by `link`.
- queries = unique `question` strings.
- qrels = each question → its one source passage, relevance = 1.

Live-verified for every one of the 7 languages: every query has **exactly
one** relevant document. `validateRetrievalTask()` in `fetch-belebele.mjs`
enforces and rejects any deviation from this invariant.

**This is not a pooled IR judgment set.** There is no annotated negative,
no graded relevance, and no guarantee another passage isn't also a
reasonable answer — Belebele was never designed to rule that out. No
qrels row is invented beyond this exact, documented construction — per the
task's explicit instruction not to fabricate qrels, and per the finding
that a genuinely richer qrels file does not exist anywhere in this
dataset.

**Why this complements but does not replace MIRACL**: MIRACL's qrels are
pooled human annotations over a real retrieval corpus (positives +
explicitly-judged negatives). Belebele brings something MIRACL lacks for
this project's purpose — a genuinely parallel corpus across many languages
including several Slavic ones, so identical content is compared across
scripts — but its qrels are structurally weaker evidence. Belebele results
should be read as evidence about ranking a single known-relevant passage
across languages, not as a general IR-quality benchmark on the same footing
as MIRACL.

## 6. Implemented modes

All required CLI modes are implemented and syntax/behavior-verified:

```
node benchmarks/external/slavic/run-slavic-benchmark.mjs --smoke
node benchmarks/external/slavic/run-slavic-benchmark.mjs --resume
node benchmarks/external/slavic/run-slavic-benchmark.mjs --restart
node benchmarks/external/slavic/run-slavic-benchmark.mjs --resume-check
node benchmarks/external/slavic/run-slavic-benchmark.mjs --languages=ukr_Cyrl,bul_Cyrl
```

Per language: one Qdrant collection, one indexing pass (dense+sparse from
the same `embedOnnxBatch()` call — BGE-M3 always returns both in one
inference pass, so this is the model's own behavior, not extra logic this
harness had to add), then one dense-only query, one sparse-only query, one
equal-RRF (k=60) hybrid query per benchmark query — three separate TREC
runs per language, never merged. Languages run strictly sequentially.

Carried over from `benchmarks/external/fusion/run-rrf-sweep.mjs` **after**
that module's own review-driven fixes, applied here from the start rather
than re-discovered: atomic checkpoint writes (`writeJsonAtomic`), the
collection name generated and persisted to the checkpoint BEFORE
`createCollection()` runs (closing the orphan-tracking window entirely), a
404 from `deleteCollection` treated as successful cleanup (the collection
is already gone, not a failure), and `rebuildReportAggregates()` recomputed
from current state on every write rather than accumulated across
`--resume`.

## 7. Smoke result

```
node benchmarks/external/slavic/run-slavic-benchmark.mjs --smoke
```

Real BGE-M3 ONNX (CPU) + real Qdrant, 1 language (`ukr_Cyrl`), 3 queries,
10 documents (all relevant documents for the 3 selected queries preserved,
per the smoke contract):

- **Verdict: `SLAVIC_BELEBELE_SMOKE_ACCEPT`**
- Indexing: 10 docs in 8081 ms (dominated by one-time ONNX model load, not
  per-document cost).
- `dense=1.0000 sparse=0.8770 hybrid=1.0000` (nDCG@10, tiny 3-query sample
  — not a benchmark result, plumbing validation only).
- `cleanup.deleted: true`, `cleanup.error: null` — **independently
  verified** by querying Qdrant's `getCollections()` directly after the run
  completed: zero `semidex-slavic-belebele-*` collections remained.
- `errors: []`.
- Real sparse diagnostics produced: mean 82.4 non-zero sparse weights/doc,
  14 non-zero sparse weights/query, mean query sparse-index coverage in the relevant document
  0.336, 1 real "sparse failure" example captured (sparse nDCG@10 lower
  than dense for that query).
- Truncation detection ran cleanly: 0/10 documents and 0/3 queries exceeded
  BGE-M3's 8192-token limit (expected — Belebele passages/questions are
  short).
- Provenance recorded: commit hash, Qdrant SDK version `1.18.0`, ONNX
  execution provider `cpu`, dataset revision, corpus/query counts.
- TREC files written to `.runs/smoke/`, never `.runs/` — verified the real
  report path (`2026-07-23-slavic-belebele-benchmark.json`) was never
  created or touched.
- Peak RSS: 1946 MB.
- No API keys, Qdrant URL, or local file paths found in the smoke report
  (`grep`-verified).

Smoke artifacts were deleted after verification (not committed).

## 8. Full 7-language run: measured time and RAM

The approved full run used `ONNX_EXECUTION_PROVIDER=dml`, bounded batches of
24 for both corpus and query embeddings, and sequential languages/Qdrant
queries. It completed with verdict `SLAVIC_BELEBELE_HARNESS_ACCEPT`:

- successful resumed run: ~21 min 10 s;
- all 7 languages completed, 900 queries each;
- 0 indexing/query errors and 0 cleanup failures;
- measured peak RSS: ~1.33 GiB;
- DML indexing per 488-document language: 19.1–22.7 s.

The original CPU estimate below is retained only as the pre-run planning
baseline. It no longer describes the measured DirectML run.

Anchored to real measured data from the existing 1000-document local
BGE-M3 CPU benchmark (`2026-07-22-beir-scifact-local-rrf-mini.json`):
indexing 1000 docs took 1,090,273 ms (~18.2 min), and each Qdrant query
(dense/sparse/hybrid) averaged ~55-56 ms.

Belebele's corpus is smaller (488 docs vs 1000) and each language has 900
queries × 3 modes:

| Component | Per language | All 7 languages |
|---|---:|---:|
| Indexing (488 docs, proportional to the 1000-doc anchor) | ~8.9 min | ~62 min |
| Querying (900 × 3 queries × ~56ms) | ~2.5 min | ~17.5 min |
| **Total (rough estimate)** | **~11.4 min** | **~80 min (~1.3 hours)** |

This was a rough CPU extrapolation, not a DirectML measurement. It did
**not** include one-time ONNX model
load/warmup (a few seconds) or dataset download time (small — each
language's JSONL is ~3-4 MB, already cached locally from this
investigation).

**Peak RAM**: the 1000-doc single-language anchor run peaked at 3,273 MB,
dominated by the ~2.3 GB ONNX model itself plus working memory. Since this
harness holds only one language's ~488-document corpus and query set in
memory at a time, reuses the same loaded ONNX model across languages (no
per-language re-load), and never accumulates cross-language state, peak
RSS for the full 7-language run should stay in the same ~2-3.5 GB range
throughout — not scale per language. The smoke run's 1946 MB (10-doc
subset) is consistent with this — the peak is model-load-dominated, not
corpus-size-dominated at Belebele's scale.

## 9. Exact command for the full run

```bash
node benchmarks/external/slavic/run-slavic-benchmark.mjs
```

Requires `QDRANT_URL`/`QDRANT_KEY` in the environment (Semidex's own
`bootstrapEnv()`). Runs all 7 languages sequentially, one Qdrant collection
at a time, writing:

- `benchmarks/external/results/2026-07-23-slavic-belebele-benchmark.json`
- `benchmarks/external/results/2026-07-23-slavic-belebele-benchmark.md`
- Per-language TREC runs under `benchmarks/external/slavic/.runs/`

If interrupted, resume with `--resume`; to discard and start over,
`--restart`. **This command was not run as part of this task** — only
`--smoke` was executed, per the task's explicit instruction not to start
the full benchmark without separate approval.

## 10. Belebele's limitations as a retrieval benchmark, and why it complements rather than replaces MIRACL

- **MRC-derived qrels, not pooled** (see §5): exactly one relevant document
  per query, no annotated negatives, no graded relevance. A model that
  ranks a *different but also-reasonable* passage above the source passage
  is scored as wrong, even if that passage is genuinely relevant — Belebele
  was never designed to guard against this, unlike MIRACL's human-pooled
  annotation process.
- **Small, fixed corpus per language** (488 passages) — far smaller than
  MIRACL's pooled subset (1000 passages) or its full 9.5M-passage corpus.
  Results here measure fine-grained ranking within a small, controlled set,
  not large-scale retrieval behavior.
- **Short, encyclopedic-register text** (FLORES-200 passages are drawn from
  Wikinews/Wikijunior/Wikivoyage-style sources) — not representative of
  Semidex's actual indexed content (chunked technical documents, code,
  Markdown).
- **What Belebele uniquely offers**: a genuinely *parallel* corpus — the
  same underlying passages and questions, translated across many
  languages — which MIRACL does not provide (MIRACL's Russian split has no
  cross-lingual sibling in this project's existing harnesses). This is what
  makes it possible to isolate the language/script factor at all, which
  was the explicit goal of this task.
- Together: MIRACL is the stronger evidence for realistic pooled-retrieval
  quality in one language (Russian); Belebele is the only available
  evidence for controlled cross-language/cross-script comparison, with a
  weaker qrels contract. Neither should be treated as sufficient alone for
  a production decision about sparse-retrieval defaults across Slavic
  languages.

## 11. Verification performed

- `node --check` clean on the 3 runtime modules and all 3 `.test.mjs`
  files.
- `node --test --test-concurrency=1` on all 3 new test files after review:
  **102/102 pass** (32 + 20 + 50).
- Pre-review combined regression run across BEIR + MIRACL + fusion + slavic
  suites: **384/384 pass**. The review changed only the Slavic harness and
  its tests; its final bounded suite is the 102/102 result above.
- `git diff --check`: clean.
- Live smoke run against real BGE-M3 + real Qdrant: `SLAVIC_BELEBELE_SMOKE_ACCEPT`,
  cleanup independently verified via `getCollections()`, no secrets/paths
  leaked.
- `git status` before starting this task was clean — no uncommitted
  RRF-sweep or other files were touched or reformatted.

## 12. Acceptance criteria checklist

- [x] Production retrieval/indexing code not changed.
- [x] Full benchmark not run without separate approval.
- [x] Smoke used real BGE-M3 and real Qdrant.
- [x] All offline tests pass with `--test-concurrency=1`.
- [x] `node --check` clean.
- [x] `git diff --check` clean.
- [x] No API keys, Qdrant URL credentials, or local private paths in this
      report or any committed file.
- [x] Nothing committed.
