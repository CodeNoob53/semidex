// Resolves which ONNX Runtime module path Semidex should actually load —
// explicit ONNXRUNTIME_NODE_PATH setting > managed CUDA runtime selection
// (ONNX_MANAGED_RUNTIME, CUDA provider only — see resolveEffectiveOnnxRuntimePath()'s
// own header comment) > default npm package — and prepares this PROCESS's
// own environment (PATH, ONNXRUNTIME_NODE_PATH, ONNX_MANAGED_RUNTIME_ACTIVE)
// so local/core/onnx-runtime.js's existing loadOnnxRuntime()/
// resolveOnnxRuntimeModule() (untouched, still reads only
// env.ONNXRUNTIME_NODE_PATH) picks it up correctly.
//
// This is the ONE place every real caller (the indexer CLI via
// src/indexer/index-full.js, the Admin server via src/admin/bootstrap.js,
// MCP via src/mcp/onnx-runtime-resolution.js, the Admin probe route via
// src/local/admin/api/onnx.js, and any future entry point) goes through —
// never duplicated, so the explicit>managed>npm precedence, its
// provider-gating, and the cuDNN PATH preparation it requires can never
// drift apart between processes.
//
// Real OS-level explicit values are never at risk of being cleared
// incorrectly: resolveEffectiveOnnxRuntimePath() always reads the CURRENT
// ONNXRUNTIME_NODE_PATH value as its own `explicitPath` input — if it was
// genuinely set and non-empty, `resolved.source` is 'explicit' and
// `resolved.path` equals that same value, so applying the patch re-writes
// the identical value it just read, never deletes it.
import { existsSync, readdirSync } from 'node:fs';
// resolved.cudnnBinPath (checked below) is always recorded by the
// Windows-only CUDA installer (scripts/install-onnxruntime-cuda-windows.ps1)
// into the managed runtime's own manifest — a real Windows path by
// construction, regardless of which OS the CURRENT process consuming it
// happens to run on (e.g. the Admin server's settings-listing layer can
// itself run on a non-Windows host). The OS-native node:path.isAbsolute
// would silently return false for a "C:\..." string on any non-Windows
// host, so path.win32.isAbsolute is used explicitly here.
import { win32 as pathWin32 } from 'node:path';
const { isAbsolute } = pathWin32;
import { readManagedRuntimeManifest, isManifestWellFormed, verifyManagedRuntimeOnDisk } from './managed-onnx-runtime-manifest.js';
import { isValidManagedRuntimeId, resolveManagedRuntimePathSafe } from './managed-runtime-id.js';
import { resolveSemidexHomePaths } from './semidex-home.js';

/**
 * Review finding (P1): a `source: 'npm'` fallback with just a `warning`
 * string used to be indistinguishable, to every real caller, from "no
 * managed runtime was ever selected" — both looked like an ordinary,
 * healthy npm resolution. That silently downgraded an explicit CUDA
 * choice to CPU: the user selected a specific managed runtime, it turned
 * out to be invalid/corrupt/missing, and every real caller (indexer,
 * Admin, MCP) proceeded to load the plain npm package anyway, often
 * without the caller even noticing (a `warning` alone was easy to miss —
 * tests even asserted this fallback as the CORRECT behavior). `resolutionFailed`
 * is the explicit, typed signal that fixes this: true if and ONLY if the
 * caller actually selected a managed runtime (`managedSelection` was
 * non-empty), that selection is meaningful for the REQUESTED provider (see
 * `provider` below), and it could not be resolved — never true for a
 * genuine "no selection made" npm default, and never true for a managed
 * selection that's simply inapplicable to a non-CUDA provider.
 * resolveOnnxRuntimeForProcess() below treats this the same as a
 * prepareOnnxRuntimeProcessEnv() failure (prepared.ok: false), so every
 * real caller's own fail-fast/typed-unavailable handling applies here too,
 * not just to a cuDNN-PATH failure on an otherwise-valid selection.
 *
 * Provider-awareness (bug fix): `ONNX_MANAGED_RUNTIME` names a CUDA-only
 * build (see managed-runtime-id.js's `<ortVersion>-cuda<cudaMajor>` id
 * format — there is no other flavor) with no DirectML execution provider
 * compiled in. Applying it regardless of the REQUESTED provider used to
 * make a dml/cpu selection silently load the CUDA build anyway, which then
 * failed DML probes with "no available backend found. ERR: [dml] backend
 * not found" — the managed runtime was never the problem, using it for a
 * provider it was never built for was. `provider` is REQUIRED (no
 * default) precisely so a caller can never forget to pass it and
 * accidentally get the old CUDA-only behavior back.
 *
 * The managed selection value itself is deliberately never cleared or
 * validated away for a non-cuda provider — it stays in settings exactly as
 * the user left it (see applyOnnxRuntimeEnvPatch()'s own provider-aware
 * clearing of the ACTIVE env markers below), so switching back to cuda
 * later re-applies the same managed runtime without the user reselecting
 * it. Only the EXPLICIT `ONNXRUNTIME_NODE_PATH` is treated as
 * provider-universal — a user-provided custom onnxruntime-node build can
 * legitimately support any provider (npm's own default package does, for
 * instance), so it is never gated by `provider` here.
 * @param {{
 *   provider: 'cpu'|'dml'|'cuda',
 *   explicitPath?: string,
 *   managedSelection?: string,
 *   runtimesDir: string,
 *   readFileSyncFn?: Function,
 *   existsSyncFn?: Function,
 * }} opts
 * @returns {{
 *   path: string, source: 'explicit'|'managed'|'npm', managedId: string|null,
 *   cudnnBinPath: string|null, warning?: string, resolutionFailed?: boolean,
 * }}
 */
