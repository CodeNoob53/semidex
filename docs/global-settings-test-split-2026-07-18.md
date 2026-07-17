# Global Settings UI test split — root cause, refactor, verification

## Root cause

`tests/unit/admin/ui-global-settings.test.js` (originally 1456 lines, 79
tests across 33 `describe()`) called `loadGlobalSettingsHelpers()` 63
times. Each call:

- Read 8 files fresh from disk (7 UI source modules + 1 HTML template
  partial) via uncached `readFileSync`.
- Concatenated ~2000 lines of stripped source into one string.
- Called `vm.runInContext(src, context)`, which re-parses and re-compiles
  that ~2000-line string from scratch, every single call.

None of this was cached or reused, so the monolithic file accumulated a
large avoidable DOM/VM cost. However, the immediate runaway trigger was a
specific assertion pattern. The injected HTML contains reusable
`<template>` elements whose content includes `id="gs-save"`. In LinkeDOM,
`document.getElementById('gs-save')` can return that template node after
the mounted save bar has been removed. Tests that expected `null` then
failed, and `node:assert` attempted to inspect the returned cyclic DOM
graph while formatting the failure. That formatting path consumed memory
until the process or system failed.

The five affected absence checks now query the mounted surface with
`document.querySelector('#gs-content #gs-save')`. Test-file splitting,
compiled-script reuse, bounded concurrency, and the heap cap reduce the
blast radius and baseline cost, but they do not replace this assertion
fix.

Per the task's explicit framing, this is **not being treated as a
confirmed production memory leak** — `global-settings-view.js` itself has
no module-level state that survives past a single `vm.createContext`
(verified: `pendingByCategory`, `invalidByCategory`, `lastFetchedPayload`,
`lastOllamaModels`, `renderGeneration` are all fresh per context). The
failure was confined to the **test harness and assertion formatting**,
not the production settings view.

## Fixes applied

### 1. Test split

| File | Lines | describe | it |
|---|---|---|---|
| `ui-global-settings.test.js` | 270 | 9 | 25 |
| `ui-global-settings-editing.test.js` | 578 | 15 | 32 |
| `ui-global-settings-providers.test.js` | 568 | 9 | 22 |
| `ui-global-settings-fixtures.js` (non-test) | 64 | — | — |
| **Total (3 test files)** | **1416** | **33** | **79** |

**Test count: 79 before, 79 after — zero net change.** Every test from
the original monolithic file has a home in exactly one split file. No
test was deleted, weakened, or converted to a source-regex check as part
of this pass.

Shared fixtures (`HEALTH_OK`, `HEALTH_FAIL`, `GENERATION_READY`,
`GENERATION_UNAVAILABLE`, `CATEGORIES`, `makeEntry`, `settingsPayload`)
live in `ui-global-settings-fixtures.js` and are imported by all three
test files — not duplicated. Provider-only factories
(`tagProviderEntry`, `OLLAMA_MODELS_MIXED`, `vectorSizeEntry`, etc.) are
local to `ui-global-settings-providers.test.js` since no other file uses
them — extracting single-consumer factories into the shared module would
have added indirection without removing duplication, so they were left
in place.

No individual file exceeds 578 lines — under the 600–700 line ceiling.

### 2. `loadGlobalSettingsHelpers()` — `vm.Script` reuse (this session's
change, `tests/unit/admin/ui-test-helpers.js`)

Added three lazily-initialized module-level caches:

- `getGlobalSettingsTemplates()` — the HTML template partial, read once.
- `getGlobalSettingsShellHtml()` — the parseHTML() shell markup string,
  built once.
- `getGlobalSettingsScript()` — the concatenated, stripped source,
  compiled **once** into a `vm.Script`.

`loadGlobalSettingsHelpers()` now calls `getGlobalSettingsScript().runInContext(context)`
instead of `vm.runInContext(src, context)` — same compiled bytecode
reused across every call, executed fresh against a brand-new
`vm.createContext()` and a brand-new `parseHTML()` document each time.
**Each test's context/document remains fully isolated** — nothing
mutable is shared between tests, only the immutable compiled source and
static HTML strings.

### 3. `HTMLDetailsElement.open` shim fix (this session's change, same file)

Verification of the pre-existing shim found it was dead code: it patched
`HTMLDetailsElement.prototype`, but linkedom 0.18.12 never actually
instantiates that class for parsed `<details>` tags — a parsed
`<details>` element's constructor is plain `HTMLElement`. Confirmed
directly:

