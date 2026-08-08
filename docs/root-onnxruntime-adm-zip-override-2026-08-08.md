# Root ONNX Runtime adm-zip override — implementation report

Status: implemented (2026-08-08). Removes the vulnerable nested
`adm-zip@0.5.18` copy under `onnxruntime-node@1.24.3` from the root
Semidex dependency graph, via a narrowly-scoped `package.json` override,
without upgrading `onnxruntime-node` or `@huggingface/transformers` and
without touching `sharp`/`vite`.

## Change

`package.json` — added the narrowest possible override, scoped to the
exact vulnerable version string (not a global `adm-zip` override):

```json
"overrides": {
  "onnxruntime-node@1.24.3": {
    "adm-zip": "0.6.0"
  }
}
```

No prior `overrides` block existed, so nothing needed to be preserved
around it.

`package-lock.json` — regenerated via plain `npm install` (normal npm
resolution, no manual editing). The only change is the removal of the
now-redundant nested lockfile entry:

```diff
-    "node_modules/onnxruntime-node/node_modules/adm-zip": {
-      "version": "0.5.18",
-      ...
-    },
```

Total diff: `package.json` +5/-0, `package-lock.json` +0/-9. No other
package version changed.

## Resolved dependency tree

```
$ npm ls adm-zip onnxruntime-node @huggingface/transformers --all
semidex@2.0.0 C:\Users\Aorus\Documents\Projects\semidex
+-- @huggingface/transformers@4.2.0
| `-- onnxruntime-node@1.24.3 deduped
+-- adm-zip@0.6.0 overridden
`-- onnxruntime-node@1.24.3 overridden
  `-- adm-zip@0.6.0 deduped
```

- `adm-zip` now resolves to a single version (`0.6.0`) everywhere in the
  graph — the nested nested copy is gone, deduped onto the root instance.
- `onnxruntime-node` stayed on `1.24.3` (unchanged — `overridden` here
  only reflects that it participates in an override rule, not a version
  bump).
- `@huggingface/transformers` stayed on `4.2.0` (unchanged), its own
  `onnxruntime-node` dependency deduped to the same `1.24.3` instance.

`npm ls` (plain, top-level): exit code 0, no `invalid`/`extraneous`/`UNMET
DEPENDENCY` markers among direct dependencies. `npm ls --all` shows a
number of pre-existing `UNMET OPTIONAL DEPENDENCY` lines for
platform-specific optional binaries (`sharp`'s per-OS binaries, `canvas`,
`bufferutil`/`utf-8-validate`) — all pre-existing, Windows-irrelevant
optional deps unrelated to this change, not caused by it.

## Audit counts — before / after

**Before** (`npm audit`, prior to the override):

```
6 vulnerabilities (1 moderate, 5 high)
```

Findings: `adm-zip <0.6.0` (high, no fix available, via
`onnxruntime-node` → `@huggingface/transformers`), `esbuild <=0.24.2`
(moderate, via `vite`), `sharp <0.35.0` (high, no fix available, via
`@huggingface/transformers`).

**After** (`npm audit`, with the override applied):

```
4 vulnerabilities (1 moderate, 3 high)
```

```
esbuild  <=0.24.2
Severity: moderate
esbuild enables any website to send any requests to the development server and read the response
fix available via `npm audit fix --force` (breaking: vite@8.2.1)