export function resolveEffectiveOnnxRuntimePath({
  provider, explicitPath, managedSelection, runtimesDir, readFileSyncFn, existsSyncFn,
}) {
  const trimmedExplicit = String(explicitPath ?? '').trim();
  if (trimmedExplicit) {
    return { path: trimmedExplicit, source: 'explicit', managedId: null, cudnnBinPath: null };
  }

  const trimmedManaged = provider === 'cuda' ? String(managedSelection ?? '').trim() : '';
  if (trimmedManaged) {
    if (!isValidManagedRuntimeId(trimmedManaged)) {
      return {
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: `managed runtime selected but invalid/corrupt: invalid managed runtime id "${trimmedManaged}"`,
      };
    }
    let dirPath;
    try {
      dirPath = resolveManagedRuntimePathSafe(runtimesDir, trimmedManaged);
    } catch (err) {
      return {
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: `managed runtime selected but invalid/corrupt: ${err.message}`,
      };
    }

    const read = readManagedRuntimeManifest(dirPath, { readFileSyncFn, existsSyncFn });
    if (!read.ok) {
      return {
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: `managed runtime selected but invalid/corrupt: manifest ${read.reason}`,
      };
    }
    if (!isManifestWellFormed(read.manifest)) {
      return {
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: 'managed runtime selected but invalid/corrupt: manifest is not well-formed',
      };
    }
    // Full, UNCACHED integrity check — this is the actual security
    // boundary (the moment a path is about to be handed to
    // ONNXRUNTIME_NODE_PATH and actually loaded). Never reuses any
    // listing-route display cache.
    const verify = verifyManagedRuntimeOnDisk(dirPath, read.manifest, { readFileSyncFn, existsSyncFn });
    if (!verify.ok) {
      return {
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: `managed runtime selected but invalid/corrupt: integrity check failed (${verify.mismatches.map((m) => `${m.name}: ${m.reason}`).join(', ')})`,
      };
    }

    return {
      path: dirPath,
      source: 'managed',
      managedId: trimmedManaged,
      cudnnBinPath: read.manifest.dependencies.cudnnBinPath,
    };
  }

  return { path: '', source: 'npm', managedId: null, cudnnBinPath: null };
}

/**
 * Adds `dir` to `env.PATH` exactly once, case-insensitively (Windows PATH
 * comparisons are case-insensitive; this avoids "C:\Foo" and "c:\foo"
 * being treated as two different entries and duplicated on repeated
 * calls in a long-lived process). Returns the same env for chaining.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 */
function addToPathOnce(env, dir) {
  const current = env.PATH ?? env.Path ?? '';
  const existing = current.split(';').map((p) => p.trim()).filter(Boolean);
  const alreadyPresent = existing.some((p) => p.toLowerCase() === dir.toLowerCase());
  if (!alreadyPresent) {
    env.PATH = [dir, ...existing].join(';');
  }
}