```js
const { document } = parseHTML('<details id="d">...</details>');
document.getElementById('d').constructor.name // => 'HTMLElement', not 'HTMLDetailsElement'
```

This did not cause incorrect test behavior (linkedom's default
own-property assignment already made `.open = true` readable back as
`true`, and no test or production code ever reads `hasAttribute('open')`
after a JS-driven toggle — the disclosure widget's real attribute
reflection is native-browser-only, never inspected by
`global-settings-view.js`), but the shim's documented contract ("reflect
the real browser contract") was not actually being met.

Fixed by patching `HTMLElement.prototype.open` directly, guarded to
`<details>` tags only (transparent passthrough for every other element
type — verified no other element previously had a `.open` IDL property).
Verified directly:

```
after set true  — .open: true  hasAttribute: true
after set false — .open: false hasAttribute: false
setAttribute('open','') — getter reflects: true
non-details element — .open passthrough unaffected
```

**No production source was touched for this fix** — it is entirely
within `tests/unit/admin/ui-test-helpers.js`.

### 4. `package.json` bounded concurrency

```json
"test": "node --max-old-space-size=512 --test --test-concurrency=1 \"tests/**/*.test.js\"",
"test:watch": "node --max-old-space-size=512 --test --test-concurrency=1 --watch \"tests/**/*.test.js\"",
"test:coverage": "node --max-old-space-size=512 --test --test-concurrency=1 --experimental-test-coverage \"tests/**/*.test.js\"",
```

All three scripts carry `--test-concurrency=1` and
`--max-old-space-size=512`. The default `npm test` is the safe command;
no custom flags are required.

### 5. Dangerous DOM assertion audit

Five absence checks used document-wide `getElementById('gs-save')` and
were unsafe after settings markup moved into injected templates. They now
query only `#gs-content`, the mounted UI surface under test. This matches
browser intent and prevents assertion formatting from walking a
template-owned LinkeDOM graph.

The remaining DOM assertions compare primitives or explicit node
identity. There are no `deepEqual(node, node)` assertions.

## Verification log

All runs used explicit `execFileSync(..., { timeout })` wrappers (not bare
Bash-tool timeouts) for deterministic process lifecycle control, per this
session's process-safety protocol. `tasklist`/`wmic` were checked before
and after each run; no orphaned `node --test` processes were left by any
run in this verification pass.

| Command | Result | Time |
|---|---|---|
| `node --test --test-concurrency=1 ui-global-settings.test.js` | 25/25 pass | ~500ms |
| `node --test --test-concurrency=1 ui-global-settings-editing.test.js` | 32/32 pass | ~500ms–1.5s |
| `node --test --test-concurrency=1 ui-global-settings-providers.test.js` | 22/22 pass | ~500ms |
| Full suite (`--max-old-space-size=512 --test --test-concurrency=1`), run 1 | **1552/1552 pass**, 0 fail | 22.3s |
| Full suite, run 2 (consecutive) | **1552/1552 pass**, 0 fail | 22.3s |
| `npm run smoke` | **1293/1293 pass** | — |
| `npm run admin:build` (vite) | **success**, 225 modules, 826ms | — |
| `git diff --check` | only pre-existing LF/CRLF warnings, no conflict markers/trailing whitespace | — |

Two consecutive full-suite runs completed with no hang, no OOM at the
512MB V8 heap cap, and no growth in the baseline set of live `node.exe`
processes (confirmed via `tasklist`/`wmic` before/after — the only
processes present throughout were pre-existing, unrelated MCP servers,
never touched).

The apparent 60s hang was reproduced and traced to the failed
document-wide save-bar assertion described above. After scoping those
assertions to `#gs-content`, the editing suite completes in well under a
second with a 256MB heap cap.

## Scope discipline

No production source file was modified. The three split test files,
shared fixture module, test helper, report, and bounded test scripts form
one reviewed change set.

No actual production defect was discovered during this work.

## Verdict

**`GLOBAL_SETTINGS_TEST_SPLIT_ACCEPT`**

- No test file exceeds 578 lines (ceiling: 600–700).
- Default `npm test` uses bounded sequential concurrency with a capped
  heap; no custom flags required.
- Full suite (1552 tests) completes twice consecutively, ~22s each, no
  OOM, no hang.
- No orphaned test processes after any run in this verification pass.
- Test count unchanged: 79 before, 79 after.
- Smoke unchanged: 1293/1293.
- Admin UI production build succeeds.
- No production source changed.
- Nothing committed.
