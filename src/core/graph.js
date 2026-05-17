import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

function graphPath(collection) {
  return resolve(`graph.${collection}.json`);
}

const _graphCache = new Map(); // collection → { mtimeMs, data }

export function loadGraph(collection = 'default') {
  const p = graphPath(collection);
  if (!existsSync(p)) return {};
  const { mtimeMs } = statSync(p);
  const cached = _graphCache.get(collection);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  const data = JSON.parse(readFileSync(p, 'utf8'));
  _graphCache.set(collection, { mtimeMs, data });
  return data;
}

export function saveGraph(graph, collection = 'default') {
  const p = graphPath(collection);
  writeFileSync(p, JSON.stringify(graph, null, 2), 'utf8');
  const { mtimeMs } = statSync(p);
  _graphCache.set(collection, { mtimeMs, data: graph });
}

export function addLink(graph, from, to) {
  if (!graph[from]) graph[from] = { links: [], backlinks: [] };
  if (!graph[from].links.includes(to)) graph[from].links.push(to);
}

export function addBacklink(graph, to, from) {
  if (!graph[to]) graph[to] = { links: [], backlinks: [] };
  if (!graph[to].backlinks.includes(from)) graph[to].backlinks.push(from);
}

export function removeFile(graph, sourceFile) {
  const oldLinks = graph[sourceFile]?.links ?? [];
  for (const target of oldLinks) {
    if (graph[target]) {
      graph[target].backlinks = graph[target].backlinks.filter(f => f !== sourceFile);
    }
  }
  for (const node of Object.values(graph)) {
    node.links = node.links?.filter(f => f !== sourceFile) ?? [];
    node.backlinks = node.backlinks?.filter(f => f !== sourceFile) ?? [];
  }
  delete graph[sourceFile];
}
