# Operations

## Indexing Mode Guide

### Recommended: production / multilingual

Use for serious indexing — books, multilingual docs, benchmark collections, any corpus where retrieval quality matters:

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

- Dense + sparse: `bge-m3-onnx` + `bge-m3-onnx`
- Downloads the ONNX model (~2.3 GB) on first use into `./models/`; subsequent runs use local cache
- Best retrieval quality for current semidex work

### Light / local fallback

Use when ONNX model is unavailable or for quick early exploration:

```bash
COLLECTION=my-docs npm run index ./docs
```

- Dense + sparse: `ollama` + `hashed-tf`
- Requires Ollama running locally with `bge-m3` pulled
- `hashed-tf` has no corpus statistics — not recommended for production-quality retrieval

### Full-root cleanup indexing

Use after file deletes or renames, only when the target is the complete source root:

```bash
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

- Removes Qdrant points for files no longer on disk after the indexing loop
- **Only safe for full root** — single files and subdirectory subsets are rejected with a warning
- Rename = old `source_file` pruned + new path indexed as fresh file

### PDF / book indexing

```bash
ONNX_EMBED=1 MAX_CHUNK_TOKENS=800 COLLECTION=my-book npm run index ./book.pdf
```

- PDFs are parsed by `pdf-parse`, not pandoc — pandoc cannot read PDFs
- Heading structure is usually unavailable after extraction; all chunks get `section: ""`
- Chunking uses a recursive paragraph → sentence → word splitter with page-marker cleanup
- `MAX_CHUNK_TOKENS=800` is a reasonable starting point for dense book text; tune based on benchmark results
- `chunks_out/` is a human review artifact only — Qdrant is the source of truth

### Large corpus

```bash
SOURCE_ROOT=/path/to/vault ONNX_EMBED=1 COLLECTION=my-docs npm run index /path/to/vault
```

- Use `SOURCE_ROOT` for stable `source_file` paths when indexing from different working directories or machines
- `PRUNE_STALE=1` is only safe when the target path equals `SOURCE_ROOT`
- If Ollama/ONNX shows memory pressure under concurrent load, reduce `LLM_BATCH_SIZE`
- Do not manually edit `vectorSize` in `config.json`

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
- marks schema-incompatible collections as `linkDisabled: true` in `config.json` (flat schema or no named `dense` vector)

**Link target filtering:** `sync` adds every remote Qdrant collection to `config.json`, including collections created by other tools. Collections are marked `linkDisabled: true` and excluded from link-building when any of the following is true:

- flat vector schema (no named `dense` vector) — Stage 1
- no named `dense` vector at all — Stage 1
- non-empty collection whose sampled point payload lacks semidex discriminator fields (`source_file`, `chunk_index`, `file_hash`, `dense_provider`, etc.) — Stage 2
- payload scroll fails during sync (conservative: unknown → disabled) — Stage 2

Empty collections with a compatible schema are not disabled — a newly created semidex collection has no points yet. The current collection being indexed is always included regardless of `linkDisabled`.

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

## Semantic Link Building

During indexing, each chunk is searched against one or more collections to build
cross-file semantic links and backlinks. By default, link building searches only
collections that are **known to semidex** — i.e. listed in `config.json`. Qdrant
collections created by other tools or applications are never included as link targets.

By default, the current collection being indexed is always included (intra-collection
cross-file links are the primary use case).

### LINK_COLLECTIONS — narrow the target set further

Set `LINK_COLLECTIONS` to a comma-separated list of collection names to restrict link
building to that explicit subset:

```bash
LINK_COLLECTIONS=my-docs,my-notes COLLECTION=my-docs npm run index ./docs
```

The allowlist is applied on top of the config-known filter. A collection not in
`config.json` cannot be added via `LINK_COLLECTIONS`.

When `LINK_COLLECTIONS` is set, the current collection is **not** automatically added.
Include it explicitly if you want intra-collection links to be built:

```bash
LINK_COLLECTIONS=my-docs,my-notes COLLECTION=my-docs npm run index ./docs
#                 ^^^^^^^^ include current collection for intra-collection links
```

### Tuning thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `LINK_TOP` | `5` | Top-N semantic neighbors to consider per chunk |
| `LINK_MIN_SCORE` | `0.75` | Minimum cosine similarity to create a link |
| `LINK_COLLECTIONS` | all config-known | Comma-separated allowlist to narrow link targets |

## PDF Ingestion

PDF files are extracted by `pdf-parse`, which returns plain text. The resulting text has no Markdown structure.

**What this means in practice:**

- `section` is set to `"intro"` or `""` for every chunk from a PDF — there are no recoverable headings.
- Chunking uses a recursive paragraph → sentence → word splitter. This produces well-bounded chunks, but it does not reconstruct heading structure.
- Tags and LLM context summaries still run normally, so chunks remain semantically meaningful for retrieval.
- `chunks_out/` shows the extracted chunks for review, but Qdrant is the source of truth.

**Pandoc cannot read PDFs.** Pandoc is used only for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm`. Passing a `.pdf` to pandoc produces `Unknown input format pdf` or `Unknown reader pdf`. PDF-to-Markdown conversion, OCR, and structure recovery are not part of the current pipeline.

