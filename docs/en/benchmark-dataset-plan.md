# Benchmark Dataset Plan

semidex retrieval and reranking quality is currently validated against a single
50-query dataset (`custom-50`). This document defines a three-tier benchmark
structure that separates fast dev regression from broader in-domain validation
from blind holdout, and gives explicit rules to prevent overfitting.

---

## 1. Problem Statement

`custom-50` started as a general quality benchmark but has evolved into a
development regression fixture. Several properties of its current state create
overfitting risk:

**Repeated tuning against the same 50 queries inflates metrics.** Every guard
rule, qrel correction, and routing decision that improves a specific query
effectively reduces the degrees of freedom in the benchmark. At the extreme,
a model that scores perfectly on `custom-50` may have learned 50 queries, not
retrieval quality.

**Qrel corrections reduce benchmark independence.** Corrections like c36
(`project-structure.md#1` rel=2→3) are methodologically valid — the original
label was wrong. But each correction means the benchmark is now tighter around
the development history of the system. A fresh annotator starting from the
corpus would produce somewhat different labels, and any divergence masks real
quality differences.

**Per-query guards can accidentally become benchmark-specific.** The c03
heuristic (suppress `config-env.md` env-tables for provider-activation queries
when `providers.md` is in pool) is principled and generalizable. But it was
designed with c03 in mind. If we evaluate only on `custom-50`, we cannot tell
whether it generalizes or merely memorizes c03.

**Aggregate MRR hides class-specific regressions.** A global MRR@10 of 0.760
does not reveal whether `source-navigation` queries regressed while
`config-env` improved, or whether the Ukrainian query subset is carrying the
score. Class-level metrics require enough queries per class to be meaningful.

---

## 2. Benchmark Tiers

### Tier A — `custom-50`

**Purpose:** fast dev regression loop; tracks known historical failures; must
pass before every retrieval or reranking change.

**Corpus:** current `benchmarks/retrieval/custom-50/` fixtures and
`queries.json`.

**Allowed:**
- tuning model parameters, guard thresholds, routing rules against it;
- per-query diagnostics and result inspection;
- qrel corrections when the existing label is demonstrably wrong, with a
  written rationale in `queries.json` `note` field.

**Not sufficient alone:**
- should never be the sole promotion evidence for a retrieval strategy change;
- qrel correction frequency should be tracked — if corrections are frequent,
  the dataset needs replacement, not repair.

---

### Tier B — `custom-150`

**Purpose:** broader in-domain semidex docs validation; covers more query
classes and edge cases; required before promoting a new retrieval or reranking
strategy to production.

**Corpus:** same fixture files as `custom-50`, plus additional semidex
documentation pages. Queries must be written fresh — do not copy or
paraphrase `custom-50` queries.

**Allowed:**
- class-level diagnostics (e.g. "source-navigation queries regress on CE");
- per-query inspection after the fact to understand class patterns;
- improving routing/guard rules based on class-level findings.

**Not allowed:**
- per-query hardcoding (query-id checks, individual chunk protections);
- qrel tuning to move a specific query from FAIL to PASS.

**Per-query fixes must generalize.** If a `custom-150` query fails, the fix
must be expressed as a rule that applies to the entire query class, not as a
fix for that specific query. The rule is then validated on `custom-50` to
confirm no regression before re-running `custom-150`.

---

### Tier C — `holdout-50`

**Purpose:** blind validation that improvements generalize beyond tuned
examples.

**Corpus:** separate fixture documents not present in `custom-50` or
`custom-150` fixture sets, plus queries drawn from fresh annotation sessions.
Query IDs and qrels must be finalized before any retrieval strategy is
evaluated against them.

**Rules:**
- **Do not tune against it.** Do not inspect per-query failures during feature
  development.
- **Run only after a candidate strategy is frozen** — after it passes Tiers A
  and B.
- If holdout fails, diagnose the failure at the class or pattern level, then
  improve using Tier A/B. Do not patch directly to holdout failures.
- Preserve query IDs and qrels once accepted. Corrections require the same
  written rationale rule as Tier A, but are expected to be rare.

---

## 3. Query Taxonomy

All tiers share the same class taxonomy. Each query in `queries.json` must
have a `"type"` field matching one of these classes.