/**
 * Review requirement: Semidex configures PATH only inside the CURRENT
 * process, before the first ONNX Runtime load — never the system/user
 * PATH. A managed CUDA runtime's onnxruntime_providers_cuda.dll cannot
 * locate its cuDNN dependency without this (confirmed live: the probe
 * fails with "Failed to load shared library" without the cuDNN bin
 * directory on PATH, succeeds identically to production with it) — the
 * exact directory was found and verified by the installer at install
 * time and is recorded in the manifest's own dependencies.cudnnBinPath,
 * never re-discovered or guessed here.
 *
 * This is the ONE function every real caller (indexer, Admin, probe, and
 * any child process that inherits its env) uses — never duplicated.
 *
 * @param {{ path: string, cudnnBinPath: string|null }} resolved
 * @param {{ env?: NodeJS.ProcessEnv, existsSyncFn?: Function, readdirSyncFn?: Function }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function prepareOnnxRuntimeProcessEnv(resolved, { env = process.env, existsSyncFn = existsSync, readdirSyncFn = readdirSync } = {}) {
  if (!resolved.cudnnBinPath) return { ok: true }; // npm/explicit-without-cuDNN-dependency — nothing to prepare

  if (!isAbsolute(resolved.cudnnBinPath)) {
    return { ok: false, reason: `recorded cudnnBinPath is not an absolute path: "${resolved.cudnnBinPath}"` };
  }
  if (!existsSyncFn(resolved.cudnnBinPath)) {
    // Review requirement: never silent-fallback if the recorded path
    // disappeared — return a clear diagnostic instead.
    return { ok: false, reason: `recorded cuDNN directory no longer exists on disk: "${resolved.cudnnBinPath}" — re-run the installer to repair this managed runtime` };
  }
  let entries;
  try {
    entries = readdirSyncFn(resolved.cudnnBinPath);
  } catch (err) {
    return { ok: false, reason: `could not list the recorded cuDNN directory: ${err.message}` };
  }
  const hasCudnnDll = entries.some((e) => /^cudnn64_\d+\.dll$/i.test(e));
  if (!hasCudnnDll) {
    return { ok: false, reason: `recorded cuDNN directory no longer contains a cudnn64_*.dll: "${resolved.cudnnBinPath}" — re-run the installer to repair this managed runtime` };
  }

  addToPathOnce(env, resolved.cudnnBinPath);
  return { ok: true };
}

/**
 * The ONE place that ever touches ONNXRUNTIME_NODE_PATH/
 * ONNX_MANAGED_RUNTIME_ACTIVE, applying a symmetric set-or-delete
 * contract so a stale value from an earlier resolution can never leak
 * into a later call in a long-lived process. Callers never set/delete
 * these two keys directly.
 * @param {{ path: string, source: 'explicit'|'managed'|'npm', managedId: string|null }} resolved
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function applyOnnxRuntimeEnvPatch(resolved, { env = process.env } = {}) {
  if (resolved.path) env.ONNXRUNTIME_NODE_PATH = resolved.path;
  else delete env.ONNXRUNTIME_NODE_PATH;

  if (resolved.source === 'managed') env.ONNX_MANAGED_RUNTIME_ACTIVE = resolved.managedId;
  else delete env.ONNX_MANAGED_RUNTIME_ACTIVE;
}

/**
 * Review finding (P1): every real composition root (indexer/index-full.js,
 * admin/bootstrap.js, and now mcp/server.js) needs the EXACT same
 * five-step sequence — read ONNXRUNTIME_NODE_PATH/ONNX_MANAGED_RUNTIME from
 * settingsService, resolve runtimesDir, resolve the effective path,
 * apply the env patch, prepare the cuDNN PATH — and until now that
 * sequence was hand-copied into each composition root separately. MCP's
 * own copy was simply missing entirely (the actual P1 finding this
 * function was added to close): mcp/server.js called applyEnvWriteBack()
 * but never touched ONNX runtime resolution at all, so a managed CUDA
 * selection silently had no effect on MCP search — it would construct its
 * onnxEmbed capability against whatever ONNXRUNTIME_NODE_PATH happened to
 * already be set in the OS environment (usually unset), never the
 * managed selection.
 *
 * This function is the ONE place that sequence now lives — every real
 * caller goes through it, so the explicit>managed>npm precedence and the
 * cuDNN PATH preparation it requires can never drift apart between
 * processes, and a future caller can never forget a step (like MCP did).
 *
 * Deliberately returns a single typed result rather than throwing —
 * callers decide for themselves whether a non-ok `prepared` result should
 * be fail-fast (indexer CLI: refuse to start) or degrade to a typed
 * "unavailable" capability (Admin/MCP: keep serving, but never attempt to
 * load a runtime this function just proved is broken).
 *
 * Review finding (P1): `prepared.ok` used to reflect ONLY
 * prepareOnnxRuntimeProcessEnvFn()'s own cuDNN-PATH check — an explicitly
 * selected but invalid/corrupt/missing managed runtime (caught earlier,
 * inside resolveEffectiveOnnxRuntimePathFn() itself) fell all the way
 * through to `resolved.source === 'npm'` with `cudnnBinPath: null`, which
 * trivially satisfies prepareOnnxRuntimeProcessEnvFn()'s own early-exit
 * ("nothing to prepare") and reports `ok: true` — silently downgrading an
 * explicit CUDA choice to CPU with no fail-fast/typed-unavailable
 * signal at all, only a `warning` string easy to miss. Fixed by folding
 * `resolved.resolutionFailed` into `prepared` here: a failed EXPLICIT
 * managed selection is now indistinguishable, to every real caller, from
 * a failed cuDNN-PATH prep — both produce `prepared.ok: false` with the
 * same actionable `reason`, and neither is ever silently absorbed into a
 * plain npm/CPU fallback.
 *
 * Reads `ONNX_EXECUTION_PROVIDER` from the same settingsService as
 * `ONNXRUNTIME_NODE_PATH`/`ONNX_MANAGED_RUNTIME` (never a raw env read —
 * this must reflect the SAME active-value resolution, saved config +
 * next_restart semantics, as every other setting this function reads) and
 * threads it into resolveEffectiveOnnxRuntimePathFn() as `provider`, so a
 * dml/cpu process never applies a CUDA-only managed runtime (see
 * resolveEffectiveOnnxRuntimePath()'s own header comment for the bug this
 * closes).
 * @param {{
 *   settingsService: { getActiveValue(key: string): string },
 *   env?: NodeJS.ProcessEnv,
 *   resolveSemidexHomePathsFn?: typeof resolveSemidexHomePaths,
 *   resolveEffectiveOnnxRuntimePathFn?: typeof resolveEffectiveOnnxRuntimePath,
 *   applyOnnxRuntimeEnvPatchFn?: typeof applyOnnxRuntimeEnvPatch,
 *   prepareOnnxRuntimeProcessEnvFn?: typeof prepareOnnxRuntimeProcessEnv,
 * }} opts
 * @returns {{
 *   resolved: ReturnType<typeof resolveEffectiveOnnxRuntimePath>,
 *   resolutionWarning: string | null,
 *   prepared: { ok: true } | { ok: false, reason: string },
 * }}
 */