**If heading structure is critical:** convert the PDF to Markdown externally (e.g. with a specialized OCR tool or PDF-to-MD converter) before indexing. Pass the `.md` file to the indexer instead.

## Legacy Flat Vector Schema Recovery

semidex requires **named vectors**: every Qdrant point must have a `dense` vector and a `sparse` vector stored under those exact names. Search and link building both target `dense` by name; hybrid search also requires `sparse`.

Collections created before semidex adopted named vectors (or created by other tools) may use a **flat schema** — Qdrant stores `{ size, distance }` directly instead of `{ dense: { size, distance } }`. This breaks hybrid search with:

```
Not existing vector name: dense
```

`npm run sync` detects flat-schema collections and prints a `⚠ LEGACY SCHEMA` warning with the affected collection name. Sync can add payload indexes and backfill config metadata, but **cannot rename or recreate vector schema in-place** — Qdrant does not support this operation.

**Recovery steps:**

1. Run `npm run sync` to identify which collections have the legacy schema.
2. Delete the collection via the Qdrant dashboard or API:
   ```
   DELETE /collections/<name>
   ```
3. Reindex from the original source:
   ```bash
   COLLECTION=<name> npm run index <original-source-path>
   ```

Do not hand-edit `vectorSize` or other config fields to make the error disappear — the vector schema mismatch is in Qdrant, not in config.

## Known Limitations

- BGE-M3 ONNX downloads about 2.3 GB on first use.
- `hashed-tf` is not BM25 and has no corpus statistics.
- Reranker is off by default because current bundled benchmark shows neutral effect.
- ColBERT / late-interaction retrieval is not implemented yet.
- Bundled benchmark is a regression suite, not a scientific evaluation.
- PDF files lose all heading structure during extraction; all chunks have empty or generic `section`.
- `chunks_out/` is a review layer and can have path collisions for files with the same parent-folder and basename.
- `chunks_out/` cleanup uses filename pattern matching (`base__chunk*.md`).

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `fetch failed` or `ECONNREFUSED` during context/tag generation | Ollama not running or wrong `OLLAMA_URL` | Start Ollama, verify `ollama pull bge-m3` and that the configured `CONTEXT_MODEL` / `TAG_MODEL` are pulled (`gemma3:4b` in `.env.example`), retry |
| `fetch failed` on search with ollama provider | Ollama not running | Same as above; with `ONNX_EMBED=1`, Ollama is not needed for search but still used for context/tag during indexing |
| Qdrant connection refused or timeout | Qdrant not running or wrong `QDRANT_URL` | Start Qdrant, verify `QDRANT_URL` in `.env`, run `npm run sync` |
| `Invalid provider combination` | Mixed dense/sparse providers | Use either the default (no extra env) or `ONNX_EMBED=1` — mixed combos are rejected at runtime |
| Search/link error: `Not existing vector name: dense` | Legacy flat vector schema (`{ size, distance }` instead of named `{ dense, sparse }`) or collection without a named `dense` vector | Run `npm run sync` — if it reports `LEGACY SCHEMA`, the collection must be dropped and reindexed (see below); collections without named `dense` are marked `linkDisabled` automatically |
| Stale search results after file delete or rename | Old Qdrant points remain | Run full-root `PRUNE_STALE=1 COLLECTION=... npm run index ./root` |
| Provider mismatch triggers unexpected full reindex | Changed `ONNX_EMBED`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, schema version, or `vectorSize` | Expected behavior — let reindex complete; do not interrupt |
| `pandoc: Unknown input format pdf` | Pandoc cannot read PDFs | PDFs are handled by `pdf-parse`; pandoc is only used for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` |
| First ONNX indexing run is very slow | Model download and cache warmup (~2.3 GB) | Wait for download to complete; all subsequent runs use `./models/` cache |
| `ONNX_EXECUTION_PROVIDER=cuda` falls back to CPU | CUDA not bundled in `onnxruntime-node` | Expected — semidex retries with CPU automatically and logs a warning; use `dml` on Windows for GPU acceleration without extra packages |
| Wrong search results after re-indexing | `config.json` still has old provider metadata | Check `config.json` entry for the collection, run `npm run sync`, verify provider fields match the current indexing env |
| All PDF chunks have empty or `"intro"` section | PDF extracted as plain text — heading structure is not preserved | Acceptable fallback; navigate chunks via `source_file` + `chunk_index`. If heading structure is required, convert the PDF to Markdown externally before indexing |
