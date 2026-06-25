# Structural Node Resolver — `qdrant_get_node`

**Date:** 2026-06-25
**Smoke:** 1268 passed, 0 failed (+64 new assertions in section 56)
**Verdict:** STRUCTURAL_NODE_RESOLVER_ACCEPT

---

## What Was Added

New MCP tool `qdrant_get_node` — resolves skeleton structural content nodes
(table, code_block, checklist, image, paragraph, etc.) by `node_id` or `node_path`.
Makes placeholders like `[table node: ...]` or `[code_block node: ...]` actionable.

### Files Changed

| File | Change |
|------|--------|
| `src/core/qdrant.js` | Added `getContentNodeById`, `getContentNodeByPath`, `getAnyNodeById`, `getAnyNodeByPath` helpers; added `CONTENT_NODE_FIELDS` projection constant including `raw_content` and `rawContent` |
| `src/mcp/tools/getNode.js` | New MCP tool implementation |
| `src/mcp/server.js` | Registered `qdrant_get_node` |
| `src/smoke/sections/56-get-node-tool.js` | New smoke section, 60 assertions |
| `src/smoke/index.js` | Registered section 56 |
| `docs/en/mcp-tools.md` | Added tool to reference table and structural-data-trigger note |
| `AGENTS.md` | Added tool to quick-reference table |

---

## Output Contract

```json
{
  "found": true,
  "collection": "...",
  "node_type": "table|code_block|checklist|image|paragraph|...",
  "node_id": "...",
  "node_path": "...",
  "parent_id": "...",
  "source_file": "...",
  "heading_path": ["..."],
  "chunk_index": 12,
  "section": "...",
  "lang": "python",
  "summary": null,
  "context": "...",
  "preview": "...",
  "preview_chars": 2000,
  "raw_chars": 12345,
  "truncated": true,
  "raw_available": true
}
```

Not found:
```json
{ "found": false, "collection": "...", "reason": "not_found" }
```

Nav node at identifier:
```json
{ "found": false, "collection": "...", "reason": "nav_node_not_content" }
```

---

## Design Decisions

**Raw source priority:** `raw_content` → `rawContent` → `text`. Real payloads use
`raw_content` (snake_case); `rawContent` camelCase added as fallback for older
or alternate indexers. Both fields are included in the Qdrant projection.

**Nav rejection in code:** Qdrant filter semantics make `must_not` unreliable
for the general case. Instead: `getContentNodeById/ByPath` fetch up to 2 points
filtered only by node_id/node_path and reject any `point_kind === 'skeleton_nav'`
in JS. If the content lookup returns null, `getAnyNode*` checks whether a nav node
exists at the same identifier to return the correct error reason.

**`preview_chars` clamped to [200, 8000]:** prevents agents from accidentally
requesting 0-char, negative, or unbounded previews. Missing/invalid values use
the default 2000. Full raw content is never returned — `raw_chars` and
`truncated` signal when to follow up with `qdrant_get_chunk`.

**Missing fields:** All optional payload fields default to `null` — no crash on
minimal payloads (tested with a payload containing only `node_type` and `raw_content`).

---

## Smoke Coverage (section 56, 64 assertions)

| Category | Assertions |
|----------|-----------|
| `validateIdentifier`: both/neither/one — ok/error | 5 |
| Table node with `raw_content`: all output fields | 17 |
| Code node with `rawContent` (camelCase fallback) | 4 |
| Paragraph node with `text` fallback | 3 |
| `preview_chars` truncation | 4 |
| `preview_chars` clamping (below min / zero / negative / above max / invalid default) | 6 |
| No raw content: `raw_available: false`, empty preview | 5 |
| Minimal payload: no crash, all fields null | 12 |
| Nav rejection: `found: false`, `reason: nav_node_not_content` | 4 |
| No `preview` field in nav rejection response | 1 |
| Nav rejection: `collection` preserved | 1 |
| Additional field checks | 2 |

---

## Limitations

- **No full raw dump:** `qdrant_get_node` returns only `preview_chars` of content.
  Agents needing the complete text should follow up with `qdrant_get_chunk` using
  `source_file` and `chunk_index` from the response.
- **`lang` field sparsely populated:** skeleton indexer stores `lang` on code blocks
  parsed from Markdown fences. Other node types return `lang: null`.
- **No live integration test:** smoke uses fake payloads. Real payload retrieval
  was verified manually during the live validation session.
- **`summary` field absent on content nodes:** structural chunks do not store a
  `summary` field today (it is a nav-layer field). The tool returns `null` gracefully.
