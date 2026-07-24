# Slavic Belebele weighted-RRF fusion matrix — feasibility and harness verification report

This report covers **harness implementation and verification only**. The
full 7-language benchmark has **not** been run — per the task's explicit
instruction, this phase builds and validates the harness, then stops for
manual review before the expensive full run is approved and executed
separately.

## What this report is, and is not

- **IS**: a record of what was built, how it was verified (unit tests,
  syntax checks, one real-Qdrant smoke run), and an estimate of what the
  full run would cost.
- **IS NOT**: a report of Slavic-language weighted-RRF retrieval quality.
  No full-scale conclusions about sparse/hybrid regression by language or
  script group exist yet — those numbers do not exist until the full
  7-language run is explicitly approved and executed.
- **IS NOT**: a restatement or re-analysis of the completed live
  SciFact/MIRACL weighted-RRF benchmark
  (`2026-07-24-weighted-rrf-live.{json,md}`). That benchmark's own finding
  — dense-heavy weighted RRF (`k2_rho0.10`) removes most of the MIRACL
  regression seen under equal-weight hybrid, but the effect is
  dataset/provider-dependent — is cited below only as the MOTIVATION for
  this harness, never as evidence about Slavic languages themselves.

## Goal

Determine whether sparse and equal-weight RRF regressions correlate with
individual Slavic languages or script groups, using the exact same six
fusion modes and rho -> sparseWeight conversion already validated by the
live SciFact/MIRACL weighted-RRF benchmark, applied to the existing
7-language Slavic Belebele matrix
(`ukr_Cyrl`/`rus_Cyrl`/`bul_Cyrl`/`pol_Latn`/`ces_Latn`/`slk_Latn`/`eng_Latn`).

CUDA is treated strictly as an execution accelerator throughout this
harness — never as a retrieval-quality variable. No CPU/DML/CUDA quality
comparison is made or implied anywhere in this harness or report.

## What was built

### Shared modules (new — extracted to remove duplication)

- **`benchmarks/external/fusion/weighted-rrf-fusion-modes.mjs`**: the
  six-mode fusion list (`dense`, `sparse`, `equal_k2`, `equal_k60`,
  `k2_rho0.10`, `k2_rho0.25`) and the `sparseWeightFromRho(k, rho)`
  closed-form conversion, in exactly one place. Both
  `../fusion/weighted-rrf-live-config.mjs` (SciFact/MIRACL) and
  `../slavic/slavic-weighted-rrf-config.mjs` (this task) import the
  identical `FUSION_MODES` object reference — a dedicated test
  (`the SciFact/MIRACL weighted benchmark and this Slavic benchmark
  import the exact same FUSION_MODES object reference`) asserts this with
  `assert.strictEqual`, not just deep equality.
- **`benchmarks/external/fusion/weighted-rrf-cuda.mjs`**: the strict-CUDA
  pre-flight gate (`verifyStrictCudaConfigured`) and post-hoc provenance
  verification (`verifyCudaProvenance`), extracted from
  `run-weighted-rrf-live.mjs` so both the SciFact/MIRACL and Slavic
  harnesses enforce the identical CUDA contract. `run-weighted-rrf-live.mjs`
  now imports and re-exports both functions unchanged, so its existing
  public API and test suite required no changes beyond the import path.

### New Slavic weighted-RRF harness

