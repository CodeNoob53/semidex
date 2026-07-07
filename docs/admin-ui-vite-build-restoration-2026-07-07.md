# Admin UI — Vite Build Restoration Report (2026-07-07)

`vite.config.js` previously overrode Vite's production-build defaults:
output forced into `src/admin/ui` (tracked in git as if it were source),
minification disabled, CSS code splitting disabled, and asset filenames
pinned to fixed `app.js`/`app.css`. This defeated the point of using Vite
for production builds. This change restores normal Vite behavior: build to
repo-root `dist/admin-ui` with hashed, minified output; serve it by parsing
the built `index.html` instead of hardcoding filenames; stop tracking
`src/admin/ui/**`; and migrate the test suite that depended on the old
fixed-filename assumption.

## What changed

```text
vite.config.js                   - build.outDir: '../ui' -> '../../../dist/admin-ui'
                                    removed: minify: false, cssCodeSplit: false,
                                    sourcemap: false, rollupOptions.output.
                                    {entryFileNames,chunkFileNames,assetFileNames}
                                    kept: root, base, server.proxy, plugins,
                                    emptyOutDir: true (now the only build key
                                    besides outDir)
src/admin/static.js               - UI_DIR: './ui/' -> '../../dist/admin-ui/'
                                     (exported, was private)
                                   - resolveStaticPath()/handleStatic() gained
                                     an optional uiDir parameter (default:
                                     the real UI_DIR) for test injection
                                   - handleStatic() now checks for
                                     dist/admin-ui/index.html and returns
                                     503/'ui_not_built' with an actionable
                                     message if the build is missing
.gitignore                        - +dist/
src/admin/ui/**                   - untracked (git rm -r --cached) and
                                     physically deleted — nothing writes
                                     there anymore
tests/unit/admin/static.test.js   - migrated (see below)
```

## Scope decisions

