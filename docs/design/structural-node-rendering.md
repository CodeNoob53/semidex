# Structural Node Rendering and Agent Access

Status: design draft.

This document extends the skeleton-first chunking design. It does not replace
`skeleton-first-chunking.md` or its implementation spec. The skeleton design
defines how Markdown becomes typed structural nodes. This note defines how
agents, MCP tools, and a future UI should access those nodes without flooding
the model context or losing the original raw content.

## 1. What Already Exists Elsewhere

This topic is partially covered in existing design docs:

- `docs/design/skeleton-first-chunking.md` already defines structural nodes,
  `point_kind`, `node_type`, `node_id`, `parent_id`, `raw_content`,
  `heading_path`, placeholders, and the split between `retrieval_content` and
  `skeleton_nav`.
- `docs/design/skeleton-first-chunking-impl-spec.md` defines MVP file/function
  contracts for parser, policy, chunk emission, payload fields, and nav points.
- `docs/en/roadmap.md` Stage 2 mentions `qdrant_get_skeleton` and
  `qdrant_get_content` as future navigation/content tools.

What is not yet specified clearly enough:

- how a prose chunk and its table/code/checklist nodes are linked for agents;
- how to retrieve a focused table/code fragment without returning the full raw;
- how to expose full raw content only when the user explicitly asks for it;
- how a future native UI should render tables, code, images, and diagrams
  without making the LLM rewrite them;
- how to protect the model from accidentally loading a node larger than its
  context window.

That is the scope of this document.

## 2. Core Principle

Structural content has three different access surfaces:

```text
retrieval surface  -> compact/searchable context for ranking and reasoning
focused render     -> exact relevant fragment for the answer
full render/export -> full original object for user display or download
```

The LLM should normally reason over the retrieval surface and focused render.
The full raw object remains available, but it is returned only through an
explicit render/export operation and should not be silently inserted into the
model context.

This separates:

- what Qdrant searches;
- what the LLM reads;
- what the user sees;
- what the UI renders.

## 3. Structural Relations

This is not the old semantic related-file graph. It is an anchored structural
relation graph inside one document skeleton.

The relation is factual and local:

```text
this prose chunk contains/mentions this table placeholder
this table belongs to this section
this table row group belongs to this table
this code slice belongs to this code block
this code block belongs to this section
```

Recommended payload fields:

```jsonc
{
  "node_id": "stable-hash",
  "node_path": "guide.md#install/table-1",
  "node_type": "table",
  "point_kind": "retrieval_content",
  "parent_id": "section-node-id",
  "parent_chunk_id": "prose-node-id",
  "related_node_ids": ["table-node-id", "code-node-id"],
  "child_node_ids": ["table-row-group-node-id"],
  "heading_path": ["Guide", "Install"]
}
```

Minimum MVP relation:

- prose chunk may include `related_node_ids`;
- structural node may include `parent_id` and optionally `parent_chunk_id`;
- large parent nodes may include `child_node_ids`.

This lets an agent move both ways:

```text
prose -> related table/code/checklist
table/code/checklist -> parent prose/section
table row group -> full table parent
```

### 3.1 Parent Semantics (crisp rule)

`parent_id` and `parent_chunk_id` answer two different questions and must not
be conflated:

- `parent_id` — structural parent in the skeleton tree. For a top-level
  table/code/checklist node this is its **section** node. For a child slice
  (table row group, code slice) this is its **entity** node. Never a prose
  chunk.
- `parent_chunk_id` — the **prose chunk that carries this node's placeholder**
  (the anchor an agent would naturally arrive from). Nullable.

Edge cases:

- Content before any heading (preamble): `parent_id` = file node;
  `parent_chunk_id` = the preamble prose chunk if one exists, else null.
- Entity-only section (no content-bearing prose): `parent_id` = section node;
  `parent_chunk_id` = null — there is no anchor prose, and synthesising one is
  forbidden (placeholders attach by the 4-tier rule, they are never invented).
- Nested entity (table inside a list item): `parent_id` = nearest typed
  ancestor node; `parent_chunk_id` = the prose chunk holding the **outermost**
  placeholder.

Invariant: `parent_id` is always present and always a skeleton node id;
`parent_chunk_id` is an optional convenience anchor, derived at parse time
from the same deterministic ordinals — never reconstructed by text-parsing
placeholders.

## 4. Retrieval Surface

