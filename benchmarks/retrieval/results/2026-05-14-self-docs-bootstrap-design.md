# Design Audit: First-Run semidex Documentation Self-Indexing

Date: 2026-05-14

## Summary

An agent using semidex today must read repo files directly to understand
how to use semidex (providers, chunking settings, troubleshooting). A
`semidex-docs` self-indexed collection would let agents query semidex's
own documentation through MCP — no file reads, consistent context window
semantics, same retrieval tools already in use.

This audit answers seven design questions, then proposes a three-stage
implementation plan. The core recommendation is to implement as an
**explicit opt-in command** (`npm run bootstrap:docs`) rather than any
automatic behavior.

---

## Q1 — Trigger: What Is "First Run"?

### What counts as "first run"

There is no clean "first run" signal in the current architecture. Possible
proxies:

| Signal | Reliable? | Problem |
|--------|-----------|---------|
| `config.json` does not exist | No | Absent after `git clone` even on machines where Qdrant already has data |
| `semidex-docs` collection absent from Qdrant | No | Collection may have been deleted manually; re-triggering is undesirable |
| Env var `SEMIDEX_BOOTSTRAP=1` | Yes | Explicit, no ambiguity, user controls it |
| Explicit command `npm run bootstrap:docs` | Yes | Best: user intent is unambiguous |

"First run" cannot be reliably detected from filesystem or Qdrant state
alone. Any automatic trigger would fire at surprising times (fresh checkout
on an existing machine, `npm run sync` in CI, container restarts).

### Where to trigger

Candidate entry points:

| Entry point | Assessment |
|-------------|------------|
| `npm run mcp` | **No.** The MCP server starts stdio and should never block on Qdrant writes or model downloads. A first-run download of the ONNX model (~2.3 GB) during `npm run mcp` would break the Claude Code session silently. |
| `npm run sync` | **No.** `sync` is safe to re-run and is used in CI and post-upgrade. Silently triggering indexing during sync violates its "safe to repeat" contract and would add LLM calls and Qdrant writes to a previously read-only operation. |
| `npm run index` | **No.** Already has a defined purpose (index user documents). Bootstrapping docs would be an invisible side-effect. |
| `npm run bootstrap:docs` | **Yes.** Explicit, named, documented. Easy to add to setup instructions. |
| Explicit `SEMIDEX_BOOTSTRAP=1 npm run sync` flag | Acceptable variant. But a dedicated command is clearer in docs and onboarding checklists. |

### Automatic vs opt-in vs suggested command

- **Automatic**: Not recommended. Triggers ONNX model download or Ollama calls
  without user consent. Could surprise users in environments where `semidex-docs`
  is already indexed, leading to unnecessary reindexing. Violates "keep
  `npm run mcp` fast to start."

- **Opt-in env flag** (`SEMIDEX_BOOTSTRAP=1`): Acceptable for scripted
  setups, but hard to discover.

- **Suggested command** (`npm run bootstrap:docs`): Recommended. Appears
  in README setup checklist, shows estimated cost, can be skipped. Natural
  to add to the quick-start section: "Run once after setup:
  `npm run bootstrap:docs`."

**Verdict:** Implement as `npm run bootstrap:docs`. Surface in README and
`docs/en/operations.md` as an optional post-setup step.

---

## Q2 — Collection Name and Config Marking

### Name

| Option | Assessment |
|--------|-----------|
| `semidex-docs` | Clear, human-readable, unlikely to conflict with user projects |
| `semidex-internal` | Suggests more than docs (config, state) — misleading for current scope |
| `_semidex-docs` | Underscore prefix = "private", consistent with Unix conventions, but unfamiliar in Qdrant context |
| `semidex:docs` | Colon is legal in Qdrant collection names but awkward in shell commands and env vars |

**Verdict:** `semidex-docs`. Simple, obvious, consistent with the roadmap
entry that already uses this name.

### Config marking: internal/semidex-managed

The `config.json` collection entry already has extensible fields. Two
new fields are sufficient:

```json
"semidex-docs": {
  "denseProvider": "bge-m3-onnx",
  "denseModel": "aapot/bge-m3-onnx",
  "sparseProvider": "bge-m3-onnx",
  "embeddingSchemaVersion": 2,
  "vectorSize": 1024,
  "description": "semidex documentation — indexed by bootstrap:docs",
  "semidexManaged": true,
  "linkDisabled": true
}
```

`semidexManaged: true` is a new config-level field. Its purpose:

- `sync.js` can skip linkDisabled/schema-degradation warnings for this
  collection (it is expected to be managed)
- `bootstrap:docs` can detect "already bootstrapped" without a Qdrant round-trip
- Future tooling (agent wake-up wizard, diagnostic bundle) can filter it in
  or out as needed
- Does NOT affect indexing or retrieval behavior — purely metadata

`linkDisabled: true` prevents `semidex-docs` from appearing as a link
target when user project files are indexed. See Q5 for rationale.

### Visibility in `qdrant_collection_info`

`qdrant_collection_info` lists all Qdrant collections with their metadata.
`semidex-docs` should be visible — it is a valid retrieval target and agents
need to know it exists. The `description` field is the natural way to signal
its role:

```
semidex-docs  — semidex documentation — indexed by bootstrap:docs
```

No special filtering or suppression is needed. Showing `semidexManaged: true`
in the collection info output is optional but helpful.

---

## Q3 — Indexed Sources

### Minimum useful set

| File/path | Include? | Rationale |
|-----------|----------|-----------|
| `README.md` | Yes | Entry point; setup instructions, quick start |
| `AGENTS.md` | Yes | Agent instructions; MCP workflow; search tactics |
| `docs/en/architecture.md` | Yes | Pipeline phases, data model, local models |
| `docs/en/retrieval.md` | Yes | Hybrid search, RRF, providers, MMR/literal status |
| `docs/en/mcp-tools.md` | Yes | Tool reference and agent patterns |
| `docs/en/configuration.md` | Yes | All env vars |
| `docs/en/operations.md` | Yes | Usage, troubleshooting |
| `docs/en/benchmarking.md` | Yes | Profiler, smoke, benchmark commands |
| `docs/en/project-structure.md` | Yes | Source tree |
| `docs/en/roadmap.md` | Yes | Decisions, deferred items, next planned work |
| `docs/en/obsidian.md` | Yes | Review layer for completeness |
| `docs/en/chunking-quality.md` | Yes | Chunking rationale |
| `docs/en/README.md` | Optional | Index file; low information density |

**Minimum corpus:** `README.md` + `AGENTS.md` + all `docs/en/**/*.md`.
This is a small corpus (~12 files, ~6,000–10,000 tokens estimated). Full
indexing with ONNX takes under a minute.

### docs/ua/ — Ukrainian docs

**Defer.** The Ukrainian docs are a translation layer, not a primary
information source. Including them doubles the corpus size and creates
near-duplicate chunks that would bloat search results without adding unique
retrieval value. If multilingual query support is needed later, add
`docs/ua/` as a separate `semidex-docs-ua` collection rather than mixing
into `semidex-docs`.

Exception: if a meaningful portion of content exists only in `docs/ua/` and
not in `docs/en/`, include those files explicitly.

### Roadmap + benchmark reports

| Path | Include? | Rationale |
|------|----------|-----------|
| `docs/en/roadmap.md` | Yes | Already in minimum set — decisions, deferred items, next work |
| `benchmarks/retrieval/results/*.md` | No | Audit noise: 10+ reports with predicted values, per-query tables, candidate comparisons |

The benchmark reports are useful for human review but generate noisy chunks
for agent retrieval. A query like "why is MMR deferred?" is answered cleanly
by `roadmap.md`; the full audit report would produce lower-quality hit
candidates around tables and predicted query scores.

**Exception:** if an agent needs to answer "what was the result of the
duplicate-source pressure audit?", direct it to read the file rather than
search. Benchmark reports are a human artifact, not a knowledge base.

---

## Q4 — Provider Choice

### Recommended provider: ONNX if available

```
ONNX_EMBED=1 COLLECTION=semidex-docs npm run index ./
```