| Class | Description | Examples |
|-------|-------------|---------|
| `exact-token` | function names, env vars, file names, metric IDs | `ONNX_EMBED`, `chunkFile`, `MRR@10`, `hybridSearch` |
| `config-env` | env/config reference lookup — what a variable does or its default | `QDRANT_URL`, `SOURCE_ROOT`, `RERANK_PREFETCH_MULT` |
| `provider-activation` | how to enable or switch a provider | `як увімкнути bge-m3-onnx без Ollama`, `enable ONNX provider without Ollama` |
| `source-navigation` | where code lives / what a file exports / entry points | `де знаходиться src/core/qdrant.js`, `chunkFile location in source` |
| `conceptual` | why/how explanations, architecture rationale | `чому RRF краще за MMR для технічних токенів`, `how sparse vectors differ from BM25` |
| `troubleshooting` | error messages, failure symptoms, debug procedures | `Not existing vector name: dense`, `hybridSearch falls back when sparse missing` |
| `cross-lingual-ua-en` | Ukrainian query, English answer documents | Ukrainian operational queries against English fixture docs |
| `english` | English query, English answer documents | `Hybrid RRF prefetch limit`, `resolveEnvProviders single source of truth` |
| `negative` | no strong answer should be returned | semidex + PostgreSQL, features that do not exist |
| `window-dependent` | answer requires adjacent chunk context, not the exact top chunk | queries where ±1 chunk window is needed to confirm relevance |
| `multi-hop` | requires combining context from multiple files or sections | workflow/architecture dependency queries |

**Notes on classification:**
- `config-env` and `exact-token` overlap when the query is a bare env var
  name with no surrounding intent. Prefer `config-env` when the query asks
  about a variable's purpose or default, `exact-token` when it asks about a
  specific function/identifier in code.
- `provider-activation` is a sub-class of `conceptual` but gets its own class
  because it has a known distractor pattern (`config-env.md` env-table chunks)
  and requires dedicated routing guard rules.
- `cross-lingual-ua-en` covers queries in Ukrainian that target English-language
  documentation. This class stresses the multilingual embedding and is where
  English-only models fail hardest (see ms-marco failure analysis).

---

## 4. Dataset Size Targets

### `custom-50` — keep as-is

Do not add queries to `custom-50` except to replace a broken or
methodologically invalid case with a corrected equivalent. Adding queries risks
inflating the "50" label and making historical MRR comparisons inconsistent.

### `custom-150`

Target: **150 queries** across the following distribution:

| Class | Count | Rationale |
|-------|-------|-----------|
| `exact-token` | 20 | Largest class in current corpus; needs sufficient coverage for class MRR to be meaningful |
| `config-env` | 15 | Distinct from exact-token; env-table distractor pattern must be validated at scale |
| `provider-activation` | 10 | Small class but the one where CE guard is most critical; c03-pattern must generalize |
| `source-navigation` | 15 | Source-nav guard rule must generalize beyond c35/c36 |
| `conceptual` | 20 | Largest semantic class; needs depth across different doc areas |
| `troubleshooting` | 10 | Error message / symptom queries; validates sparse leg for rare tokens |
| `cross-lingual-ua-en` | 25 | Stress test for multilingual; must cover multiple Ukrainian query phrasings |
| `english` | 15 | Baseline English-only validation |
| `negative` | 10 | Must include at least 5 completely off-domain queries |
| `window-dependent` | 5 | Lower priority; window=1 already tested by smoke |
| `multi-hop` | 5 | Lower priority; current system does not explicitly support multi-hop |

**Total: 150**

If annotating 150 queries is too costly in one session, prioritize: `exact-token`,
`config-env`, `provider-activation`, `source-navigation`, `cross-lingual-ua-en`.
A 100-query subset covering those five classes already provides meaningful
class-level metrics.

### `holdout-50`

Target: **50 queries**, drawn from fresh annotation, balanced:

| Class | Count |
|-------|-------|
| `exact-token` | 8 |
| `config-env` | 5 |
| `provider-activation` | 5 |
| `source-navigation` | 5 |
| `conceptual` | 7 |
| `troubleshooting` | 5 |
| `cross-lingual-ua-en` | 8 |
| `english` | 2 |
| `negative` | 5 |

**Constraints:**
- At least 5 negative queries.
- At least 10 Ukrainian cross-lingual queries (combined `provider-activation` +
  `cross-lingual-ua-en` with Ukrainian phrasing).
- At least 5 source-navigation queries.
- No query may paraphrase a `custom-50` or `custom-150` query.

---

## 5. Qrel Guidelines

**Relevance scale:**

| Score | Meaning |
|-------|---------|
| 3 | Exact answer chunk — directly and sufficiently answers the query |
| 2 | Supporting context — useful but not sufficient alone; adjacent chunk, overview section |
| 1 | Weak topical match — mentions the topic but cannot answer; do not assign if unsure |
| 0 / absent | Distractor — irrelevant or misleading for this query |

**Special cases:**

- **Source-navigation:** file-tree chunks (e.g. `project-structure.md#1`) may
  be rel=3 if they explicitly name the function, file, or export asked about.
  A chunk that names `chunkFile()` with its file path is a direct answer to
  "where is chunkFile".