Every searchable node may have a retrieval surface. This is the part used by
embedding and search.

For prose:

```text
embedding input = prose text + local deterministic context
```

For normal-sized table/code/checklist nodes:

```text
embedding input = deterministic/LLM context + bounded raw excerpt
payload raw_content = full original object
```

For large table/code/image/diagram nodes:

```text
embedding input = summary/context + structural terms + small preview
payload raw_content = full original object or storage reference
children = searchable smaller parts
```

Important rule: payload itself does not score. A table affects search only if it
is represented as a `retrieval_content` point with text/context that is embedded
or represented by child points that are embedded.

## 5. Large Node Policy

Large structural nodes must not be silently truncated.

If a structural node exceeds the embedding or safe return budget, semidex should
emit:

```text
parent structural node
  -> stores metadata, full raw reference, summary, and child list

child retrieval nodes
  -> table row groups, code slices, checklist groups, etc.
```

Example for a large table:

```text
table node
  node_type: table
  raw_available: true
  raw_size_tokens: 12400
  children: [table-1/rows-1-40, table-1/rows-41-80]

table_row_group node
  node_type: table_row_group
  parent_id: table node
  raw_content: header + rows 41-80
```

Example for a large code block:

```text
code_block node
  node_type: code_block
  raw_available: true
  raw_size_tokens: 9200
  language: js
  children: [code-1/lines-1-120, code-1/lines-121-240]

code_slice node
  node_type: code_slice
  parent_id: code_block node
  line_start: 121
  line_end: 240
```

The parent is the authoritative object. Children are retrieval surfaces and
focused access points.

### 5.1 Schema Migration Note

Emitting child nodes (row groups, code slices) changes the number of points a
file produces. This is an indexing-schema change, not a silent enrichment:

- bump `indexing_schema_version` when child emission ships, so the B1 reindex
  detector flags already-indexed skeleton collections instead of leaving a
  mixed old/new point population;
- parent node ids stay stable (structural ordinals do not change); children
  get new ids in their own ordinal space (`table-1/rows-41-80`);
- cleanup needs no new machinery: skeleton files always pre-delete by
  `source_file`, which covers newly appearing and disappearing children.

## 6. Safe MCP Defaults

Default MCP calls should not return huge raw content.

`qdrant_search` should return compact structural metadata:

```jsonc
{
  "node_id": "...",
  "node_type": "table",
  "source_file": "config.md",
  "section": "Parameters",
  "context": "Table of chunking parameters.",
  "safe_preview": "| Parameter | Default | ...",
  "raw_available": true,
  "raw_size_tokens": 12400,
  "has_children": true,
  "related_node_ids": ["..."]
}
```

`qdrant_get_node(collection, node_id)` should default to safe output:

```jsonc
{
  "node_id": "...",
  "node_type": "table",
  "context": "Table of chunking parameters.",
  "safe_preview": "...",
  "raw_available": true,
  "raw_truncated": true,
  "raw_size_tokens": 12400,
  "children": [".../rows-1-40", ".../rows-41-80"],
  "related": ["parent prose chunk id"]
}
```

If the node is small enough, the tool may include full raw inline. If it is not
small enough, it must return metadata and safe preview only.

## 7. Focused Render

Focused render returns the exact relevant fragment, not a model-written
summary. It is the normal answer surface for structured data.

### 7.1 Table Focused Render

Tool shape:

```text
qdrant_render_table_slice(
  collection,
  node_id,
  row?,
  matched_text?,
  before=2,
  after=2
)
```

Output:

```md
| Parameter | Default | Description |
|---|---:|---|
| MAX_CHUNK_TOKENS | 512 | maximum body token budget |
| MIN_CHUNK_TOKENS | 160 | merge threshold |
| CHUNK_OVERLAP_TOKENS | 80 | max dynamic overlap |
| OVERLAP_SENTENCES | 2 | legacy fallback |
```

Rules:

- always include table header;
- include a small number of rows before and after the matched row;
- do not let the LLM reconstruct table formatting manually;
- if no row match is known, return a bounded preview plus available row ranges.

### 7.2 Code Focused Render

Tool shape:

```text
qdrant_render_code_slice(
  collection,
  node_id,
  line?,
  matched_text?,
  before=8,
  after=12
)
```

Output:

