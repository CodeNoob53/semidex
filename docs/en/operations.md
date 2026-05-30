# Operations

## Indexing Mode Guide

### Recommended: production / multilingual

Use for serious indexing — books, multilingual docs, benchmark collections, any corpus where retrieval quality matters:

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

- Dense + sparse: `bge-m3-onnx` + `bge-m3-onnx`
- Downloads the ONNX model (~2.3 GB) on first use into `./models/`; subsequent runs use local cache
- Chunk boundaries use the real BGE-M3 tokenizer by default; tokenizer files are loaded separately from the ONNX inference session
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

- PDFs are converted to Markdown by `@opendocsg/pdf2md`, not pandoc — pandoc cannot read PDFs
- Heading structure is recovered from the PDF text layer; most digitally-created PDFs yield real `section` values
- Scanned or image-only PDFs may produce weak structure; those chunks default to `section: ""`
- The Markdown output is processed through the same heading-aware path as `.md` files
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
The skip guard also checks `chunking_schema_version` and `token_count_mode`.
Collections created before tokenizer-aware chunking are reindexed automatically.
Use `TOKEN_COUNT=heuristic` only as an explicit fallback to the older approximate
chunk boundaries.

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

## Duplicate point repair

semidex generates deterministic point IDs from `collection + source_file + chunk_index + embeddingSchemaVersion`. Reindexing the same content is idempotent — Qdrant overwrites the existing point.

Collections indexed before deterministic IDs were introduced may contain duplicate points from earlier randomUUID-based runs: multiple Qdrant points sharing the same `source_file + chunk_index` but carrying different IDs (and often different LLM-generated tags/context). `PRUNE_STALE=1` does not fix this — both duplicates share a live `source_file` and survive the stale check.

### Safe Repair v2 (default)

The default apply flow is **reindex-first**: a file is never deleted before it has been successfully reindexed. Only orphan old-ID duplicates are deleted after the reindex is verified.

For each affected `source_file`:
1. Reindex the file — deterministic IDs overwrite the current points in place.
2. Verify Qdrant has `>0` points for that `source_file` after reindex.
3. Delete only the orphan old-ID duplicate points (those not overwritten by the reindex).

A file can never become absent: it is always reindexed before any deletes occur.

**Step 1 — Run the diagnostic to scope the repair:**

```bash
COLLECTION=my-docs node benchmarks/retrieval/duplicate-point-diagnostic.js
```

**Step 2 — Dry-run the repair (non-destructive, always run first):**

```bash
COLLECTION=my-docs SOURCE_ROOT=. \
  node benchmarks/retrieval/duplicate-point-repair.js
```

Prints a summary (duplicate groups, affected files, estimated extra points, which files are missing from disk) and writes a privacy-safe report to `benchmarks/retrieval/results/`. Does not delete or reindex anything.

**Step 3 — Apply the repair:**

Ollama must be reachable before apply — the script runs an indexer preflight check before touching any Qdrant data and aborts if Ollama is unavailable.

```bash
DUPLICATE_REPAIR_APPLY=1 COLLECTION=my-docs SOURCE_ROOT=. ONNX_EMBED=1 \
  node benchmarks/retrieval/duplicate-point-repair.js
```

Runs sequentially. Stops on the first failure and reports the affected file hash and reason. Writes a before/after verification report. In safe mode, a failed file is **not** left absent from Qdrant — the delete step only runs after a successful reindex is verified.

**Step 4 — Confirm repair (optional):**

```bash
COLLECTION=my-docs node benchmarks/retrieval/duplicate-point-diagnostic.js
```

Compare duplicate group counts before and after to confirm the repair was effective.

**Key options:**

| Env var | Default | Description |
|---------|---------|-------------|
| `DUPLICATE_REPAIR_APPLY` | (unset) | Set to `1` to enable apply mode |
| `SOURCE_ROOT` | (required in apply) | Must match the root used during original indexing |
| `DUPLICATE_REPAIR_MODE` | (unset) | Set to `legacy-delete-first` to use the old unsafe delete-then-reindex flow — not recommended |
| `DUPLICATE_REPAIR_LIMIT=N` | all | Repair only the first N affected files |
| `DUPLICATE_REPAIR_REPORT_PATH` | auto | Override the report output path |
| `ONNX_EMBED`, `TAG_GEN`, `CONTEXT_MODEL`, etc. | (from env) | Passed through to the indexer subprocess |

