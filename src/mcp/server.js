import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as search from './tools/search.js';
import * as collections from './tools/collections.js';
import * as getChunk from './tools/getChunk.js';
import * as related from './tools/related.js';
import * as backlinks from './tools/backlinks.js';
import * as findByTag from './tools/findByTag.js';

const tools = [search, collections, getChunk, related, backlinks, findByTag];
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
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
