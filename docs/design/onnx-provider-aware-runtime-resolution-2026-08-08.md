# Provider-aware ONNX Runtime resolution (CPU / DirectML / CUDA)

Date: 2026-08-08

## Root cause

`resolveEffectiveOnnxRuntimePath()` (`src/local/core/onnx-runtime-source-resolution.js`)
applied `ONNX_MANAGED_RUNTIME` unconditionally whenever it was set,
regardless of the currently-configured `ONNX_EXECUTION_PROVIDER`. The
managed runtime is a CUDA-only build (`managed-runtime-id.js`'s id format
is `<ortVersion>-cuda<cudaMajor>` — there is no other flavor) with no
DirectML execution provider compiled in. Selecting `dml` or `cpu` still
loaded that CUDA-only build, and a DML probe against it failed with
`no available backend found. ERR: [dml] backend not found` — the managed
runtime itself was never broken, using it for a provider it was never
built for was.

## Fix summary

### 1. `resolveEffectiveOnnxRuntimePath()` is now provider-aware

New required parameter `provider: 'cpu'|'dml'|'cuda'`. Precedence:

- **Explicit `ONNXRUNTIME_NODE_PATH`** — universal, applied for **any**
  provider, unchanged. A user-provided custom build can support any
  provider (npm's own default package does), so it's never gated.
- **Managed `ONNX_MANAGED_RUNTIME`** — only ever considered when
  `provider === 'cuda'`. For `dml`/`cpu`, the managed selection is
  silently ignored (not an error, not a warning — a valid, simply
  inapplicable choice) and resolution falls through to plain npm.
- **npm** — the fallback, unchanged.

Critically, the managed selection **value itself is never cleared** for a
non-cuda provider — it stays in settings exactly as the user left it, so
switching back to `cuda` later re-applies the same managed runtime without
reselecting it (proven by a dedicated round-trip test).

### 2. `resolveOnnxRuntimeForProcess()` reads the provider itself

Now reads `ONNX_EXECUTION_PROVIDER` via
`settingsService.getActiveValue('ONNX_EXECUTION_PROVIDER')` — the same
tier every other setting it reads uses — and threads it into
`resolveEffectiveOnnxRuntimePathFn()`. This is the ONE function every real
composition root calls, so no caller needed its own call-site changes:

| Caller | Change needed |
|---|---|
| `src/admin/bootstrap.js` | None — comment updated only |
| `src/indexer/index-full.js` | None — comment updated only |
| `src/mcp/onnx-runtime-resolution.js` | None — comment updated only |
| `src/local/admin/api/onnx.js` (probe route) | **Yes** — passes its own resolved `provider` (staged body value, falling back to configured) into `resolveEffectiveOnnxRuntimePathFn()`, instead of leaving it unset |

The probe route needed an explicit change because it builds a *per-request*
`probeEnv`, resolving a possibly-staged provider that hasn't been saved —
it never goes through `resolveOnnxRuntimeForProcess()` at all (that
function is for the real, persistent `process.env`).

### 3. `applyOnnxRuntimeEnvPatch()` — no changes needed

Already symmetric (sets-or-deletes both `ONNXRUNTIME_NODE_PATH` and
`ONNX_MANAGED_RUNTIME_ACTIVE` based on `resolved.source`). Since
`resolveEffectiveOnnxRuntimePath()` now always returns `source: 'npm'` for
a non-cuda provider (even with a managed selection saved), this function
automatically clears both stale env markers on a provider switch away from
cuda — proven by two dedicated tests (cuda→dml, cuda→cpu).

### 4. cuDNN PATH preparation — unaffected, correctly gated by construction

`prepareOnnxRuntimeProcessEnv()` only ever does anything when
`resolved.cudnnBinPath` is set, which only happens for `source: 'managed'`
— which itself now only happens for `provider === 'cuda'`. No direct
change was needed; the existing no-op-when-null behavior already closes
this requirement once resolution itself is provider-gated.

### 5. Admin ONNX probe route

`resolveEffectiveOnnxRuntimePathFn()` call now passes `provider` (the
route's own resolved requested/staged provider, computed a few lines
above from `body.provider ?? configuredValue ?? 'cpu'`). This is what
makes a staged CUDA→DML switch testable **before a restart**: the managed
CUDA-only runtime is excluded from resolution the instant `provider` is
`'dml'`, even if `ONNX_MANAGED_RUNTIME`/`ONNX_EXECUTION_PROVIDER` haven't
been saved/restarted into yet.

Downstream effect (no code change needed, already correct by
construction): `runtimeSource: 'managed'` can only ever appear in a probe
response when `resolved.source === 'managed'`, which the provider gate now
guarantees is `false` for dml/cpu — so a DML/CPU probe result can never
present `runtimeSource: 'managed'` to the UI, and `managedRuntimeManifest`
stays `null` (already gated by `provider === 'cuda'` in the existing
write-back block).

### 6. Admin UI

- New `.gs-onnx-dml-runtime-note` in `onnx-probe-panel.html`, shown only
  when the staged provider is `dml`: *"DirectML uses the standard npm
  onnxruntime-node package — the managed CUDA runtime installer does not
  apply to DirectML."* Wired in `local-features.js`'s `onnxProbePanel()`.
- The `ONNX_MANAGED_RUNTIME` dropdown was **already** gated to
  `provider === 'cuda'` via its existing `visibleWhen` definition — this
  was the one part of the original plan that had actually shipped.
  Confirmed (not changed) with a new explicit test: the `<select>` never
  renders for `dml`, even when installed managed runtimes exist.
- A successful DML probe already displays `effectiveProvider: dml`
  correctly (no UI change needed) — confirmed with a new test showing
  `runtimeSource` renders `'npm'`, never `'managed'`, and
  `.gs-onnx-managed-runtime` stays `'—'`.

## What did NOT change

- No backend API contract changes beyond the probe route's internal
  `resolveEffectiveOnnxRuntimePathFn()` call gaining one argument.
- `local/core/onnx-embed.js`'s `resolveOnnxExecutionProviders()` (the
  separate ORT-session-creation-time provider→executionProviders array
  map) — untouched; it was never the buggy layer.
