# CUDA runtime configuration, validation, and Admin UI support — 2026-07-24

Closes the gaps between "CUDA is selectable in settings" and "CUDA is
actually verifiable" across the semidex backend and Admin UI. Covers the
process-isolation work needed to make that verification safe, the settings
contract for a custom CUDA-enabled ONNX Runtime build, a truthful isolated
probe, and Admin UI surfacing.

## State model

Four states are now distinguished everywhere ONNX execution provider status
is surfaced — none of them collapse into "selected":

| State | What it means | Where it lives |
|---|---|---|
| **Configured** | The value in settings.json / `.env` / OS env for `ONNX_EXECUTION_PROVIDER` | `SettingsService`'s `configuredValue` |
| **Active** | What the *current process* is actually using — frozen at process start for `next_restart` fields | `SettingsService`'s `activeValue` (never recomputed mid-process for `next_restart` fields) |
| **Verified** | The result of a real, isolated probe that created and released an actual inference session | `POST /api/system/onnx-probe` response / `npm run doctor`'s CUDA check |
| **Pending restart** | Configured differs from active — a save happened but the process hasn't restarted | `entry.pendingRestart` (`service.js`), surfaced in the Admin UI as "Saved — still using X until semidex restarts" |

**The core rule:** a configured value is never presented as a verified one,
anywhere. The Admin UI's "Test CUDA configuration" button starts in a
"Not yet tested" state and only ever updates from a real probe response —
never from the setting, never automatically.

## What changed

**Process isolation (Part A).** `@huggingface/transformers` bundles its own
ONNX Runtime (1.24) and can conflict with a custom CUDA-enabled build (1.26)
loaded via `ONNXRUNTIME_NODE_PATH` in the same process. Two call sites used
to load Transformers.js directly in-process:

- `token-count.js`'s BGE-M3 tokenizer now uses `@huggingface/tokenizers`
  (the same lower-level, non-ORT-backed library `onnx-embed.js` already used
  for its own tokenizer) instead of `AutoTokenizer`. Token counts are
  byte-for-byte identical to the old implementation (verified against
  hardcoded fixture token IDs, including BOS/EOS handling).
- Cross-encoder reranking (`ce-rerank.js`) now runs inside a lazily-spawned,
  persistent `worker_thread` (`ce-rerank-worker.js`), mirroring the existing
  tag-generation worker pattern (`indexer/phases/tag-onnx.js`). The
  coordinator never imports `@huggingface/transformers` directly; only the
  worker does, and only inside an async function, never at module load
  time. A structural repo-wide test confirms no file imports both
  `onnx-runtime.js`/`onnx-embed.js` and `@huggingface/transformers`.

Verified live in this process (not just unit tests): a real BGE-M3
embedding, a real token count, and a real CE rerank call all ran
successfully in the same Node process, including running an embedding call
again *after* the CE worker was loaded — no ONNX Runtime duplicate-backend-
registration error at any point (see Live results below).

**Settings contract (Part B).** `ONNXRUNTIME_NODE_PATH` is now a registered
setting (category `embeddings`, `appliesAt: next_restart`,
`requiresReindex: false`) — a filesystem path to a compatible custom
`onnxruntime-node` build. Empty means "use the default npm package"
(CPU/DirectML only). Field visibility (`visibleWhen`) was generalized from a
single `{ key, equals }` condition to an array of AND-composed conditions,
fully backward compatible with every existing single-condition field:

- `ONNX_EXECUTION_PROVIDER` — visible for BGE-M3 ONNX (unchanged).
- `ONNX_BATCH_SIZE` — visible only for BGE-M3 ONNX **+ DML** (previously
  shown for every provider, even though batching is DML-only).
- `ONNX_CUDA_STRICT` / `ONNXRUNTIME_NODE_PATH` — visible only for
  BGE-M3 ONNX **+ CUDA**.

Bootstrap propagation was traced end-to-end, not assumed: a
`settings.json`-only `ONNXRUNTIME_NODE_PATH` value reaches `process.env` via
`applyEnvWriteBack()`, and a spawned indexer child process receives it too,
because `admin/jobs/registry.js` passes the *pre*-write-back env snapshot to
the child and the child runs its own independent `bootstrapEnv()` →
`SettingsService` resolution — confirmed with a live test that inspects the
actual env object passed to `spawn()`, not just the production code path in
isolation.