- **Config-env reference vs. activation:** env-var reference tables
  (`config-env.md#2` — a flat table of every ONNX variable) are rel=3 for
  `config-env` lookup queries (`"what does ONNX_EMBED do"`), but rel=0 for
  `provider-activation` queries (`"how to enable bge-m3-onnx"`). The table
  lists the variable but does not explain the activation workflow. This
  distinction is the root cause of the c03 BGE regression and must be applied
  consistently across all tiers.

- **Window-dependent:** if the exact answer is split across two adjacent chunks,
  both may be rel=3. Use `windowRecall` metrics to evaluate; do not force a
  single chunk to carry the full load.

- **Qrel corrections:** every correction must update the `note` field in
  `queries.json` with: original label, new label, and one sentence explaining
  why the original was wrong. Example: `"rel=2→3: Source Tree chunk explicitly
  names chunkFile(), splitSentences(), parseMarkdown() — direct answer to
  source-location query"`.

---

## 6. Metrics

### Global metrics (all tiers)

| Metric | Description |
|--------|-------------|
| MRR@10 | Mean reciprocal rank of first rel≥3 hit |
| rank1 exact | Count of queries where rank-1 result is rel≥3 |
| nDCG@10 | Graded NDCG using full relevance scale |
| chunkRecall@3/5/10 | % queries with rel≥3 hit in top K |
| windowRecall@5/10 | chunkRecall with ±1 chunk tolerance |
| supportRecall@10 | % queries with rel≥2 hit in top 10 |
| negativePass | % negative queries with no strong-hit token in top-1 |
| p50/p95 latency | Query latency for each mode |

### Per-class metrics (Tier B and C reports)

Report separately for:

- `exact-token` — MRR@10, chunkRecall@5, regression count
- `config-env` — MRR@10, chunkRecall@5
- `provider-activation` — MRR@10, chunkRecall@5, regression count (c03-pattern)
- `source-navigation` — MRR@10, chunkRecall@5, regression count
- `conceptual` — MRR@10, chunkRecall@5
- `troubleshooting` — MRR@10, chunkRecall@5
- `cross-lingual-ua-en` — MRR@10, chunkRecall@5 (Ukrainian subset)
- `negative` — negativePass only

**Why per-class matters:** global MRR@10 can be stable while Ukrainian query
quality degrades. The ms-marco model passed MRR@10 thresholds on subsets but
failed the Ukrainian class entirely (c16, c23, c46 all hard-regressed). Per-class
metrics catch this pattern before global aggregates do.

---

## 7. Promotion Policy

A candidate retrieval or reranking strategy may be promoted to production only
when all of the following are satisfied:

### Tier A gate (`custom-50`)

| Criterion | Threshold |
|-----------|-----------|
| Zero regressions | rel≥3 chunk at hybrid rank ≤3 must not move to CE rank >3 |
| MRR@10 | ≥ hybrid-true baseline + feature-specific target (see below) |
| negativePass | 100% |
| chunkRecall@5 | ≥ hybrid-true baseline |

Feature-specific MRR targets on `custom-50`:
- New embedding provider: ≥ current provider MRR (no regression).
- New reranking strategy: ≥ hybrid-true + 0.030.
- Routing/guard change: ≥ previous reranker MRR with 0 new regressions.

### Tier B gate (`custom-150`)

| Criterion | Threshold |
|-----------|-----------|
| MRR@10 | ≥ hybrid-true baseline + 0.020 |
| Zero protected-class hard regressions | exact-token, source-navigation, provider-activation |
| negativePass | 100% |
| Ukrainian MRR@10 | ≥ hybrid-true Ukrainian subset MRR |

### Tier C gate (`holdout-50`)

Holdout has different queries and difficulty from Tiers A/B. Absolute MRR
cannot be compared across datasets. The gate compares the candidate against
a holdout-specific baseline, measured on the same holdout queries using the
same ONNX provider before any CE or routing strategy is applied.

| Criterion | Threshold |
|-----------|-----------|
| MRR@10 | ≥ holdout hybrid-true baseline + 0.010, or ≥ holdout det-rerank baseline if the feature is reranking-only |
| Zero hard regressions | no class-level regression vs holdout baseline |
| negativePass | 100% |

For features that are not primarily about ranking quality (e.g. latency
optimization, provider switch with equivalent quality): no material regression
vs holdout baseline is sufficient — a drop of ≤ 0.005 MRR is acceptable.

