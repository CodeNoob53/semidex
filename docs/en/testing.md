# Testing

semidex uses the built-in Node.js test runner (`node:test`) for unit tests.
No test framework dependency is required — this matches the project's
minimal-dependency philosophy. Requires Node ≥ 18.17 (declared in
`package.json` `engines`; matches the `@qdrant/js-client-rest` requirement).

## Test Tiers

| Tier | Command | Needs services | Runs in CI |
|------|---------|----------------|------------|
| Unit tests | `npm test` | No | Yes, every push/PR |
| Offline smoke | `npm run smoke` | No | Yes, every push/PR |
| Live smoke | `npm run smoke:retrieval-live` etc. | Qdrant (+ Ollama) | No |
| Benchmarks | `npm run bench:*` | Qdrant + models | No |

Unit tests are the target home for all pure-logic assertions. The offline
smoke suite (`src/smoke/`) predates the unit tests and is being migrated
incrementally (see the migration plan below); until migration completes, both
suites run in CI.

## Running

```bash
npm test                # all unit tests
npm run test:watch      # watch mode
npm run test:coverage   # with the built-in coverage reporter

# single file
node --test tests/unit/core/point-id.test.js

# filter by test name
node --test --test-name-pattern="makePointId" "tests/**/*.test.js"
```

## Layout

```text
tests/
  helpers/
    setup.js       - hermetic env defaults; import FIRST in every test file
  unit/
    core/          - tests for src/core/ modules
    indexer/       - tests for src/indexer/ modules
    mcp/           - tests for src/mcp/ modules
```

## Conventions

1. **Import `tests/helpers/setup.js` before any `src/` import.** Several src
   modules read env at import time (e.g. `search.js` snapshots
   `RERANK_ENABLED`). The setup module provides safe defaults so tests never
   depend on a developer's `.env` or fail in a bare CI environment.
   (`qdrant.js` itself no longer needs env at import time — the SDK client is
   created lazily; `qdrant-lazy.test.js` deliberately skips setup.js to verify
   that.)
2. **One src module (or one behavior cluster) per test file.** Name the file
   after the module under test: `point-id.test.js` tests `src/core/point-id.js`.
3. **Use `node:assert/strict`.** Prefer `assert.equal` / `assert.deepEqual` /
   `assert.match` / `assert.throws` with a regex for the error message.
4. **Unit tests never touch the network, Qdrant, Ollama, or the model cache.**
   Anything that needs a service or a downloaded model belongs to the live
   smoke tier or is skipped conditionally (see the bge-m3 block in
   `token-count.test.js` for the `t.skip()` pattern).
5. **Env mutation is allowed but must be restored** in `beforeEach`/`afterEach`
   (see `config-providers.test.js`). `node --test` runs each file in its own
   process, so leakage across files is impossible — restore anyway for
   readability.
6. **No snapshot tests.** Assert on specific fields and invariants; the smoke
   suite's history shows these survive refactors better.

## Migration Plan: src/smoke → tests/

The offline smoke suite contains ~53 sections and ~1300 assertions. Migration
is incremental: a section is migrated by porting its assertions to a
`tests/unit/**` file, then deleting the section from `src/smoke/index.js`.
CI keeps running both suites, so partial migration is always safe.

Migrated so far:

| Smoke section | Unit test |
|---------------|-----------|
| 03 invalid-combo-resolve | `tests/unit/core/config-providers.test.js` |
| 08 compact-window | `tests/unit/mcp/compact-window.test.js` |
| 16 extract-json-array | `tests/unit/indexer/extract-json-array.test.js` |
| 23 length-bucket | `tests/unit/core/length-bucket.test.js` |
| 28 setext-headings | `tests/unit/indexer/setext-headings.test.js` |
| 32 deterministic-point-id | `tests/unit/core/point-id.test.js` |
| 36 token-count (heuristic + mode resolution) | `tests/unit/core/token-count.test.js` |
| 48 nav-filter | `tests/unit/mcp/nav-filter.test.js` |

Remaining sections, in suggested order (easiest and highest-value first):

**Phase 1 — pure helpers, no fixtures:** 20 colbert-math, 26
extract-context-tags-array, 37 pipeline-primitives, 39 dynamic-overlap, 40
colbert-guard, 52 run-num-ctx → `tests/unit/core/` and `tests/unit/indexer/`.

**Phase 2 — chunking and payload logic:** 06 chunking-edge-cases, 11
recursive-chunk-text, 13 semidex-payload, 29 semidex-ignore, 30 tag-gen-flag,
31 empty-section, 33 duplicate-repair-helpers → `tests/unit/indexer/`.

**Phase 3 — skeleton family:** 42–47, 49–51, 53–57 (parse, policy, warnings,
chunk, payload, nav, edge cases, upsert, summaries, nav tools, get-node,
carryover) → `tests/unit/indexer/skeleton-*.test.js` and `tests/unit/mcp/`.
These are the largest sections; split one smoke section into several test
files where natural.

**Phase 4 — env/provider-sensitive:** 01 default-provider, 02 onnx-embed, 04
embed-runtime-guard, 05 reindex-detection, 07 reranker-top1, 09
stale-source-files, 12 onnx-providers, 18 validate-ollama-models, 19
doctor-checks, 24 dml-batching-gate, 27 combined-phase, 34
mcp-navigation-tools, 35 mcp-ux-polish, 38 tag-onnx-provider, 41
ce-rerank-stub. These mutate env or use `withConfig`; port the `withConfig`
helper into `tests/helpers/` when the first of them migrates.

**Stays in smoke (or a future integration tier):** 14 profiler, 15
bootstrap-docs, 17 pdf-fixture, and the tokenizer-cache-dependent half of 36 —
they rely on local files, the model cache, or process-level side effects.

When all sections are migrated, `src/smoke.js` and `src/smoke/` can be deleted
and the `npm run smoke` script removed from CI.

## Coverage

`npm run test:coverage` uses Node's built-in coverage reporter
(`--experimental-test-coverage`). Coverage of modules that require services
(`ollama.js`, `qdrant.js`, `embeddings.js`) will stay low until an integration
tier with mocked transports exists — do not chase coverage numbers there;
prioritise the pure-logic modules where a regression is silent.

## CI

`.github/workflows/smoke.yml` runs `npm test` and `npm run smoke` on every
push and pull request. Neither requires Qdrant, Ollama, or model downloads.