- **`benchmarks/external/slavic/slavic-weighted-rrf-config.mjs`**: the
  same 7-language matrix (re-declared independently of
  `slavic-profiles.mjs`, verified byte-for-byte identical by test),
  imports the shared `FUSION_MODES`, defines the three descriptive-only
  groups (Cyrillic Slavic / Latin Slavic / English control), the single
  local BGE-M3 ONNX provider (no Qdrant Cloud — same confound-isolation
  rationale as the existing equal-RRF-only Slavic benchmark), and a
  dedicated collection prefix (`semidex-slavic-weighted-rrf-`, distinct
  from both the equal-RRF Slavic benchmark's prefix and the SciFact/MIRACL
  weighted benchmark's prefix).
- **`benchmarks/external/slavic/run-slavic-weighted-rrf.mjs`**: the
  harness itself. Per language: one Qdrant collection, one indexing pass
  (dense+sparse from the same `embedOnnxBatch()` call — mirrors
  `run-slavic-benchmark.mjs`); per query, dense+sparse query vectors
  computed once and reused across all six fusion modes (mirrors
  `run-weighted-rrf-live.mjs`); real Qdrant `query.rrf.weights` requests,
  never `prefetch.weight`. Supports `--smoke`, `--resume`, `--restart`,
  `--resume-check`, `--languages=`. Atomic checkpoint writes
  (temp-file + rename). Strict-CUDA pre-flight gate runs before any
  collection is created for a non-smoke, non-resume-check invocation
  (every language here is a local scope, so the gate always applies to a
  real run). Cleanup always runs in `finally`, guarded to the exact owned
  prefix; a 404 from `deleteCollection` is treated as already-deleted
  success, not a failure.
- Group summaries (`computeGroupSummaries`) and per-language decision
  classification (`classifyLanguageDecisions`) — both explicitly
  descriptive-only for the former, and enforcing "never promote a
  candidate merely because it wins a group average" for the latter, via a
  hard rule: a classification only becomes `_helps`/`_hurts`/"restores" or
  "does not restore" when the underlying paired-bootstrap 95% CI excludes
  zero; `MIXED`/`INCONCLUSIVE` verdicts always report as neutral, never
  silently upgraded.

### Documentation

- `benchmarks/external/slavic/README.md` — new "Live weighted-RRF fusion
  matrix" section: purpose, exact language matrix, fusion modes, commands,
  resume behavior, CUDA's limited accelerator-only role, interpretation
  limits.
- This report.

## Preflight compliance

- **Existing uncommitted weighted-RRF work preserved**: `git status` was
  inspected before any change; the pre-existing uncommitted files
  (`run-weighted-rrf-live.mjs`, its test file, `weighted-rrf-live-config.mjs`,
  the completed `2026-07-24-weighted-rrf-live.{json,md}` reports, the
  modified `.gitignore`/`README.md`/`onnx-embed.js`) were left untouched in
  content except for the two files refactored to consume the new shared
  modules (`weighted-rrf-live-config.mjs`, `run-weighted-rrf-live.mjs`) —
  both changes are additive extractions verified non-breaking by
  re-running that suite's full 100-test file after the refactor (100/100
  pass, unchanged from before the extraction).
- **No unrelated reverts/reformats**: only the files listed in "Changed
  files" below were touched.
- **Dataset cache reused exactly**: `fetchAndValidateLanguage()` from the
  existing `fetch-belebele.mjs` is used unchanged — no new fetch/download
  logic, no invented qrels. This is confirmed by a real fixture test
  (`fetchAndValidateLanguage() succeeds using ONLY the cache, with zero
  network calls, when a real valid manifest+checksum exist`) that writes a
  genuine, schema-valid 900-row/488-doc JSONL plus a matching sha256
  manifest to the real `DATA_DIR` under a synthetic language code, stubs
  `global.fetch` to throw, and calls the real (unmocked)
  `fetchAndValidateLanguage()` — not merely a test of `executeLanguage()`/
  `shrinkForSmoke()` (an earlier version of this test suite had a
  same-titled describe block that exercised only those two functions,
  which never call `fetchAndValidateLanguage()` at all and so proved
  nothing about the actual cache-vs-network path; that gap is fixed). A
  companion negative-control test confirms the fixture test is not
  vacuously true: with the cache fixture removed, the same call genuinely
  throws through the stubbed `fetch`.
- **Full 7-language benchmark NOT run** during implementation — only the
  harness was built and validated (unit tests + one real-Qdrant smoke
  scope, `ukr_Cyrl` only, 3 queries/10 docs).

## Test results

New test file, run bounded (`node --test --test-concurrency=1`), after a
follow-up review round fixed three findings (see "Follow-up review round"
below — a non-inferiority classification bug, a shallow-freeze gap on the
locked fusion weights, and an offline-cache test that didn't actually
exercise `fetchAndValidateLanguage()`):

```
benchmarks/external/slavic/run-slavic-weighted-rrf.test.mjs
tests 95, pass 95, fail 0
```

