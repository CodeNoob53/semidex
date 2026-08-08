// Full Semidex indexer CLI entry point (code review, round 4, P1 — split
// out of the former index.js, which used to branch on
// SEMIDEX_INDEXER_EDITION inside one shared file; the AST-based Lite
// package closure validator is branch-insensitive, so a literal
// `import '../local/core/ollama.js'` anywhere in a Lite-shipped file's
// source would be a real static edge regardless of which `if` branch it
// sat in — the only way to make Lite's shipped entry point genuinely free
// of that edge is for Lite to run a DIFFERENT file that never contains the
// literal at all). This file is Full-only (excluded from the Lite package
// — see packages/lite/build.mjs's EXCLUDE_FILES) and owns Full's own real
// capability selection; index-lite.js is Lite's sibling entry point,
// imports NONE of the same local-runtime modules, and shares the actual
// CLI/indexing flow via index-runtime.js's runIndexerCli() — neither entry
// point duplicates that orchestration logic.
//
// Phase 8B Step 8 removed the transitional *-lazy.js dynamic-loader
// wrappers — every real capability is now constructed directly from
// local/core/ollama-capability.js/onnx-embed.js/local/indexer/phases/
// tag-onnx.js. These three imports stay DYNAMIC (`await import(...)`
// inside runFullIndexerComposition(), below), not static top-level
// imports, for a reason unrelated to the Lite package boundary (this file
// is already wholesale-excluded from Lite regardless of import shape):
// local/core/ollama.js has its own top-level `import 'dotenv/config'`
// side effect, and indexer/index.js (the backward-compatible launcher —
// see its own header comment) does a plain top-level `import
// './index-full.js'`. A STATIC import chain here would make merely
// IMPORTING index.js (never running it as the main module — e.g. a probe
// script, or a future consumer that imports index.js as a library) load
// dotenv and mutate process.env as a side effect, before
// isIndexerMainModule()'s own guard ever runs — exactly the ordering bug
// tests/unit/indexer/index-bootstrap-ordering.test.js exists to catch.
// Deferring these three imports until INSIDE runFullIndexerComposition()
// (only reached once the isMainModule guard has already passed, or when a
// test calls the function directly and accepts that cost) preserves the
// "importing index.js has zero env side effects" guarantee exactly as it
// held before this step.
//
// admin/jobs/spawn-indexer-full.js's own spawnIndexer selects THIS file as
// the spawn target — admin/jobs/registry.js itself has no `edition`
// concept and no default spawnIndexer; Full's composition roots
// (admin/server-full.js's createApp(), admin/bootstrap.js) inject
// spawn-indexer-full.js's spawnIndexer explicitly, never both editions
// spawning one shared file anymore.
//
// Usage: COLLECTION=my-collection node src/indexer/index-full.js <file|folder>
import { isIndexerMainModule, runIndexerCli } from '../shared/indexer/index-runtime.js';
import { createCloudEmbeddingCapability } from '../cloud/embedding/cloud-embedding-provider.js';
import { createSettingsService } from '../core/settings/service.js';
import { bootstrapEnv } from '../shared/core/env-bootstrap.js';

// indexer/index.js is the backward-compatible launcher (see its own header
// comment) — a direct `node src/indexer/index.js <path>` invocation sets
// process.argv[1] to index.js's own path, not this file's, even though
// index.js immediately delegates here. Registered as an alias so
// isIndexerMainModule() still matches in that case.
const LAUNCHER_ALIAS_URL = new URL('./index.js', import.meta.url).href;

/**
 * The real composition logic, pulled into its own function (rather than
 * inline in the isIndexerMainModule guard below) specifically so it can
 * `return` early on a fail-fast ONNX-runtime-resolution failure without
 * resorting to an illegal top-level-module `return` — and so a test can
 * call it directly with injected dependencies instead of only ever
 * proving structure via source-text regex.
 *
 * Review finding (P2): a broken resolved runtime (prepared.ok === false —
 * e.g. an explicitly-selected managed CUDA runtime whose recorded cuDNN
 * directory has vanished since install) used to only log a warning and
 * let the indexer proceed anyway, silently attempting to load a runtime
 * already proven broken deep inside phase 4's real embed call — the exact
 * failure mode this whole review exists to close. The indexer CLI is a
 * one-shot job (unlike the long-lived Admin/MCP servers, which have
 * plenty of non-ONNX work to keep doing even when the local ONNX runtime
 * is broken) — prepared.ok === false only happens when an explicit
 * managed selection is actually configured and broken, which is always a
 * real configuration error worth stopping for. This now fails fast: no
 * job starts, a clear diagnostic goes to stderr, exit code 1.
 *
 * @param {{
 *   resolveOnnxRuntimeForProcessFn?: Function,
 *   bootstrapEnvFn?: typeof bootstrapEnv,
 *   createSettingsServiceFn?: typeof createSettingsService,
 *   runIndexerCliFn?: typeof runIndexerCli,
 *   errorLogFn?: (msg: string) => void,
 *   warnLogFn?: (msg: string) => void,
 * }} [deps] — all injectable for tests; production always calls with none.
 * @returns {Promise<{ started: boolean, exitCode?: number }>} — started:false
 *   means the fail-fast path was taken; the caller (isIndexerMainModule
 *   guard below) is responsible for actually setting process.exitCode.
 */
