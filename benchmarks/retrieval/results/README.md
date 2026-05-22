# Retrieval Results

This directory contains benchmark reports, audits, diagnostics, and result
snapshots for semidex retrieval and indexing work.

Use this README as the first stop before opening individual reports. The folder
is intentionally history-rich, so agents should narrow by category and filename
pattern instead of reading every file.

## Folder Policy

| Location | Meaning |
|----------|---------|
| `benchmarks/retrieval/results/` | Current or still-useful reports for active decisions, recent diagnostics, and design evidence. |
| `benchmarks/retrieval/results/archive/` | Historical reports whose methodology, qrels, fixture data, labels, or setup were superseded. |

Archived reports are not deleted. They remain available for regression
archaeology and comparisons, but they should not be treated as current quality
evidence unless the archive README explicitly says so.

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