Rationale:
- `semidex-docs` will be queried by agents using the same MCP tools
  and search path as any other collection
- ONNX (bge-m3-onnx) gives better exact-token and multilingual retrieval
  than `ollama + hashed-tf`
- semidex documentation contains many exact technical terms: env vars,
  function names, CLI flags, error messages — exactly where bge-m3 sparse
  wins over hashed-tf (confirmed by 100% tokenHit@5 on custom-raw benchmark)
- The `bootstrap:docs` command should default to ONNX and document the
  download cost once, clearly

### Fallback on ollama/hashed-tf

Allowed but suboptimal. If the user does not have ONNX available, the
fallback path works — hashed-tf will handle plain keyword queries adequately.
The bootstrap command should:
1. Default to ONNX
2. Print a notice if ONNX model is not yet cached: "This will download
   ~2.3 GB on first use. Re-run with `ONNX_EMBED=0` to use Ollama instead."
3. Not override the user's `.env` provider settings silently

### If Ollama/ONNX is unavailable

If `npm run bootstrap:docs` is run with `ONNX_EMBED=1` but ONNX model is
not cached, the indexer downloads it automatically on first use (already
implemented). This is expected behavior and the cost is already documented.

If Ollama is unavailable and `ONNX_EMBED=0`, context/tag LLM calls will
fail with `fetch failed`. The command should fail fast and print: "Context
and tag generation requires Ollama. Start Ollama and retry, or use
`ONNX_EMBED=1` (downloads ~2.3 GB model on first use)."

This is not a new error — it is the same behavior as any other `npm run index`
call. No special handling needed beyond existing error messaging.

---

## Q5 — Safety

### Isolation from user project link targets

`linkDisabled: true` in `config.json` for `semidex-docs` prevents:
- Indexer from creating cross-file links from user documents into
  `semidex-docs` chunks
- Indexer from creating cross-file links from `semidex-docs` into user
  collections

Without `linkDisabled`, a user indexing their project docs might get
a link from their `architecture.md` to `semidex-docs/architecture.md`
because both discuss architectural concepts. This is noise, not signal.

The `resolveLinkCollections` function already implements this correctly:
any collection with `linkDisabled: true` in config is excluded from link
targets unless it is the current collection being indexed. The
`semidex-docs` bootstrap would set `linkDisabled: true` automatically,
so no code change is needed.

One nuance: when running `npm run bootstrap:docs`, the `semidex-docs`
collection itself would have `linkDisabled: true`, but that is the
**current** collection during bootstrap. `resolveLinkCollections` always
includes the current collection regardless of `linkDisabled` — meaning
`semidex-docs` files will still link to each other internally. This is
the correct behavior.

### Exclusion from PRUNE_STALE user runs

`PRUNE_STALE=1` is scoped to a directory target. The user runs:

```bash
PRUNE_STALE=1 COLLECTION=my-docs npm run index ./my-project/
```

`semidex-docs` is a different collection name, so `PRUNE_STALE` for
`my-docs` cannot touch it. There is no cross-collection PRUNE_STALE.

**No issue here.** The only scenario where semidex-docs could be accidentally
pruned is if the user explicitly runs:
```bash
PRUNE_STALE=1 COLLECTION=semidex-docs npm run index ./
```
against the semidex repo root. This would correctly prune stale docs files
(e.g. after a docs rename). Intentional behavior.

### Preventing accidental reindex/download during `npm run mcp`

`npm run mcp` starts the MCP stdio server and does zero Qdrant writes. It
does not call the indexer, does not read providers, and does not touch
`config.json` at runtime. There is no path by which `npm run bootstrap:docs`
logic could be triggered from `npm run mcp` unless explicitly wired in.

As long as `bootstrap:docs` is a separate `scripts` entry in `package.json`,
this concern does not arise. No runtime gating needed.

### What if `semidex-docs` already exists?

`npm run bootstrap:docs` should:
1. Check if the collection exists in Qdrant
2. If it does, check if `semidexManaged: true` is in `config.json`
3. If already indexed and current (hash skip will fire for unchanged files),
   print: "semidex-docs already up to date (N files unchanged)."
