# Obsidian Review Output

semidex can export indexed chunks as Obsidian-compatible Markdown files for
human review. This output is written to a directory controlled by `CHUNKS_OUT_DIR`
(default: `./chunks_out`).

## What the Output Contains

Each exported file corresponds to one chunk. The filename is derived from
`source_file` and `chunk_index`, for example:

```
chunks_out/
  my-doc.md#0.md
  my-doc.md#1.md
  my-doc.md#2.md
```

Each file contains:

- The chunk text as the body.
- YAML frontmatter with metadata: `source_file`, `chunk_index`, `section`,
  `total_chunks`, `dense_provider`, `sparse_provider`, `tags`, `links`.
- Wikilink-style cross-references to semantically related chunks, based on
  the linking phase output.

## CHUNKS_OUT_DIR

Set `CHUNKS_OUT_DIR` to control the output path:

```bash
CHUNKS_OUT_DIR=./review npm run index
```

If the directory does not exist, it is created automatically. Existing files
are overwritten on re-index. This directory is typically added to `.gitignore`.

## Wikilinks and Linking

During the linking phase, semidex computes top-N semantic neighbors for each chunk
using cosine similarity over dense vectors. These links are written to the Obsidian
output as `[[source_file#chunk_index]]` wikilinks, which Obsidian renders as a graph.

The number of links per chunk is controlled by `LINK_TOP` (default: 5). Only links
above the `LINK_MIN_SCORE` threshold (default: 0.75) are written. Cross-collection
linking can be restricted with `LINK_COLLECTIONS`.

## Frontmatter Fields

| Field | Source | Description |
|-------|--------|-------------|
| `source_file` | payload | Stable file identifier relative to `SOURCE_ROOT` |
| `chunk_index` | payload | Zero-based position within the source file |
| `section` | payload | Markdown heading of the containing section |
| `total_chunks` | payload | Total chunk count for this source file |
| `dense_provider` | payload | Provider used to generate the dense vector |
| `sparse_provider` | payload | Provider used to generate the sparse vector |
| `tags` | payload | LLM-generated topic tags |
| `links` | computed | Semantic neighbors sorted by score descending |

## Relationship to Qdrant Payload

The Obsidian output is derived from Qdrant payloads. It is a human-readable view
of what is stored in the vector database. If you re-index with a different provider,
re-run the export to keep the review files in sync with the live embeddings.

## Use Cases

- Reviewing chunking quality: check that section headings and overlap are correct.
- Auditing LLM-generated tags for a collection before relying on `qdrant_find_by_tag`.
- Navigating the semantic graph of a documentation corpus in Obsidian.
- Spotting missing or over-split chunks before querying via the MCP server.
