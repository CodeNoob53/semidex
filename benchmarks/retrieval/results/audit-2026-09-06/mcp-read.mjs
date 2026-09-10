import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
const requests = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = new Client({ name: 'retrieval-audit', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp/server.js'], cwd: process.cwd(), env: { ...process.env }, stderr: 'pipe' });
const output = [];
try {
  await client.connect(transport);
  const available = await client.listTools();
  if (requests.length === 0) output.push(available);
  for (const request of requests) {
    if (!available.tools.some(t => t.name === request.name) || !/^qdrant_(collection_info|get_|list_|search|find_by_tag)/.test(request.name)) throw new Error('Not an available read tool');
    const start = performance.now();
    const result = await client.callTool(request, undefined, { timeout: 180000 });
    output.push({ request, ms: performance.now() - start, result });
    writeFileSync(process.argv[3], JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output.at(-1)));
  }
  writeFileSync(process.argv[3], JSON.stringify(output, null, 2));
} finally { await client.close(); }
