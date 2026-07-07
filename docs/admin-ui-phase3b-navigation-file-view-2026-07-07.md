# Admin UI — Phase 3B Navigation/File View UX Report (2026-07-07)

This task asked for seven requirements covering sidebar navigation, file/
section view behavior, a resizable sidebar, simplified search, readable
labels, avoiding Qdrant-dashboard drift, and tests. **Six of the seven were
already fully shipped** by earlier phases (Phase 2E navigation redesign,
Phase 3A information-architecture pivot, Phase 3A0 usability baseline) —
confirmed by direct reads of the current `src/admin/ui-src/app.js`/
`app.css`/`index.html`, not assumed from old reports. The only genuinely
new work is **requirement #3: a resizable sidebar with persisted width**.

(Informational note: the design doc's own "Phase 3B" at
`docs/design/admin-ui-ux-and-ask-plan.md:123-130` names a different
scope — F1+F2+F4, accessibility/toasts/search-QoL. Toasts already shipped
in an earlier session. This is a naming mismatch between this task's own
numbering and the design doc's, not something requiring resolution.)

## What changed

```text
src/admin/ui-src/app.css   - .layout: grid-template-columns 240px 1fr ->
                              var(--sidebar-width, 320px) 6px 1fr
                            - .sidebar: removed border-right (superseded
                              by the new handle's own divider line)
                            - +.sidebar-resize-handle rules
src/admin/ui-src/index.html - +one <div id="sidebar-resize-handle"
                              role="separator" ...> between <nav> and <main>
src/admin/ui-src/app.js    - +SIDEBAR_MIN_WIDTH/MAX_WIDTH/DEFAULT_WIDTH/
                              WIDTH_KEY constants
                            - +clampSidebarWidth/readSidebarWidth/
                              writeSidebarWidth/applySidebarWidth/
                              initSidebarResize
                            - startAdminApp() calls initSidebarResize()
                              first, before hashchange/loadTopbar/
                              loadSidebar/route
tests/unit/admin/static.test.js - +10 tests (pure helpers + markup/CSS guards)
```

## Requirement-by-requirement

### 1. Sidebar as primary navigation — already done, verified

`loadSidebarTree` (app.js:225), `loadSidebarFileList` (251),
`renderSidebarSkeletonLevel` (272), `sidebarNodeRow` (296),
`onSidebarNodeClick` (351-375) already form a full collection →
skeleton-tree (directory/file/section) → leaf hierarchy, falling back to a
flat file list when no skeleton exists. Section/leaf clicks set
`location.hash` directly — no bypass. Confirmed zero matches for
`col-docs`/`col-skel`/`loadDocuments` anywhere in `ui-src/`: no standalone
Documents or Skeleton-navigation panels exist. Nothing changed here.

### 2. Main content behavior (file/section view) — already done, verified

`openFileView` fetches with `window=3` (up to 7 chunks around the target,
not just a bare 3), with a working "load more" button
(`fileViewLoadMoreButton`/`wireFileViewButtons`/`loadMoreFileChunks`).
This already satisfies "load enough to be useful... pagination if
needed" — the load-more mechanism is a forward-only overlapping-window
re-fetch rather than true cursor pagination (see Known limitations), which
is a minor efficiency quirk, not a missing feature; no cursor API was
built for this task. `openSectionView` already resolves via
`GET .../skeleton/anchor` to the true first content chunk under a section;
the only `chunkIndex=0` usage is the deliberate "Open file from start"
fallback shown when a section has no indexed content (404 case) — this
already satisfies "do not open section as chunkIndex=0 unless truly
first." Nothing changed here.

### 3. Wider + resizable sidebar — new work, implemented this phase

Previously `.layout`'s `grid-template-columns: 240px 1fr` was the sole,
fixed, non-configurable width source. Now:

- Default width **320px** (task's suggested range was "320 or 340" — no
  strong signal either way, picked the lower/rounder value).
- Min **240px** (the old fixed width, now the floor), max **520px**
  (static, not `40vw` — see Design decisions).
- A dedicated 6px grid column (`.sidebar-resize-handle`) sits between
  sidebar and main, with its own 2px visible divider line — not an
  absolutely-positioned overlay, so its hit area is a real grid track that
  can't be clipped by either neighbor's `overflow-y: auto`.
- Drag via Pointer Events (`pointerdown`/`pointermove`/`pointerup`/
  `pointercancel`, with `setPointerCapture` so drag tracking survives the
  cursor leaving the narrow 6px hit area mid-drag).
- `document.body.style.userSelect = 'none'` during drag, restored on drag
  end — satisfies "must not break text selection."
- Width persists to `localStorage` under `semidex-admin-sidebar-width`,
  applied once at `startAdminApp()` time (before any route/data-dependent
  render), matching the existing `RECENT_SOURCE_PATHS_KEY` try/catch
  convention so storage failures never break the UI.
- Double-click on the handle resets to the 320px default (optional per the
  task's own wording — implemented anyway, it reuses the same
  apply+persist path as drag-end).
- The handle is a distinct grid-column sibling from the sidebar's own
  `.tree-row` elements, so there's no hit-area overlap with normal sidebar
  clicks, by construction.

### 4. Search stays simplified — already done, verified

`initSearchPanel` already shows only query/top-k/submit by default, with
window/format/score/file-filter collapsed behind
`<details class="advanced-box">`. Default window format is already "full."
No regression found; nothing changed here.

### 5. File/section labels — already done, verified

`nodeDisplayLabel`/`basename`/`shortLabel` already produce human-readable
short labels per node type, with the raw `nodePath`/summary surfacing only
via a `title` tooltip. `.tree-label` already has `overflow: hidden;
text-overflow: ellipsis; white-space: nowrap` — long names already
ellipsize cleanly rather than overflowing. Nothing changed here.

### 6. No Qdrant/debug dashboard drift — already done, verified

The collection header already shows only name/health/point-count/
description; dense/sparse/provider/schema details are already confined to
Settings → Advanced diagnostics. This task added no new UI surface on this
axis, so there was nothing to regress.

### 7. Tests

Ten new tests in `tests/unit/admin/static.test.js`, following the
established `readUiSource()` + `extractBetween`/`vm.createContext` pattern
(a new `loadSidebarResizeHelper(js)` extracts the pure constants/functions,
stopping before `applySidebarWidth`, which touches `document` and can't
run in the no-DOM vm context):

- `clampSidebarWidth`: below-min clamps to 240, above-max clamps to 520,
  NaN/`'abc'`/`undefined`/`null` fall back to 320, in-range value passes
  through unchanged.
- `readSidebarWidth`/`writeSidebarWidth` against a fake in-memory storage
  object (no real `localStorage` needed): round-trip works; missing key
  returns the default; a corrupted non-numeric stored value falls back to
  the default (via `clampSidebarWidth`'s own NaN handling, not
  clamped-garbage); a storage whose methods throw never propagates.
- Markup guard: `index.html` source has `id="sidebar-resize-handle"`,
  `role="separator"`, `aria-orientation="vertical"`.
- CSS guard: `app.css` source uses `var(--sidebar-width,` and the old
  fixed `240px 1fr` value is gone.
- Existing router/no-standalone-panel/search-defaults tests re-run
  unmodified and still pass (not newly written — re-verified only).

## Verification

- `node --check` on `src/admin/static.js`, `vite.config.js`,
  `tests/unit/admin/static.test.js` — all OK.
- `npm run admin:build` — succeeds; `dist/admin-ui/assets/index-<hash>.js`
  (40.76 kB) and `index-<hash>.css` (14.90 kB, up from 14.61 kB for the new
  handle rules).
- `npm test` — 543/543 pass (was 533; +10 new).
- `npm run smoke` — 1293/1293 pass.
- `git diff --check` — clean (routine CRLF/LF notices only).
- Live check against a real running server (stub adapter, no Qdrant
  needed): confirmed via direct `fetch` against the built/served output
  that the resize handle markup, the `--sidebar-width` CSS variable, the
  old `240px 1fr` removal, the `pointerdown` wiring, and the
  `semidex-admin-sidebar-width` localStorage key are all present in what
  the browser actually receives — not just in source.
- Full interactive manual checklist (drag-resize by hand, refresh to
  confirm persistence, run a real search) — **not performed**: Qdrant is
  unreachable in this environment (confirmed via a direct connection
  check). The live check above substitutes a served-output inspection for
  the parts of the checklist that don't require a real collection; the
  drag/refresh/search steps need a human with a live Qdrant instance.

## Known limitations

- `loadMoreFileChunks`'s pagination is a forward-only overlapping-window
  re-fetch, not true cursor/offset pagination — pre-existing behavior from
  an earlier phase, not introduced or changed by this task. Left as-is
  since the task's literal requirement ("load enough to be useful... use
  pagination if needed") is already satisfied by the existing mechanism.
- Sidebar max width is a static 520px, not `40vw` — the task's own
  suggested `clampSidebarWidth(value)` signature takes a single argument;
  a viewport-relative max would require either reading `window` inside an
  otherwise-pure function (breaking the vm-eval test pattern, which runs
  in a no-DOM context) or a second parameter (contradicting the task's own
  suggested signature). 520px is within the task's stated "or" alternative.
- ~~No keyboard-driven resize~~ — fixed in the follow-up below.
- Full interactive manual verification (drag, refresh-persistence, live
  search) deferred to a human with a reachable Qdrant instance, per the
  Verification section above.

## Follow-up (2026-07-07): accessible keyboard resize

The initial resize handle was interactive (draggable, `role="separator"`)
but not focusable and had no keyboard support — a real accessibility gap
worth closing immediately rather than letting it sit as debt. This
follow-up makes the handle a fully operable control regardless of input
method.

### What changed

```text
src/admin/ui-src/index.html - +tabindex="0" on #sidebar-resize-handle
                               (aria-valuemin/max/now deliberately NOT
                               hardcoded here — set from JS instead)
src/admin/ui-src/app.js     - +SIDEBAR_STEP (16px) / SIDEBAR_LARGE_STEP (48px)
                             - +nextSidebarWidth(current, key, shiftKey) —
                               pure function, key -> new (unclamped) width
                             - +updateSidebarResizeAria(handle, width) —
                               sets aria-valuemin/max/now/valuetext
                             - +setSidebarWidth(px, {persist}) — shared
                               clamp+apply+ARIA+persist path, replacing
                               duplicated logic across drag-end,
                               double-click, and (new) keyboard
                             - initSidebarResize(): +keydown listener
src/admin/ui-src/app.css    - +:focus-visible rule for
                               .sidebar-resize-handle (widens the divider
                               line to 4px in --amber; no outline, no
                               layout shift; only shows for keyboard focus,
                               not after a pointer drag/click)
tests/unit/admin/static.test.js - +13 tests (nextSidebarWidth math,
                               markup/ARIA/keyboard/focus-visible guards)
```

### Key bindings

| Key | Effect |
|---|---|
| `ArrowLeft` | decrease width by 16px |
| `ArrowRight` | increase width by 16px |
| `Shift+ArrowLeft` | decrease width by 48px |
| `Shift+ArrowRight` | increase width by 48px |
| `Home` | jump to minimum width (240px) |
| `End` | jump to maximum width (520px) |
| `Enter` or `Space` | reset to default width (320px) |

Every keyboard change goes through the same `setSidebarWidth()` helper as
drag-end and double-click: clamp → apply CSS var → update ARIA → persist
to `localStorage`. `preventDefault()` is called only for keys the control
actually handles (`nextSidebarWidth()` returns `null` for anything else,
and the handler returns early without calling `preventDefault` — so `Tab`,
for instance, still moves focus normally).

### ARIA behavior

`aria-valuemin`/`aria-valuemax`/`aria-valuenow`/`aria-valuetext` are set
dynamically from `SIDEBAR_MIN_WIDTH`/`SIDEBAR_MAX_WIDTH`/the current width
via `updateSidebarResizeAria()` — never hardcoded in `index.html` — so they
can never drift out of sync with the actual JS constants. Updated on
init and on every width change (drag-end, double-click, keyboard),
matching the standard `role="separator"` (resizable-pane divider) ARIA
pattern.

### Focus styling

`:focus-visible` (not `:focus`) so the indicator only appears for keyboard
navigation, not after a pointer drag or click — avoids visual noise for
mouse/touch users while still giving keyboard users a clear signal. The
indicator widens the handle's existing divider line (2px → 4px) and
switches it to the theme's `--amber` accent color, rather than adding an
outline or shifting any layout.

### Tests

13 new tests in `tests/unit/admin/static.test.js`:
- `nextSidebarWidth` pure-math: small step, large (shift) step, Home/End,
  Enter/Space reset, unhandled keys return `null`, boundary clamping still
  needed after a step past min/max.
- Markup guards: `tabindex="0"` present; `aria-valuemin`/`max`/`now` absent
  from static HTML (must come from JS); `app.js` actually sets them from
  the width constants.
- Keyboard guards: a `keydown` listener exists and references
  `ArrowLeft`/`ArrowRight`/`Home`/`End`/`Enter`; the handler calls
  `nextSidebarWidth` and only `preventDefault`s when it returns non-null.
- `app.css` has a `:focus-visible` rule for the handle.
- Drag-end, double-click, and keyboard all call the same shared
  `setSidebarWidth` (at least 4 call sites), guarding against the
  duplicated-logic pattern the task explicitly asked to avoid.

### Verification

- `node --check src/admin/ui-src/app.js` / `tests/unit/admin/static.test.js` — OK.
- `npm run admin:build` — succeeds; JS 41.34 kB (was 40.76), CSS 15.03 kB
  (was 14.90) — the small increase is the keyboard handler and
  focus-visible rule.
- `npm test` — 556/556 pass (was 543; +13 new).
- `npm run smoke` — 1293/1293 pass.
- `git diff --check` — clean.
- Live check against a real running server (stub adapter): confirmed via
  direct `fetch` against the built/served output that `tabindex="0"` is
  present, `aria-valuenow` is absent from static HTML but set by the
  served JS, a `keydown` listener and `:focus-visible` CSS rule are both
  present in what the browser actually receives.
- Full interactive keyboard-navigation check (Tab to the handle, press
  arrow keys, observe screen-reader announcement of `aria-valuetext`) not
  performed — same environment constraint as the parent phase (no browser
  automation harness here); deferred to a human.
