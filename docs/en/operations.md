# Operations

## Indexing

Index one file:

```bash
COLLECTION=my-docs npm run index path/to/document.md
```

Index a folder:

```bash
COLLECTION=my-docs npm run index path/to/docs/
```

Re-run after edits:

```bash
COLLECTION=my-docs npm run index path/to/docs/
```

Unchanged files are skipped by file hash and provider metadata checks.

## Stable Source IDs

Use `SOURCE_ROOT` when indexing subfolders from a larger vault:

```bash
SOURCE_ROOT=/path/to/vault COLLECTION=my-docs npm run index /path/to/vault/docs/
```

This keeps `source_file` IDs stable regardless of which subfolder is passed to the indexer.

Files outside `SOURCE_ROOT` cause an explicit error.

## Stale file cleanup

When files are deleted or renamed, their Qdrant points remain until explicitly pruned. Use `PRUNE_STALE=1` to remove them after the indexing loop:

```bash
PRUNE_STALE=1 COLLECTION=my-docs npm run index ./docs
```

After indexing completes, semidex compares the files found on disk against all `source_file` values stored in Qdrant. Any file present in Qdrant but absent from the current scan is deleted from Qdrant and removed from the graph.

Run only against the **full directory root** used for indexing. Single-file targets are rejected with a warning. When `SOURCE_ROOT` is set, subdirectory targets are also rejected because they cannot safely represent the full collection scope.

Renamed files: the old `source_file` persists in Qdrant until `PRUNE_STALE=1` is run over the full directory. The new path is indexed as a fresh file.

## Qdrant indexes and sync

```bash
npm run sync
```

The `sync` command ensures that the Qdrant collection is correctly configured for semidex. It:

- generates/updates `config.json`
- discovers Qdrant collections
- backfills provider metadata for older config entries
- ensures required payload indexes
- checks sparse vector support

**Operational Note:**

- **When to run**: Always run `npm run sync` after upgrading semidex.
- **Required indexes**: It ensures existing or older collections have payload indexes on `source_file`, `tags`, and `chunk_index`. These are strictly necessary for search filters, context window chunks, and agent MCP tools.
- **Safety**: Do not manually mutate the Qdrant schema unless you know exactly what you are doing. `npm run sync` is safe to re-run.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run index` | Index files: `COLLECTION=x npm run index <path>` |
| `npm run mcp` | Start MCP server |
| `npm run sync` | Sync config and Qdrant indexes |
| `npm run smoke` | Offline smoke tests |
| `npm run bench:retrieval` | Live retrieval benchmark |
| `npm run bench:retrieval:compare` | Provider comparison |
| `npm run bench:retrieval:rerank` | Rerank matrix |

## Project Structure

See [project-structure.md](project-structure.md) for the source tree, runtime
entry points, benchmark layout, and generated files.

## Known Limitations

- BGE-M3 ONNX downloads about 2.3 GB on first use.
- `hashed-tf` is not BM25 and has no corpus statistics.
- Reranker is off by default because current bundled benchmark shows neutral effect.
- ColBERT / late-interaction retrieval is not implemented yet.
- Bundled benchmark is a regression suite, not a scientific evaluation.
- `chunks_out/` is a review layer and can have path collisions for files with the same parent-folder and basename.
- `chunks_out/` cleanup uses filename pattern matching (`base__chunk*.md`).

## Troubleshooting

### `fetch failed` on search

Ollama must be running when the MCP server embeds queries with the Ollama provider.

With `ONNX_EMBED=1`, Ollama is not required for search embeddings, but it is still used for context/tag generation during indexing unless those phases are changed.

### Wrong search results

Check that:

- `config.json` provider metadata matches how the collection was indexed
- `npm run sync` has been run
- the collection has sparse vector support if hybrid search is expected
- the source file was reindexed after provider/schema changes