```js
function buildSkeletonQrels(query, legacyChunkMap, skeletonChunkMap) {
  const target = legacyChunkMap.get(query.chunkId);
  if (!target) return null;

  return migrateChunkId(target, skeletonChunkMap);
}
```

Rules:

- preserve language and original indentation;
- include a bounded line range around the match;
- if a parser can identify a function/class/config entry, prefer that logical
  block over a raw fixed line window;
- do not make the LLM rewrite code from memory.

### 7.3 Checklist / YAML / JSON Focused Render

The same pattern applies:

- return the matched item plus nearby sibling items;
- preserve original formatting;
- include parent heading path;
- keep hard token caps.

## 8. Full Render / Export

Users may explicitly ask to see the full original object:

- show the full table;
- show the full code block;
- show the image;
- show the wiring diagram;
- attach the full file fragment.

This requires a separate full render/export surface:

```text
qdrant_render_node(collection, node_id, mode="full")
qdrant_export_node(collection, node_id, format="markdown|code|image|download")
```

Full render is not a reasoning call. It is a user-output call.

The tool may return:

- markdown table;
- fenced code block;
- image/file reference;
- attachment/resource ID for a native UI;
- download link or local file reference in a hosted/native interface.

For ordinary MCP chat hosts, full render may still be plain text. For a future
native semidex UI, full render should become an interactive artifact.

## 9. UI / API Contract

In a native UI or an app using OpenAI/Claude/local model APIs, the model should
not embed huge raw objects in its answer. It should emit a structured render
request.

Example:

```jsonc
{
  "answer": "Here is the relevant table fragment.",
  "renders": [
    {
      "type": "table_slice",
      "collection": "semidex-docs",
      "node_id": "docs/en/chunking.md#params/table-1",
      "mode": "focused",
      "row": 3,
      "before": 2,
      "after": 2
    }
  ]
}
```

The UI then:

1. validates the render request;
2. calls the semidex render API;
3. receives exact raw/focused content;
4. renders it as a table/code/image/chart/attachment.

Runtime roles:

```text
LLM     -> planner and narrator
semidex -> knowledge, node graph, render API
UI      -> renderer and interaction layer
```

This works for local LLMs and external APIs. The model only needs tool calling
or structured output support; it does not need to understand how to render the
artifact itself.

## 10. Images, Diagrams, Charts

Images and diagrams follow the same access model, but their processors arrive
later.

Current/future node model:

```jsonc
{
  "node_type": "image",
  "raw_available": true,
  "raw_ref": "storage://...",
  "alt": "...",
  "ocr_text": null,
  "vision_summary": null,
  "render_modes": ["image", "download"]
}
```

For text-heavy images:

```text
OCR processor -> retrieval text child node
```

For diagrams/charts:

```text
vision processor -> diagram summary / labels / relationships
```

The original image remains authoritative. OCR/vision output enriches retrieval,
but does not replace the raw visual object.

Future optional enrichment may add external context after OCR/VLM has produced
an identification candidate. Example: a public artwork image could get a
Wikipedia/web-derived child node with author/date/location/style context. This
is not part of the source document and must be modeled separately:

```jsonc
{
  "node_type": "image_external_context",
  "parent_id": "image-node-id",
  "source_kind": "external",
  "source_url": "https://...",
  "retrieved_at": "2026-06-25T00:00:00Z",
  "confidence": 0.0,
  "provenance": {
    "trigger": "ocr | vision | alt_text | user_request",
    "processor": "web_lookup"
  }
}
```

Rules: external image context is opt-in, disabled for private collections by
default, clearly labeled as external, and never mixed with local document
evidence without provenance.

## 11. Safety Rules

Hard rules:

- `qdrant_search` never returns unbounded raw for large nodes.
- `qdrant_get_node` defaults to safe preview and metadata.
- full raw requires explicit render/export mode.
- render/export has hard caps or returns an attachment/resource reference.
- large base64 blobs are never inserted into LLM context.
- focused render returns exact source slices; the LLM should not reconstruct
  tables/code manually.
- every rendered fragment carries provenance: collection, source file, node id,
  heading path, and line/row range when available.
- OCR, vision, and external image enrichment are derived evidence surfaces; the
  original image remains authoritative, and external context requires source URL
  and retrieval timestamp.

## 12. Proposed Tool Set

MVP order after skeleton retrieval is stable:

1. `qdrant_get_node(collection, node_id, include_related=false)`
   - safe metadata + preview + relation ids.