4. If the collection exists but is **not** marked `semidexManaged`, warn
   and exit: "A collection named 'semidex-docs' exists but was not created
   by bootstrap:docs. Refusing to overwrite."

This prevents accidental clobbering of a user collection with an unfortunate name.

---

## Q6 — Agent UX

### How agents discover semidex-docs

`qdrant_collection_info` is the recommended first call per AGENTS.md. It
already returns collection descriptions. With a clear description:

```
semidex-docs  — semidex usage, configuration, troubleshooting, and MCP
                reference. Indexed by `npm run bootstrap:docs`.
```

Agents will see it alongside user project collections and can choose to
search it for how-to queries.

No new MCP tool is needed. The existing `qdrant_search` handles it.

### description in qdrant_collection_info

The `description` field in `config.json` is returned by `qdrant_collection_info`.
Recommended value:

```
semidex usage docs: providers, indexing, retrieval, MCP tools, troubleshooting, architecture
```

This is dense with retrieval-relevant keywords, which helps agents recognize
it as the right collection for a "how do I..." query.

### Example queries that should work

| Query | Expected source files |
|-------|-----------------------|
| "how do I index docs?" | `docs/en/operations.md`, `README.md` |
| "what provider should I use?" | `docs/en/operations.md` (recommended: ONNX if available) |
| "why is Qdrant search returning low scores?" | `docs/en/retrieval.md` (RRF score interpretation) |
| "what env vars control chunk size?" | `docs/en/configuration.md` (MAX_CHUNK_TOKENS etc.) |
| "how does contextualization work?" | `docs/en/architecture.md` |
| "what MCP tools are available?" | `docs/en/mcp-tools.md`, `AGENTS.md` |
| "how do I prune stale files?" | `docs/en/operations.md` |
| "what is the recommended search pattern?" | `AGENTS.md` |
| "why isn't my PDF getting section headings?" | `docs/en/architecture.md`, `docs/en/operations.md` |
| "what does INDEX_PROFILE=1 do?" | `docs/en/benchmarking.md` |

All of these involve technical terms (env vars, config keys, MCP tool names)
that benefit from bge-m3-onnx sparse encoding. The corpus is small and
well-structured Markdown — ideal for semidex's chunker.

### Agent query pattern for semidex-docs

```text
qdrant_search("how do I...", "semidex-docs", window=1, window_format="compact", top=3)
```

No changes to the MCP API needed. Agents already know this pattern.

---

## Q7 — Minimal Implementation Plan

### Stage 1 — docs/config only (no runtime changes)

**Files to create/edit:**

| File | Change |
|------|--------|
| `docs/en/operations.md` | Add "Documentation Self-Index" section: purpose, command (once implemented), what gets indexed, provider recommendation |
| `docs/en/roadmap.md` | Task 8: mark as "design audit complete; Stage 2 is `bootstrap:docs` command" |

**Config shape defined (but not yet written by any command):**
Document the `semidexManaged: true` field semantics in `docs/en/configuration.md`.

No runtime code changes. No new npm script. No Qdrant writes.

**Deliverable:** An agent reading `semidex-docs` (once it exists) can answer
"how was `semidex-docs` created and what is in it?"

### Stage 2 — explicit `npm run bootstrap:docs` command

**New file:** `src/bootstrap-docs.js`

Responsibilities:
1. Resolve semidex repo root (relative to `import.meta.url`)
2. Define source list: `['README.md', 'AGENTS.md', 'docs/en']` (relative
   to repo root)
3. Check if `semidex-docs` already exists in Qdrant
   - If yes + `semidexManaged: true` in config → proceed (hash-skip handles
     unchanged files)
   - If yes + NOT `semidexManaged` → warn and exit
4. Create or verify collection `semidex-docs` with ONNX provider
5. Run indexer logic for the defined source list
   (call `main()`-equivalent with hardcoded collection and source list, or
   shell out to `npm run index`)