- `local/core/onnx-runtime.js`'s `resolveOnnxRuntimeModule()`/
  `loadOnnxRuntime()` — untouched; still just reads
  `env.ONNXRUNTIME_NODE_PATH`, unaware of providers, as designed.
- No live CUDA/DML installation or verification performed by this session.

## Automated verification results

Run sequentially (no parallel/background test runners):

| Command | Result |
|---|---|
| `node --test --test-concurrency=1 tests/unit/local/core/onnx-runtime-source-resolution.test.js` | 35/35 pass (21 pre-existing + 14 new) |
| `node --test --test-concurrency=1 tests/unit/admin/api/onnx.test.js` | 32/32 pass (30 pre-existing + 2 new) |
| `node --test --test-concurrency=1 tests/unit/admin/ui-global-settings-onnx-panel.test.js` | 39/39 pass (36 pre-existing + 3 new) |
| `node --test --test-concurrency=1 tests/unit/indexer/index-capability-wiring.test.js tests/unit/admin/bootstrap.test.js` | 22/22 pass, unchanged |
| `node --test --test-concurrency=1 tests/unit/architecture/phase-8b-step7b-shared-indexer-relocation.test.js` | 77/77 pass, unchanged |
| `node --test --test-concurrency=1 tests/unit/mcp/onnx-runtime-resolution.test.js` | 7/7 pass, unchanged |
| `npm test` (full suite) | 3398 pass, 4 fail — all 4 in `tests/unit/local/core/managed-runtime-listing.test.js`, pre-existing and unrelated to this task (confirmed: file untouched by this session; same 4 failures observed before any change here) |
| `npm run admin:build` | Vite build succeeded, 227 modules transformed |
| `npm run smoke` | 1316 passed, 0 failed |
| `git diff --check` | No whitespace errors (only informational LF→CRLF warnings from Windows `core.autocrlf`) |

### New/updated regression tests (mapped to the 10 required scenarios)

