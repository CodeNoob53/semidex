# Retrieval Results

This directory contains benchmark reports, audits, diagnostics, and result
snapshots for semidex retrieval and indexing work.

**Read this README first before opening individual reports.** The folder is
intentionally history-rich; use the tables below to go directly to the file
you need instead of scanning directory listings.

## Folder Policy

| Location | Meaning |
|----------|---------|
| `benchmarks/retrieval/results/` | Current or still-useful reports for active decisions, recent diagnostics, and design evidence. |
| `benchmarks/retrieval/results/archive/` | Historical reports whose methodology, qrels, fixture data, labels, or setup were superseded. |

Archived reports are not deleted. They remain available for regression
archaeology and comparisons, but they should not be treated as current quality
evidence unless the archive README explicitly says so.

## Current Canonical Reports

These are the reports that represent current decisions and should be read first
for each area. For superseded or exploratory runs in the same area, check
`archive/README.md`.

| Area | Canonical report(s) | Use when | Notes |
|------|---------------------|----------|-------|
| Retrieval quality — custom-50 | `2026-05-27T0000-combined-post-qrel-fix-verification.md` | Checking current hybrid+combined retrieval baseline | Post-qrel-fix canonical. Pre-2026-05-26T1200 reports (incl. T1144) are archival — stale qrels. |
| Retrieval quality — custom-150 | `2026-05-18T-custom150-qwen25-combined-quality.md` | Checking quality on 150-query fixture | Combined-LLM qwen2.5 run |
| CE routing / reranking | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt`, `2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Understanding why reranking is off by default | ADR 0003 cites these; v4 = final decision run |
| ColBERT / rerankers | `2026-05-16-bge-m3-colbert-head-probe.md` | ColBERT head probe results | Cited by ADR 0003 |
| BGE-M3 ONNX provider | `2026-05-09-bge-m3-onnx.txt` | BGE-M3 vs Ollama initial quality comparison | ADR 0001 cites this |
| Ollama hashed-TF provider | `2026-05-09-ollama-hashed-tf.txt` | Baseline for Ollama+hashed-TF provider path | ADR 0001 cites this |
| MMR opt-in | `2026-05-14-mmr-mcp-opt-in-audit.md` | Whether dense_mmr mode should be exposed | Cited by docs/en |
| Literal/full-text search | `2026-05-14-full-text-literal-search-audit.md` | Why full-text search is deferred | Cited by docs/en |
| Duplicate source pressure | `2026-05-14-duplicate-source-pressure-audit.md` | Duplicate source rate analysis | Cited by docs/en |
| Combined context+tags | `2026-05-17-combined-context-tags-feasibility.md`, `2026-05-17T2248-combined-llm-live-verification.md` | Feasibility and live verification of combined mode | T2122 is a superseded earlier draft |
| Combined mode quality — final decision | `2026-05-27T1430-combined-post-stable-ordering-verification.md` | **Current combined-mode opt-in decision** | Post-stable-ordering canonical. T0906 = raw matrix evidence. Supporting: T0000, T0430, T0900. |
| Combined mode quality (post-qrel-fix) | `2026-05-27T0000-combined-post-qrel-fix-verification.md`, `2026-05-27T0430-c41-combined-regression-diagnostic.md`, `2026-05-27T0900-combined-identifier-preserving-policy.md` | Supporting evidence behind T1430 | Pre-stable-ordering; verdicts confirmed by T1430. T0802 = raw matrix for T0900. |
| Prompt policy matrix | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Which context policy to use for initial model sweep | qwen2.5 canonical cross-model run (pre-qrel-fix); superseded for quality conclusions by T0900 |
| Section-window context policy | `2026-05-18-section-window-context-policy.md` | Section-window policy evaluation | Deferred — recall risk |
| ONNX batching / DML | `2026-05-17-onnx-batching-provider-comparison.md`, `2026-05-17-dml-batching-production-wiring-design.md` | GPU/DML batching decision | DML design = production wiring record |
| Indexing performance | `2026-05-17-indexing-perf-onnx-cpu.md`, `2026-05-17-indexing-perf-onnx-dml.md` | CPU vs DML wall-time baselines | DML = 6.9× speedup vs CPU |
| Architecture blockers | `2026-05-17-architecture-blockers-audit.md` | Outstanding architecture decisions | Cited by docs/en |
| Self-docs bootstrap | `2026-05-14-self-docs-bootstrap-design.md` | Semidex indexing its own docs | Cited by docs/en |
| Live agent review | `2026-05-12-clean-live-agent-review.md` | Definitive compact-window agent eval | Supersedes May-11 text dumps |
| Custom-raw answer policy | `2026-05-12-custom-raw-*.md` series (8 files) | Specific retrieval policy cases | Evidence for docs/en/retrieval.md answer-policy section |
| Tag usefulness | `2026-05-20-tag-usefulness-audit.md` | Whether tags improve retrieval | Audit vs. no-tag baseline |
| Tag gen ablation | `2026-05-21T1833-tag-gen-ablation-custom50.md` | Tag generation quality on custom-50 | |
| Tag batch fallback | `2026-05-22T0129-tag-batch-fallback-diagnostic.md`, `2026-05-22T0129-tag-batch-fallback-postfix-qwen25.md` | Tag batch JSON parse failure behavior | T0039 is superseded earlier run |
| Empty section live test | `2026-05-21T2221-empty-section-live-verification.md` | Empty section behavior verification | |
| Combined parser stability | `2026-05-22T0239-combined-parser-stability.md` | Parser stability independent of c48 qrel | Not archived despite c48 fix |
| Duplicate point repair | `2026-05-24T1500-duplicate-point-repair-bitwize-music-closure.md` | Full closure report for duplicate repair | Supersedes dry-run and apply intermediates |
| Deterministic point IDs | `2026-05-23T1249-deterministic-point-id-implementation.md` | Deterministic ID implementation record | |
| MCP agent UX | `2026-05-25-mcp-agent-ux-polish-v3-live-retest.md` | Current agent workflow retest verdict | v2 retest also in results/ for v2→v3 diff |
| Link-building equivalence | `link-equivalence-snapshot-*.json` | Dense-reuse graph equivalence snapshots | Machine-readable; 4 snapshots |
| Entity boost — historical design | `2026-05-27T1600-source-navigation-entity-chunking-design.md` | Superseded source-navigation boost design | Historical only; superseded by removal decision |
| Entity boost — historical implementation | `2026-05-27T1800-entity-aware-source-navigation-mvp.md` | Removed MVP implementation record | Historical only; code path removed |
| Entity boost — removal decision | `2026-05-29T0000-entity-boost-production-rollback.md` | **Current entity boost decision; verdict ENTITY_BOOST_REMOVED** | Runtime, benchmark command, and backfill path removed; prior positive runs are situational only |
| Entity boost — benchmark | `2026-05-27T2000-entity-boost-benchmark.md` | Situational source-navigation evidence | custom-50 improved, but not sufficient for production acceptance |
| Entity boost — live validation | `2026-05-27T1422-entity-boost-live-optin-validation-refresh.md` | Situational semidex-docs evidence | Fresh semidex-docs index; still semidex-like technical docs |
| Merge strategy | `2026-05-29T1500-merge-strategy-benchmark-v2.md` | **Current** LLM merge vs deterministic: wall-time, qrel safety, hard-boundary diagnostic | Verdict MERGE_STRATEGY_EQUIVALENT_ON_CUSTOM50_LLM_ALWAYS_SPLITS; supersedes T1200 |
| Merge strategy v1 | `2026-05-29T1200-merge-strategy-benchmark.md` | Superseded — missing wall-time breakdown, qrel safety, hard-boundary phase | Use T1500-v2 instead |