**Baseline measurement:** immediately after sealing `holdout-50`, run
`hybrid-true` and `det-rerank` once and record the result as the holdout
baseline. This file is committed and never overwritten. Running the baseline
before sealing risks unconsciously tuning qrels or query phrasing toward a
favourable number.

If Tier C fails: diagnose at class/pattern level, improve using Tier A/B, then
re-freeze and re-run Tier C. Do not patch holdout cases directly.

---

## 8. Anti-Overfitting Rules

These rules are explicit constraints, not suggestions:

1. **No query-ID hardcoding.** Runtime code (`src/`) must not contain checks
   like `if (queryId === 'c03')`. Guards and routing rules must be expressed as
   general patterns.

2. **No qrel-dependent runtime logic.** Production code must not read or use
   qrel annotations. The oracle guard in `ce-routing-bench.js` is benchmark-only
   and must never be promoted to `src/`.

3. **No direct tuning against holdout.** Once a holdout set is sealed, failures
   are only inspected after a candidate strategy is frozen.

4. **Document every qrel correction.** Use the `note` field in `queries.json`.
   Track correction count per session.

5. **Report class-level deltas, not only global scores.** A benchmark run
   report that only reports global MRR is not sufficient for promotion review.

6. **Keep old result files.** Every benchmark run writes a dated file to
   `benchmarks/retrieval/results/`. Do not overwrite. Historical comparison
   is the primary defense against silent regressions introduced by parameter
   drift.

7. **Separate guard generalization from benchmark performance.** When a guard
   rule is introduced to fix a known query (e.g. c03), run it on
   `custom-150` before claiming the rule generalizes. If `custom-150` does not
   exist yet, the guard is provisional.

---

## 9. Implementation Plan

Steps in order:

1. **Add `type` field validation to `custom-50` runner.**
   Verify every query in `queries.json` has a `type` from the taxonomy.
   Log a warning (not error) for unknown types. ETA: low-effort, can be done
   inline in `run-v3.js` or `cross-encoder-bench.js`.

2. **Add per-class metrics to `custom-50` report.**
   In `run-v3.js` and `cross-encoder-bench.js`, group results by `query.type`
   and emit a per-class MRR@10 / chunkRecall@5 / regression count table at
   the bottom of the report. This is the minimal step needed before `custom-150`
   adds value, because without class metrics on `custom-50` there is no baseline
   to compare against.

3. **Create `benchmarks/retrieval/custom-150/queries.json`.**
   Write 150 queries following the distribution in Section 4.
   Use the same `schemaVersion: 3` format as `custom-50`.
   Fixtures: reuse `benchmarks/retrieval/fixtures/docs/` shared fixtures where
   possible; add new fixture documents under
   `benchmarks/retrieval/custom-150/fixtures/docs/` if needed.

4. **Create a `custom-150` runner.**
   Either extend `run-v3.js` with a `BENCH_DATASET` env var, or copy
   `cross-encoder-bench.js` as `benchmarks/retrieval/custom-150/run.js`.
   The runner must emit per-class metrics.

5. **Run and record `custom-150` baseline.**
   Run `hybrid-true` and `det-rerank` on `custom-150` with the current ONNX
   provider. Save the dated result file. This becomes the baseline for all
   future CE and routing promotion decisions.

6. **Create `benchmarks/retrieval/holdout-50/queries.json`.**
   Annotate 50 queries from a fresh session. Seal the file (no per-query tuning
   after this point). Store the file but do not run benchmarks against it until
   a candidate strategy has passed Tiers A and B.

7. **Run CE routing bench on `custom-150`.**
   After `ce-routing-bench.js` passes `custom-50`, run the same benchmark
   against `custom-150` using `BENCH_SKIP_INDEX=1`. If provider-activation guard
   generalizes, c03-class queries in `custom-150` should not regress.

8. **Document first multi-tier baseline result.**
   Add a dated summary to `docs/en/retrieval.md` covering:
   hybrid-true MRR on all three tiers; CE+routing MRR on Tiers A and B; and
   the first holdout run result once a strategy is frozen.

---

## File Locations

```
benchmarks/retrieval/
  custom-50/
    queries.json                  — Tier A, 50 queries (existing)
    fixtures/docs/                — Tier A fixtures
    cross-encoder-bench.js        — Tier A CE bench
    ce-routing-bench.js           — Tier A routing bench
  custom-150/
    queries.json                  — Tier B, 150 queries (to be created)
    fixtures/docs/                — Tier B fixtures (may extend shared)
    run.js                        — Tier B runner (to be created)
  holdout-50/
    queries.json                  — Tier C, 50 queries (to be created, then sealed)
  fixtures/docs/                  — Shared fixtures (providers.md, qdrant.md, chunking.md, sync.md)
  results/                        — Dated result files for all tiers
```