2. `qdrant_expand_related(collection, node_id, direction="both")`
   - structural neighbors: parent, children, related nodes.
3. `qdrant_render_table_slice(...)`
   - focused table output.
4. `qdrant_render_code_slice(...)`
   - focused code output.
5. `qdrant_render_node(collection, node_id, mode="full")`
   - explicit full render/export.

Alternative naming can be simplified later, but the separation matters:

```text
get_node       -> safe read
expand_related -> graph/navigation
render_slice   -> focused evidence
render_node    -> full user output
```

## 13. Implementation Plan

### Phase 0 - Table Retrieval Surface (quick win, before any new tools)

The custom-50 benchmark already shows the failure this document exists to fix:
"default value of parameter X" queries lose because a table entity's embedded
text is too poor to rank (2026-06-11 run, query c15). The cheapest fix needs
no new tools and no new node types:

- embedding input for a table entity = deterministic/LLM context + table
  header + column names + a bounded sample of cell values (hard token cap);
- `raw_content` stays the full table — only the retrieval surface changes;
- this is a chunking-behavior change → bump `chunking_model`/schema per §5.1;
- validate against custom-50: the c15-class queries are the regression gate,
  rerun the skeleton-vs-legacy bench before and after.

Ship Phase 0 first: it pays for itself immediately and de-risks Phase 3
(the row-metadata work builds on the same parsed-table machinery).

### Phase 1 - Payload Relations

- Add or confirm `related_node_ids`, `child_node_ids`, `parent_chunk_id`.
- Ensure prose chunks and structural nodes can reference each other without
  parsing placeholder text.
- Add smoke tests for bidirectional relation creation.

### Phase 2 - Safe Node Read

- Implement `qdrant_get_node`.
- Return safe preview, metadata, raw size, children, parent, and related ids.
- Add token/size caps and tests for large nodes.

### Phase 3 - Focused Table Rendering

- Store parsed table headers and row metadata for table nodes.
- Implement row-group children for oversized tables.
- Add `qdrant_render_table_slice`.
- Test header + matched row + surrounding rows.

### Phase 4 - Focused Code Rendering

- Store line ranges for code nodes.
- Add code-slice children for oversized code blocks.
- Implement `qdrant_render_code_slice`.
- Start with line windows; later add symbol-aware blocks for codebase memory.

### Phase 5 - Full Render / Export

- Implement explicit `qdrant_render_node(mode="full")`.
- Keep hard caps for text-only MCP hosts.
- Return attachment/resource metadata for future native UI/API mode.

### Phase 6 - UI/API Structured Output Contract

- Define render request JSON schema.
- Add assistant-runtime adapter that converts model render requests into
  semidex render API calls.
- Add native UI renderers for markdown table, code, image, chart/diagram, and
  downloadable raw.

## 14. Benchmark Plan

New evaluation should not only measure chunk recall.

Needed metrics:

- structural node recall: table/code/checklist found at K;
- focused render accuracy: correct row/code lines included;
- over-return rate: how often tool returns too much raw;
- provenance correctness: node id, row/line range, source file;
- answer faithfulness with focused render vs full raw vs plain search;
- UI/API task success for "show full table/image/code" requests.

Representative tasks:

- "What is the default for parameter X?" -> table slice.
- "Show the code that handles X." -> code slice.
- "Show the whole table." -> full render.
- "Show the diagram/image." -> image render.
- "Explain this section and include the relevant table rows." -> prose + table
  focused render.

## 15. Non-goals

- Do not reintroduce entity boost.
- Do not make payload fields affect score unless they are part of the embedded
  retrieval surface or a separately benchmarked retrieval leg.
- Do not make the LLM parse placeholders by hand.
- Do not rely on AGENTS.md instructions as the safety layer for huge raw.
- Do not make full raw the default response surface.
- Do not treat OCR/vision summaries as source truth.

## 16. Expected Result

If implemented correctly, semidex becomes more than chunk search:

- search finds the right structural object;
- the agent can move from prose to table/code and back;
- the model sees only the safe/focused evidence it needs;
- the user can still request the full original object;
- future UI can render exact source artifacts without making the LLM rewrite
  them;
- codebase memory gets a natural path to exact code slices and full file
  artifacts.

This is the practical bridge from skeleton-first RAG to a structured knowledge
runtime for agents.
