# BGE-M3 Token Count Production Default

**Date:** 2026-05-30
**Verdict:** `BGE_M3_TOKEN_COUNT_DEFAULT_ACCEPT`

## Decision

Production indexing now uses the real BGE-M3 tokenizer for chunk boundaries by
default. `TOKEN_COUNT=heuristic` is an explicit compatibility/offline opt-out
that restores the old `Math.ceil(text.length / 4)` approximation.

Benchmark qrels based on positional `chunk_index` may need regeneration after a
reindex. This is expected and does not block the production correctness fix.

## Implementation

- `src/core/token-count.js`
  - loads tokenizer files only; no ONNX inference session is created;
  - downloads tokenizer files on first use when cache is absent;
  - caches token counts with bounded memory;
  - exports `CHUNKING_SCHEMA_VERSION=1` and validates `TOKEN_COUNT`.
- `src/indexer/phases/chunk.js`
  - production `chunkFileFromPath()` uses the async BGE-M3 tokenizer path by default;
  - legacy synchronous `chunkFile()` remains heuristic for benchmark callers that
    have not migrated yet.
- `src/indexer/index.js`
  - stores `chunking_schema_version` and `token_count_mode` in every point payload;
  - compares them in the unchanged-file skip guard;
  - preloads the tokenizer before destructive pre-delete work.
- `src/core/qdrant.js`
  - treats the new payload fields as semidex discriminator metadata.

## Offline Comparison

Reproduce with:

```bash
node benchmarks/retrieval/token-count-default-comparison.js
```

The script uses public repository data only and does not touch Qdrant.
Measurements below use a warm tokenizer cache.

| Corpus | Mode | Chunks | Avg real tokens | Max real tokens | >400 | >512 | Chunking time |
|--------|------|--------|-----------------|-----------------|------|------|---------------|
| Ukrainian synthetic fixture | heuristic | 12 | 142.8 | 364 | 0 | 0 | <1 ms |
| Ukrainian synthetic fixture | BGE-M3 default | 12 | 142.8 | 364 | 0 | 0 | 63 ms |
| `docs/en/` (13 files) | heuristic | 293 | 243.5 | 644 | 66 | 30 | 5 ms |
| `docs/en/` (13 files) | BGE-M3 default | 342 | 208.6 | 396 | 0 | 0 | 4655 ms |

The synthetic fixture does not cross a split boundary, so both modes produce the
same chunks. The mixed Markdown documentation corpus demonstrates the real issue:
the heuristic leaves 30 chunks above 512 real BGE-M3 tokens, while tokenizer-aware
chunking leaves none.

## Performance Note

Real tokenization is materially slower than `chars/4`, but bounded memoization
reduced the `docs/en/` tokenizer-aware pass from about 10.9 seconds to about
4.5-4.7 seconds without changing boundaries. In normal indexing this cost is paid
before the substantially more expensive embedding and LLM phases.

## Verification

```text
npm run smoke
Smoke tests: 695 passed, 0 failed
```

A destructive Qdrant live indexing run was not needed for this decision.