**Truthful probe (Part C).** `onnx-provider-probe.js` no longer imports the
default `onnxruntime-node` package directly — it spawns an isolated child
process (`onnx-probe-runner.js`) that resolves the runtime the same way
`onnx-embed.js` does (honoring `ONNXRUNTIME_NODE_PATH`). Neither the Admin
server nor `npm run doctor` loads any ONNX Runtime build itself merely to
report status. The probe:

- Uses **only** the requested provider — never appends `cpu` to a CUDA
  verification.
- Creates and releases a real BGE-M3 inference session against the actual
  cached model — never downloads it; reports `modelCached: false` and stops
  before session creation if the model isn't present.
- Has a timeout (default 30s) and cleanly kills the child process on
  expiry, on spawn failure, or on any other exit path.
- Redacts error messages (reuses `doctor-checks.js`'s existing
  `sanitiseErrorMessage`) — no raw env vars or secrets ever reach a caller.

`POST /api/system/onnx-probe` (new Admin API endpoint) wraps this: defaults
the requested provider to the currently configured
`ONNX_EXECUTION_PROVIDER`, passes the configured `ONNXRUNTIME_NODE_PATH`
into the probe's env, and reports `restartRequired` from the same
`pendingRestart` concept the settings service already computes. `npm run
doctor`'s CUDA check now calls the identical isolated probe — one shared
implementation, not two.

**Admin UI (Part D).** "Embeddings & hardware" gained:

- A path-picker control for `ONNXRUNTIME_NODE_PATH` — a normal text field
  (always directly editable) plus a Browse button wired to the existing
  `POST /api/system/pick-folder` endpoint. If the picker is unavailable
  (non-Windows, missing `powershell.exe`, timeout), the field falls back to
  manual entry with an explanatory message — never a dead end.
- An "ONNX hardware status" panel, shown only when the *staged* (not yet
  necessarily saved) `ONNX_EXECUTION_PROVIDER` is `cuda` or `dml`. Shows
  requested/active provider, a pending-restart note, and a "Last verified"
  field that starts as "Not yet tested" and is populated only by a real
  click of "Test CUDA configuration."
- On a probe result with `fellBackToCpu: true`, the panel renders exactly:
  **"CUDA was requested, but the effective provider is CPU."** — this
  string is driven only by the probe's own dedicated `fellBackToCpu` flag,
  never inferred from `ok`/`effectiveProvider` alone, so a plain probe
  failure (e.g. `model_not_cached`) is never mislabeled as a silent
  fallback.
- Both additions use the existing generic template/partial architecture
  (`global-settings.html` templates cloned and populated via DOM APIs) —
  no new HTML-as-JS-strings.

Every conditional visibility rule (CPU hides DML/CUDA-only controls; DML
shows batch size but not CUDA controls; CUDA shows CUDA controls but not
batch size) falls out of the declarative `visibleWhen` array work with no
extra UI logic.

**Documentation (Part E).** `.env.example`, `README.md`,
`docs/en/configuration.md`, and `docs/en/operations.md` were corrected to
stop asserting Windows CUDA is categorically unsupported. The accurate
statement: the npm-installed `onnxruntime-node` package has no CUDA
execution provider on any platform; CUDA requires a compatible **custom**
build, referenced via `ONNXRUNTIME_NODE_PATH`; CUDA Toolkit/cuDNN are
OS-level prerequisites semidex does not install, build, or manage; a
selected `cuda` value is never proof it loaded — verify with the Admin
probe or `npm run doctor`; execution-provider changes affect performance
only, never the vector schema, never requiring reindexing.

## A known limitation on `fellBackToCpu`

The probe's response shape includes `fellBackToCpu` for parity with
`onnx-embed.js`'s own `getOnnxProviderState()` (which legitimately falls
back to CPU during real, non-strict embedding sessions and sets this flag
true). The **probe itself** never retries with CPU by design — a probe
exists to report the truth about the requested provider — so
`fellBackToCpu` is always `false` in every current probe response; a failed
CUDA probe reports `effectiveProvider: null` (unknown/failed), never a
substituted `cpu`. This is intentional, not a defect: `onnxruntime-node`'s
JS API gives no reliable way to detect that ONNX Runtime silently accepted
an unavailable execution provider request and ran on CPU without throwing
(confirmed by inspecting the package's public API surface — there is no
`session.executionProviders` or equivalent). The probe can only report what
it can actually observe: did session creation with the requested provider
throw, or not.

