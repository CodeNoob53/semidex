import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { bootstrapEnv } from '../shared/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../core/settings/service.js';
import { resolveOnnxEmbedCapabilityForMcp } from './onnx-runtime-resolution.js';

// Bootstrap env FIRST (before any import below could mutate process.env via
// a static 'dotenv/config' import) — same provenance-correct pattern
// src/admin/bootstrap.js uses. Static `import` statements are hoisted
// above all other top-level code regardless of where they're written, so
// the ONLY way to guarantee this bootstrap genuinely runs before every
// tool module (and their transitive imports, several of which still do
// `import 'dotenv/config'`) is to import everything else dynamically,
// after this bootstrap call — mirroring admin/bootstrap.js's own
// isMainModule dynamic-import block exactly. This replaces the old
// `config({ path: ... })` (a static dotenv side-effect import) that used
// to run here with no OS-env snapshot taken first, meaning a settings.json
// config_json-tier value and a real .env value could never have been told
// apart for this process either.
const { osEnv, dotenvValues } = bootstrapEnv({ envPath: join(dirname(fileURLToPath(import.meta.url)), '../../.env') });
const settingsService = createSettingsService({ osEnv, dotenvValues });
// Writes every writable setting's active value into process.env —
// QDRANT_URL in particular, since core/qdrant/client.js still reads it via
// plain process.env.QDRANT_URL per call (code review finding: without
// this, a settings.json-saved QDRANT_URL never reached the real client in
// the MCP process either). Must run before any dynamically-imported tool
// module below can construct a Qdrant client.
applyEnvWriteBack(settingsService);

const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

const { embedForSearch } = await import('../shared/core/embeddings.js');
// MCP is a Full-only entry point (never staged in the Lite package — see
// packages/lite/build.mjs's EXCLUDE_DIRS 'mcp' entry), so importing
// local/core/ollama-capability.js's factories directly here never reaches
// Lite's module graph (Phase 8B Step 8 — the transitional
// core/ollama-lazy.js dynamic-loader wrapper is gone).
const { createOllamaEmbedCapability, createOllamaDiscoveryCapability } = await import('../local/core/ollama-capability.js');
const ollamaEmbed = createOllamaEmbedCapability();
const ollamaDiscovery = createOllamaDiscoveryCapability();
// createCloudEmbeddingCapability() (code review, Phase 8B Step 6): the real
// Qdrant Cloud Inference embedding-budget/tokenizer capability — this
// process imports src/cloud/ directly (a real `composition root -> cloud`
// edge, explicitly allowed), so embeddings.js/search.js/tools/search.js
// never need to import it themselves.
const { createCloudEmbeddingCapability } = await import('../cloud/embedding/cloud-embedding-provider.js');
const cloudEmbed = createCloudEmbeddingCapability();
// onnxEmbed: resolveOnnxEmbedCapabilityForMcp() (mcp/onnx-runtime-resolution.js,
// real behavioral test coverage in tests/unit/mcp/onnx-runtime-resolution.test.js
// — not just source-regex) constructs ONE fresh, independent capability
// instance for this process's own composition (code review — onnx-embed.js
// no longer exposes a shared module-scope singleton; every composition
// root must construct its own instance, exactly like index-full.js's own
// indexer-CLI composition does).
//
// Review finding (P1/P2): this process used to write settings back into
// process.env but never resolved which onnxruntime-node build to
// actually load — a managed CUDA selection (ONNX_MANAGED_RUNTIME) had no
// effect here, so MCP search against an ONNX-backed collection could
// silently load the plain npm package (no CUDA) even when Admin/the
// indexer correctly picked up the managed runtime.
// resolveOnnxEmbedCapabilityForMcp() is the ONE place this process
// resolves which onnxruntime-node build to load and builds the
// real-vs-typed-unavailable capability decision together, so it can
// never drift out of sync with indexer/index-full.js's/admin/bootstrap.js's
// own equivalent resolution again. Runs BEFORE any real embed call —
// createOnnxEmbeddingCapability() itself defers the actual heavy load
// until first use, but the env patch this applies must be in place well
// before that.
const onnxEmbed = await resolveOnnxEmbedCapabilityForMcp({ settingsService });
// core/embeddings.js's applyEmbeddingCapabilities() (the process-wide
// module-scope fallback) is deliberately NEVER called from this file (code
// review, round 4 — removed after round 3 made it redundant, same
// rationale as composition/lite.js's createLiteApp() and
// server-full.js's createApp()): this server's own search request path
// reaches embeddings.js exclusively through search.setEmbedQuery() below,
// which passes capabilities explicitly per call — mutating the shared
// module-scope fallback here would be pure global side-effecting noise
// with no real consumer, and risks stomping whatever OTHER composition
// root (e.g. createLiteApp(), constructed in the same process by a test)
// happens to share embeddings.js's module scope. The fallback itself still
// exists in embeddings.js, but starts UNSET (null) rather than defaulting
// to a real local-runtime implementation (see embeddings.js's own header
// comment): a caller that
// hasn't been updated to pass capabilities explicitly (e.g. a smoke-test
// script) gets a clear "no capability injected" error instead of a silent
// real-network default — this file has no reason to touch it in either
// direction.

