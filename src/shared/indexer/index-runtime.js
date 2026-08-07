// Shared indexer CLI runtime (code review, round 4, P1) — extracted out of
// index.js so the orchestration logic (bootstrap env, construct
// SettingsService, apply settings, apply an EXPLICITLY SUPPLIED capability
// bundle, run()) is not duplicated between index-full.js and
// index-lite.js. This module never imports core/ollama-lazy.js,
// core/onnx-embed-lazy.js, indexer/phases/tag-onnx-lazy.js, or any
// Lite typed-unavailable stub — it has NO opinion on which edition is
// running and NEVER branches on edition/SEMIDEX_LITE itself (Phase 8B's
// own "composition root is the only place that selects an implementation"
// requirement). The capability bundle is a parameter, supplied by
// whichever thin entry point (index-full.js or index-lite.js) calls
// runIndexerCli() — this file is the ONE shared CLI/indexing flow both
// entry points run, never a third composition root of its own.
//
// Usage: COLLECTION=my-collection node src/indexer/index-full.js <file|folder>
//        (or index-lite.js, for the Lite edition)
import { pathToFileURL } from 'url';

/**
 * True only when the actually-invoked script's own URL matches
 * `entryFileUrl` OR one of `aliasFileUrls` (mirrors every other real CLI
 * entry point's own isMainModule guard). Exported so index-full.js/
 * index-lite.js can gate their OWN capability-building dynamic imports
 * behind it too — not just the orchestration flow below — so importing
 * either entry point for testing never has a side effect (matches the
 * former single index.js's own discipline: no real work ever ran as a bare
 * module-import side effect, only inside this guard).
 *
 * aliasFileUrls exists ONLY for index-full.js's own backward-compatible
 * launcher, indexer/index.js — a direct `node src/indexer/index.js <path>`
 * invocation sets process.argv[1] to index.js's own path, not
 * index-full.js's, even though index.js immediately delegates to
 * index-full.js's runIndexerCli(). Without this, that delegation would
 * silently do nothing (the guard would never match either file's own
 * URL). No other caller needs this parameter — index-lite.js has no
 * launcher alias of its own.
 * @param {string} entryFileUrl — the calling entry point's own import.meta.url.
 * @param {string[]} [aliasFileUrls] — additional URLs that should also count as "this is the invoked script".
 */
export function isIndexerMainModule(entryFileUrl, aliasFileUrls = []) {
  if (!process.argv[1]) return false;
  const invoked = pathToFileURL(process.argv[1]).href;
  return invoked === entryFileUrl || aliasFileUrls.includes(invoked);
}

/**
 * Awaits `runFn()` to real completion and reports failure via
 * `process.exitCode`, never a hard `process.exit()` (code review, P2 —
 * pulled out of runIndexerCli() into its own small function specifically
 * so it's unit-testable with a fake `runFn`/`errorLogFn`, without needing
 * to load the real indexer environment — bootstrapEnv(), a real
 * SettingsService, run.js's own Qdrant-touching main()).
 *
 * The bug this replaced: the original code did `run().catch(err => {
 * console.error(err); process.exit(1); })` — a fire-and-forget call that
 * never awaited the returned promise. `await runIndexerCli(...)` in
 * index-full.js/index-lite.js therefore resolved as soon as run() was
 * merely CALLED, not once it actually finished — the process could reach
 * end-of-script (and Node's natural exit) while indexing was still in
 * flight, or exit 0 despite a failure that hadn't been observed yet. A
 * hard `process.exit(1)` inside the `.catch` handler was also its own
 * hazard: it could fire WHILE run()'s own `finally` block (clearing the
 * active-run capability snapshot, shutting down the ONNX tag worker) was
 * still running, killing the process mid-cleanup.
 *
 * Fixed by genuinely awaiting `runFn()` inside a try/catch: this
 * function's own returned promise only resolves after `runFn()` truly
 * settles (so `await runIndexerCli(...)` correctly blocks until indexing
 * is done), a failure is reported via `errorLogFn` and
 * `process.exitCode = 1` (a graceful signal Node acts on only once the
 * event loop naturally drains — never a hard exit that could interrupt
 * `runFn()`'s own in-flight cleanup), and rejection is always caught here
 * — awaited errors are never left as an unhandled promise rejection.
 * @param {() => Promise<void>} runFn
 * @param {(err: unknown) => void} [errorLogFn] — defaults to console.error; overridable so tests never print to the real console.
 */
export async function runAndReportExitCode(runFn, errorLogFn = console.error) {
  try {
    await runFn();
  } catch (err) {
    errorLogFn(err);
    process.exitCode = 1;
  }
}

/**
 * Runs the indexer CLI flow: bootstrap env, construct SettingsService, apply
 * settings, then run({ capabilities }) — the capability bundle is passed
 * directly into run() as a real argument, never applied through a
 * module-scope mutator first (code review, Phase 8B Step 3, second pass: an
 * earlier version of this file called `applyAllCapabilities(capabilities)`
 * to mutate run.js's own module state, then invoked bare `run()` — even
 * though run.js's OWN internals no longer hold module-scope capability
 * state at all, keeping that two-step shape here would have re-introduced
 * exactly the same class of bug this fix removes: a caller-facing API that
 * LOOKS instance-scoped but still routes through a mutate-then-call
 * sequence one process could interleave with another. run({ capabilities })
 * is the whole call — one step, no intermediate global to race). Caller
 * must already have checked isIndexerMainModule() itself before resolving
 * `capabilities` — this function assumes it should always run when called.
 * @param {{
 *   ollamaGenerate: Object, ollamaSummary: Object, ollamaEmbed: Object, ollamaDiscovery: Object,
 *   onnxEmbed: Object, tagOnnx: Object,
 * }} capabilities — the six capability slots run.js's own run() expects,
 *   already fully resolved by the caller (real *-lazy.js-backed objects for
 *   index-full.js, typed-unavailable objects for index-lite.js).
 */
export async function runIndexerCli(capabilities) {
  const { bootstrapEnv } = await import('../core/env-bootstrap.js');
  const { osEnv, dotenvValues } = bootstrapEnv();

  const { createSettingsService } = await import('../../core/settings/service.js');
  const settingsService = createSettingsService({ osEnv, dotenvValues });

  const { applyAllSettings, run } = await import('./run.js');
  applyAllSettings(settingsService);

  await runAndReportExitCode(() => run({ capabilities }));
}
