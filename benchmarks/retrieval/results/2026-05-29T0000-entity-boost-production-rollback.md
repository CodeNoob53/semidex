# Entity Boost Production Rollback

**Date:** 2026-05-29T0000  
**Verdict:** `ENTITY_BOOST_DEFERRED_SITUATIONAL`

## Summary

Entity boost is removed from production MCP search. The custom-50 and semidex-docs
results showed a useful source-navigation effect on semidex-like technical
documentation, but a later hard-technical validation showed the current entity
extractor does not generalize: on a Linux/systemd corpus it created no useful
boost-relevant entities, making the rerank a no-op.

The issue is not the score formula itself. The blocker is entity creation.
Without reliable entity extraction, an overlap boost can only work on corpora
whose syntax matches the current extractor.

## Decision

- Remove the `ENTITY_BOOST_ENABLED` runtime branch from `qdrant_search`.
- Remove `ENTITY_BOOST_*` from production docs/env-variable tables.
- Keep `bench:custom50:entity-boost`, its local benchmark helper, entity payloads,
  and `backfill:entities` as benchmark/diagnostic infrastructure.
- Reclassify previous positive results as situational evidence.

## Evidence

| Report | Result | Current interpretation |
|--------|--------|------------------------|
| `2026-05-27T2000-entity-boost-benchmark.md` | custom-50 source-navigation improved | Useful but tuned to semidex-like fixture |
| `2026-05-27T1422-entity-boost-live-optin-validation-refresh.md` | semidex-docs improved/stable | Useful but still semidex-like technical docs |
| `2026-05-27T1619-entity-boost-private-linux-hard-technical-validation.md` | no useful entities extracted; all boosted results unchanged | Failed generalization test |

## Production Scope After Rollback

`qdrant_search` uses:

- hybrid dense+sparse RRF by default
- optional reranker only when `RERANK_ENABLED=1`

`ENTITY_BOOST_ENABLED`, `ENTITY_BOOST_WEIGHT`, and `ENTITY_BOOST_PREFETCH` are no
longer supported production controls.

## Future Work

Before entity reranking can return to production, semidex needs a proper entity
creation layer:

- neutral extractor baseline
- explicit domain profiles, for example `code-docs`, `linux-devops`, `api-docs`
- validation that separates entity extraction quality from rerank quality
- tests on non-semidex corpora before production exposure