export function resolveOnnxRuntimeForProcess({
  settingsService,
  env = process.env,
  resolveSemidexHomePathsFn = resolveSemidexHomePaths,
  resolveEffectiveOnnxRuntimePathFn = resolveEffectiveOnnxRuntimePath,
  applyOnnxRuntimeEnvPatchFn = applyOnnxRuntimeEnvPatch,
  prepareOnnxRuntimeProcessEnvFn = prepareOnnxRuntimeProcessEnv,
}) {
  const provider = settingsService.getActiveValue('ONNX_EXECUTION_PROVIDER');
  const explicitPath = settingsService.getActiveValue('ONNXRUNTIME_NODE_PATH');
  const managedSelection = settingsService.getActiveValue('ONNX_MANAGED_RUNTIME');
  const { runtimesDir } = resolveSemidexHomePathsFn({ env });
  const resolved = resolveEffectiveOnnxRuntimePathFn({ provider, explicitPath, managedSelection, runtimesDir });
  applyOnnxRuntimeEnvPatchFn(resolved, { env });
  const prepared = resolved.resolutionFailed
    ? { ok: false, reason: resolved.warning }
    : prepareOnnxRuntimeProcessEnvFn(resolved, { env });
  return { resolved, resolutionWarning: resolved.warning ?? null, prepared };
}
