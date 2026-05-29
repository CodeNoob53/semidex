# ADR 0005: Entity Boost Removed After Scope Validation

Status: Accepted

Date: 2026-05-29

## Context

The entity-aware MVP added deterministic entity payloads to indexed chunks and a
post-RRF overlap boost experiment for source-navigation queries. The first
custom-50 benchmark looked promising: source-navigation cliff cases improved
without new hard regressions in the benchmark fixture.

Later validation exposed a scope problem. The boost mechanism is generic, but
the current entity extractor is not. It is tuned to semidex/code-documentation
tokens such as `src/...` paths, JavaScript-style symbols, known semidex env-var
prefixes, and `npm run ...` commands. On a harder Linux/systemd technical corpus,
the extractor produced no useful boost-relevant entities, so entity boost became
a structural no-op.

That means the production opt-in decision was premature: the feature worked on
the corpus it was effectively tuned for, but did not generalize to another
realistic technical corpus.

## Decision

Entity boost is removed from semidex runtime and benchmark tooling.

- `qdrant_search` no longer reads or applies `ENTITY_BOOST_ENABLED`,
  `ENTITY_BOOST_WEIGHT`, or `ENTITY_BOOST_PREFETCH`.
- The default production search path remains hybrid dense+sparse RRF, with the
  existing `RERANK_ENABLED=1` path as the only optional production rerank stage.
- Entity payload extraction, payload indexes, backfill tooling, and
  `bench:custom50:entity-boost` are removed. Historical reports remain as
  evidence only.
- The previous positive custom-50 and semidex-docs results are retained as
  situational evidence, not as production acceptance evidence.

## Rationale

1. **The extractor is the blocker.** Entity boost can only help when both the
   query and candidate chunks contain comparable entity tokens. The current
   extractor does not produce those tokens for common non-semidex technical
   documents such as shell commands, system paths, unit-file directives, or
   generic config keys.

2. **Production opt-in is still a production surface.** Even if disabled by
   default, documenting and shipping a production env flag implies the feature is
   ready for users who know when to enable it. The current evidence does not meet
   that bar.

3. **Benchmark success was situational.** The custom-50 benchmark and fresh
   semidex-docs validation are useful, but they mostly validate semidex-like
   source-navigation. They do not validate entity extraction as a general RAG
   primitive.

4. **The implementation path should not be preserved.** Regex-token payloads and
   post-RRF overlap boosting are not the structural entity model semidex needs.
   Future work should be specified separately, for example through skeleton-first
   chunking, rather than extending this experiment.

## Current Status

Verdict: `ENTITY_BOOST_REMOVED`

Entity boost was a failed production rollout attempt. It is not available as a
runtime feature, benchmark command, or backfill path.

## Future Work Boundary

Do not reintroduce this mechanism as a shortcut. Any future entity work should
start from a separate design, with structural document objects and benchmark
coverage before implementation.

## Consequences

- Production MCP behavior is simpler: no hidden entity rerank path.
- New indexes do not write `entities` payloads or `doc_role`.
- Existing old collections may still contain stale `entities` metadata, but
  semidex no longer reads or maintains it.
- Documentation must not present entity boost as an available agent, benchmark,
  or production workflow.

## Evidence

- `benchmarks/retrieval/results/2026-05-27T2000-entity-boost-benchmark.md` -
  positive custom-50 source-navigation result; now classified as situational.
- `benchmarks/retrieval/results/2026-05-27T1422-entity-boost-live-optin-validation-refresh.md` -
  positive semidex-docs result; now classified as semidex-like technical evidence.
- `benchmarks/retrieval/results/2026-05-27T1619-entity-boost-private-linux-hard-technical-validation.md` -
  hard technical validation showing the current extractor produces no useful
  boost-relevant entities for a Linux/systemd corpus.
