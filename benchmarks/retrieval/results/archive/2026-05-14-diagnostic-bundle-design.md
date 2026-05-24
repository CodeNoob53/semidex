# Diagnostic Bundle Design Audit — 2026-05-14

Design report for a `npm run doctor` command that collects a safe, shareable
diagnostic snapshot of the semidex environment. No production code is implemented here.

---

## 1. Command Name and Scope

**Recommended name:** `npm run doctor`

Rationale:
- `doctor` is established convention (Homebrew, Flutter, React Native). Users recognise it
  immediately as "tell me what's wrong with my setup."
- `diagnostics` is longer and ambiguous — already used by `bench:custom50:diagnostics`
  for search-quality signal analysis, a different concept entirely.
- `debug:bundle` is developer-internal framing; users would not know to run it.

**Entry point:** `src/doctor.js` (new file, ~200–250 lines)

**npm script to add:**
```
"doctor": "node src/doctor.js"
```

**CLI-only for Stage 1.** MCP tool (`qdrant_doctor`) is a natural Stage 2 addition — the
same pure check functions can be called from the MCP server without duplicating logic.

---

## 2. Stage 1 Check List

Each check has a status: **PASS** / **WARN** / **FAIL** / **SKIP**.
Checks are always collected; one failing check never aborts the rest.

### Group A — Runtime environment

| # | Check | FAIL condition | WARN condition |
|---|---|---|---|
| A1 | Node.js version | < 18 (no native fetch) | < 20 (recommended) |
| A2 | npm version | parse error | — |
| A3 | semidex package version | package.json missing | — |
| A4 | `.env` file presence | absent | — |
| A5 | Required env vars set | `QDRANT_URL` or `QDRANT_KEY` absent | `OLLAMA_URL` absent (defaults used) |

### Group B — Qdrant connectivity

| # | Check | FAIL condition | WARN condition |
|---|---|---|---|
| B1 | QDRANT_URL reachable | connection error / timeout | HTTP 4xx (key issue) |
| B2 | QDRANT_KEY validity | HTTP 401/403 on `/collections` | — |
| B3 | listCollections success | any error | — |
| B4 | Collection count | 0 collections and no config entries | config has entries but Qdrant has none |

### Group C — Per-collection schema audit

Run for every collection in config.json that also exists in Qdrant.

| # | Check | FAIL condition | WARN condition |
|---|---|---|---|
| C1 | Named vector schema | `vectorsCfg.size` is a number (flat/legacy schema → `dense` vector name error) | — |
| C2 | dense vector present | `vectorsCfg.dense` missing | — |
| C3 | sparse vector support | `hasSparseVectors()` false and provider is bge-m3-onnx | `hasSparseVectors()` false and provider is ollama |
| C4 | Payload indexes: source_file | index missing | — |
| C5 | Payload indexes: tags | index missing | — |
| C6 | Payload indexes: chunk_index | index missing | — |
| C7 | Point count | 0 and collection not newly created | — |
| C8 | Config ↔ Qdrant provider agreement | config.denseProvider ≠ sampled point's dense_provider | sample unavailable (empty collection) |
| C9 | Schema version | sample point embeddingSchemaVersion < SCHEMA_VERSION (2) | — |
| C10 | isSemidexPayload on sample | payload missing required discriminator fields | empty collection (no sample possible) |

Collections in Qdrant but NOT in config.json → labelled **foreign**, skipped for C1–C10,
surfaced as an informational line.

### Group D — Ollama (skipped if DENSE_PROVIDER=bge-m3-onnx and TAG_MODEL/CONTEXT_MODEL unused)

| # | Check | FAIL condition | WARN condition |
|---|---|---|---|
| D1 | OLLAMA_URL reachable | connection error / timeout | HTTP non-200 |
| D2 | CONTEXT_MODEL pulled | not in `api/tags` response | — |
| D3 | TAG_MODEL pulled | not in `api/tags` response | — |
| D4 | bge-m3 embed model (if ollama dense) | not in `api/tags` response | — |

### Group E — Local files

| # | Check | FAIL condition | WARN condition |
|---|---|---|---|
| E1 | config.json exists | absent | — |
| E2 | config.json parse | invalid JSON | — |
| E3 | graph.*.json files | invalid JSON in any present file | present for collections not in config |
| E4 | ONNX model cache | models/ dir absent (only if ONNX_EMBED=1 or bge-m3-onnx in config) | expected model file absent |
| E5 | chunks_out directory | — | present but non-empty (debug artifacts left over) |

---

## 3. Redaction Policy

These rules apply everywhere: console output, written report file, and any future JSON export.

