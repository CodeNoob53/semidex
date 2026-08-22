# Graph-expanded retrieval — live A/B benchmark

Implements `docs/tasks/graph-expanded-retrieval-live-benchmark.md` (evaluation
gate item 7 of `docs/design/graph-expanded-retrieval.md`): a reproducible,
disposable-collection A/B benchmark comparing hybrid retrieval with
`GRAPH_EXPANSION_ENABLED=false` (mode A) against `GRAPH_EXPANSION_ENABLED=true`
(mode B), against a small deterministic fixture with explicit, human-authored
relevance judgments.

## What this measures

For every query in `queries.json`, both modes run through the exact same
production entry point (`runHybridSearch()`,
`src/core/retrieval/search.js`) with the same collection, query text,
filters, `top`, and embedding profile — only the three `GRAPH_EXPANSION_*`
settings differ. The harness (`run-live.mjs`) captures ranked hit identities,
provenance (`retrievalOrigin`, seed rank, relation path, depth), latency
(median/p95 over repeated timed samples), and storage-call counts, then
scores both modes against `qrels.json` using `metrics.js`.

**This is a small, synthetic, hand-authored fixture (2 files, 8 chunks, 5
queries) designed to exercise specific structural relations deterministically
— section siblings, sequential prev/next chunks, filter compliance, a
negative query, and the design doc's documented ranking-order tradeoff. It
demonstrates mechanism correctness and measures real overhead on THIS
fixture. It is not a general retrieval-quality benchmark — a larger external
benchmark corpus (e.g. `benchmarks/retrieval/`) is required before drawing
any general conclusion about production quality impact.**

## Fixture and qrels

`fixtures/docs/cache-tuning.md` and `fixtures/docs/index-lifecycle.md` are
indexed through the real skeleton-aware indexer (no synthetic payload
assembly). An offline dry run of `parseSkeleton()` + `chunkFromSkeleton()`
(no Qdrant) confirmed the exact `(sourceFile, chunkIndex, parent_id)` layout
`qrels.json` is authored against:

| sourceFile | chunkIndex | type | section | role |
|---|---|---|---|---|
| cache-tuning.md | 0 | paragraph | Warm-Up Sequencing | seed (q1) |
| cache-tuning.md | 1 | table | Warm-Up Sequencing | relevant section-sibling, weak lexical overlap (q1) |
| cache-tuning.md | 2 | paragraph | Warm-Up Sequencing | irrelevant section-sibling (q1, q4); also chunk_index-adjacent 'prev' neighbor of the q2 seed (q2) |
| cache-tuning.md | 3 | paragraph | Eviction Policy | seed (q2) |
| cache-tuning.md | 4 | paragraph | Purge Timing Details | relevant next-chunk, different section (q2) |
| index-lifecycle.md | 0 | paragraph | Snapshot Rotation Policy | unused filler |
| index-lifecycle.md | 1 | paragraph | Cold Start Warm-Up Interplay | irrelevant near-miss distractor (q1, q3 prev-neighbor, q4) |
| index-lifecycle.md | 2 | checklist | Backup Verification Checklist | seed (q3), no siblings |

`qrels.json` is explicit and human-authored from reading the fixture text —
never derived from a search result. Its own header comment records this.

Required-case coverage (`docs/tasks/graph-expanded-retrieval-live-benchmark.md`,
"Fixture and qrels"):

1. weak-overlap relevant section sibling → q1, `cache-tuning.md#1`
2. relevant prev/next chunk via sequential structure → q2, `cache-tuning.md#4`
3. irrelevant structural neighbor → q1, `cache-tuning.md#2`
4. already-correct seed set, expansion must not reduce relevance → q3
5. source-file-scoped query respecting filters → q4 (`filters.sourceFile: cache-tuning.md`)
6. negative query, no relevant content → q5
7. graph candidate of a higher-ranked seed potentially displacing a
   lower-ranked real seed → q1 is designed to make this plausible; the
   harness's `displacedSeeds()` detection in `metrics.js` is generic and
   checks every query, not just q1

## Metrics (`metrics.js`)

Pure, offline-testable functions (see
`tests/unit/benchmarks/graph-expand-retrieval-metrics.test.js`):
Recall@k, MRR, nDCG@k (binary relevance, `null`/"n/a" for a query with no
relevant items), `recoveredByGraph` (qrels-relevant keys in B's top-k but
absent from A's), `displacedSeeds` (real seed keys in A's top-k pushed out of
B's top-k by a graph-origin candidate), `filterViolations`,
`irrelevantSurfaced`, `latencyStats` (median/p95), `sameRankedKeys`
(determinism), `hasNoProvenanceFields` (feature-off byte-parity).

## Safety boundary

- Never reads, modifies, or deletes an existing collection.
- Creates exactly one disposable collection named `graph-expand-live-<8 hex
  chars>`; a name collision with a pre-existing collection is a hard failure,
  not a silent reuse.
- Deletes only that exact collection in a `finally` block, even on failure.
- Requires an explicit `CONFIRM_LIVE_GRAPH_BENCH=1` opt-in — refuses to make
  any Qdrant call otherwise.
- Never logs `QDRANT_KEY` or document text from any other collection.
- Not part of `npm test` or `npm run smoke`.

## Running it

Requires `QDRANT_URL` and `QDRANT_KEY` (`.env` or environment).

```sh
CONFIRM_LIVE_GRAPH_BENCH=1 npm run bench:graph-expand
# or directly:
CONFIRM_LIVE_GRAPH_BENCH=1 node benchmarks/graph-expand-retrieval/run-live.mjs
```

Writes `results/<timestamp>-live-raw.json` and
`results/<timestamp>-live-report.md`, and prints one final verdict line
(`GRAPH_EXPAND_LIVE_ACCEPT` / `_PARTIAL` / `_REJECT`).

## Known limitations

- "Candidates before dedup" is the sum of raw neighbor-array lengths
  `adapter.getStructuralNeighbors()` returns across all calls for a query;
  "candidates after dedup" is read off the FINAL hits array (already
  deduplicated AND already sliced to `top` by `runHybridSearch()`) — the
  harness does not independently call `expandSeedsWithGraph()` a second time
  to observe the deduplicated-but-not-yet-top-sliced intermediate set, since
  reconstructing that set's own inputs would require re-implementing
  `runHybridSearch()`'s execution-branch/seed-pool logic in the harness,
  which the task explicitly prohibits ("do not duplicate retrieval or
  graph-expansion logic in the harness").
- `graphOverheadMs` (median(B) − median(A) per query) is a whole-query
  latency delta, not an isolated internal timer around expansion alone —
  `runHybridSearch()` does not expose one.
- 5 queries over 2 files/8 chunks is a mechanism-correctness and
  cost-measurement fixture, not a statistically powered quality benchmark.
