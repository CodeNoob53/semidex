# ADR 0005: Entity Boost Deferred After Scope Validation

Status: Deferred

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

Entity boost is removed from production MCP search.

- `qdrant_search` no longer reads or applies `ENTITY_BOOST_ENABLED`,
  `ENTITY_BOOST_WEIGHT`, or `ENTITY_BOOST_PREFETCH`.
- The default production search path remains hybrid dense+sparse RRF, with the
  existing `RERANK_ENABLED=1` path as the only optional production rerank stage.
- Entity payload extraction, payload indexes, backfill tooling, and
  `bench:custom50:entity-boost` remain as experimental infrastructure for
  future entity-layer work.
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

4. **The underlying idea is still worth preserving.** Payload entities and
   overlap-based reranking remain promising, but they need a neutral/entity-profile
   extraction layer and broader validation before production exposure.

## Current Status

Verdict: `ENTITY_BOOST_DEFERRED_SITUATIONAL`

Entity boost is a failed production rollout attempt, not a failed research
direction. It should be treated as a benchmark-only experiment until the entity
creation layer is redesigned and validated.

## Future Acceptance Criteria

Reconsider production exposure only after all of the following are true:

1. A neutral entity extractor exists and is documented.
2. Optional domain profiles are explicit and named, for example:
   `neutral`, `code-docs`, `linux-devops`, `api-docs`.
3. Entity extraction is validated on at least:
   - semidex/code documentation
   - Linux/devops technical documentation
   - one prose-heavy or non-code corpus
4. Benchmarks show no new hard regressions vs hybrid RRF.
5. Reports clearly separate:
   - entity creation quality
   - boost/rerank quality
   - retrieval quality without entity boost

## Consequences

- Production MCP behavior is simpler and safer: no hidden entity rerank path.
- Existing indexed `entities` payloads are harmless metadata and may be reused by
  future experiments.
- `backfill:entities` remains available for diagnostics, but should not be
  presented as a production quality improvement path.
- Documentation must describe entity boost as deferred/benchmark-only, not as an
  accepted opt-in feature.

## Evidence

- `benchmarks/retrieval/results/2026-05-27T2000-entity-boost-benchmark.md` -
  positive custom-50 source-navigation result; now classified as situational.
- `benchmarks/retrieval/results/2026-05-27T1422-entity-boost-live-optin-validation-refresh.md` -
  positive semidex-docs result; now classified as semidex-like technical evidence.
- `benchmarks/retrieval/results/2026-05-27T1619-entity-boost-private-linux-hard-technical-validation.md` -
  hard technical validation showing the current extractor produces no useful
  boost-relevant entities for a Linux/systemd corpus.