6. Write `semidexManaged: true` + `linkDisabled: true` to `config.json`
   before spawning the indexer, then re-apply after success. This keeps
   retries safe if the first run creates the Qdrant collection but fails
   before all docs are indexed.

**Invocation path — child_process vs programmatic import**

`src/indexer/index.js` currently does not export `indexFile` or `main()` —
the guard at the bottom (`if (process.argv[1] && ...index.js...`) prevents
accidental double-execution when imported, but there is no exported API.

Two options:

| Option | Pros | Cons |
|--------|------|------|
| **A. child_process.spawn** — `bootstrap-docs.js` spawns `node src/indexer/index.js <path>` with a constructed `env` object | No refactor of indexer; env isolation is clean; `ONNX_EMBED`, `COLLECTION`, `SOURCE_ROOT` set in `env` dict (cross-platform) | Slightly more verbose; exit code forwarding needed |
| **B. Export programmatic API** — add `export { indexFile }` to `index.js`, import and call directly | Tighter integration; single process; easier to unit test | Requires small refactor; guard logic must be updated |

**Recommended for Stage 2: Option A (child_process).** No refactor, no
risk of accidentally running `main()` twice, and env variables are set
in JS (`env: { ...process.env, ONNX_EMBED: '1', COLLECTION: 'semidex-docs',
SOURCE_ROOT: repoRoot }`) — fully cross-platform, no shell env-prefix.

Option B is a better long-term shape if a programmatic API is wanted for
testing or embedding. Document as a Stage 2 follow-up if needed.

**package.json** addition:
```json
"bootstrap:docs": "node src/bootstrap-docs.js"
```

No env-prefix in the script value — Windows `npm run` does not support
`KEY=value node ...` syntax. All env variables (`ONNX_EMBED`, `COLLECTION`,
`SOURCE_ROOT`) are set inside `bootstrap-docs.js` before spawning the
child process.

**Key implementation constraint:**
`bootstrap-docs.js` should derive its source paths from `import.meta.url` so
it works regardless of the user's current working directory. The semidex repo
location is fixed relative to this script; user documents are not.

**Smoke tests (no live Qdrant):**

| Case | Assert |
|------|--------|
| `resolveDocsRoot()` returns absolute path to repo root | `path.isAbsolute(root)` === true |
| Source list contains `README.md`, `AGENTS.md`, `docs/en` | All three present |
| `semidexManaged` config field round-trips through `loadConfig/saveConfig` | Field survives JSON serialization |
| Collision detection: non-managed collection → reject | Returns error message, does not write config |

**Live smoke tests (with Qdrant):**

| Case | Assert |
|------|--------|
| `npm run bootstrap:docs` completes without error | Exit code 0 |
| `semidex-docs` collection exists in Qdrant after run | `listCollections()` includes it |
| `config.json` has `semidexManaged: true`, `linkDisabled: true` for `semidex-docs` | Config fields present |
| Re-run → all files skipped (hash unchanged) | Console output: "N files unchanged" |
| `qdrant_search("hybrid search", "semidex-docs")` returns retrieval.md chunks | At least 1 hit |

### Stage 3 — optional first-run suggestion/wizard (not planned now)

Could add to `npm run sync` output:
```
Tip: semidex-docs collection not found.
     Run `npm run bootstrap:docs` once to let agents query semidex usage through MCP.
```

This is a passive suggestion on stdout, not an automatic action. Low priority —
Stage 2 command in README is sufficient for onboarding.

### Smoke tests to add without live Qdrant

Four pure-unit cases (no Qdrant, no LLM):
1. `resolveDocsRoot()` → absolute path
2. `getBootstrapSources(root)` → array containing `README.md`, `AGENTS.md`,
   `docs/en` (all three present, no undefined entries)
3. `semidexManaged` field survives `loadConfig/saveConfig` round-trip
4. Non-managed collection name collision returns error message (unit test
   of the collision check logic, not a Qdrant call)

Location: Section 15 — Bootstrap Docs in `src/smoke.js`.

---

## Cross-Cutting Concerns

### What happens when semidex docs are updated