const { sanitiseErrorMessage } = await import('../shared/core/doctor-checks.js');
const { createRerankCapability } = await import('../core/rerank-provider.js');
const search = await import('./tools/search.js');
const collections = await import('./tools/collections.js');
const getChunk = await import('./tools/getChunk.js');
const findByTag = await import('./tools/findByTag.js');
const listFiles = await import('./tools/listFiles.js');
const listTags = await import('./tools/listTags.js');
const listDirectories = await import('./tools/listDirectories.js');
const getSkeleton = await import('./tools/getSkeleton.js');
const getSkeletonNode = await import('./tools/getSkeletonNode.js');
const getSkeletonChildren = await import('./tools/getSkeletonChildren.js');
const getNode = await import('./tools/getNode.js');
const getContent = await import('./tools/getContent.js');

search.setSettingsService(settingsService);
// Binds tools/search.js's own runHybridSearch() call to THIS process's
// real capability explicitly (code review, round 3 — the actual per-call
// isolation fix, matching admin/server-full.js's createApp() and
// admin/composition/lite.js's createLiteApp() own equivalents): this
// server's own search requests never consult embeddings.js's shared
// module-scope fallback at all, regardless of what any other composition
// root does with it in the same process.
search.setEmbedQuery((profile, query) => embedForSearch(profile, query, { capabilities: { ollama: ollamaEmbed, onnxEmbed, cloudEmbed } }));
search.setCloudEmbed(cloudEmbed);
// setRerank()/setOllamaDiscovery() (code review, Phase 8B Step 6 second
// pass, P1 fix): binds tools/search.js's/tools/collections.js's own
// local-runtime-coupled operations (CE reranking, Ollama discovery) to
// THIS process's real capabilities explicitly — mirrors setCloudEmbed()'s
// own pattern. Neither tool module imports core/ce-rerank.js,
// core/rerank.js, or local/core/ollama.js directly anymore.
search.setRerank(createRerankCapability());
collections.setOllamaDiscovery(ollamaDiscovery);

const tools = [search, collections, getChunk, findByTag, listFiles, listTags, listDirectories, getSkeleton, getSkeletonNode, getSkeletonChildren, getNode, getContent];
const toolMap = Object.fromEntries(tools.map(t => [t.schema.name, t.handle]));

const server = new Server(
  { name: 'qdrant-indexer-mcp', version: 'unreleased' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => t.schema),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = toolMap[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    const text = await handler(args ?? {});
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${sanitiseErrorMessage(err.message, process.env.QDRANT_KEY)}` }] };
  }
});

// RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are next_restart
// settings — must be applied before the FIRST loadCEModel() call, whether
// that happens here (warmup) or lazily later (a real CE-enabled query, if
// RERANK_CE_WARMUP=0). Applying unconditionally, not just inside the
// warmup branch below, closes that gap (code review finding).
const { applyCeRerankSettings, loadCEModel, shutdownCEWorker } = await import('./../core/ce-rerank.js');
applyCeRerankSettings(settingsService);

// The CE worker is a persistent CHILD PROCESS (not a thread) — an orphaned
// child left running past this server's own shutdown is a real, observable
// leaked process, not just an open in-process handle. Ensures a graceful
// SIGTERM/SIGINT (the normal way a supervisor or `docker stop` ends this
// long-lived server) always terminates it, rather than only cleaning up
// inside a bounded CLI run like the indexer's (see
// indexer/run.js:shutdownOnnxTagWorker() for that equivalent).
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await shutdownCEWorker(); } catch { /* best effort on the way out */ }
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Mode C (docs/en/ce-rerank-design.md §1): preload the cross-encoder before
// accepting MCP connections so the first CE-enabled query has no load spike.
// Load failure must not kill the server — CE degrades to the pre-CE path.
// RERANK_CE_WARMUP/RERANK_CE_ENABLED are next_restart settings (a startup-
// time preload decision) — resolved once here via the settings service,
// matching their classification in core/settings/definitions.js.
if (settingsService.getActiveValue('RERANK_CE_ENABLED') && settingsService.getActiveValue('RERANK_CE_WARMUP')) {
  try {
    await loadCEModel();
  } catch (err) {
    process.stderr.write(`[ce-rerank] warmup failed: ${err.message} — CE disabled for this session\n`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
