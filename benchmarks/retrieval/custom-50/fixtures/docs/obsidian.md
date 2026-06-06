# File and Directory Navigation

semidex indexes files into Qdrant and exposes tools for navigating the indexed
corpus without issuing a semantic query. The primary tools are `qdrant_list_files`
and `qdrant_list_directories`.

## qdrant_list_directories

`qdrant_list_directories` returns the distinct top-level directory paths present
in a collection. It uses a scroll over the `source_file` payload field to derive
the prefix set. No arguments are required beyond the collection name.

```bash
# Example MCP call
qdrant_list_directories(collection="my-notes")
# Returns: ["docs/", "src/", "notes/", ...]
```

This is the recommended first step when the agent does not know the corpus layout.

## qdrant_list_files

`qdrant_list_files` returns all `source_file` values in a collection, optionally
filtered to a directory prefix. Results are returned in alphabetical order.

```bash
# List all files
qdrant_list_files(collection="my-notes")

# Scope to a subdirectory
qdrant_list_files(collection="my-notes", directory="docs/")
```

Use `qdrant_list_files` when you need to enumerate files before calling
`qdrant_get_chunk` or when checking whether a specific document is indexed.

## Payload Fields Used for Navigation

| Field | Type | Description |
|-------|------|-------------|
| `source_file` | string | Stable file identifier relative to `SOURCE_ROOT` |
| `chunk_index` | integer | Zero-based position within the source file |
| `section` | string | Markdown heading of the containing section |
| `total_chunks` | integer | Total chunk count for this source file |
| `tags` | string[] | LLM-generated topic tags |

`source_file` and `tags` are payload-indexed for efficient filtering. They are
created automatically by `npm run index` for new collections.

## Combining Navigation with Search

The typical agent workflow combines navigation and search:

1. `qdrant_collection_info` — discover available collections.
2. `qdrant_list_directories` — map the corpus layout.
3. `qdrant_search(source_file=...)` — scope search to a known file.
4. `qdrant_get_chunk(window=1)` — expand context around a result.

Use `source_file` from search results as a direct input to `qdrant_list_files`
to find neighboring documents in the same directory.

## Use Cases

- Listing all indexed documents before a benchmark run to verify coverage.
- Auditing LLM-generated tags for a collection with `qdrant_find_by_tag`.
- Scoping a search to a known subdirectory using the `source_file` filter.
- Confirming that a specific file was indexed after running `npm run index`.
- Navigating the directory structure of a large documentation corpus.