Docs change when features are added or audits are committed. The user re-runs:
```bash
npm run bootstrap:docs
```
Changed files are reindexed (new hash); unchanged files are skipped. No
special "update" mode needed — the existing hash-based skip already handles
this correctly.

### `source_file` paths in semidex-docs

The bootstrap command should set `SOURCE_ROOT` to the semidex repo root.
This ensures `source_file` values are stable relative paths like:
- `README.md`
- `AGENTS.md`
- `docs/en/architecture.md`

Without `SOURCE_ROOT`, `source_file` paths depend on the working directory
where `bootstrap:docs` is run, which could vary.

### vectorSize

Default `VECTOR_SIZE=1024` matches bge-m3-onnx. No change needed.

### Chunking settings

Default `MAX_CHUNK_TOKENS` is appropriate for Markdown docs. No special
tuning needed for the semidex corpus.

### `chunks_out/` artifacts

The indexer writes `chunks_out/` artifacts by default. For `semidex-docs`,
these are low value (the source files are already readable). The bootstrap
command could set `CHUNKS_OUT_DIR=/dev/null` (or Windows equivalent), but
this is a minor cosmetic concern, not a blocking issue.

---

## Recommendation

**Implement now at Stage 2 level: `npm run bootstrap:docs` explicit command.**

Rationale for "implement now" vs "defer":
- The corpus is small (~12 files), the command is short (~60 lines), and
  the infrastructure is all in place: indexer, config schema, `linkDisabled`
  isolation, hash-based skip
- The agent UX benefit is immediate: agents can use `qdrant_search` on
  semidex's own docs instead of reading files
- No new MCP tools, no new Qdrant schema changes, no new providers
- The main design risks (provider availability, accidental reindex, link
  pollution) are addressed by `linkDisabled`, explicit trigger, and
  `semidexManaged` collision guard

**Safest first implementation shape:**

```
src/bootstrap-docs.js (new, ~70 lines)
  - hardcoded source list
  - resolves repo root from import.meta.url
  - sets process.env.ONNX_EMBED, COLLECTION, SOURCE_ROOT before spawn
  - spawns child_process with node src/indexer/index.js per source path
  - writes semidexManaged + linkDisabled to config.json before spawning
    and re-applies them after success
  - detects collision with non-managed existing collection

package.json: add "bootstrap:docs" script
docs/en/operations.md: add "Documentation Self-Index" section
src/smoke.js: Section 15, 4 pure-unit cases
```

**Exact next coding task if approved:**

1. Write `src/bootstrap-docs.js` — resolves repo root, defines source list,
   checks collision, writes `semidexManaged` + `linkDisabled` to config.json,
   spawns indexer as child process with env dict (cross-platform), then
   re-applies the managed config fields after success.
2. Add `bootstrap:docs` to `package.json` scripts.
3. Add Section 15 pure-unit smoke cases to `src/smoke.js`.
4. Add "Documentation Self-Index" section to `docs/en/operations.md`.
5. Update roadmap task 8: mark design audit complete.

**Defer Stage 3** (sync suggestion wizard) until Stage 2 has been used in
practice. The "Tip:" suggestion in sync output is a nice-to-have, not
required for correctness.

---

## Open Questions (Not Blocking Stage 2)

1. **Should `bootstrap:docs` index `docs/ua/`?** Current answer: no. If
   a multilingual semidex user needs Ukrainian docs in MCP, revisit as
   `semidex-docs-ua`. Not a Stage 2 concern.

2. **Should `qdrant_collection_info` distinguish managed vs user collections
   visually?** Could add a `[managed]` tag in the output. Low priority —
   the `description` field already signals it.

3. **Should `chunks_out/` be suppressed for `semidex-docs`?** Minor cosmetic
   issue. Could set `CHUNKS_OUT_DIR` to a dedicated path or suppress it.
   Not blocking.

4. **Should `semidexManaged` prevent `PRUNE_STALE`?** No — `PRUNE_STALE` is
   already scoped to the current `COLLECTION`. An accidental
   `PRUNE_STALE=1 COLLECTION=semidex-docs npm run index ./docs/en` would be
   user-initiated and intentional. No guard needed.