| Data | Rule |
|---|---|
| `QDRANT_KEY` | Never print. Show only: `present (N chars)` or `absent`. |
| `QDRANT_URL` | Print host+port only. Strip credentials, query strings, path beyond origin. Example: `https://b0c13d7f-…aws.cloud.qdrant.io` → `https://b0c13d7f-…eu-central-1.qdrant.io` (keep subdomain for cluster identification, strip bearer tokens if embedded). |
| `.env` file | Never print raw lines. Only print which keys are present/absent. |
| Ollama model names | Safe to print (not secret). |
| Local absolute paths | Print repo-relative paths only. Never print home directory or drive-level paths. Exception: SOURCE_ROOT presence check prints only whether it is set and whether it resolves, not the actual path. |
| Chunk text / context / tags | Never included in any output. |
| Source document content | Never included. |
| Point payloads | Print only metadata fields (provider, model, schema_version, vector_size, chunk_index). Never print `text`, `context`, `tags` field values. |
| QDRANT_KEY in error messages | Sanitise any caught error message before printing (`err.message.replace(KEY, '[REDACTED]')`). |

**Report file safety:** The written `.md` report must be safe to paste into a GitHub issue or
share with another agent. All rules above apply to the file content identically.

---

## 4. Output Shape

### Console output (primary)

Grouped sections with emoji status prefix, printed as the checks run:

```
semidex doctor — 2026-05-14T19:04:12Z
══════════════════════════════════════

[A] Runtime environment
  ✓ PASS  Node.js v25.2.1
  ✓ PASS  semidex v2.0.0
  ✓ PASS  .env present
  ✓ PASS  QDRANT_URL set  (host: b0c13d7f-…eu-central-1.qdrant.io)
  ✓ PASS  QDRANT_KEY set  (64 chars)
  ✓ PASS  OLLAMA_URL set  (http://localhost:11434)

[B] Qdrant connectivity
  ✓ PASS  Reachable (HTTP 200)
  ✓ PASS  API key valid
  ✓ PASS  listCollections → 11 collections

[C] Collection schema — bench-retrieval
  ✓ PASS  Named vector schema
  ✓ PASS  dense + sparse vectors present
  ✓ PASS  Payload indexes: source_file, tags, chunk_index
  ✓ PASS  Point count: 1 247
  ✓ PASS  Provider agreement: ollama / hashed-tf
  ✓ PASS  Schema version: 2

[C] Collection schema — semidex-docs
  ✓ PASS  Named vector schema
  …

[D] Ollama
  ✓ PASS  Reachable (v0.23.2)
  ✓ PASS  CONTEXT_MODEL gemma3:4b — pulled
  ✓ PASS  TAG_MODEL gemma3:4b — pulled

[E] Local files
  ✓ PASS  config.json (11 collections)
  ✓ PASS  graph.bench-retrieval.json
  ✗ FAIL  ONNX model cache: models/aapot/bge-m3-onnx not found
             → Run: npm run bootstrap:docs  (triggers model download)
  ⚠ WARN  chunks_out/ non-empty (debug artifacts present)

══════════════════════════════════════
Results: 38 PASS  1 WARN  1 FAIL  0 SKIP
Report written: diagnostics/2026-05-14T190412-doctor.md
Exit code: 1 (FAIL present)
```

### Written report

Path: `diagnostics/YYYY-MM-DDTHHMMSS-doctor.md`

Same content as console, in Markdown. The `diagnostics/` directory is gitignored.
Filename includes timestamp to avoid overwrite collisions on repeated runs.

The file is safe to share: redaction rules applied identically.

### JSON option (Stage 2, not Stage 1)

`node src/doctor.js --json` outputs structured JSON to stdout for machine consumption
(CI pipelines, MCP tool). Deferred.

---

## 5. Failure Behavior

- **Never throw at check level.** Every check is wrapped in `try/catch`; exceptions become
  a `FAIL` with the sanitised error message as the detail line.
- **Continue after FAIL.** All checks in all groups always run.
- **Exit code:**
  - `0` — all checks PASS or WARN
  - `1` — any check FAIL

WARN does not affect exit code. Callers can treat exit `0` as "safe to proceed."

---

## 6. Relationship to Existing Commands

| Command | What it does | Relationship to `doctor` |
|---|---|---|
| `npm run smoke` | Offline unit tests (193 checks, no network) | Complementary. `smoke` tests logic correctness; `doctor` tests environment health. Run `smoke` first in CI, `doctor` for operational issues. |
| `npm run sync` | Repairs schema + config (mutates) | `doctor` is read-only. If `doctor` reports FAIL on C1/C3/C6, `sync` is the fix action. `doctor` output should say so explicitly. |
| `npm run index` | Indexes files (mutates Qdrant + graph) | `doctor` explains why `index` would fail (wrong key, wrong model, flat schema). |
| `bench:custom50:diagnostics` | Search-quality signal analysis | Different domain. No conflict. |
| live smoke tests | Integration tests requiring Qdrant+Ollama | `doctor` is the pre-flight for these; if `doctor` reports FAIL B or D, live smokes will fail too. |