**Notes:**
- `SOURCE_ROOT` must match the root used during the original indexing run. Without it, single-file targets derive root from `dirname(file)`, which shortens `source_file` and creates a mismatched path in Qdrant.
- Do not run while another indexer job is active on the same collection.
- Reports contain no raw paths, tags, context, or chunk text — only SHA-1 hashes of source file paths.
- The legacy `DUPLICATE_REPAIR_MODE=legacy-delete-first` mode deletes all points for a file before reindexing. If interrupted between delete and reindex, the file becomes absent from Qdrant. Use only if the safe default is not suitable.

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

## Documentation Self-Index

semidex can index its own documentation into a reserved `semidex-docs` collection so
that AI agents can query semidex usage, configuration, and troubleshooting through MCP
instead of reading repo files directly.

```bash
npm run bootstrap:docs
```

Run once after initial setup, and again whenever the docs change significantly.

**What gets indexed:**

- `README.md`
- `AGENTS.md`
- `docs/en/` (all `.md` files)

**Provider:** Uses `ONNX_EMBED=1` (bge-m3-onnx) by default for embeddings. On first
run this downloads the ONNX model (~2.3 GB) into `./models/`. Set `ONNX_EMBED=0`
in the shell or `.env` to use the Ollama/hashed-tf embedding fallback instead.
Context and tag generation still use Ollama during indexing, so keep Ollama running
with the configured `CONTEXT_MODEL` / `TAG_MODEL` available.

**Re-run safety:** Unchanged files are skipped by the file-hash check. Re-running after
a docs update only reindexes the files that changed.

**Config fields written automatically:**

```json
"semidex-docs": {
  "semidexManaged": true,
  "linkDisabled": true,
  "description": "semidex usage docs: providers, indexing, retrieval, MCP tools, troubleshooting, architecture"
}
```

`linkDisabled: true` prevents `semidex-docs` from appearing as a cross-file link target
when user project collections are indexed. Agents can still search it directly.

**Agent usage:**

```text
qdrant_search("how do I index docs?", "semidex-docs", window=1, window_format="compact")
qdrant_search("what env vars control chunk size?", "semidex-docs")
qdrant_search("why is search returning low scores?", "semidex-docs")
```

**Collision guard:** If a collection named `semidex-docs` already exists in Qdrant but
was not created by `bootstrap:docs` (no `semidexManaged` flag in `config.json`), the
command exits with a warning rather than overwriting it.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run index` | Index files: `COLLECTION=x npm run index <path>` |
| `npm run mcp` | Start MCP server |
| `npm run sync` | Sync config and Qdrant indexes |
| `npm run smoke` | Offline smoke tests |
| `npm run bootstrap:docs` | Index semidex's own docs into `semidex-docs` |
| `npm run bench:indexing` | Indexing phase timing benchmark |
| `npm run bench:retrieval` | Live retrieval benchmark |
| `npm run bench:retrieval:compare` | Provider comparison |
| `npm run bench:retrieval:rerank` | Rerank matrix |
| `node benchmarks/retrieval/duplicate-point-diagnostic.js` | Detect duplicate points |
| `node benchmarks/retrieval/duplicate-point-repair.js` | Repair duplicate points (dry-run by default) |

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

PDF files are converted to Markdown by `@opendocsg/pdf2md`, then chunked through the same heading-aware `parseMarkdown` path used for `.md` files.

**What this means in practice:**

- Digitally-created PDFs with an embedded text layer typically yield real `section` values from H1–H6 headings found in the Markdown output.
- Scanned or image-only PDFs may produce weak or no structure. If fewer than 3 heading lines are detected, the indexer falls back to `pdf-parse` plain-text extraction with recursive paragraph → sentence → word splitting, and chunks get `section: ""`.
- Tags and LLM context summaries run normally in both paths, so chunks remain semantically meaningful for retrieval.
- `chunks_out/` shows the extracted chunks for review, but Qdrant is the source of truth.

**Pandoc cannot read PDFs.** Pandoc is used only for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm`. Passing a `.pdf` to pandoc produces `Unknown input format pdf`.

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
- PDF files from digitally-created sources typically have heading structure recovered by `@opendocsg/pdf2md`; scanned PDFs fall back to plain-text and get empty `section`.
- `chunks_out/` is a review layer and can have path collisions for files with the same parent-folder and basename.
- `chunks_out/` cleanup uses filename pattern matching (`base__chunk*.md`).

