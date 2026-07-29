# Architecture

semidex has three runtime surfaces:

- **Indexer** - writes documents into Qdrant.
- **MCP server** - exposes retrieval tools to external AI agents, which decide
  how and when to search.
- **Admin/application server** - operates collections and hosts the
  versioned Ask HTTP/SSE runtime for grounded answers
  (`POST /api/v1/ask`).

They share the same provider, configuration, retrieval, and Qdrant core. The
dashboard is a reference client for Ask, not the integration boundary for
websites, bots, or other applications. The target public contract and staged
integration scope are defined in
[Ask application runtime](../design/ask-application-runtime.md).

## Pipeline

```text
Documents (md, pdf, docx, epub, txt, ...)
  |
  +- [1] Chunk          - structure-aware: headings -> sentences -> boundary check
  +- [2] Contextualize  - LLM writes a 1-2 sentence summary per chunk
  +- [3] Tag            - optional payload tags (TAG_GEN=1 or backfill)
  +- [4] Embed + Upsert - dense vector + sparse vector -> Qdrant point
       |
       v
  Qdrant collection
  (dense, sparse, text, section, tags, context, source_file)
       |
       +--> MCP tools --> external AI agent controls retrieval
       |
       +--> Ask runtime --> generation provider --> grounded answer + citations
                              |
                              +--> dashboard reference client
                              +--> future website, bot, and application clients
```

The MCP path is the shipped agent-tooling surface. The Ask path has a
versioned, stateless, provider-neutral local implementation
(`POST /api/v1/ask`, SSE streaming, native provider system instructions,
grounded prompt assembly, citations, and refusal behavior across both the
Ollama and Gemini `GenerationProvider` implementations), but it is **not
yet** authenticated or safe for direct public Internet exposure. Public
authentication, abuse controls, SDKs, and packaged website/Telegram
integrations remain planned — see
[Ask application runtime](../design/ask-application-runtime.md) and
[docs/ask-api-v1-contract-2026-07-28.md](../ask-api-v1-contract-2026-07-28.md).