sharp  <0.35.0
Severity: high
sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
No fix available
```

**What disappeared**: the `adm-zip <0.6.0` (GHSA-xcpc-8h2w-3j85, "Crafted
ZIP file triggers 4GB memory allocation") finding and its
`onnxruntime-node`/`@huggingface/transformers` dependency-chain entries
are fully gone — `adm-zip` no longer appears anywhere in `npm audit`'s
output. This is confirmed both by the count drop (6→4, with 2 fewer high
findings than the moderate/high split shows on its own — `npm audit`
groups the `adm-zip` finding as one node but it touched multiple
high-severity report lines in the "before" listing) and by direct
inspection: the "after" report contains zero mentions of `adm-zip`.

**What did NOT change and is NOT claimed fixed**: `esbuild`/`vite`
(moderate) and `sharp` (high, via `@huggingface/transformers`) are
unchanged in both count and content — same severity, same advisory IDs,
same "no fix available"/`--force`-only status, both still present after
the override. Per the task's own constraint, neither was touched.

## Real ONNX runtime verification (not import-only)

Ran a one-shot verification script (temporary, never committed — created
at repo root as `.scratch-onnx-verify.mjs`, deleted immediately after use)
that calls the exact production capability path
`admin/server-full.js`/`indexer/index-full.js`/`mcp/server.js` all use:
`local/core/onnx-embed.js`'s real `createOnnxEmbeddingCapability()`, with
no fakes, against the real cached BGE-M3 model (`models/bge-m3-onnx/`,
already present — no download performed).

```
[verify] loading ONNX runtime + model via createOnnxEmbeddingCapability()...
[verify] session ready. running real embed()...
[onnx] loading tokenizer...
[onnx] cached: tokenizer.json (17 MB)
[onnx] cached: tokenizer_config.json (0 MB)
[onnx] cached: model.onnx (0 MB)
[onnx] cached: model.onnx.data (2271 MB)
[onnx] creating inference session (providers: cpu)...
[onnx] ready. outputs: dense_vecs,sparse_vecs,colbert_vecs
[verify] provider state: {"requested":"cpu","effective":"cpu","fellBackToCpu":false}
[verify] dense: 1024-dim, first 5: [-0.0616, 0.0137, -0.0075, -0.0225, -0.0159]
[verify] sparse: 17 non-zero tokens
[verify] PASS — real embedding produced valid dense + sparse output
[verify] shutdown() completed cleanly
```

- **Provider used**: `cpu` (requested `cpu`, effective `cpu`, no
  fallback) — this machine's default `ONNX_EXECUTION_PROVIDER`.
- **Dense output**: real 1024-dim float array, all finite values —
  validated shape and numeric sanity.
- **Sparse output**: real `{indices, values}` pair, 17 non-zero tokens
  for the test sentence, matching `indices.length === values.length`.
- **Shutdown**: `capability.shutdown()` completed without throwing,
  releasing the real `InferenceSession` cleanly (confirmed via the
  `finally` block completing with no unhandled rejection).

This proves `onnxruntime-node@1.24.3` genuinely loads and performs real
inference with `adm-zip@0.6.0` present instead of `0.5.18` — the override
did not silently break the native binary loading path (which
`onnxruntime-node`'s own install step uses `adm-zip` for, to unpack
platform binaries) or the runtime's actual inference behavior.

## Focused regressions

Ran sequentially (`--test-concurrency=1`), covering ONNX embedding
capability/runtime, MCP's ONNX resolution, tag-generation
(Transformers-backed ONNX tag worker), and CE reranker (shares the same
`onnxruntime-node`/native-binary loading path):

```
tests/unit/admin/server-full-onnx-embed-capability.test.js
tests/unit/architecture/onnx-embed-instance-scoping.test.js
tests/unit/core/managed-onnx-runtime-manifest.test.js
tests/unit/core/onnx-embed-capability.test.js
tests/unit/core/onnx-embed-instance-isolation.test.js
tests/unit/core/onnx-embed-output-selection.test.js
tests/unit/core/onnx-provider-probe.test.js
tests/unit/core/onnx-runtime.test.js
tests/unit/local/core/onnx-runtime-source-resolution.test.js
tests/unit/local/core/onnx-runtime-unavailable-capability.test.js
tests/unit/mcp/onnx-runtime-resolution.test.js
tests/unit/architecture/phase-8b-step4-tag-onnx-relocation.test.js
tests/unit/indexer/phases/tag-onnx-capability.test.js
tests/unit/indexer/phases/tag-onnx.test.js
tests/unit/core/ce-rerank.test.js
tests/unit/core/rerank.test.js
tests/unit/core/embeddings-capability-injection.test.js
tests/unit/core/embeddings.test.js
```

Result: **234/234 passing**, 0 failures.

## Full verification (sequential, no parallel Node test processes)

- `npm test`: **3374/3374** passing.
- `npm run admin:build`: succeeds, 227 modules transformed, output
  unchanged in shape (identical file names/sizes to before the change).
- `npm run admin:build:lite`: succeeds, 226 modules transformed,
  unchanged.
- `git diff --check`: exit 0, clean (no whitespace errors).

## Remaining advisories

Two, both explicitly out of this task's scope and unchanged by it:

1. **`esbuild <=0.24.2`** (moderate) — via `vite`. Fix requires
   `vite@8.2.1` (breaking change); not attempted per the "do not touch
   Vite" constraint.
2. **`sharp <0.35.0`** (high) — via `@huggingface/transformers`. No fix
   available upstream; not attempted per the "do not touch sharp"
   constraint.

## Constraints honored

- No global `adm-zip` override added — the scoped
  `onnxruntime-node@1.24.3` form works and was used.
- `sharp`/`vite` untouched.
- `npm audit fix --force` never run.
- `onnxruntime-node`/`@huggingface/transformers` versions unchanged.
- The managed CUDA installer's separate ORT 1.26 security policy
  (`scripts/onnxruntime-cuda-lock.json`, the installer's own trust-gate
  logic) was not touched — this task only affects the root npm dependency
  graph's `onnxruntime-node@1.24.3` (the plain npm-installed CPU/DML
  package), an entirely separate artifact from the managed CUDA build.
- Nothing committed — `package.json`/`package-lock.json` remain as
  working-tree changes only.
- No parallel/background `node --test` processes were run.
- No unrelated working-tree changes existed at task start (confirmed via
  `git status` before any edit) and none were introduced.

## Verdict

`ROOT_ORT_ADM_ZIP_OVERRIDE_ACCEPT`
