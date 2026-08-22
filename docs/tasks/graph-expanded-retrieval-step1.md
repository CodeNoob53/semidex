# Task: opt-in bounded graph-expanded retrieval, Step 1

Implement the first iteration described in
`docs/design/graph-expanded-retrieval.md`.

## Required approach

Start by auditing the current search, storage adapter, Qdrant store, settings,
Ask evidence, MCP search, and benchmark/test conventions. Treat the design as
the behavioral contract, but adapt file placement and naming to established
repository patterns. Do not copy `htrag` code or add it as a dependency.

Implement an opt-in, depth-1 structural expansion lane after the existing
dense+sparse RRF seed search. It must resolve only authoritative structural
relations already present in Semidex payloads and must return only real
retrieval-content points.

## Scope

1. Add a provider-neutral graph expansion coordinator in core retrieval.
2. Add the narrow optional storage-adapter capability and its Qdrant
   implementation using bounded indexed lookups. No exhaustive collection
   scan is permitted.
3. Add typed settings through the existing registry/service and Lite policy.
   The feature is disabled by default. Add Admin UI controls only if this is
   the existing convention for retrieval settings; do not hand-build a new UI
   section.
4. Wire expansion into the shared retrieval path so Admin search, Ask, and MCP
   cannot drift. Client and Qdrant Cloud embedding branches must remain
   unchanged.
5. Preserve deterministic provenance internally and expose it only where
   existing contracts permit additive diagnostic metadata.
6. Add focused unit/architecture tests and a deterministic fixture/evaluation
   proving recovery of graph-related evidence that seed retrieval missed.
7. Write a concise implementation/benchmark report with actual measurements.

## Mandatory constraints

- Do not alter the default production ranking or enable the feature by
  default.
- Do not use skeleton summaries as evidence.
- Do not implement LLM relation extraction, PageRank, learned edges, recency,
  or multi-hop depth greater than one.
- Do not use absolute RRF score thresholds.
- Do not introduce a graph database or a new runtime dependency.
- Do not weaken collection/source/tag filters.
- Do not commit changes.
- Work with the current clean worktree and do not revert unrelated user work
  if it appears during the task.

## Verification

Run focused tests while developing, then:

- `npm test`
- `npm run smoke`
- `npm run admin:build`
- the Lite Admin build if it is a separate command
- `git diff --check`

If a live Qdrant smoke would modify data, use a uniquely named disposable
collection, request confirmation before running it, and delete only that exact
collection. A deterministic offline fixture is required regardless of whether
live smoke is run.

Report changed files, architecture decisions, feature-off compatibility,
fixture/benchmark numbers, verification results, known limitations, and the
next smallest follow-up.