## Live results (this machine, 2026-07-24)

All probe calls below used the real, isolated child-process probe
(`probeOnnxProvider()`), not a stub — a genuine BGE-M3 session was created
and released for each `ok: true` result, against the real cached model
(`models/bge-m3-onnx/`, ~2.3 GB).

**CPU** (default npm package):
```json
{
  "ok": true, "requestedProvider": "cpu", "effectiveProvider": "cpu",
  "fellBackToCpu": false, "runtimeSource": "npm", "runtimeVersion": "1.24.3",
  "modelCached": true, "message": "CPU session created successfully"
}
```

**DML** (default npm package, real DirectML GPU on this machine):
```json
{
  "ok": true, "requestedProvider": "dml", "effectiveProvider": "dml",
  "fellBackToCpu": false, "runtimeSource": "npm", "runtimeVersion": "1.24.3",
  "modelCached": true, "message": "DML session created successfully"
}
```

**CUDA** (default npm package — expected, honest failure; no custom CUDA
build was configured for this run, see note below):
```json
{
  "ok": false, "requestedProvider": "cuda", "effectiveProvider": null,
  "fellBackToCpu": false, "runtimeSource": "npm", "runtimeVersion": "1.24.3",
  "modelCached": true,
  "message": "no available backend found. ERR: [cuda] backend not found."
}
```

**`ONNXRUNTIME_NODE_PATH` wiring check** (pointed at a deliberately
nonexistent path, to confirm the setting is honored without needing a real
build): `runtimeSource` correctly switched to `"custom"`, and the probe
failed cleanly with a clear module-resolution error rather than silently
falling back to the npm package — proving the configured path genuinely
reaches the isolated probe process.

**Note on CUDA verification scope:** this task's premise referenced a
previously-verified custom CUDA-enabled `onnxruntime-node` build from an
earlier benchmarking session. That build is **not present on this machine**
at the time of this run (checked common install locations and environment
variables — none found). This report does not claim a live
`effectiveProvider: "cuda"` result, since none actually occurred in this
session. Everything else in the live acceptance checklist — CPU probe, DML
probe, the honest CUDA-without-a-build failure, the `ONNXRUNTIME_NODE_PATH`
wiring check, a real embedding, real token counting, and CE reranking
running without an ORT conflict — was verified directly against real code,
not mocks. CUDA effectiveness verification requires a compatible custom
build to be present, obtained separately (out of scope per this task), and
pointed to via `ONNXRUNTIME_NODE_PATH` before the same probe can produce a
real `cuda` result.

**Process isolation check:** in a single Node process, in this order — real
BGE-M3 embedding → real token count via the new tokenizer module → CE
worker load → real CE rerank call (worker-isolated `@huggingface/transformers`)
→ a second real BGE-M3 embedding — all succeeded with no ONNX Runtime
duplicate-backend-registration error and no crash.

**No benchmark-scale indexing was started at any point during this work.**

## Remaining limitations

- CUDA end-to-end effectiveness (a genuine `effectiveProvider: "cuda"`
  result) was validated in an earlier benchmarking session on this machine
  using a build not present during this task's live acceptance run — see
  the note above. The mechanism (config → probe → Admin UI) is fully wired
  and tested with stubs and with the CPU/DML/error paths for real; a real
  CUDA pass still requires a compatible build to be present.
- Windows CUDA support, once a build is verified, applies to that one
  tested Windows version / NVIDIA driver / CUDA Toolkit / custom-build
  combination — not a general guarantee across all Windows + NVIDIA
  hardware.
- The probe cannot detect a *silent* in-session fallback to CPU (ONNX
  Runtime accepting a requested EP without throwing, then actually running
  on CPU) — see the `fellBackToCpu` limitation above. It can only report
  whether session creation with the requested provider threw.
- No automatic CUDA Toolkit/cuDNN installation and no automatic ONNX
  Runtime build/download were added, per this task's explicit scope
  boundary — obtaining a custom CUDA-enabled `onnxruntime-node` build
  remains a manual, out-of-band step.