export async function runFullIndexerComposition({
  resolveOnnxRuntimeForProcessFn, bootstrapEnvFn = bootstrapEnv, createSettingsServiceFn = createSettingsService,
  runIndexerCliFn = runIndexerCli, errorLogFn = console.error, warnLogFn = console.warn,
} = {}) {
  // Resolve which onnxruntime-node build this PROCESS should load —
  // explicit ONNXRUNTIME_NODE_PATH > managed CUDA runtime selection
  // (ONNX_MANAGED_RUNTIME) > default npm package — via the one shared
  // resolution module every real caller (this file, admin/bootstrap.js,
  // mcp/server.js, the Admin probe route) goes through, so the precedence
  // and the cuDNN PATH preparation it requires never drift apart between
  // processes. Runs BEFORE createOnnxEmbeddingCapability() below, since
  // that capability's default ortFactory reads
  // process.env.ONNXRUNTIME_NODE_PATH lazily at first-embed-call time —
  // this only has to run once, up front, well before that.
  const resolveOnnxRuntimeForProcess = resolveOnnxRuntimeForProcessFn
    ?? (await import('../local/core/onnx-runtime-source-resolution.js')).resolveOnnxRuntimeForProcess;
  const { osEnv, dotenvValues } = bootstrapEnvFn();
  const settingsService = createSettingsServiceFn({ osEnv, dotenvValues });
  const onnxRuntimeResolution = resolveOnnxRuntimeForProcess({ settingsService });
  if (onnxRuntimeResolution.resolutionWarning) warnLogFn(`[indexer] ${onnxRuntimeResolution.resolutionWarning}`);
  if (!onnxRuntimeResolution.prepared.ok) {
    errorLogFn(`[indexer] ONNX runtime unavailable, refusing to start: ${onnxRuntimeResolution.prepared.reason}`);
    return { started: false, exitCode: 1 };
  }

  // createTagOnnxCapability()/createOnnxEmbeddingCapability() each
  // construct ONE fresh, independent instance for this composition root
  // (neither tag-onnx.js nor onnx-embed.js exposes a shared module-scope
  // singleton; every consumer must construct its own instance). Called
  // exactly once, here, at composition time — never per-request, never
  // shared with another composition root's own instance. Dynamically
  // imported (see this file's own header comment for why: preserves
  // index.js's "import has zero env side effects" guarantee, unrelated to
  // the Lite package boundary — this file is already wholesale-excluded
  // from Lite regardless of import shape).
  const {
    createOllamaGenerateCapability, createOllamaSummaryCapability,
    createOllamaEmbedCapability, createOllamaDiscoveryCapability,
  } = await import('../local/core/ollama-capability.js');
  const { createOnnxEmbeddingCapability } = await import('../local/core/onnx-embed.js');
  const { createTagOnnxCapability } = await import('../local/indexer/phases/tag-onnx.js');
  const tagOnnx = createTagOnnxCapability();
  const onnxEmbed = createOnnxEmbeddingCapability();
  // The four narrow Ollama capability slots — each satisfies exactly the
  // contract runIndexerCli()/run.js declares for it
  // (core/generation/ollama-capability.js), never the full ollama.js
  // namespace. Stateless object literals — a fresh call per slot costs
  // nothing.
  const ollamaGenerate = createOllamaGenerateCapability();
  const ollamaSummary = createOllamaSummaryCapability();
  const ollamaEmbed = createOllamaEmbedCapability();
  const ollamaDiscovery = createOllamaDiscoveryCapability();
  // createCloudEmbeddingCapability() (code review, Phase 8B Step 6): the
  // real Qdrant Cloud Inference embedding-budget/tokenizer capability —
  // this composition root imports src/cloud/ directly (a real
  // `composition root -> cloud` edge, explicitly allowed by the task's own
  // dependency rules), so run.js/embeddings.js/token-count.js/search.js
  // never need to import it themselves.
  const cloudEmbed = createCloudEmbeddingCapability();

  await runIndexerCliFn({
    ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery,
    onnxEmbed, tagOnnx, cloudEmbed,
  });
  return { started: true };
}

// Run only when executed directly, not when imported for testing — gates
// runFullIndexerComposition() itself, which is what actually reaches
// local/core/ollama-capability.js/onnx-embed.js/local/indexer/phases/
// tag-onnx.js (via the dynamic imports inside it, see that function's own
// comment) — merely importing this file (e.g. index.js's own top-level
// `import './index-full.js'`) never does.
if (isIndexerMainModule(import.meta.url, [LAUNCHER_ALIAS_URL])) {
  const result = await runFullIndexerComposition();
  if (!result.started) process.exitCode = result.exitCode;
}