## Report Lookup by Task

| If you need to... | Start with |
|-------------------|------------|
| Understand current retrieval quality | `summary.md`, then `2026-05-27T0000-combined-post-qrel-fix-verification.md` |
| Decide whether to enable reranking | `2026-05-16-custom50-ce-routing-v4-*.txt` and `docs/adr/0003-rerankers-default-off.md` |
| Understand why `dense_mmr` is not the default | `2026-05-14-mmr-mcp-opt-in-audit.md` |
| Understand combined context+tags mode | `2026-05-17-combined-context-tags-feasibility.md`, then `2026-05-27T0000-combined-post-qrel-fix-verification.md` |
| Understand current combined-mode quality decision | `2026-05-27T1430-combined-post-stable-ordering-verification.md`, then `docs/adr/0004-combined-llm-opt-in.md` (2026-05-27 update section) |
| Understand c41 combined regression | `2026-05-27T0430-c41-combined-regression-diagnostic.md` |
| Decide which context policy to use | `2026-05-27T0900-combined-identifier-preserving-policy.md` (post-qrel-fix), `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` (initial model sweep) |
| Understand ONNX GPU/DML setup | `2026-05-17-onnx-batching-provider-comparison.md` then `2026-05-17-dml-batching-production-wiring-design.md` |
| Debug duplicate points in a collection | `2026-05-24T1500-duplicate-point-repair-bitwize-music-closure.md` |
| Validate MCP agent workflow | `2026-05-25-mcp-agent-ux-polish-v3-live-retest.md` |
| Understand answer-policy edge cases | `2026-05-12-custom-raw-*.md` series |
| Understand tag generation behavior | `2026-05-20-tag-usefulness-audit.md`, `2026-05-21T1833-tag-gen-ablation-custom50.md` |
| Understand why entity boost was removed | `2026-05-29T0000-entity-boost-production-rollback.md`, then `docs/adr/0005-entity-boost-opt-in.md` |

