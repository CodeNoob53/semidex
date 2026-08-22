# Graph-expanded retrieval: live disposable benchmark

## Context

Step 1 implemented an opt-in graph-expansion stage in the shared retrieval
path. It is disabled by default and must not be proposed as default-on until a
real Qdrant benchmark demonstrates useful retrieval gains at acceptable cost.

Read first:

- `docs/design/graph-expanded-retrieval.md`
- `docs/tasks/graph-expanded-retrieval-step1.md`
- `docs/tasks/graph-expanded-retrieval-step1-report.md`
- `src/core/retrieval/search.js`
- `src/core/retrieval/graph-expand.js`
- existing external benchmark harnesses and disposable-collection acceptance
  scripts for repository conventions

## Objective

Build and run a reproducible A/B benchmark against a real configured Qdrant
instance:

- A: existing hybrid retrieval with graph expansion disabled;
- B: the same hybrid retrieval with graph expansion enabled.

The benchmark must determine whether structural expansion recovers relevant
content missed by the seed pool, how often it displaces a relevant direct seed,
and what latency and storage-call overhead it adds.

## Safety boundary

- Never read, modify, migrate, or delete an existing user collection.
- Create one uniquely named disposable collection owned by this benchmark.
- Record the exact owned collection name before creation.
- Delete only that exact collection in a `finally` cleanup.
- Treat a pre-existing collection with the generated name as a hard failure.
- Do not print or persist secrets, URLs containing credentials, document text
  from unrelated collections, or environment values.
- No commits.

## Fixture and qrels

Create a small deterministic Markdown fixture corpus that indexes through the
real skeleton chunker and contains at least these cases:

1. a relevant section sibling whose wording has weak lexical/semantic overlap
   with the query but is structurally adjacent to a strong seed;
2. a relevant previous/next chunk recoverable through sequential structure;
3. an irrelevant structural neighbor that must not improve the result;
4. a query where the direct hybrid seed set is already correct and expansion
   must not reduce top-k relevance;
5. a source-file or tag-scoped query proving expansion respects caller filters;
6. a negative query with no relevant content;
7. a case where a graph candidate from a high-ranked seed can displace a
   lower-ranked direct seed, so the current merge policy is measured rather
   than assumed correct.

Define explicit human-authored qrels before running retrieval. Do not derive
qrels from the system output.

## Harness requirements

Prefer a new focused harness under `benchmarks/` that reuses production code.
Do not duplicate retrieval or graph-expansion logic in the harness.

For every query and both modes capture:

- ranked result identities and provenance (`retrievalOrigin`, seed identity,
  relation path, depth);
- Recall@k, MRR@k, nDCG@k, and zero-hit/negative-query correctness;
- relevant direct seeds displaced by graph candidates;
- relevant graph candidates newly recovered;
- total query latency and graph-expansion-only latency where measurable;
- storage calls added by expansion and candidate counts before/after dedup;
- feature-off parity against the existing production result;
- errors and fallback-to-seed-only events.

Use the same collection, query text, filters, `top`, embedding profile, and
retrieval settings for A and B. Warm up both modes before timed samples. Run
enough repeated timed samples to report median and p95 without making the test
unreasonably slow. Keep raw per-run measurements in JSON and write a concise
Markdown report.

## Required analysis

The report must answer:

1. Did expansion recover any qrel-relevant content missed by seed-only search?
2. Did it lower any metric or displace relevant direct seeds?
3. What median/p95 latency and Qdrant-call overhead did it add?
4. Are results deterministic across repeated runs?
5. Do source-file/tag filters remain intact?
6. Is the current seed-then-neighbors merge policy acceptable, or should the
   next iteration use a reserved graph quota, reranking, or a different merge?
7. Should the feature remain experimental/off by default?

Do not claim general quality improvement from this synthetic fixture. State
that a later external benchmark is required for a general conclusion.

## Verification

Add focused offline tests for the harness calculation/reporting logic. Then run:

- the new focused tests;
- the live disposable benchmark;
- relevant graph-expanded retrieval and Qdrant adapter tests;
- `npm run smoke`;
- `git diff --check`.

If the configured environment cannot run the live benchmark, report the exact
blocker and leave a runnable command. Do not weaken the benchmark or silently
replace the real Qdrant run with mocks.

## Deliverables

- reproducible benchmark harness;
- deterministic fixture and explicit qrels;
- raw JSON result;
- Markdown report with the A/B table, limitations, and recommendation;
- implementation report listing files, commands, results, cleanup evidence,
  and any unresolved risks.