## Diagnostics

Run `npm run doctor` for a read-only environment health check. It verifies:

- Node.js version, `.env` presence, required env vars
- Qdrant reachability and API key validity
- Per-collection: vector schema, point count, payload indexes, provider agreement, schema version
- Ollama reachability and required model presence
- ONNX model cache and local generated files

Output is printed to the console and written to `diagnostics/<timestamp>-doctor.md` (gitignored, safe to share).
Exit code 0 = no failures; exit code 1 = at least one FAIL check.

Doctor never mutates. Use `npm run sync` to repair any schema or index issues it reports.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `[preflight] Ollama unreachable at ...` | Ollama not running or wrong `OLLAMA_URL` | Indexer fails fast before chunking. Start Ollama (`ollama serve`); on Windows try `OLLAMA_URL=http://127.0.0.1:11434` if localhost is proxied |
| `[preflight] Required Ollama model(s) not pulled` | `CONTEXT_MODEL` or `TAG_MODEL` not pulled | Run `ollama pull <model>` as shown in the error message, then retry |
| `Unable to load BGE-M3 tokenizer` | Tokenizer cache is missing and cannot be downloaded | Check network/cache access and retry. Set `TOKEN_COUNT=heuristic` only when the older approximate boundaries are intentionally acceptable |
| `fetch failed` on search with ollama provider | Ollama not running | `ONNX_EMBED=1` makes search use ONNX, but Ollama is still needed for context/tag during indexing — preflight will catch this before the loop |
| Qdrant connection refused or timeout | Qdrant not running or wrong `QDRANT_URL` | Start Qdrant, verify `QDRANT_URL` in `.env`, run `npm run sync` |
| `Invalid provider combination` | Mixed dense/sparse providers | Use either the default (no extra env) or `ONNX_EMBED=1` — mixed combos are rejected at runtime |
| Search/link error: `Not existing vector name: dense` | Legacy flat vector schema (`{ size, distance }` instead of named `{ dense, sparse }`) or collection without a named `dense` vector | Run `npm run sync` — if it reports `LEGACY SCHEMA`, the collection must be dropped and reindexed (see below); collections without named `dense` are marked `linkDisabled` automatically |
| Stale search results after file delete or rename | Old Qdrant points remain | Run full-root `PRUNE_STALE=1 COLLECTION=... npm run index ./root` |
| Metadata mismatch triggers unexpected full reindex | Changed `ONNX_EMBED`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, schema version, `vectorSize`, or `TOKEN_COUNT`; or collection predates tokenizer-aware chunking | Expected behavior — let reindex complete; do not interrupt |
| `pandoc: Unknown input format pdf` | Pandoc cannot read PDFs | PDFs are handled by `@opendocsg/pdf2md`; pandoc is only used for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` |
| First ONNX indexing run is very slow | Model download and cache warmup (~2.3 GB) | Wait for download to complete; all subsequent runs use `./models/` cache |
| `ONNX_EXECUTION_PROVIDER=cuda` falls back to CPU | CUDA unavailable or not supported on this platform | On Windows, CUDA is not supported via prebuilt npm — use the verified `dml` path instead. On Linux x64 + NVIDIA, CUDA is experimental / unverified: install CUDA 12.x + cuDNN 9, set `LD_LIBRARY_PATH`, then retry. Run `npm run doctor` with `ONNX_EMBED=1` for a CUDA session probe (PASS/WARN, no indexing run, never retries CPU). A successful probe does not turn Linux into a supported platform; end-to-end validation is still required. To make CUDA failure a hard error instead of a silent CPU retry, set `ONNX_CUDA_STRICT=1`. |
| Wrong search results after re-indexing | `config.json` still has old provider metadata | Check `config.json` entry for the collection, run `npm run sync`, verify provider fields match the current indexing env |
| All PDF chunks have empty `section` | Scanned or image-only PDF — `pdf2md` found no heading structure, fell back to plain-text | Navigate via `source_file` + `chunk_index`; digitally-created PDFs will have sections automatically |
