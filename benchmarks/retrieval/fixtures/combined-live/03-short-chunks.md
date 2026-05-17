# Edge Cases

## Very Short Section

Hi.

## Empty-ish Section

(placeholder)

## Normal Section After Short Ones

This section contains meaningful content that should produce a full context and tag set. The indexer uses `COMBINED_MIN_CHARS=80` as the threshold below which a chunk skips the combined LLM call and falls back to the separate context and tag path using `CONTEXT_MODEL`.

Short chunks like the ones above are expected to trigger the fallback path. The fallback calls `addContext` then `addTagsWithModel` with the same `CONTEXT_MODEL`, so no `TAG_MODEL` dependency is introduced.

## Another Normal Chunk

Retrieval quality depends on the embedding of `context + "\n\n" + text`. The context summary written by the LLM is the primary semantic anchor for the embedding. Tags are stored in payload and used for tag-filter queries but do not affect the default hybrid RRF ranking.

When tags are missing or low quality, `qdrant_find_by_tag` will return fewer results, but `qdrant_search` is unaffected. This is the main reason tags are considered a secondary signal in the current architecture.
