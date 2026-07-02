# Admin UI — Phase 2A Shell Report (2026-07-02)

First usable Semidex Admin UI on top of the existing Local API. Read-only
shell: health, capabilities, collections, collection detail, documents with
chunk preview, skeleton navigation. No indexing jobs, no search playground
(Phase 2B), no writes.

## What shipped

```text
src/admin/static.js       - static file serving (GET/HEAD only, traversal
                            guard, extension allow-list, JSON 404/405 envelope)
src/admin/ui/index.html   - app shell (top bar, sidebar, main view)
src/admin/ui/app.css      - "instrument console" theme, no external fonts
src/admin/ui/app.js       - vanilla JS, hash router, Local API fetch client
src/admin/server.js       - +static fallback for non-/api paths (router keeps /api/*)
tests/unit/admin/static.test.js - 10 offline tests
```

No frameworks, no build step, no new dependencies. The UI is fully offline:
no CDN fonts/scripts — a local admin tool must not degrade without internet.

## Semidex-first framing (not a Qdrant dashboard)

- The UI fetches **only** `/api/*`; zero storage-backend imports. The
  existing layering test (`server.test.js`) scans every file under
  `src/admin/` including the new ones.
- Backend identity appears only as data: `health.storage.backend` string and
  the capability chip row. Nothing in UI logic branches on "qdrant".
- Concepts on screen: collections, documents (source files), chunks,
  skeleton navigation, provider metadata, schema versions.
- Skeleton copy explicitly frames summaries as a map, not evidence:
  *"Summaries are a navigation map for orientation — verify facts in the
  chunks themselves."*

## Screens

| Route | Content |
|---|---|
| `#/` (overview) | storage health card (backend, reachable badge, detail), capability chips (on/off), collections table (name, points, dense/sparse provider, schema badge: named / legacy flat / empty) |
| `#/collections/:name` | metadata panel (points, vector schema, providers, schema versions, semidex-managed, skeleton availability badge, warnings), documents panel (`?limit=100`, source file + chunk count; click → chunk preview `chunkIndex=0&window=2` with section/context/text), skeleton panel |
| top bar (always) | status lamp (green/red glow) + backend name from `/api/health`, capability count from `/api/capabilities` |

Skeleton panel behavior: collection without skeleton → neutral *"No skeleton
navigation for this collection"* plus a one-line explanation; with skeleton →
root summary, children as typed nodes (directory/file/section), click to
drill down, breadcrumb trail to climb back.

## Static serving contract

- `GET /` → `index.html` (`text/html`); `/app.js` → `text/javascript`;
  `/app.css` → `text/css`.
- Unknown paths, unknown extensions, and `..` traversal → `404` with the
  standard `{ error: { code, message } }` envelope; non-GET/HEAD → `405`.
- Extension allow-list (`.html .js .css .svg .ico`) — the UI dir is not a
  general file server.
- API and static are separated: the server routes `/api/*` to the router
  first; static never sees API paths and vice versa.

## Tests run

| Check | Result |
|---|---|
| `npm test` (309 tests; 10 new in `static.test.js`) | 309/309 pass |
| `npm run smoke` | 1293 pass, 0 fail |
| `git diff --check` (touched files) | clean |
| `node --check` server.js / static.js; app.js parse check | pass |

New tests: `/` returns HTML shell; `/app.js` and `/app.css` content types;
unknown static path 404; extension-less path 404; POST to static 405; `/api`
routes unaffected; `resolveStaticPath` traversal guard (`..` escapes and
unknown extensions rejected) tested directly.

## Manual check (described; no screenshots)

Steps to verify against a live instance: `npm run admin`, open
`http://127.0.0.1:8642/`. Expected: green lamp + backend name in the top
bar when Qdrant is reachable (red lamp with the error detail in the tooltip
when not); collections in the sidebar with point counts; clicking one shows
metadata, documents, and either the skeleton map or the neutral no-skeleton
notice; clicking a document opens the first chunks with section/context.
Not run in this task's sandbox (no live Qdrant); all behavior above is
covered by the stub-adapter tests at the HTTP level.

No private collection names or source files appear in this report.

## Notes / deferred

- Search playground → Phase 2B (endpoint already live from Phase 1C).
- Indexing jobs, create/delete collection UI → later phases per design doc.
- The chunk preview always starts at `chunkIndex=0`; per-chunk navigation
  within a document is a natural Phase 2B refinement.
- `documents?limit=100` — the panel shows `100+` when the cap is hit; full
  pagination deferred.

## Verdict

**ADMIN_UI_SHELL_ACCEPT**
