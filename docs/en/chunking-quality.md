# Chunking Quality

Chunking is not a pre-processing step. It is a retrieval-grade concern: the
boundaries and content of each chunk determine whether an AI agent can find,
read, and correctly use an answer. A perfect embedding model cannot recover an
answer that was split across two chunks, diluted by unrelated content, or indexed
as a heading-only stub.

## Role of Chunking in Retrieval Quality

semidex indexes chunks, not documents. At query time, the agent retrieves a small
number of chunks — typically top-5 or top-10 — and uses them directly as context.
This means the chunk is the unit of retrieval success.

Three things must be true for a chunk to be useful:

1. **It contains the answer**, or enough context to reach it via `qdrant_get_chunk(window=1)`.
2. **It does not contain unrelated content** that dilutes the signal or confuses the model.
3. **Its boundaries are predictable enough** that `window=N` expansion reliably
   recovers the neighboring chunk when the exact answer sits at a boundary.

These properties are not guaranteed by token-count splits alone. They require
structure-aware splitting with explicit guarantees about section boundaries,
overlap handling, and edge cases.

## Current Chunking Guarantees

semidex `chunkFile()` provides the following guarantees for Markdown input:

### Section-aware splitting

Chunks do not span Markdown section boundaries (headings). Each headed section
is kept as its own chunk regardless of size. An unheaded preface at the start
of a file that falls below `MIN_CHUNK_TOKENS` may be omitted, but headed
sections are never merged across heading boundaries.

### No overlap leakage across sections

Token-budgeted overlap (`CHUNK_OVERLAP_TOKENS=80` default) carries forward
contextual continuity within a section only. The overlap is a suffix of the
previous chunk's body, re-selected to fit inside the remaining token budget
(`MAX_CHUNK_TOKENS - bodyTokens`). The overlap itself never pushes a chunk over
`MAX_CHUNK_TOKENS`; normal splittable content stays within the limit. Unsplittable
blocks — dense checklists, code blocks, or tables with no sentence boundaries —
may still exceed `MAX_CHUNK_TOKENS` and are a known limitation until structural
chunking handles those block types. Overlap does not copy content from one heading
section into the next, preventing a chunk from appearing to cover a topic it does
not actually address. When `CHUNK_OVERLAP_TOKENS=0`, the legacy sentence-based
overlap (`OVERLAP_SENTENCES`) is used instead.

### Final chunk preservation

The final chunk of a file is never dropped due to being below `MIN_CHUNK_TOKENS`.
This prevents the last section of a document — often a conclusion, summary, or
configuration reference — from being silently lost.

### Deterministic short-fragment merge

When token splitting creates a fragment below `MIN_CHUNK_TOKENS`, semidex merges
that fragment with an adjacent chunk in the same section before overlap is added.
This removes the former LLM merge/split decision from the production indexing
path while keeping short tails from becoming weak standalone chunks.

### Stable `chunk_index` / `total_chunks`

Every chunk carries a zero-based `chunk_index` and a `total_chunks` field in its
Qdrant payload. These are stable across re-indexing of the same file if the
content is unchanged, making `qdrant_get_chunk(window=N)` deterministic.

### Window recovery through `qdrant_get_chunk`

The MCP `qdrant_get_chunk` tool accepts a `window` parameter. It fetches the
requested chunk and its `±window` neighbors by `chunk_index` within the same
`source_file`. The `windowRecall@K` benchmark metric measures how often the
correct answer is reachable via window expansion even when `chunkRecall@K` misses —
the gap between these two metrics quantifies chunk-boundary effects vs. true
ranking failures.

## Failure Modes

The following failure modes have been observed or are structurally possible
in the current chunking implementation.

### Answer split across chunks

A long technical explanation spans a section boundary. Half is in chunk N, half
in chunk N+1. Neither chunk alone is sufficient. `chunkRecall@K` fails; only
`windowRecall@K` can recover via `±1` expansion.

**Detection:** `windowRecall@K − chunkRecall@K` gap in the benchmark. A wide gap
on specific query types (paraphrase, multi-step) suggests boundary effects.

### Unrelated topics merged inside one large section

A large flat section may contain multiple unrelated topics with no headings.
Token-based splitting and short-fragment merging can still place neighboring
subtopics in the same chunk when the source document lacks structural boundaries.

**Detection:** high `duplicateSourceRate` on queries where only one subtopic is relevant.

### Chunk too small to be useful

A heading-only section, a single-sentence note, or an `(empty section: …)`
placeholder produces a chunk that carries no answer content. It may still rank
highly due to lexical overlap with the query.

**Detection:** The custom-50 benchmark flags empty-text or heading-only expected
chunks (logged as `emptyChunkIds`) and warns when a qrel chunk ID resolves to
one. Production indexing does not apply this guardrail.

### Chunk too large and noisy

A section with no sub-headings spans many topics. The resulting chunk is long
enough that the relevant answer is diluted by surrounding content, hurting both
dense embedding quality and reranker signal.

**Detection:** high `total_chunks` per file combined with low per-chunk
`chunkRecall` on specific queries; tunable via `MAX_CHUNK_TOKENS`.

### Code block separated from explanation

A code example and its preceding or following prose explanation fall into
different chunks due to a section boundary or token limit. The agent retrieves
the code without context, or the explanation without the example.

**Detection:** a future `codeExplanationPairRate` metric on fixture files with paired code+explanation blocks.

### Heading-only or overlap-only chunks