**Doctor must never mutate:** no `createPayloadIndex`, no `addSparseVectorSupport`, no
`saveConfig`. Read-only Qdrant calls only (`listCollections`, `getCollectionInfo`,
`scroll` for one sample point per collection).

---

## 7. Implementation Plan

### Stage 1 — Core CLI (scope of next implementation task)

**New files:**

| File | Purpose |
|---|---|
| `src/doctor.js` | Entry point: orchestrates all checks, prints console output, writes report |
| `src/core/doctor-checks.js` | Pure check functions (Groups A, C-logic, E); no I/O, smoke-testable |

**Modified files:**

| File | Change |
|---|---|
| `package.json` | Add `"doctor": "node src/doctor.js"` script |
| `.gitignore` | Add `diagnostics/` |

**Pure helpers worth smoke-testing** (in `doctor-checks.js`):

- `redactUrl(url)` — strips credentials, keeps host
- `redactKey(key)` — returns `present (N chars)` or `absent`
- `checkNodeVersion(version)` — returns PASS/WARN/FAIL with detail
- `classifyVectorSchema(vectorsCfg)` → `'flat'` | `'named'` | `'empty'`
- `checkProviderAgreement(configEntry, samplePayload)` → PASS/WARN/FAIL
- `checkSchemaVersion(samplePayload, currentVersion)` → PASS/FAIL
- `sanitiseErrorMessage(msg, key)` — replaces key literal in error strings

These are all pure (no network, no fs). They get a new smoke section `19-doctor-checks.js`.

**Impure checks** (network / fs, tested manually or via live smoke):

- Group B (Qdrant fetch calls)
- Group D (Ollama fetch calls)
- E4 (fs.existsSync on model cache path)

**Report writer:** a simple `writeFileSync` at the end of `src/doctor.js`. Not a separate
helper — no logic to test there.

### Stage 2 — Deferred

- `--json` flag for machine-readable output
- MCP tool `qdrant_doctor` (wraps same pure check functions)
- Per-collection point-count histogram
- Graph integrity check (orphaned entries, cross-collection reference validation)
- `--fix` flag that calls `sync` internals for schema repairs (consider carefully — scope creep risk)
- CI integration example (run doctor as pre-step before live smoke)

---

## 8. Non-Goals

- **Not a repair tool.** Doctor describes; `sync` fixes.
- **Not a benchmark.** No search quality analysis; that's `bench:custom50:diagnostics`.
- **Not a log aggregator.** Does not parse INDEX_PROFILE output.
- **Not a secret scanner.** Does not inspect file contents beyond metadata.
- **Not exhaustive Qdrant inspection.** Samples one point per collection; does not scroll
  all points or validate every payload field.
- **No OCR / PDF pipeline checks.** Out of scope for Stage 1.

---

## Sample Failure Outputs

### Qdrant 403 (expired key)
```
[B] Qdrant connectivity
  ✓ PASS  Reachable (HTTP 403 — server responded)
  ✗ FAIL  API key invalid (HTTP 403)
             → Regenerate key in Qdrant Cloud dashboard, update QDRANT_KEY in .env
```

### Legacy flat schema
```
[C] Collection schema — old-collection
  ✗ FAIL  Flat vector schema detected (vectorsCfg.size = 1024, no named 'dense')
             → Run: npm run sync   (repairs schema, recreates collection)
```

### Missing Ollama model
```
[D] Ollama
  ✓ PASS  Reachable (v0.23.2)
  ✗ FAIL  CONTEXT_MODEL gemma3:4b — not pulled
             → Run: ollama pull gemma3:4b
```

### Config/Qdrant provider mismatch
```
[C] Collection schema — bench-retrieval
  ⚠ WARN  Provider mismatch: config says ollama but last indexed point says bge-m3-onnx
             → Full reindex will be triggered on next `npm run index` run
```

---

## Open Questions (for implementation phase)

1. **Scroll sample for C8/C9/C10:** use `scroll(collection, null, 1)` (first point, no filter).
   For empty collections this returns `[]` → status SKIP, not FAIL. Confirm this is the
   right sentinel.

2. **Graph check granularity:** E3 currently just checks parse validity. Worth adding an
   orphan check (source_file in graph but not in Qdrant)? Probably Stage 2 — requires
   `listSourceFiles()` per collection (N+1 Qdrant calls).

3. **`diagnostics/` vs `benchmarks/retrieval/results/`:** Doctor reports are operational
   snapshots, not benchmark results. Keeping them in a separate `diagnostics/` directory
   avoids polluting the benchmark results tree. Confirm before implementing.

4. **ONNX cache path:** `src/core/onnx-embed.js` sets `CACHE_DIR = join(ROOT, 'models')`.
   E4 should check `models/aapot/bge-m3-onnx/model.onnx` exists. Exact filename needs
   verification against what `@huggingface/transformers` actually downloads.
