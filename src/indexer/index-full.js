// Full Semidex indexer CLI entry point (code review, round 4, P1 — split
// out of the former index.js, which used to branch on
// SEMIDEX_INDEXER_EDITION inside one shared file; the AST-based Lite
// package closure validator is branch-insensitive, so a literal
// `await import('../core/ollama-lazy.js')` anywhere in a Lite-shipped
// file's source was a real static edge regardless of which `if` branch it
// sat in — the only way to make Lite's shipped entry point genuinely free
// of that edge is for Lite to run a DIFFERENT file that never contains the
// literal at all). This file is Full-only (excluded from the Lite package
// — see packages/lite/build.mjs's EXCLUDE_FILES) and owns Full's own real
// capability selection; index-lite.js is Lite's sibling entry point,
// dynamically imports NONE of the same local-runtime modules, and shares
// the actual CLI/indexing flow via index-runtime.js's runIndexerCli() —
// neither entry point duplicates that orchestration logic.
//
// admin/jobs/spawn-indexer-full.js's own spawnIndexer selects THIS file as
// the spawn target — admin/jobs/registry.js itself has no `edition`
// concept and no default spawnIndexer; Full's composition roots
// (admin/server-full.js's createApp(), admin/bootstrap.js) inject
// spawn-indexer-full.js's spawnIndexer explicitly, never both editions
// spawning one shared file anymore.
//
// Usage: COLLECTION=my-collection node src/indexer/index-full.js <file|folder>
import { isIndexerMainModule, runIndexerCli } from './index-runtime.js';

// indexer/index.js is the backward-compatible launcher (see its own header
// comment) — a direct `node src/indexer/index.js <path>` invocation sets
// process.argv[1] to index.js's own path, not this file's, even though
// index.js immediately delegates here. Registered as an alias so
// isIndexerMainModule() still matches in that case.
const LAUNCHER_ALIAS_URL = new URL('./index.js', import.meta.url).href;

// Run only when executed directly, not when imported for testing — gates
// the capability-building dynamic imports too, not just runIndexerCli()
// itself, so importing this file never touches core/ollama-lazy.js/
// core/onnx-embed-lazy.js/phases/tag-onnx-lazy.js as an import side effect.
if (isIndexerMainModule(import.meta.url, [LAUNCHER_ALIAS_URL])) {
  const ollamaLazy = await import('../core/ollama-lazy.js');
  const onnxEmbedLazy = await import('../core/onnx-embed-lazy.js');
  const tagOnnxLazy = await import('./phases/tag-onnx-lazy.js');
  // createTagOnnxCapability()/createOnnxEmbeddingCapability() each
  // construct ONE fresh, independent instance for this composition root
  // (code review — neither tag-onnx.js nor onnx-embed.js exposes a shared
  // module-scope singleton; every consumer must construct its own
  // instance). Called exactly once, here, at composition time — never
  // per-request, never shared with another composition root's own
  // instance.
  const tagOnnx = await tagOnnxLazy.createTagOnnxCapability();
  const onnxEmbed = onnxEmbedLazy.createOnnxEmbeddingCapability();

  await runIndexerCli({
    ollamaGenerate: ollamaLazy, ollamaSummary: ollamaLazy, ollamaEmbed: ollamaLazy, ollamaDiscovery: ollamaLazy,
    onnxEmbed, tagOnnx,
  });
}