A chunk contains only a Markdown heading line, or consists entirely of overlap
sentences copied from the previous chunk with no new content. Neither is useful
as a standalone retrieval unit.

**Detection:** empty-text guardrail catches heading-only cases. Overlap-only
chunks are structurally prevented by the no-overlap-leakage-across-sections
guarantee, but can occur within a long single section.

## Proposed Quality Metrics

These metrics are not yet computed by the benchmark pipeline. They are defined
here as targets for a future chunk-quality evaluation pass.

| Metric | Definition |
|--------|------------|
| `selfContainedChunkRate` | Fraction of rel≥3 chunks that alone contain enough context for an agent to answer the query without window expansion |
| `boundaryErrorRate` | Fraction of benchmark misses attributable to chunk-boundary placement rather than embedding or ranking failure (`windowRecall@1 − chunkRecall@1` as a proxy) |
| `windowRecoveryRate` | Fraction of misses recovered by `qdrant_get_chunk(window=1)` (already measured as `windowRecall@K − chunkRecall@K`) |
| `answerSplitRate` | Fraction of queries where the exact answer spans two adjacent chunks (measured on large-doc fixtures with annotated answer spans) |
| `codeExplanationPairRate` | Fraction of code+explanation pairs in fixture docs that are co-located in the same chunk or in adjacent chunks |

`windowRecoveryRate` is the only metric currently computed end-to-end (as
`windowRecall@K`). The others require either annotated answer spans or fixture
documents with explicit code+explanation pair qrels.

## Connection to Custom-50 and Future Large-Doc Benchmark

The custom-50 quality benchmark evaluates chunk-level retrieval on 10 fixture
documents (4 shared, 6 extended) covering semidex's own documentation. It measures
chunk recall, window recall, graded nDCG, and MRR at multiple depths.

Custom-50 reveals boundary effects and merge failures on short, well-structured
docs. It does not stress-test chunking under conditions that are common in real
technical corpora:

- long files with many sections (>30)
- large flat sections without sub-headings
- files mixing prose, code blocks, and config tables
- files with dense cross-references between sections
- non-English or mixed-language technical content

### Planned large-document stress benchmark

The next benchmarking phase will add fixture documents that stress chunking
beyond what custom-50 covers. Candidate fixture types:

| Fixture type | What it tests |
|--------------|---------------|
| Long API reference (>500 lines) | Final-chunk preservation, large-section splitting |
| Config reference with many small sections | Merge policy, heading-only chunk prevention |
| Tutorial with interleaved code+prose | Code/explanation co-location |
| Migration guide with numbered steps | Step boundary respect, no step-merging |
| Multilingual mixed doc | Section-boundary behavior across Unicode heading levels |

Qrel annotation for these fixtures will use the same v3 schema as custom-50:
`relevantChunks` with `relevance: 1|2|3` and `chunkId: "file.md#N"`.

The primary evaluation signal will remain `chunkRecall@5` and `windowRecall@5`.
New metrics (`answerSplitRate`, `codeExplanationPairRate`) will be introduced
only after fixture annotation is complete and at least one benchmark run has been
committed to `benchmarks/retrieval/results/`.

### When to act on chunking quality findings

Do not change chunking parameters based on a single diagnostic run. The threshold
sweep and failure analysis tools exist to build evidence across runs. A chunking
change is ready to promote when:

1. A failure mode is reproducible across at least two benchmark runs.
2. A proposed fix improves `chunkRecall@5` or `windowRecall@5` without regressing
   the other.
3. The `npm run smoke` suite passes with the new parameters.
4. The 21-query regression benchmark shows no regressions.

## Skeleton-first Chunking and Structural Carryover

Skeleton-first chunking (`SKELETON_CHUNKING=1`) is the main semidex indexing
direction. Legacy chunking remains supported as a compatibility/fallback path.

### Structural nodes: raw content preserved, context enriched

Tables, code blocks, and checklists are indexed as individual structural chunks
(`point_kind = retrieval_content`, `node_type = table / code_block / checklist`).
Their `text` and `raw_content` fields always contain the unmodified source content.

Each structural chunk's `context` field — which becomes part of the embedding
input alongside `text` — includes a short excerpt of the nearby prose from the
same section. This is **deterministic structural carryover**:

```
<heading path> — <node type> — <cleaned nearby prose excerpt>
```

The prose excerpt is taken from the prose run that immediately precedes the
structural node in the same section (or from the last emitted prose chunk in the
section if no active run is present). Placeholder lines
(`[code block node: ...]`, `[table node: ...]`) are stripped from the excerpt.
The excerpt is capped at `SKELETON_CARRYOVER_CHARS` characters (default: 500,
max: 2000). Invalid or missing env values fall back to the default silently.

This does not add LLM calls. No LLM-generated summary is created per structural
node unless `SKELETON_CONTEXT=llm` is explicitly set.

### Why carryover matters

Structural nodes — especially short tables and brief code blocks — have limited
semantic content on their own. Without the surrounding prose explanation, a
natural-language query ("which table tracks completion status?") may not retrieve
the table directly. Carryover embeds the prose context that a human reader would
use to understand what the structure means.

Synthetic smoke evidence (`57-skeleton-carryover.js`) confirms that placeholder
lines are stripped and prose is carried across entity boundaries without crossing
section headings. Production retrieval impact (NL structural recall before/after)
is pending reindex validation of a private skeleton collection.

### Heading boundary rule

Carryover never crosses a section boundary. A structural node at the start of a
new section inherits no prose from the previous section.