Markdown files always parse through an AST instead (unconditional, not
configurable): tables, code blocks, and checklists become typed structural
chunks, phase 2 uses deterministic context (heading path + structural
carryover, no LLM calls), and a separate `skeleton_nav` point layer is
written for the `qdrant_get_skeleton*` navigation tools. Non-Markdown formats
still use the legacy chunker. See
[chunking-quality.md](chunking-quality.md#skeleton-first-chunking-and-structural-carryover).

## Qdrant Data Model

semidex uses Qdrant as its primary retrieval index and storage backend. All
Qdrant access goes through the adapter in `src/core/qdrant/` (stable facade:
`src/core/qdrant.js`), backed by the official `@qdrant/js-client-rest` SDK.
The adapter separates concerns: `client.js` (lazy SDK client + env),
`store.js` (network operations), `payload.js` (pure helpers), `schema.js`
(canonical vector schema and payload indexes). The client is created lazily
on the first network call: importing the module does not require
`QDRANT_URL`, so offline consumers can import it safely. Read operations use
a 30 s timeout and writes 60 s, matching the pre-SDK wrapper. Indexer, MCP
tools, sync, and benchmarks never call the SDK directly — only through this
adapter, which centralizes future Qdrant-native decisions (aliases,
snapshots, richer query APIs) in one place.

- **Collection**: Represents a single semidex knowledge base.
- **Point**: Represents exactly one indexed chunk from a document.
- **Named Vectors**: Each point stores two distinct vectors:
  - `dense`: Captures semantic meaning for paraphrase and conceptual search.
  - `sparse`: Captures exact lexical tokens for keyword matching.
- **Payload Schema**: In addition to vectors, Qdrant stores a JSON payload for each point (containing the raw `text`, LLM `context`, `section`, `source_file`, `tags`, `links` (Wikilink targets from source), `chunk_index`, `total_chunks`, `file_hash`, and provider metadata). This payload is crucial because it provides all the text and metadata the MCP server needs to answer queries without reading files from disk.
- **Payload Indexes**: To efficiently filter searches by specific attributes, Qdrant relies on payload indexes. semidex requires indexes on `source_file` (keyword), `tags` (keyword), `chunk_index` (integer), plus `point_kind`, `node_type`, `node_id`, and `node_path` (keyword) for skeleton navigation and structural-node lookup. `npm run index` creates all of them for new collections; `npm run sync` ensures them on existing ones.
- **Reindexing**: Changing the embedding providers (`denseProvider`, `sparseProvider`), embedding models (`denseModel`), embedding schema version, or `vectorSize` fundamentally alters the vector schema. Because query vectors must perfectly match stored point vectors, any such change requires a full collection reindex. Conversely, changes to a `file_hash` trigger an automatic reindex of only the affected file.
- **Deterministic Point IDs**: Every point ID is derived from `uuidv5(collection + source_file + chunk_index + embeddingSchemaVersion)`. This makes every upsert idempotent — reindexing the same logical chunk overwrites the existing point rather than inserting a new one, preventing duplicate accumulation across repeated indexing runs. `file_hash`, tags, context, and model names are intentionally excluded from the ID formula so that content changes overwrite in place without orphaning the old point. After each file is indexed, any trailing points whose `chunk_index` exceeds the new chunk count are deleted to handle files that shrank between indexing runs.
- **Embedding Profile (native collection metadata)**: A collection's embedding identity — dense/sparse provider, model, vector name, dimensions, distance, and execution mode — is stored as native Qdrant collection metadata (`CollectionInfo.config.metadata`, Qdrant v1.16+), under a dedicated top-level key `semidex_embedding_profile`. This makes the collection portable: the profile survives deleting `config.json`, moving machines, or reconnecting to a remote cluster, because it travels with the collection itself rather than a local file. A sibling key, `semidex_indexing_state`, holds mutable operational fields (`indexingSchemaVersion`, `chunkingSchemaVersion`) that change on ordinary indexer upgrades — kept as a separate top-level key specifically so an indexing-state update can never touch the embedding profile, and vice versa, relying on Qdrant's documented shallow top-level metadata merge. Written by `src/indexer/run.js` at the end of every successful indexing run (best-effort — a failure to write it never fails the run itself, since the per-point payload fields `chunking_schema_version`/`indexing_schema_version` remain the authoritative per-file record regardless). The profile is **write-once**: once a collection has a valid profile, `src/core/storage/qdrant-adapter.js`'s `setEmbeddingProfile()` refuses to overwrite it — there is no override parameter. `config.json` is demoted to a local cache, rebuilt by `npm run sync` from native metadata and never consulted to resolve an existing collection's identity. See [configuration.md](configuration.md#embedding-profile-native-qdrant-metadata) for the full portability/migration contract and [operations.md](operations.md) for recovery procedures.
  - **Known SDK caveat**: the installed `@qdrant/js-client-rest` (`1.18.0`)'s high-level `client.createCollection()` wrapper silently drops a `metadata` field passed in the request body — confirmed against a live Qdrant Cloud v1.17.1 cluster. `src/core/qdrant/store.js`'s `createCollection()` works around this by calling the SDK's low-level `client.api().createCollection()` fetch wrapper directly (`client.api()` takes no argument — it always returns the same flat generated fetch-client object regardless), which passes the request body through unfiltered — so collection creation and metadata write happen in a single atomic request, never a two-phase create-then-update that could leave an empty, profile-less collection behind if the process dies in between. This is a client-library workaround only: Qdrant's server-side `createCollection` API has natively accepted a `metadata` field since v1.16.0.
- **Qdrant Cloud Inference execution (`qdrant-cloud`, "Semidex Lite")**: an embedding profile's `execution` field can be `qdrant-cloud` instead of `client` — both dense and sparse vectors are then computed server-side by Qdrant Cloud's Inference API (`intfloat/multilingual-e5-small` dense, `qdrant/bm25` sparse; typed catalog in `src/core/embedding-profile/qdrant-cloud-models.js`), never by local ONNX/Ollama. Indexing (`embedForIndexCloud()`, `src/core/embeddings.js`) and search (`buildCloudQueryInputs()`, `src/core/embedding-profile/qdrant-cloud-catalog.js`) both send `{text, model}` inference descriptors — never real vector arrays — as the `dense`/`sparse` fields of a point's `vector` object or a Query API `prefetch[].query`; the existing `buildQdrantVectorSchemaFromProfile()` (`src/core/storage/qdrant-adapter.js`) needed no changes, since it already derives the full Qdrant vector schema (distance, sparse presence, modifier) from the profile alone, independent of execution mode. `runHybridSearch()` (`src/core/retrieval/search.js`) branches on execution mode itself — the storage adapter's `searchHybridVectors()`/`searchHybridInference()` methods are both storage-only and never decide whether to embed locally, keeping the provider-neutral storage boundary intact; MCP search, Admin Search, and Ask all share this one retrieval path. Before every cloud embed call, `checkEmbedInputFits()` re-tokenizes the exact assembled `context+text` string against the real target model's tokenizer (cached per-model tokenizer files under the same `models/` cache ONNX uses, never the model's inference weights, downloaded via an atomic temp-file-then-rename so a partial download can never be mistaken for a complete cache) — this is intentionally a real tokenizer count, not the cheaper `heuristicTokenCount()` char/4 estimate, since that estimate can understate token counts for non-English text or dense identifiers badly enough to let an over-long input through undetected. If the assembled string doesn't fit, `fitContextToBudget()` first tries to reserve room by trimming `context` (never the chunk body — silently shortening indexed content is forbidden) via a real-tokenizer binary search, and the check retries once with the shortened context; only when the chunk body alone still doesn't fit does indexing raise a typed, non-silent rejection (`EmbeddingInputTooLongError`). The same tokenizer-backed check gates search queries too (`runHybridSearch()`'s cloud branch, no trim — a query has no separate context to shorten). `validateEmbeddingProfile()` (`src/core/embedding-profile/schema.js`) additionally rejects any profile whose dense and sparse lanes declare different `execution` values, since every runtime path branches on `dense.execution` alone and assumes the sparse lane agrees. Availability for a `qdrant-cloud` lane is a two-tier state machine mirroring the existing ONNX cached-vs-verified precedent: a routine, cheap reachability+auth check (`checkQdrantReachable()`) can only ever report "reachable, unverified," never "available" — proving inference itself works requires the adapter's provider-neutral `probeInference()` capability, which runs one real, minimal round-trip against a disposable collection and is only ever invoked by an explicit Admin UI action ("Test Cloud Inference"), never routine browsing.

## Phase 1 - Chunk

The parser tries to preserve document structure:

- Markdown headings and sections are respected.
- Body text styled as a heading by Word/pandoc artifacts is kept as content.
- Oversized sections fall back to sentence splitting.
- Short split fragments inside a section are deterministically merged using
  `MIN_CHUNK_TOKENS`; headed sections are not merged across boundaries.
- Token-budgeted overlap (`CHUNK_OVERLAP_TOKENS=80` default) is applied after
  deterministic chunk finalization. The overlap is taken from the previous chunk's
  body and included inside `MAX_CHUNK_TOKENS`, so the overlap itself never pushes
  a chunk over the limit. Normal splittable content stays within `MAX_CHUNK_TOKENS`;
  unsplittable blocks (dense checklists, code blocks, tables with no sentence
  boundaries) may still exceed it and are a known limitation. Overlap is reset at
  section boundaries so it does not leak content from one heading into another.
  When `CHUNK_OVERLAP_TOKENS=0` the legacy sentence-based overlap
  (`OVERLAP_SENTENCES`) is used instead.
- Very short `.txt` files are preserved instead of being dropped.

### Format-specific behavior

Markdown is the primary input format and has the strongest structural fidelity.
Other formats are best-effort ingestion paths: they rely on text extraction or
third-party conversion before entering the Markdown-oriented chunking pipeline.

| Format | Parser | Section headings | Notes |
|--------|--------|-----------------|-------|
| `.md` | Native | Preserved | Wikilinks, frontmatter, heading hierarchy |
| `.txt` | Native (sentence-based) | None | Plain sentence splitting with overlap |
| `.pdf` | `@opendocsg/pdf2md` → Markdown | Recovered from PDF text layer | See below |
| `.docx`, `.odt`, `.epub`, `.html`, `.htm`, `.rtf` | pandoc → Markdown | Preserved if pandoc can extract them | pandoc converts to Markdown first |

**PDF ingestion:** `@opendocsg/pdf2md` converts PDF to Markdown, then the same `parseMarkdown` path used for `.md` files processes the output. Headings (H1–H6) found in the Markdown become `section` values on chunks. PDFs with a proper text layer (digitally created) typically yield good section coverage. Scanned or image-only PDFs produce weak or no structure; chunks from those files will have `section: ""`. Pandoc does not support PDF as an input format.

Important environment variables:

- `MAX_CHUNK_TOKENS` (default `512`)
- `MIN_CHUNK_TOKENS` (default `160`)
- `CHUNK_OVERLAP_TOKENS` (default `80`; token-budgeted, included in MAX)
- `OVERLAP_SENTENCES` (legacy fallback when `CHUNK_OVERLAP_TOKENS=0`)

## Phase 2 - Contextualize

A chunk extracted from a document is often meaningless without its surroundings —
a code snippet, a rule, or a number that makes sense on the page but loses its
meaning when isolated. The vector computed from such a fragment is just as
meaningless, and no amount of search tuning can recover what was never encoded.

The fix: before embedding, the local LLM reads the chunk and writes a 1-2 sentence
summary of what it means in the document. That summary is prepended to the raw text
before the embedding is computed, so the vector represents the chunk's meaning, not
just its surface tokens. The summary is also stored separately in the `context`
payload field and returned to the agent alongside the raw text.

Example:

```text
It must not exceed 512 bytes.
```

Without context, this is ambiguous. With contextualization it becomes:

```text
The session token in the auth module must not exceed 512 bytes.
```

This approach was developed independently as part of semidex's core design.
Anthropic published a similar technique under the name "Contextual Retrieval" in
September 2024, reporting a ~49% reduction in retrieval failures — which validates
the direction without being the source of it.

## Phase 3 - Tag

Tags are optional payload metadata. They are disabled by default because they do
not affect normal hybrid retrieval: dense/sparse vectors are built from
`context + text`, not from tags.

Enable tags during indexing with `TAG_GEN=1`, or generate them later with:

```bash
COLLECTION=my-docs npm run backfill:tags
```

Tags are useful when a workflow depends on `qdrant_list_tags`,
`qdrant_find_by_tag`, tag-filtered `qdrant_search`, or manual collection audits.

## Phase 4 - Embed + Upsert

For each chunk, semidex embeds:

```text
context + "\n\n" + text
```

Each Qdrant point stores:

- `dense` named vector
- `sparse` named vector
- raw `text`
- `context`
- `section`
- `source_file`
- `tags`
- `links`
- `chunk_index`
- `total_chunks`
- `file_hash`
- provider metadata

## Phase 5 - Link (removed)

Indexing-time semantic link building has been removed. The planned replacement is query-time scoped global search across selected collections. See `docs/en/roadmap.md` for the design direction.

## What Is Stored vs What the Agent Sees

What lives in Qdrant for each point:

| Field | Stored in | Used for |
|-------|-----------|----------|
| `dense` vector | named vector | semantic similarity search |
| `sparse` vector | named vector | lexical keyword search |
| `text` | payload | returned to agent as the raw chunk text |
| `context` | payload | returned to agent as the LLM summary of this chunk |
| `section`, `source_file`, `tags` | payload | filtering, reranking, agent display |
| `links` | payload | Wikilink targets parsed from the source Markdown |
| `chunk_index`, `total_chunks` | payload | context window expansion |
| `file_hash`, provider metadata | payload | skip-unchanged detection, reindex guard |

### Why context + text are embedded together

At index time, the embedding input is:

```
context + "\n\n" + text
```

The LLM-generated `context` is a 1-2 sentence summary of what the chunk means in
the larger document. Embedding it together with the raw `text` means the vector
represents the chunk's **meaning**, not just its surface words.

This matters for sparse or ambiguous chunks. A code snippet like:

```js
super(name, salary)
```

has almost no searchable words on its own. Its context summary — "calls the
superclass constructor in a Manager subclass" — makes the dense vector findable
by natural language queries like "how to call a parent class constructor".

At query time, the search query is embedded with the same provider and matched
against these combined vectors. The agent receives both `context` and `text` as
separate payload fields, so it can read the summary and the raw content together.

### Source of Truth

Qdrant is the live retrieval source of truth. Use MCP tools to inspect indexed data.

## Local Models

semidex is designed for local/private knowledge bases:

| Model/runtime | Role |
|---------------|------|
| `gemma3:4b` through Ollama | Context summaries; optional tags when `TAG_GEN=1` and no separate `TAG_MODEL` is set |
| `bge-m3` through Ollama | Default dense embeddings |
| `aapot/bge-m3-onnx` through ONNX Runtime | Dense + neural sparse multilingual embeddings |

No document text needs to leave your machine when using local Qdrant/Ollama/ONNX.