## How To Navigate

| Need | Start with |
|------|------------|
| Current custom-50/custom-150 retrieval quality | `*custom50*`, `*custom150*`, and `summary.md` if present |
| Combined context+tags decisions | `*combined*`, then check `archive/README.md` for superseded runs |
| Tag generation behavior | `*tag*` reports |
| ONNX, batching, DML, CUDA, indexing speed | `*onnx*`, `*indexing-perf*`, `*performance*`, `*cuda*` |
| Architecture/design blockers | `*audit*`, `*design*`, `*architecture*` |
| Link-building and graph equivalence | `*link*`, `link-equivalence-snapshot-*.json` |
| Raw benchmark text output | `.txt` reports from older benchmark runners |
| Machine-readable benchmark output | `.json` result snapshots |

Prefer `rg` over manually browsing this directory. Examples:

```bash
rg -n "Verdict|Conclusion|Hard regressions|MRR|chunkRecall" benchmarks/retrieval/results
rg -n "c48|qrel|superseded|DEFER" benchmarks/retrieval/results benchmarks/retrieval/results/archive
```

## Current Cleanup Status

**Warning — stale qrels in pre-2026-05-26T1200 combined reports:**

All combined-mode reports generated before 2026-05-26T1200 (including the May-18
and May-22 combined quality runs) used a stale custom-50 qrel for query `c48`.
They must not be treated as current quality evidence for combined-mode retrieval.
Use the post-stable-ordering canonical series instead:

- `2026-05-27T1430-combined-post-stable-ordering-verification.md` — **final combined-mode decision** (start here)
- `2026-05-27T0906-combined-llm-quality-matrix.md` — raw matrix evidence for T1430
- `2026-05-27T0000-combined-post-qrel-fix-verification.md` — post-qrel-fix quality matrix + ablation (supporting)
- `2026-05-27T0430-c41-combined-regression-diagnostic.md` — c41 root cause (supporting)
- `2026-05-27T0900-combined-identifier-preserving-policy.md` — identifier-preserving policy (supporting)
- `2026-05-27T0802-combined-llm-quality-matrix.md` — raw matrix evidence for T0900

**Second archive batch — 2026-05-25:**

