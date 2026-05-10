# custom-large: Large-Document Stress Benchmark

## Purpose

custom-large is the third benchmark tier in semidex, focused on chunking quality and retrieval behavior on **large, structured documents**. It complements the existing tiers:

| Tier | Collection | Focus |
| :--- | :--- | :--- |
| Regression (`run.js`) | `bench-retrieval` | File-level recall, fast, run before merges |
| Quality (`custom-50/run-v3.js`) | `bench-retrieval-custom-50` | Chunk-level graded recall on short controlled docs |
| Stress (`custom-large/run.js`) | `bench-retrieval-custom-large` | Chunking quality on large structured documents |

custom-50 reveals boundary effects on short, well-structured docs. custom-large stress-tests chunking on documents that are more representative of real technical corpora: long API references, configuration manuals, migration guides, multilingual workflows, and operational runbooks.

## Fixture Documents

| File | Type | Anchors |
| :--- | :--- | :--- |
| `api-reference-large.md` | API reference with endpoints, request/response, error schema | 12 |
| `configuration-manual.md` | Configuration manual with env vars, provider settings, mixed-language section | 12 |
| `migration-guide-v1-v2.md` | Step-by-step migration guide with numbered procedure | 12 |
| `mixed-language-agent-guide.md` | Agent workflow guide with Ukrainian/English content | 12 |
| `troubleshooting-runbook.md` | Operational runbook with diagnosis steps and checklists | 12 |

Total: 60 anchors across 5 documents.

## Anchor-Based Qrels

Each fixture document contains `[[BENCH_ANCHOR: NAME]]` markers embedded in its source text. After indexing, `run.js` scans all chunk texts to build an **anchor→chunkId map** at runtime. `queries.json` references anchors by name via `expectedAnchors`; the runner resolves them to actual `source_file#chunk_index` IDs before evaluating.

This means:
- No chunk indices are hardcoded in `queries.json`.
- Qrels stay valid across chunking parameter changes — the anchor moves with the content.
- The runner fails loudly if an anchor is missing from all indexed chunks.

## Query Schema (schemaVersion: 4)

```json
{
  "id": "lg-api-search-request",
  "type": "exact-token",
  "query": "POST /v1/search request body tag_filter source_file",
  "expectedAnchors": [
    { "anchor": "API_SEARCH_REQUEST", "relevance": 3 },
    { "anchor": "API_FILTER_TAGS",    "relevance": 2 }
  ],
  "expectedTokens": ["POST /v1/search", "tag_filter"]
}
```

Query types covered:

| Type | Count |
| :--- | :--- |
| exact-token | 25 |
| paraphrase | 18 |
| mixed-lang | 2 |
| negative | 1 |

## Running

```bash
# Full run (indexes + queries)
npm run bench:custom-large

# Skip reindexing, reuse existing collection
BENCH_SKIP_INDEX=1 npm run bench:custom-large

# Use ONNX provider (recommended for consistent results)
ONNX_EMBED=1 npm run bench:custom-large

# Wider search depth
BENCH_TOP_K=20 npm run bench:custom-large
```

## Metrics

### Retrieval Metrics

| Metric | Meaning |
| :--- | :--- |
| `chunkRecall@3/5/10` | Exact answer chunk (rel>=3) in top-3/5/10 |
| `windowRecall@5/10` | Exact chunk or +-1 neighbor in top-5/10 |
| `supportRecall@K` | Supporting chunk (rel>=2) in top-K |
| `nDCG@5/10 (graded)` | Gain = 2^relevance - 1, normalised |
| `MRR@10` | Reciprocal rank of first rel>=3 chunk |
| `negativePassRate` | Negative queries with no strong hit in top-1 |
| `p50/p95 latency` | Query latency percentiles |

### Chunking Guardrails

Reported after every run. Do not fail the benchmark; they inform whether the fixture docs are chunked well.

| Guardrail | Meaning |
| :--- | :--- |
| `zeroChunkFiles` | Files that produced 0 chunks — indicates a parsing failure |
| `anchorCoverage` | Fraction of queried anchors found in indexed chunks — should be 100% |
| `missingAnchors` | Anchor names not found in any chunk — fail-fast for qrels |
| `duplicateAnchors` | Anchors found in more than one chunk — indicates text duplication |
| `oversizedChunkCount` | Chunks exceeding `BENCH_OVERSIZED_CHUNK_TOKENS` threshold (default: 400 approx tokens) |
| `maxChunkTokensObserved` | Largest chunk seen — indicates flat sections with no sub-headings |
| `sectionlessRate` | Fraction of chunks with no section heading — signals unheaded prefaces |
| `anchorsPerChunk p50/p95` | Distribution of anchor count per chunk |

## Relevance Scale

| Score | Meaning |
| :--- | :--- |
| 3 | Exact answer — chunk directly answers the query |
| 2 | Supporting context — useful neighboring or related chunk |
| 1 | Same-topic, not sufficient alone |

## Results

Saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom-large.txt` after each run.

## Design Notes

**Why synthetic fixture docs?** Real technical corpora cannot be committed to the repository. The fixture docs use a neutral synthetic corpus (semidex-compatible terminology) that exercises the same chunking failure modes as real large technical documents: flat sections without sub-headings, interleaved code+prose, step-based procedures, multilingual content.

**Why anchor-based qrels?** Hardcoded chunk indices break whenever `MIN_CHUNK_TOKENS` or `MAX_CHUNK_TOKENS` changes. Anchors survive chunking parameter tuning and make the benchmark self-describing: the anchor name tells you which concept is being evaluated.

**Scope:** This benchmark does not cover unstructured blobs without headings or paragraphs. That scenario is reserved for a future raw/messy benchmark tier.
