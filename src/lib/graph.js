import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const GRAPH_PATH = resolve('graph.json');

export function loadGraph() {
  if (!existsSync(GRAPH_PATH)) return {};
  return JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
}

export function saveGraph(graph) {
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');
}

export function addLink(graph, from, to) {
  if (!graph[from]) graph[from] = { links: [], backlinks: [] };
  if (!graph[from].links.includes(to)) graph[from].links.push(to);
}

export function addBacklink(graph, to, from) {
  if (!graph[to]) graph[to] = { links: [], backlinks: [] };
  if (!graph[to].backlinks.includes(from)) graph[to].backlinks.push(from);
}

// remove all edges for a file (called before reindexing)
export function removeFile(graph, sourceFile) {
  const oldLinks = graph[sourceFile]?.links ?? [];
  // remove backlinks this file added to others
  for (const target of oldLinks) {
    if (graph[target]) {
      graph[target].backlinks = graph[target].backlinks.filter(f => f !== sourceFile);
    }
  }
  // remove all edges in other nodes that reference this file
  for (const node of Object.values(graph)) {
    node.links = node.links?.filter(f => f !== sourceFile) ?? [];
    node.backlinks = node.backlinks?.filter(f => f !== sourceFile) ?? [];
  }
  delete graph[sourceFile];
}