1. **cuda + managed selection → managed runtime**: existing test, re-confirmed under the new `provider` parameter.
2. **dml + managed selection → npm runtime**: `resolveEffectiveOnnxRuntimePath()` unit test + probe-route HTTP test (`a DML probe never receives the managed CUDA runtime path...`).
3. **cpu + managed selection → npm runtime**: same unit test, parametrized over `['dml', 'cpu']`.
4. **cuda → dml clears stale runtime env**: `resolveOnnxRuntimeForProcess()` test asserting `ONNXRUNTIME_NODE_PATH`/`ONNX_MANAGED_RUNTIME_ACTIVE` are absent after the switch.
5. **cuda → cpu clears stale cuDNN/runtime env**: same pattern, plus confirms `PATH`'s prepended cuDNN entry is never re-added (prepare step no-ops for cpu).
6. **dml → cuda reuses the saved managed runtime**: dedicated round-trip test — same `ONNX_MANAGED_RUNTIME` value, only the provider changes, and cuda re-resolves the identical managed id without reselection.
7. **DML probe never receives managed CUDA path**: HTTP-level test against the real (non-injected) `resolveEffectiveOnnxRuntimePath`.
8. **CUDA probe still verifies managed manifest/checksums**: pre-existing `managedRuntimeManifest field + verification write-back` describe block, unchanged and still passing — proves the integrity/checksum path survived the provider-gating change untouched.
9. **Admin/indexer/MCP share the resolution matrix**: new `cross-process consistency` describe block — the same `settingsService` fed through `resolveOnnxRuntimeForProcess()` three times (mirroring each real composition root's own call shape) always agrees, both for dml (all→npm) and cuda (all→the same managed id/path).
10. **UI never presents managed CUDA as active for DML**: new tests — the `ONNX_MANAGED_RUNTIME` `<select>` never renders for `dml` (visibleWhen-gated), a successful DML probe result renders `runtimeSource: 'npm'` (never `'managed'`) and `.gs-onnx-managed-runtime` stays `'—'`.

## Manual acceptance checklist (для користувача)

Автоматизовані тести покривають логіку резолюції; ручна перевірка
реальних CUDA/DML переходів виконується користувачем окремо. Чекліст:

**CUDA → DML:**
1. З активним провайдером `cuda` і збереженим `ONNX_MANAGED_RUNTIME`,
   натиснути "Test CUDA configuration" — переконатися, що результат
   показує `runtimeSource: managed` (або `custom`, залежно від того, що
   реально встановлено) і `effectiveProvider: cuda`.
2. Змінити `ONNX_EXECUTION_PROVIDER` на `dml` в UI (staged, без Save).
   Переконатися, що: (a) блок "Managed CUDA runtime" (dropdown) зникає з
   форми; (b) з'являється примітка "DirectML uses the standard npm
   onnxruntime-node package…"; (c) кнопка тепер каже "Test DML
   configuration".
3. Натиснути "Test DML configuration" **до Save** — переконатися, що
   `runtimeSource` в результаті **не** `managed`, і `effectiveProvider`
   дорівнює `dml` (або `cpu` з `fellBackToCpu: true`, якщо DML апаратно
   недоступний на цій машині — але ніколи не помилка про завантаження
   CUDA-специфічної бібліотеки).
4. Зберегти зміну провайдера, перезапустити Admin (`npm run admin`).
   Переконатися, що сервер стартує без попереджень про cuDNN/managed
   runtime у консолі.

**DML → CUDA:**
5. З провайдером `dml` активним (після кроків вище), змінити
   `ONNX_EXECUTION_PROVIDER` назад на `cuda` в UI (staged).
   Переконатися, що dropdown "Managed CUDA runtime" знову з'являється, і
   **раніше збережений вибір runtime вже виставлений** (не потрібно
   вибирати заново).
6. Натиснути "Test CUDA configuration" — переконатися, що знову working:
   `runtimeSource: managed`, `effectiveProvider: cuda`.
7. Зберегти, перезапустити Admin. Переконатися, що CUDA-embedding запити
   (Ask/search проти ONNX-backed колекції) реально працюють на GPU
   (перевірити через `npm run doctor` або лог з providerState).

**Індексатор і MCP:**
8. Із провайдером `dml` збереженим, запустити `npm run index` (або
   spawned job з Admin) проти невеликої тестової директорії з
   `ONNX_EMBED=1` — переконатися, що індексація завершується без
   `[dml] backend not found` помилки.
9. Перезапустити MCP сервер (`npm run mcp` або перепідключити в Claude
   Code) з тим самим `dml` провайдером — переконатися, що пошук проти
   ONNX-backed колекції відпрацьовує без помилки завантаження CUDA
   runtime.
