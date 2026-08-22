# Graph-expanded retrieval

Status: experimental design for an opt-in retrieval lane.

## Problem

Semidex currently uses Qdrant dense+sparse retrieval with server-side RRF to
find retrieval-content points. For skeleton-aware collections, a hit can then
be assembled into bounded section context. This preserves coherent evidence,
but retrieval itself does not use the document graph: a relevant sibling or
adjacent structural node must first be returned by vector search.

The proposed lane adds bounded structural expansion after hybrid retrieval.
It is inspired by hypertext/graph RAG systems, but is implemented on top of
Semidex's existing `skeleton_nav` model and storage adapter contract.

## Goals

- Improve recall when evidence is split across related nodes or sections.
- Preserve the current hybrid search as the seed retriever and ranking anchor.
- Return only real retrieval-content points as evidence.
- Preserve provenance from a seed hit to every expanded candidate.
- Keep the feature disabled by default and measurable independently.
- Work for client and Qdrant Cloud embedding profiles without changing their
  embedding paths.

## Non-goals for the first iteration

- LLM-extracted semantic relations or entity graphs.
- Learning edge weights from usage.
- PageRank, recency scoring, or a copied fixed-weight formula from another
  project.
- A second graph database or a new dependency.
- Treating skeleton summaries as answer evidence.
- Replacing dense+sparse RRF.
- Expanding legacy collections that have no skeleton node identity.

## Retrieval flow

1. Run the existing `runHybridSearch()` path unchanged and request a bounded
   seed pool.
2. If graph expansion is disabled, return the byte-for-byte compatible result.
3. For each skeleton-aware seed, resolve bounded structural neighbors through
   the storage adapter. The first implementation supports only relations that
   are already authoritative in the index:
   - the seed's containing section;
   - retrieval-content siblings under that section;
   - optionally the immediately previous and next content node when their
     order is known and they remain in the same file.
4. Never return `skeleton_nav` points. Navigation nodes may be traversed only
   to resolve real content descendants.
5. Deduplicate candidates by `nodeId`, falling back to
   `sourceFile + chunkIndex` only for real content points without node identity.
6. Rank with deterministic rank-derived signals, not absolute RRF values:
   - seed candidates retain seed order;
   - expanded candidates inherit their best seed rank;
   - shallower paths precede deeper paths;
   - stable document order breaks remaining ties.
7. Apply hard limits before any storage expansion and after deduplication.

**Known ranking-order tradeoff (unresolved by design, not by omission).**
Because a seed's own graph candidates are grouped immediately after that
seed (step 6), and the merged seed+graph list is then sliced to the
caller's final `top`, a graph neighbor of a HIGHER-ranked seed can occupy a
result slot that a LOWER-ranked direct seed would otherwise have held —
e.g. with `top=3`: seed rank 0, its graph neighbor, seed rank 1 fills the
three slots, and seed rank 2 (a real, directly-retrieved hybrid-search hit)
is displaced entirely. This is an intentional, currently-unaddressed
consequence of "expanded candidates inherit their best seed rank" plus
"seed's own expanded candidates are emitted immediately after it," not a
bug — the alternative (ranking every graph candidate strictly after every
seed) was rejected for the first iteration as an equally arbitrary policy
choice with no evidence behind it either. Whether this displacement
behavior is acceptable, should be capped (e.g. graph candidates never
displace a seed within the final `top`), or should be reordered entirely is
explicitly left to the evaluation gate's benchmark (item 7) — a production
default must not treat either policy as already validated.

## Initial public configuration

The exact setting names should follow the repository's typed settings
registry, but the contract is:

- enabled: boolean, default false;
- seed limit: bounded integer;
- maximum expanded candidates per seed: bounded integer;
- maximum depth: fixed at 1 in the first implementation;
- final result limit remains the caller's existing `top`.

Lite and Full must expose identical semantics. Environment, settings file, and
Admin UI handling must use the existing settings system rather than direct
module-level environment reads.

## Storage boundary

Core retrieval must not import Qdrant implementation modules. Add a narrow,
optional storage capability that accepts content identities and limits and
returns normalized retrieval-content candidates with relation metadata.
Qdrant-specific scroll/filter/batch behavior remains in the Qdrant
adapter/store.

An adapter that does not support structural expansion returns an unsupported
result or an empty expansion according to the established adapter convention;
it must not break ordinary hybrid retrieval.

## Provenance

Internally every candidate must carry:

- `retrievalOrigin`: `seed` or `graph`;
- originating seed identity/rank;
- relation sequence;
- graph depth.

These fields are diagnostic metadata. Do not change the stable Ask v1/v2 wire
contracts in the first iteration unless an additive field is already allowed
by their contract. Benchmark telemetry may record aggregate seed/expanded/
deduplicated counts, never document text.

## Safety and correctness invariants

- `skeleton_nav` is navigation-only and never evidence.
- Collection, source-file, and caller filters apply to expanded candidates.
- Expansion is bounded before I/O; no exhaustive collection scans.
- No cross-collection edges.
- Missing/broken graph identity degrades to seed-only retrieval.
- Feature-off behavior is unchanged.
- Do not compare absolute RRF scores as confidence.

## Evaluation gate

Implementation is acceptable only when all of the following are demonstrated:

1. Existing retrieval, Ask, MCP, smoke, and build tests pass.
2. Feature-off characterization proves unchanged calls and ordering.
3. A deterministic structural fixture proves that a relevant content node
   absent from the seed pool is recovered through a real graph edge.
4. Filters and hard limits cannot be bypassed by expansion.
5. Navigation nodes never appear in returned hits or Ask evidence.
6. Legacy/no-skeleton collections fall back without error.
7. A small benchmark report compares seed-only and expanded recall, candidate
   count, storage calls, and latency. No production default is changed unless
   the benchmark shows a useful gain without unacceptable regressions.

## Follow-up candidates

Only after the structural lane is measured:

- explicit document links resolved to stable node identities;
- typed semantic relations with confidence and source provenance;
- graph-aware reranking learned or tuned from external benchmarks;
- user-visible provenance paths;
- multi-hop depth greater than one.