19 files moved to `archive/`. Groups:

- 2026-05-13 indexing performance analysis (1 file) — superseded by May-17 DML/CPU reports
- 2026-05-14 diagnostic/instrumentation/preflight/sync-link audits (4 files) — superseded by later audits and docs
- 2026-05-17 link-dense-reuse design + patch-A result (2 files) — implementation complete; conclusions in AGENTS.md and code
- 2026-05-17 performance-bottleneck audit + indexing-performance live summary (2 files) — superseded by DML/CPU reports
- 2026-05-17 combined-context-tags-feasibility T2122 (1 file) — earlier draft; superseded by canonical dated file
- 2026-05-20 tag-model-qwen25-separate-path (1 file) — exploratory; superseded by tag batch diagnostic runs
- 2026-05-22 tag-batch-fallback T0039 (1 file) — superseded by T0129 pair
- 2026-05-22 results-folder-organization-plan (1 file) — organization complete; plan superseded by this README
- 2026-05-23/24 duplicate-point repair intermediates (6 files: diagnostic, plan, 2 dry-runs, 2 apply runs) — all superseded by closure report `2026-05-24T1500-duplicate-point-repair-bitwize-music-closure.md`

**First high-confidence archive batch — 2026-05-22:**

33 files moved to `archive/` per
`2026-05-22T1300-results-folder-organization-plan.md`. Groups:

- 2026-05-09 early 20q variants and rerank v1/v2 (4 files)
- 2026-05-10 abandoned custom-large fixture (2 files)
- 2026-05-11/12 agent-eval text dumps and custom-raw raw baselines (6 files)
- 2026-05-15 CE routing intermediate runs not cited by docs/en (7 files)
- 2026-05-17 ONNX intermediate probes (5 files)
- 2026-05-18 intermediate combined-LLM custom-50 quality runs T1004/T1010/T1048/T1054 (4 files)
- 2026-05-18 prompt policy matrix non-decisive model runs T0950/T0951/T0954/T1043/T1044 (5 files)

8 additional candidates were **skipped** because `docs/en/retrieval.md` or
`docs/en/benchmarking.md` cite them directly — they remain in `results/` until those
docs are updated. See `archive/README.md` "First High-Confidence Cleanup Batch" for the skipped list.

Medium/low-confidence candidates and files needing human review are intentionally
left in root; see the organization plan for the full candidate list.

**Earlier cleanup (2026-05-22, c48 qrel fix):**

7 combined-prompt alignment reports from 2026-05-22 were moved to `archive/`
because custom-50 qrel `c48` was corrected after those reports were generated.
See `archive/README.md` for the full table and rationale.

Do not archive `2026-05-22T0239-combined-parser-stability.md` for that reason:
it tests parser stability, not custom-50 retrieval quality.

## Archiving Rules

Archive a report when:

- benchmark qrels, fixtures, query labels, or metric definitions changed;
- a later report replaces a draft or superseded summary;
- the report used a known flawed env, provider mismatch, stale collection, or
  wrong setup;
- the report is useful historically but should not guide current decisions.

Do not archive:

- current reports that remain valid for active decision-making;
- design/audit reports whose conclusions do not depend on the changed benchmark
  data;
- private raw model outputs, corpus dumps, or machine-local paths. Keep those
  under `.tmp/` and do not commit them.

When moving files into `archive/`, update `archive/README.md` in the same
change. Add a row with:

| Field | What to write |
|-------|---------------|
| File | Archived filename |
| Original purpose | What the report was measuring |
| Archive reason | Why it is no longer current evidence |
| Current replacement / next action | Which report or rerun supersedes it |
| Open when | The narrow situation where an agent should read it |

## Naming Guidance

Use timestamped Markdown for human-readable reports:

```text
YYYY-MM-DDTHHMM-topic.md
YYYY-MM-DD-topic.md
```

Use `.json` only for machine-readable snapshots and `.txt` for legacy runner
output. Prefer writing private diagnostic raw outputs under `.tmp/`.
