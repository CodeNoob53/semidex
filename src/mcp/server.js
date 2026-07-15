import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { bootstrapEnv } from '../core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../core/settings/service.js';

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

const { sanitiseErrorMessage } = await import('../core/doctor-checks.js');
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

const tools = [search, collections, getChunk, findByTag, listFiles, listTags, listDirectories, getSkeleton, getSkeletonNode, getSkeletonChildren, getNode, getContent];
const toolMap = Object.fromEntries(tools.map(t => [t.schema.name, t.handle]));

const server = new Server(
  { name: 'qdrant-indexer-mcp', version: '2.0.0' },
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
const { applyCeRerankSettings, loadCEModel } = await import('./../core/ce-rerank.js');
applyCeRerankSettings(settingsService);

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