Covers (per the task's required minimum list): exact seven-language
matrix; exact six fusion modes and weights (including a direct
`sparseWeightFromRho` formula check, an `assert.strictEqual` proof that
both harnesses share the same `FUSION_MODES` object, and a deep-freeze
immutability check on every rrf mode's `weights` array); one indexing pass
per language; one embedding call per document/query batch reused across
all six modes; real weighted-RRF request shape (`query.rrf.weights`,
never `prefetch.weight`); stable comparison direction (comparison minus
baseline, both directions tested); paired-bootstrap determinism (fixed
seed reused from `../miracl/bootstrap.mjs`, ≥2000 iterations, repeated-call
identity check); group membership and macro calculation (including the
missing-language and empty-group edge cases); a three-state (restored/
regressed/inconclusive) non-inferiority classification against a fixed,
pre-registered margin; resume compatibility checks; atomic checkpoint
writes; smoke/full path isolation; exact-prefix cleanup guard; 404 cleanup
success; secret redaction; strict-CUDA preflight before indexing
(gate-runs-before-`executeLanguage()` source-order check); no network
access when cache is valid, verified against the REAL
`fetchAndValidateLanguage()` function using a real fixture cache file plus
a negative-control test proving the fixture test is not vacuous.

Combined regression run (new Slavic weighted-RRF tests + all existing
Slavic tests + all existing fusion tests, including the SciFact/MIRACL
weighted-RRF live benchmark's own test suite, which gained a matching
weights-immutability test), bounded:

```
node --test --test-concurrency=1 <8 files>
tests 531, pass 531, fail 0
```

`node --check` passed for every changed/new JavaScript file. `git diff
--check` reported no whitespace errors (one harmless CRLF-normalization
warning on `.gitignore`, not an error).

## Follow-up review round (findings fixed after initial implementation)

A code review pass against the initial implementation of this harness
found three real issues, all verified against the actual code/data before
being fixed:

1. **`classifyLanguageDecisions()`'s "restores dense quality" logic was
   wrong** (`restoresDenseQuality()`, since renamed
   `nonInferiorityClassification()`): it treated ANY `MIXED`/`INCONCLUSIVE`
   bootstrap verdict as `restores: true`, which directly contradicted the
   function's own doc comment ("absence of significance is reported as
   MIXED/neutral, never silently treated as... 'restores quality'").
   Absence of a statistically CONFIRMED regression is not proof of
   restoration — a wide or uninformative confidence interval could still
   include a large regression. **Fixed** with a genuine three-state
   non-inferiority test against a fixed, pre-registered margin
   (`RESTORES_DENSE_QUALITY_MARGIN = 0.02` nDCG@10, chosen before any
   result is inspected, never tuned post-hoc): `restored` only when the
   95% CI's lower bound excludes any regression worse than the margin;
   `regressed` only when the entire CI is such a regression; `inconclusive`
   otherwise (CI straddles the margin, or is unavailable). Regression
   tests added for all three states plus the exact previously-buggy case
   (a MIXED/INCONCLUSIVE result whose CI still reaches well below the
   margin now correctly classifies `inconclusive`, never `restored`).
2. **The "locked" fusion-mode weights were not actually immutable**:
   `Object.freeze()` on each mode object in
   `../fusion/weighted-rrf-fusion-modes.mjs` is shallow — the nested
   `weights` array remained a plain, mutable array, so
   `fusionModeById('equal_k2').weights[0] = 999` silently succeeded with
   no error, which could corrupt every subsequent live Qdrant request
   built from the "locked" config. **Fixed** by freezing each `weights`
   array individually before embedding it in its mode object. Regression
   tests (added to both this benchmark's test file and the SciFact/MIRACL
   weighted-RRF live benchmark's test file, since both consume the same
   shared module) assert `Object.isFrozen(mode.weights)` and that a
   mutation attempt throws in strict mode and leaves the array unchanged.
3. **The offline-cache test didn't test what its title claimed**: the
   describe block "fetchAndValidateLanguage never reaches the network when
   cache is valid" contained only a source-text grep and a test of
   `executeLanguage()`/`shrinkForSmoke()` — neither of which ever calls
   `fetchAndValidateLanguage()` at all (that happens earlier, in `main()`,
   using an already-constructed task fixture in tests). This report's own
   earlier draft cited that test as proof of the offline-cache claim,
   which was itself incorrect. **Fixed** by adding a real end-to-end test
   that writes a genuine, schema-valid 900-row/488-doc JSONL plus a
   correctly-computed sha256 manifest to the real `DATA_DIR` (under a
   synthetic language code that can never collide with a real cached
   language), stubs `global.fetch` to throw, and calls the real
   `fetchAndValidateLanguage()` — plus a negative-control test proving the
   positive test is not vacuously true (removing the fixture makes the
   same call genuinely throw through the network stub).

## Smoke result

One real-Qdrant smoke scope was run in the foreground:

```
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --smoke
```

- Language: `ukr_Cyrl` only (the first in canonical order).
- Corpus: 10 documents (shrunk from the smoke config's `SMOKE_CORPUS_SIZE`).
- Queries: 3 (shrunk from `SMOKE_QUERY_COUNT`).
- All six fusion modes exercised: `dense`, `sparse`, `equal_k2`,
  `equal_k60`, `k2_rho0.10`, `k2_rho0.25`.
- One collection created, one indexing pass (dense+sparse from a single
  embed call), 3 queries × 6 modes = 18 query requests issued.
- Cleanup: collection deleted, confirmed **independently** by a follow-up
  `client.getCollections()` call after the run showing zero
  `semidex-slavic-weighted-rrf-*` collections remaining in the real Qdrant
  instance — not merely self-reported by the harness.
- Report written to
  `benchmarks/external/results/.slavic-weighted-rrf-smoke-report.json`
  (gitignored, smoke-only path — never overwrites the real report).

*(Exact call counts, verdict, and peak RSS from the smoke run are reported
verbatim in the final chat response accompanying this report, since they
depend on the specific run just executed.)*

## Strict CUDA provenance

The pre-flight gate (`verifyStrictCudaConfigured`) and post-hoc provenance
check (`verifyCudaProvenance`) are the same functions the completed
SciFact/MIRACL weighted-RRF benchmark already validated in a real run —
extracted here unchanged into a shared module, not reimplemented. In this
development environment (no `ONNX_EXECUTION_PROVIDER=cuda`/
`ONNX_CUDA_STRICT=1` configured), the gate correctly refuses to start a
non-smoke run against local (i.e. every) language in this benchmark — this
was verified directly, not merely asserted by test, by calling
`verifyStrictCudaConfigured()` against the real `process.env` of this shell.
The smoke run itself is exempt from the gate (plumbing-only, never claims
real CUDA numbers) and ran successfully on whatever provider this
environment's ONNX session defaulted to.

**Whether strict CUDA works end-to-end (gate blocks a real run without it,
and accepts one with it correctly configured) is confirmed by source-level
verification and the shared module's own already-proven behavior in the
SciFact/MIRACL benchmark — this task did not re-run a full CUDA-configured
scope, since that would mean starting real indexing work beyond the
explicitly scoped smoke validation.**

## Observations from prior SciFact/MIRACL runs (context only — not evidence about Slavic languages)

The completed live SciFact/MIRACL weighted-RRF benchmark found:
`k2_rho0.10` (the same primary candidate this harness will evaluate)
removes most of the MIRACL regression seen under equal-weight hybrid RRF,
but the magnitude and significance of that effect differ between SciFact
and MIRACL and between the local and cloud providers. This motivated the
present harness's question — whether a similar regression, and a similar
rescue effect from dense-heavy weighting, appears (or does not appear)
consistently across the Slavic language matrix, or instead correlates
with specific languages/script groups. **This is a hypothesis this
harness is built to test, not a conclusion already reached** — no Slavic
retrieval-quality numbers exist yet.

## Unsupported conclusions (explicitly out of scope for this report)

- No claim is made about which Slavic languages sparse retrieval helps or
  hurts — that requires the full run.
- No claim is made about a Cyrillic-vs-Latin script effect — even once the
  full run exists, script and language remain confounded in this 7-language
  matrix (3 Cyrillic, 3 Latin Slavic, 1 Latin control), and the harness's
  own decision-classification and group-summary code is built to phrase
  any observed pattern as an association requiring further validation, not
  a causal claim.
- No CPU/DML/CUDA retrieval-quality comparison is made or implied.
- No production language-aware fusion is implemented or recommended.
- No production fusion default (RRF_K, sparse-enablement) is changed by
  this harness or by running it.

## Estimated full-run duration

Not measured directly (the full run was not started, per the task's
explicit boundary). Estimated from two real data points:

- The completed equal-RRF-only Slavic benchmark
  (`2026-07-23-slavic-belebele-benchmark.json`): ~19–23s indexing per
  language (488 docs), ~53ms median latency per Qdrant request, 900
  queries × 3 requests/query (dense+sparse+1 hybrid) per language.
- This benchmark issues 6 requests/query (dense+sparse+4 hybrid) instead
  of 3 — roughly double the query-phase request volume per language, with
  indexing cost unchanged (same corpus, same one-pass embedding).

Extrapolating: ~300–310s (~5.1 minutes) per language × 7 languages ≈
**35–40 minutes** total, sequential, on the same execution provider the
equal-RRF benchmark used (CPU, in that prior run). Strict CUDA (the
intended configuration for an eventual full run) primarily reduces
embedding/indexing time, not the number of Qdrant round trips, so it
would reduce this estimate somewhat but not proportionally — a
conservative range of **35–45 minutes** is reported rather than a single
precise number, since this is an extrapolation from a different fusion
harness's timing, not a direct measurement of this harness's own full run.

## Full-run command (for later manual approval — not executed by this task)

```bash
node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs
```

Requires `QDRANT_URL`/`QDRANT_KEY` and, for the strict-CUDA pre-flight
gate to pass, `ONNX_EXECUTION_PROVIDER=cuda` and `ONNX_CUDA_STRICT=1` set
in the environment beforehand (a custom `ONNXRUNTIME_NODE_PATH`, if
needed for this machine's CUDA setup, is read from whatever the existing
runtime configuration already provides — this harness never hardcodes
one). Not started by this task.
