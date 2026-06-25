import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { sanitiseErrorMessage } from '../core/doctor-checks.js';
import * as search from './tools/search.js';
import * as collections from './tools/collections.js';
import * as getChunk from './tools/getChunk.js';
import * as findByTag from './tools/findByTag.js';
import * as listFiles from './tools/listFiles.js';
import * as listTags from './tools/listTags.js';
import * as listDirectories from './tools/listDirectories.js';
import * as getSkeleton from './tools/getSkeleton.js';
import * as getSkeletonNode from './tools/getSkeletonNode.js';
import * as getSkeletonChildren from './tools/getSkeletonChildren.js';
import * as getNode from './tools/getNode.js';

const tools = [search, collections, getChunk, findByTag, listFiles, listTags, listDirectories, getSkeleton, getSkeletonNode, getSkeletonChildren, getNode];
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

// Mode C (docs/en/ce-rerank-design.md §1): preload the cross-encoder before
// accepting MCP connections so the first CE-enabled query has no load spike.
// Load failure must not kill the server — CE degrades to the pre-CE path.
if (process.env.RERANK_CE_ENABLED === '1' && process.env.RERANK_CE_WARMUP === '1') {
  try {
    const { loadCEModel } = await import('./../core/ce-rerank.js');
    await loadCEModel();
  } catch (err) {
    process.stderr.write(`[ce-rerank] warmup failed: ${err.message} — CE disabled for this session\n`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
