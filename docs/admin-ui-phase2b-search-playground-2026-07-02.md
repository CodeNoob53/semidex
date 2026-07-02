# Admin UI — Phase 2B Search Playground Report (2026-07-02)

Adds a search playground to the collection detail view so retrieval can be
tested from the browser. UI-only change on top of the Phase 1C
`POST /api/search` endpoint — no storage adapter, Qdrant, or API code was
modified (no API bug was found).

## What changed

```text
src/admin/ui/app.js   - search playground: form, results, window chunks,
                        file filter, chunk-preview integration;
                        loadChunkPreview() now accepts a start chunkIndex
src/admin/ui/app.css  - appended playground styles (form controls, segmented
                        toggle, filter chip, result cards, match highlight)
tests/unit/admin/static.test.js - +3 tests (playground wiring in served app.js)
```

`index.html`, `static.js`, `server.js`, all `src/admin/api/*`, and everything
under `src/core/` are untouched.

## Endpoint used

`POST /api/search` with the documented body:
`{ collection, query, top, window, windowFormat?, sourceFile? }`.
`windowFormat` is sent only when `window > 0` (matching the API's
normalisation); `sourceFile` only when the file filter is active. `tags` are
**deferred** — the field is supported by the API but a good tag input needs
tag autocomplete from `list_tags`-equivalent data the UI doesn't fetch yet.

## The playground

**Form** (in the collection detail view, between metadata and documents):
query input; `top` select (1/2/3/5/10/20, default 3); `window` select (0–5,
default 1); `compact|full` segmented toggle (default compact); file-filter
chip; submit. Submit is disabled while a request is in flight.

**File filter:** every document row has a "search in file" button
(row click still opens the chunk preview — the button stops propagation).
Clicking it pins a dashed amber chip with the file path into the form,
scrolls to the playground, and focuses the query input. The chip's `×`
clears the filter. A filtered search with 0 results says so explicitly and
suggests clearing the filter.

**Results:** rank (`#1…`), RRF score to 4 decimals (tooltip: *"compare rank
order, not absolute value"* — same guidance as the MCP docs), source file,
`chunk i / total`, section, `nodeType` badge when present, context line when
present, full chunk text (scrollable, monospace), and a **preview chunk**
button that reuses the existing chunk preview panel — now opened at the
result's own `chunkIndex` (window ±2), not chunk 0.

**Window chunks:** rendered under each result; compact shows `textSnippet`,
full shows `text`; the `isMatch` chunk gets an amber border + `match` badge.

**States:** empty query → inline client-side validation ("Enter a query
first."), request never sent; 0 results → neutral empty state; API error
(400/404/500/501) → the API's error message in a visible error box; the
`searchMode` from the response is displayed in the panel header.

**Copy:** the panel's idle text reads *"Results are retrieval evidence — real
indexed chunks with scores. Skeleton summaries below are navigation only."*
— keeping the evidence-vs-navigation distinction explicit next to both
panels.

## Semidex-first / safety

- UI still talks only to `/api/*`; no backend-specific filter DSL — the file
  filter is a plain `sourceFile` string in the documented body.
- Nothing branches on the backend name; `searchMode` is displayed as data.
- Every rendered user/API string goes through the existing `esc()` helper —
  query echoes, source files, sections, node types, context, chunk text, and
  window snippets included. Verified by a test asserting `esc(` wraps the
  result fields in the served app.js.

## Tests run

| Check | Result |
|---|---|
| `npm test` (312 tests; +3 in `static.test.js`) | 312/312 pass |
| `npm run smoke` | 1293 pass, 0 fail |
| `node --check src/admin/ui/app.js` | pass |
| `git diff --check` (touched files) | clean |

New tests (HTTP-level over the served files — no DOM runner in the
toolchain, so browser-level tests are out of scope): served `app.js` posts
to `/api/search`, renders the `search-panel` container, sends
`windowFormat`/`sourceFile`; evidence-vs-navigation copy present; result
fields escaped via `esc()`.

## Manual test cases (against a live instance)

1. `npm run admin` → open a collection → type a query → search: results with
   rank/score/source/section appear; header shows `mode: hybrid`.
2. Set `window=0` → no window chunks; `window=2` compact → snippets with the
   match chunk highlighted; switch to `full` → untruncated neighbor text.
3. Click "search in file" on a document row → chip appears, query focused;
   search returns only that file's chunks; `×` clears the chip.
4. Click "preview chunk" on a result → chunk preview panel opens at that
   chunk with ±2 neighbors.
5. Empty query + submit → inline validation, no network request (check
   devtools).
6. Stop Qdrant → search shows the API error message in the error box.
7. Query with `<script>` in it → renders as literal text (escaping).

## Known limitations

- `tags` filter deferred (needs a tag-suggestion source in the UI).
- No search history / permalinks (hash route doesn't encode the query).
- Window chunks show snippets from the API as-is; no client-side "expand
  this neighbor" yet — "preview chunk" covers that need via the chunk panel.
- Browser-level (DOM) tests are not part of the toolchain; coverage is
  HTTP-level + manual checklist above.
- `.tmp/app.phase2b.js` (gitignored scratch copy used during the edit) may
  remain on disk; safe to delete.

## Verdict

**ADMIN_UI_SEARCH_PLAYGROUND_ACCEPT**
