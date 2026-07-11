# Admin UI Phase 3T — Shared Structural Entity Renderer

Implements Phase 3D from `docs/design/admin-ui-ux-and-ask-plan.md`.

## What changed

### Domain contract: `rawContent`/`lang` now flow through the storage adapter

The indexer already persisted everything this phase needed — confirmed
directly in the production write path before touching any code:

- `src/indexer/phases/skeleton-chunk.js`'s `payload_raw_embed_context` case
  (table/code_block/checklist) sets `raw_content: n.rawContent` and
  `lang: n.lang` (conditionally, when present) on every structural chunk.
- `src/indexer/phases/skeleton.js` sets `lang` directly from remark's own
  mdast `code` node `.lang` field (the fence info-string, e.g. ` ```js `) —
  not a heuristic.
- `src/indexer/skeleton-payload.js`'s `skeletonPayloadFields()` writes
  `raw_content` unconditionally and `lang` conditionally into the actual
  Qdrant point payload for every skeleton-v1 chunk.

No indexer change, no schema bump, no reindexing needed.

What was actually missing was the **read side**: `src/core/storage/
qdrant-adapter.js`'s `toChunk()` and `toStructuralNodeChunk()` never mapped
`raw_content`/`lang` from the Qdrant payload onto the domain `Chunk` shape at
all — every structural chunk reaching the UI layer had `rawContent`/`lang`
simply absent. Both functions now map:

```js
rawContent: p.raw_content ?? null,
lang:       p.lang ?? null,
```

`text` stays a separate field (unchanged), following the same snake_case→
camelCase, missing-becomes-null convention already established by every
other field in this file (`toSkeletonNode()`'s `headingPath` was the closest
existing precedent). `toStructuralNodeChunk()`'s pre-existing `text` fallback
chain (`payload.text ?? payload.raw_content ?? payload.rawContent ?? null`)
was simplified to `payload.text ?? payload.raw_content ?? null` now that
`rawContent` is its own first-class field — `rawContent` itself always comes
straight from `payload.raw_content`, never through a fallback.

Six new tests in `tests/unit/core/storage/qdrant-adapter.test.js` cover:
table/code_block mapping, `lang` present/absent, no snake_case key ever
leaking onto the domain object.

### `structural-renderer.js` — the shared renderer

New `src/admin/ui-src/structural-renderer.js`, a real ES module (not
inlined into the vm-context test harness the way most `ui-src` files are —
see Tests below) with real npm dependencies:

- **Table**: `nodeType === 'table'` is parsed with the exact same `unified`
  + `remark-parse` + `remark-gfm` stack the indexer already uses (no
  handwritten `split('|')` parser). A real `<table>/<thead>/<tbody>/<tr>/
  <th>/<td>` is built via DOM APIs, one `textContent` assignment per cell —
  inline markdown inside a cell (bold, code spans, links) is flattened to
  its plain text only, never rendered as markup. Column alignment
  (`table.align` from the mdast tree) becomes an inline `text-align` style
  per header/cell. Parse failure (anything that isn't a real GFM table, or
  empty content) falls back to raw-only display with no toggle and no
  throw.
- **Code**: `highlight.js` (`highlight.js/lib/core` + 15 curated grammar
  imports — see Bundle below) strips the fence delimiters, resolves
  `chunk.lang` against a fixed `REGISTRY`/`ALIASES` map (never passes the
  raw untrusted `lang` string into `hljs` itself), highlights on an exact
  match, autodetects across the curated subset when `lang` is missing or
  unresolvable, and falls back to plain, unhighlighted text if even
  autodetection fails (empty/near-empty content). Explicit vs. guessed
  language is a genuinely different badge class
  (`structural-code-lang-explicit` amber vs. `structural-code-lang-guessed`
  dim grey), with `guessed:` as a visible text prefix too.
- **Rendered/Raw toggle**: one segmented control per structural chunk.
  Rendered is the default on a successful parse/highlight; Raw is the
  default on failure. Switching is a pure DOM swap between two subtrees
  already built at render time — no network call either direction, verified
  behaviorally (see Tests).
- Everything reads from `const raw = chunk.rawContent ?? chunk.text ?? ''`
  — the module never fetches `/node` or calls `qdrant_get_node`.
- `STRUCTURAL_RENDER_TYPES = new Set(['table', 'code_block'])` — deliberately
  narrower than `file-view.js`'s existing `STRUCTURAL_NODE_TYPES` (which also
  includes `checklist`, for the badge/label system only). Checklist chunks
  are out of scope this phase and keep rendering as plain text, exactly as
  before.

### Search and file/section view integration

`search.js`'s `renderResult()` and `file-view.js`'s `renderFileChunks()`
both had one line doing `card.querySelector('.chunk-text').textContent =
... ?? ''` — both now call `renderChunkContent(card.querySelector
('.chunk-text'), chunk)` instead. No other line in either function changed:
rank/source/score/section/node-type metadata, the "Open chunk"/"Open file
section" button logic, pagination, window=0, target-chunk highlighting, and
section-window loading are all untouched. `renderChunkContent()` replaces
the `<pre class="chunk-text">` element in place with a `<div class=
"structural-render-root">` for table/code chunks (or leaves it as a plain
`<pre>` with `textContent` set for everything else) — it lives directly
inside the existing `.chunk-evidence`/`.result-evidence` content area, not
wrapped in a new decorative card.

No shared constant needed to move out of `file-view.js` — `structural-
renderer.js` doesn't import anything from `file-view.js` or `search.js`
(only from `unified`/`remark-parse`/`remark-gfm`/`highlight.js`), so there
was no circular-import risk to resolve.

### Styling

New CSS block in `app.css` (`.structural-render-root`, `.structural-toggle*`,
`.structural-table*`, `.structural-code*`, `.hljs-*` token colors): a
horizontally-scrollable table wrapper (`overflow-x: auto` on the wrapper,
confirmed via live measurement that the page itself never widens — see
Verification), compact table density matching the existing `.badge`/`td.mono`
conventions, a visible amber-on-dark header row, code background using the
existing `--bg-inset` token with stable padding, a language badge, a
segmented Rendered/Raw control with `:focus-visible` styling matching every
other interactive control in this file, and an explicit (empty)
`prefers-reduced-motion` rule documenting that no animation is used here in
the first place (the toggle is an instant DOM swap). highlight.js token
colors are mapped onto the existing `--amber`/`--ok`/`--warn`/`--fail`/
`--ink*` palette rather than importing a stock highlight.js theme — no new
color system introduced. This is a single dark theme (no light-theme
toggle exists in this codebase), so no light/dark duplication was needed.

## What did NOT change (explicit scope boundary)

- No document stitching, no `entity_refs`, no placeholder resolution — that
  is Phase 3E.
- No `/node`/`qdrant_get_node` calls, no full-node retrieval.
- No image/OCR rendering, no copy/download attachments.
- No Ask/chat, no new Qdrant methods, no LLM-generated descriptions.
- Checklist rendering is unchanged (still plain text + existing badge).
- No arbitrary Markdown-to-HTML rendering — table cells render plain text
  only, by design (the task's explicit MVP scope), not a rich inline-markdown
  renderer.
- No handwritten table parser — the existing remark/gfm stack does 100% of
  the parsing.

## Tests

`tests/unit/admin/ui-structural-renderer.test.js` — 40 new tests. The
renderer is loaded as a real ES module rather than through the
`vm.runInContext` + `stripExports()` convention because it has real npm
dependencies (`unified`, `remark-parse`, `remark-gfm`, `highlight.js`) that
a bare vm script cannot resolve. DOM creation uses the target container's
`ownerDocument`, so the module does not need a process-global test document
and cannot mix nodes from different linkedom document realms.

Coverage:
- **Type detection**: table/code_block only in `STRUCTURAL_RENDER_TYPES`;
  checklist, plain prose, and no-nodeType chunks all render via `textContent`
  with no toggle.
- **Content source contract**: `rawContent` preferred over `text`; falls
  back to `text`; empty string (not `"null"`/`"undefined"`) when both are
  absent; a structural chunk with only `text` (no `rawContent`) still
  renders correctly.
- **Table rendering**: real `<table>` structure, header/body cell text and
  order, alignment metadata as inline styles, horizontal-scroll wrapper,
  single-column and header-only edge cases, inline markdown in a cell
  flattened to plain text.
- **Table security**: `<img onerror>` and `</table><script>` in a cell never
  become live elements; invalid table markdown and empty content fall back
  safely with no throw; a parse failure shows no toggle (no false
  "Rendered" affordance).
- **Code rendering**: fence stripping, explicit `javascript` highlighting,
  alias resolution (`py`→python, `sh`→bash, `yml`→yaml, `cs`→csharp,
  `html`→xml), autodetection with a `guessed:` marker, an unknown explicit
  language not throwing, empty content showing a `plaintext` badge, the
  toggle always present even on the plaintext fallback.
- **Code security**: a battery of untrusted `lang` values (`__proto__`,
  `constructor`, path-traversal-shaped, `<script>`, empty string) never
  reaching `hljs.highlight()` with unregistered input and never throwing;
  `</code><script>` and `<img onerror>` inside code content never become
  live elements.
- **Rendered/Raw toggle**: byte-exact raw `textContent` for both table and
  code (pipes/whitespace/linebreaks/fences all preserved exactly); switching
  back to Rendered restores the parsed view with no re-fetch; Rendered is
  the default/active state on success; a `fetch` spy confirms zero network
  calls across a full render + toggle cycle.

Two pre-existing XSS-regression tests (Phase 3O/3P, `ui-search.test.js` and
`ui-file-view.test.js`) asserted the *old* plain-`<pre>`-with-raw-textContent
shape for structural chunks — updated to assert the same security property
(`querySelectorAll('img')`/`querySelector('script')` still empty) against the
new rendered shape instead, plus one added test confirming a valid GFM table
with a malicious cell renders as a real, safe `<table>` (not just a raw-text
fallback). See "Bugs found and fixed this phase" below for how one of these
updates initially had its own bug.

`tests/unit/admin/ui-test-helpers.js` deliberately does **not** import the
structural renderer. Its default is a lightweight plain-text renderer, so
unrelated router/sidebar/icon tests do not load the unified/remark/highlight
dependency graph in every Node test worker. Tests that verify structural
rendering inject the real `renderChunkContent` explicitly; existing helper
call sites remain synchronous.

## Bugs found and fixed this phase

- **My own test had a false-positive XSS assertion.** The rewritten
  `ui-file-view.test.js` code_block XSS test initially asserted
  `frag.querySelector('div') === null` against the *whole* rendered
  fragment — but the chunk-card template's own root element is a real
  `<div class="chunk">`, so the assertion always failed, matching the
  card wrapper itself rather than checking whether the adversarial
  `<div onclick=...>` string had been parsed into markup. Fixed by scoping
  the query to `codeEl.querySelector('div')` (inside the `<code>` element
  specifically) instead of the whole fragment.
- **That false-positive assertion caused real memory exhaustion while Node
  tried to format the test failure**, and cost real debugging time before the actual cause was
  found: `assert.equal(actual, null)` failing on a linkedom DOM element
  triggers Node's assertion-error formatter to stringify the mismatched
  `actual` value for the diff message — and linkedom nodes carry circular
  `parentNode`/`ownerDocument`/internal-symbol references. Console-printing
  or diff-formatting one of these directly is extremely expensive. This is
  what exhausted memory; it was not an infinite loop or retained-object leak
  in `structural-renderer.js`. Isolated and confirmed via systematic
  bisection (`node --test --test-concurrency=1` on progressively smaller
  slices, then a minimal repro script with a hard `timeout`), not by
  inspection alone. Once the assertion itself was fixed to compare a
  scoped query result, all DOM-absence assertions in the affected tests were
  changed to compare booleans rather than DOM objects. The same four-file
  suite then completed in under 1.5 seconds at full default parallelism with
  a 512 MB heap limit. The shared test helper was also kept free of the heavy
  renderer dependency graph to reduce baseline memory in unrelated workers.

## Bundle

`highlight.js@^11.11.1` (BSD-3-Clause) added as a regular dependency.
Curated import — `highlight.js/lib/core` (the minimal registration API, not
the full auto-detect-everything package) plus 15 individual grammar modules:
JavaScript, TypeScript, Python, Bash, Shell, JSON, YAML, SQL, XML (covers
HTML via the `html` alias), CSS, Markdown, Java, C#, C++, C. Confirmed via
an unminified debug build (`vite build --minify false`) that exactly these
15 grammar functions (`bash`, `c`, `cpp`, `csharp`, `css`, `java`,
`javascript`, `json`, `markdown`, `python`, `shell`, `sql`, `typescript`,
`xml`, `yaml`) are present in the bundle — no unrelated language grammar
(Ruby, Go, Rust, PHP, etc.) leaked in. `grep` for CDN/jsdelivr/unpkg/dynamic-
`import(\`https...\`)` patterns in the built JS returned nothing — the
bundle is fully self-contained, no runtime network dependency.

Bundle size, measured via a real before/after in a temporary git worktree
checked out at the last commit (`c3ce7e3`, predating this phase), so the
comparison isolates exactly this phase's contribution:

| | JS (raw) | JS (gzip) | CSS (raw) | CSS (gzip) |
|---|---|---|---|---|
| Before (HEAD) | 56.31 kB | 16.21 kB | 18.16 kB | 4.18 kB |
| After (this phase) | 256.17 kB | 76.52 kB | 20.74 kB | 4.65 kB |
| Delta | +199.86 kB | +60.31 kB | +2.58 kB | +0.47 kB |

This is a real, substantial cost — `unified`+`remark-parse`+`remark-gfm`+
`highlight.js` (core + 15 grammars) is the large majority of it. Worth
naming plainly rather than burying: this is the trade-off for real syntax
highlighting and real GFM table parsing reusing the indexer's own stack,
against a handwritten/no-highlighting alternative that would have shipped
smaller but violated the task's explicit "no handwritten table parser" /
"use highlight.js, not a from-scratch highlighter" constraints.

## Real-data validation

Two real Qdrant Cloud collections plus one freshly-indexed synthetic fixture
(needed because neither real collection's markdown source happened to
contain a well-formed GFM table, only prose describing database tables
conceptually — confirmed by fetching every real chunk for the one file a
tag search suggested and finding zero `nodeType === 'table'` chunks in it).

**A large real Python/web-development course collection** (91 files, code-
heavy): search and file-view both rendered real `code_block` chunks
correctly — one hit with `lang: 'python'` (explicit, amber badge, no
"guessed" prefix) and one with no `lang` at all (autodetected, correctly
showing `"guessed: python"` in the dim badge variant). File view opened the
same chunk from a search result's "Open chunk" button, sidebar stayed in
sync, target-chunk highlighting worked, and switching that chunk to Raw
mode showed the exact fenced source (`` ```python\nimport pytest... ``,
fence intact) with no other chunk's Rendered state disturbed. Zero console
errors across the whole session.

Measured code-language coverage across a 25-file sample (180 real
`code_block` chunks) of this collection, as requested — reported as a
measurement, not tuned for:

- **Explicit + curated-set-resolvable**: 53 (29.4%)
- **Explicit + NOT in the curated set**: 90 (50.0%) — mostly mislabeled or
  noise fence tags from the source authoring/tooling (`routeros`, `pgsql`,
  `stylus`, `vim`, `ini`, `apache`, `ruby`, `angelscript`, and 30+ other
  one-off values that don't correspond to the code's actual language)
- **No `lang` at all**: 37 (20.6%)
- Both the "unsupported explicit" and "missing" groups (70.6% combined) fall
  through to autodetection across the curated 15-language subset — this is
  real, load-bearing behavior on this data, not a rarely-hit edge case.

**A benchmark structural-carryover collection** (used in an earlier phase's
work, per project memory): confirmed via search that its `table`-tagged
chunk is a semantic content tag (the text discusses database tables), not a
`node_type: 'table'` structural chunk — none of this file's 41 real
retrieval chunks have `nodeType === 'table'`, confirmed by fetching all of
them via `/api/collections/:name/chunks`. This collection's fenced code
blocks did surface several more real unsupported/mislabeled-lang examples
(`sas`, `dsconfig`, `ini`, `angelscript`, `routeros`, `pgsql`) — same
autodetect-fallback path exercised again on different real content.

**Synthetic fixture (real indexing run, not fabricated chunks)**: a small
markdown file with a real GFM table, an explicit-`python`-labeled code
block, an unlabeled fenced block, and a 7-column wide table, indexed through
the real `POST /api/jobs/index` pipeline (`onnxEmbed: true,
skeletonChunking: true` — Ollama was needed too, for sparse embedding; it
was not running at the start of this phase's live-verification pass and was
started for the duration of the check) end to end into a disposable
collection. This is what let me directly confirm the exact-raw contract
against a real HTTP round trip rather than only a unit test: fetched the
table chunk's `rawContent` from `GET /api/collections/:name/chunks`,
clicked that same chunk's Raw toggle in the live browser, and asserted
`element.textContent === apiResponse.rawContent` — **true**, byte-for-byte.
The wide (7-column) table's wrapper measured `scrollWidth (976px) >
clientWidth (850px)` — genuinely overflowing its own box and thus actually
exercising the horizontal-scroll container — while `document.body.
scrollWidth === document.body.clientWidth` throughout, confirming the page
itself never widens even when a table's content does overflow. Disposable
collection deleted afterward via `DELETE /api/collections/:name`; both the
admin server and the Ollama service started for this check were stopped
afterward.

## Verification run

- `npm test` — 894/894 passing (848 baseline before this phase + 6 adapter-
  mapping tests + 40 structural-renderer tests, net of no deletions).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build (223 modules).
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings on files
  this phase touched).
- Live Playwright verification — see "Real-data validation" above.

## Known limitations

- **Table cells render plain text only**, by design (this phase's explicit
  MVP scope) — a cell containing a link, image, or nested emphasis shows
  its flattened text, not a rendered inline element. Revisit only if a
  future phase's task explicitly asks for richer cell rendering.
- **Checklist chunks are untouched** — still the pre-existing plain-text +
  badge treatment. Bringing checklist into the shared renderer (e.g. real
  `<input type="checkbox" disabled>` elements) is not in this phase's scope
  and would need its own task.
- **highlight.js's `highlightAuto()` on genuinely ambiguous/very short input
  almost always returns *some* guess with `relevance >= 1`** (confirmed via
  direct testing — even a single out-of-context character can score a
  spurious CSS match) rather than reliably falling through to the
  `plaintext` label; the true plaintext-fallback path is really only
  reached on empty/whitespace-only content. This is inherent to how
  highlight.js's relevance scoring works, not a bug in this phase's
  integration — noted here since a "guessed: css" badge on a one-line
  snippet of unrelated text is visually a low-confidence-looking result,
  even though the code faithfully reports what highlight.js itself
  returned.
- **Bundle-size delta (+200 kB raw / +60 kB gzip)** is the direct, expected
  cost of `unified`/`remark-parse`/`remark-gfm`/`highlight.js` — see Bundle
  above. No further trimming was attempted this phase (e.g. a lighter GFM-
  table-only parser instead of the full remark pipeline) since reusing the
  indexer's exact parsing stack was an explicit task requirement, not an
  incidental choice.
