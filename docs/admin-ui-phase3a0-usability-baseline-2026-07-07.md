# Admin UI — Phase 3A0 Usability Baseline Report (2026-07-07)

Scope: feature F0 from `docs/design/admin-ui-ux-and-ask-plan.md` — turn the
indexing/deletion/provider setup from a debug-style form into a usable
first-run flow. The task specified five requirements. Investigating each
before implementing found that **three were already fully built and
regression-tested in earlier phases**; the actual delta this phase shipped
is narrower: the create-collection form's advanced options are now
collapsed behind a disclosure, and the collection-naming copy was verified
(not changed) to stay slug-free.

## What changed

```text
src/admin/ui-src/partials/index-view.html - wrapped "Prune stale" and
                                             "Generate tags" checkboxes
                                             (+ the prune-stale caveat note)
                                             in <details class="advanced-box">,
                                             matching the search panel's
                                             existing disclosure pattern
tests/unit/admin/static.test.js           - +3 tests for the new disclosure
                                             (contents, ordering, caveat text)
```

No other source file changed. No API, registry, indexer, or config.json
changes were needed — see "Already done" below for why.

## Already done — verified, not re-implemented

Three of the task's five "fix this" items turned out to already be complete
from earlier phases:

1. **Folder picker** (task requirement #1). Both the create-collection form
   (`index-view.html` + `chooseIndexFolder()` in `app.js`) and the
   settings/reindex form (`settings-shell.html` +
   `renderSourcePathField()`/`wireSourcePathField()`) already have a "Choose
   folder…" button, a selected-path display, and a manual-path fallback
   shown on picker failure. Backend: `src/admin/system/folder-picker.js`
   (Windows `FolderBrowserDialog` via PowerShell, UTF-8-safe for Cyrillic
   paths) and `POST /api/system/pick-folder`
   (`src/admin/api/system.js`), which maps picker error codes to HTTP
   status.

2. **Ollama readiness for LLM summaries** (task requirement #3). Already
   both proactive and blocking:
   - Frontend: `loadOllamaStatus()` checks and renders a badge
     (`available` / `missing` / `model_missing`) whenever the "LLM
     summaries" checkbox is toggled on.
   - Backend: `POST /api/jobs/index` (`src/admin/api/jobs.js`, lines
     ~157–172) runs a blocking pre-check via `checkOllama()` whenever
     `options.llmSummaries` is true, returning a 503 with an actionable
     message *before* the indexing job is even spawned — so a missing
     Ollama never fails silently buried in job logs.
   - No auto-start exists, and this phase deliberately does not add one
     (see "Scope decisions" below).

3. **Delete collection modal** (task requirement #4). Already a clean
   button → modal → Cancel/Delete flow with no typed-name confirmation
   step — `delete-modal.html` has no text input at all, and
   `tests/unit/admin/static.test.js` already asserted this
   ("delete uses a modal confirmation, not a typed-name text input",
   explicitly checking `maint-delete-confirm`/`confirmInput` are both
   absent). Nothing to change.

## Scope decisions (confirmed before implementation)

Two items in the task description implied more than this phase built,
by design:

- **Human-readable collection names (task requirement #2).** No
  `displayName`/technical-id split was introduced. The collection name the
  user types was already usable as-is (spaces, Cyrillic — e.g. the
  existing placeholder `Основи Node.js`) and already serves as both the
  Qdrant collection name and the display name; `requireCollectionNameField`
  only rejects `/` and `\`. Building a separate technical id (slug
  generation, transliteration, a rename flow, a new config.json field)
  was explicitly scoped out for this phase — it's a real design decision
  (uniqueness handling, migration for existing collections, a new API
  contract) that deserves its own task, not a byproduct of a "usability
  baseline" pass. This phase's job here was verification: confirmed (via
  the existing "does not suggest lowercase-hyphen slug names" test) that no
  UI copy anywhere pushes users toward `my-docs`-style slugs, and no new
  copy introduced by this phase does either.
- **Ollama autostart (task requirement #3's "auto-start attempt" clause).**
  Not implemented. The existing blocking pre-check + the message pattern
  ("Ollama is not running. Start `ollama serve`, then retry.") already
  satisfies the requirement's own fallback clause ("otherwise 'start Ollama
  manually' with actionable message"). No `child_process.spawn` of Ollama
  was added — cross-platform process lifecycle management (readiness
  polling, orphan cleanup, permission prompts) is meaningfully larger scope
  than a usability pass and has no precedent elsewhere in this codebase.
  Left as a candidate for a later local-runtime/provider-settings phase.

## Simplified indexing form (task requirement #5)

The create-collection form (`index-view.html`) had all six options in one
flat row with no grouping. Changed to:

- **Visible by default** (happy path): ONNX embeddings (checked), LLM
  summaries (unchecked, "(requires Ollama)"), Skeleton chunking (checked),
  Skeleton navigation (checked).
- **Collapsed behind `<details class="advanced-box"><summary>Advanced
  options</summary>`**: Prune stale, Generate tags, and the prune-stale
  safety caveat (moved inside the disclosure since it only applies to a
  now-hidden checkbox).

Reused the exact `.advanced-box` disclosure style already used by the
search panel's "Advanced" section, rather than the settings form's heavier
`.advanced-panel` (bordered, used for read-only diagnostics — a different
concept from actionable checkboxes) or building a third style. No `app.js`
wiring changes were needed: checkbox ids are unchanged, and
`startIndexJob()` reads them via `querySelector` regardless of whether the
parent `<details>` is open or closed.

## Verification

- `npm run admin:build` — succeeds (`app.js` 54.01 kB, was 53.90 kB).
- `npm test` — 515/515 pass (was 512; +3 new tests, both old and new
  green).
- `npm run smoke` — 1293/1293 pass.
- `node --check tests/unit/admin/static.test.js` — OK.
- `git diff --check` / `git diff --cached --check` — clean (only routine
  CRLF/LF conversion notices, no whitespace/conflict-marker errors;
  nothing staged).

## Known limitations

- The Advanced-options disclosure only exists on the create-collection
  form; the settings/reindex form keeps its own separate
  Quality/Structure/Optional-enrichment/Maintenance grouping (a different,
  pre-existing pattern for a form with more options). Bringing both forms
  to one shared style is reasonable future polish, not required by this
  phase's exit gate.
- No new tests were added for folder picker / Ollama readiness / delete
  modal, since none of that code changed — their existing regression tests
  from earlier phases remain the coverage for those behaviors.