**Minification vs. marker-slicing tests — the core conflict.** Restoring
real minification (removing `minify: false`) directly conflicts with the
test suite's existing `extractBetween(js, 'function currentRoute(', ...)`
style helpers, which slice named function bodies out of served JS text by
literal marker string. Verified empirically (direct esbuild probing):
default Vite/esbuild minification renames every top-level function/variable
identifier at the declaration site — `function currentRoute(` never
survives as literal text in minified output, and `--keep-names` doesn't
help (it only attaches a runtime `.name` string via a shim, the declaration
site itself is still renamed).

Resolution: tests that need original function names now read unminified
`src/admin/ui-src/app.js` **source** directly via a new `readUiSource()`
helper (plain `fs.readFileSync`, repo-relative path) instead of fetching
`/app.js` from a running server. This is not a workaround bolted on top of
the task — it's what the task's own requirement #6 ("source-level tests can
inspect `src/admin/ui-src/**`") already specifies. A real bonus: these
tests (the large majority of the suite) no longer require
`npm run admin:build` to have run first at all, since they never touch
build output.

**The `?raw`-imported partials gap.** `app.js` pulls in four HTML partials
via Vite's `?raw` import (`overview-shell.html`, `collection-shell.html`,
`settings-shell.html`, `index-view.html`) — only *inlined as string
literals* at build time. In source form, `app.js` still has bare
`import ... from './partials/x.html?raw'` statements with no content. Tests
checking copy/markup that actually lives in one of these files (e.g.
"Indexing progress" in `index-view.html`, "Repair collection compatibility"
in `settings-shell.html`, the `opt-group-label` grouping) needed a small
`readUiAppWithPartials()` helper that concatenates `app.js` with its four
partials — close enough to Vite's own inlining for substring/regex
assertions (this text is never eval'd as JS in these tests, only searched).

**DOM-template-rendering tests keep the real build.** `vite-plugin-html-inject`'s
`<load>` tag resolution (the `<template id="tpl-job-row">` etc. markup)
only happens at build time — `ui-src/index.html` on disk still has literal
`<load src="...">` tags. `loadDomRenderHelpers()` therefore keeps its `html`
argument sourced from the real built/served `dist/admin-ui/index.html` (via
`withServer` + `fetch(base + '/')`, unchanged), while its `js` argument
switches to `readUiSource('app.js')` — a deliberate "mixed" read: function
bodies need unminified names (source), templates need Vite's build-time
resolution (build). Each argument comes from whichever artifact actually
contains what it needs.

**`.gitignore` scope.** Added the broad `dist/` rather than the narrower
`dist/admin-ui/` — confirmed with the user; no other repo-root `dist/` use
exists today, and a broader ignore is simpler and future-proofs against
other build output landing there later.

## Test migration

`tests/unit/admin/static.test.js` (1324 → ~1050 lines): the large majority
of the ~86 `fetch(base + '/app.js')` call sites became either
`readUiSource('app.js')` or `readUiAppWithPartials()`, most also dropping
the `withServer(...)` wrapper entirely since they no longer touch HTTP.
Genuine serving-behavior tests (content-type headers, 404/405, "the real
layout is baked into index.html") keep `withServer` + real `fetch` against
the actual built output. Since assets are now hashed, a
`getBuiltAssetPaths(html)` helper parses the real `/assets/*.js`/`*.css`
paths out of served `index.html` rather than hardcoding them.

New guard tests (task requirement #6):
- `UI_DIR` (imported from `static.js`) resolves under `/dist/admin-ui/`,
  not `/src/admin/ui/`.
- `vite.config.js`'s source text contains none of
  `entryFileNames`/`chunkFileNames`/`assetFileNames`/`minify: false`/
  `cssCodeSplit: false`.
- `handleStatic()` pointed at a deliberately nonexistent directory (via the
  new `uiDir` injection parameter) returns 503/`ui_not_built` with a
  message containing `npm run admin:build`.

One `router` marker fix worth noting: `loadRouterHelper`'s end marker
(`'function startAdminApp'`) previously worked against the built bundle,
where Vite strips the `export` keyword — but `ui-src/app.js` source still
has `export function startAdminApp`, and cutting the extracted range at the
bare `function startAdminApp` substring left a dangling `export` keyword at
the end of the sliced snippet (a `SyntaxError`, since a bare `export` with
nothing following it isn't valid). Fixed by detecting which form is present
and cutting before `export` when it exists.

## Verification

- `npm run admin:build` — succeeds; `dist/admin-ui/assets/index-<hash>.js`
  (39.61 kB, down from 55.43 kB unminified) and `index-<hash>.css`
  (14.61 kB), `dist/admin-ui/index.html` referencing both by hashed path.
  Re-running produces byte-identical hashes (confirmed idempotent).
- `node --check` on `vite.config.js`, `src/admin/static.js`,
  `tests/unit/admin/static.test.js` — all OK.
- `npm test` — 533/533 pass.
- `npm run smoke` — 1293/1293 pass.
- `git status` after build — `dist/` does not appear (ignored), no
  unexpected diffs.
- `git diff --check` / `git diff --cached --check` — clean (routine
  CRLF/LF notices only).
- Live end-to-end check: temporarily moved `dist/admin-ui` aside, started
  a real `createApp()` server, confirmed `GET /` returns
  `503 {"error":{"message":"Admin UI build not found. Run \`npm run admin:build\`.","code":"ui_not_built"}}`,
  then restored the real build and confirmed normal serving resumed.

## Known limitations

- `readUiAppWithPartials()` approximates Vite's `?raw` inlining by
  concatenation, not by actually running the bundler — sufficient for the
  substring/regex assertions these tests make (none of this text is
  evaluated as JS), but it does not model where in `app.js`'s real text the
  content is inlined, only that it's present somewhere in the combined
  string. If a future test needs positional assertions across a
  partial/JS boundary, this approximation would need revisiting.
- `npm run admin:dev` (Vite's own dev server) was not changed and was not
  re-verified live in this session — its config (`root`, `server.proxy`)
  was explicitly untouched per the task's scope, and the dev flow
  (`npm run admin` + `npm run admin:dev` as two processes) is unchanged
  from before this task.

## Process note

While verifying git state for this task, three prior tasks in this
session (Phase 3A0 usability baseline, Phase 3A information-architecture
pivot, and the toast/warning-delivery follow-up) were found already
committed on `HEAD`/`HEAD~1`/`HEAD~2` — including this task's own
`git rm --cached src/admin/ui`, swept into a commit titled "Remove the
admin UI HTML file from the project." No `git commit` was run by the
assistant in any of these tasks; no Claude Code hooks or git hooks were
found configured on this machine that would explain it. Flagged to the
user directly, since it falls outside this project's established
"never commit without explicit request" convention.
