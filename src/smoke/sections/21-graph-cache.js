import { writeFileSync, unlinkSync, existsSync, statSync, utimesSync } from 'fs';
import { resolve } from 'path';

export default async function ({ ok }) {
  console.log('\n[21] graph cache — mtime invalidation');

  // Use a throwaway collection name unlikely to collide with real data.
  const col = `_smoke_graph_cache_${Date.now()}`;
  const p   = resolve(`graph.${col}.json`);

  try {
    // 21a. Missing file returns {}
    {
      const { loadGraph } = await import('../../core/graph.js');
      const g = loadGraph(col);
      ok('missing graph file returns {}', typeof g === 'object' && Object.keys(g).length === 0);
    }

    // Re-import the same module (ESM cache) — same loadGraph reference throughout.
    const { loadGraph, saveGraph } = await import('../../core/graph.js');

    // 21b. First load reads file and returns correct content.
    {
      const initial = { 'a.md': { links: ['b.md'], backlinks: [] } };
      writeFileSync(p, JSON.stringify(initial), 'utf8');
      const g = loadGraph(col);
      ok('first load returns correct content', g['a.md']?.links[0] === 'b.md');
    }

    // 21c. Second load with same mtime returns cached object identity.
    {
      const first  = loadGraph(col);
      const second = loadGraph(col);
      ok('same-mtime load returns cached object (identity)', first === second);
    }

    // 21d. saveGraph updates cache — next loadGraph is a cache hit with new data.
    {
      const updated = { 'a.md': { links: ['b.md', 'c.md'], backlinks: [] } };
      saveGraph(updated, col);
      const g = loadGraph(col);
      ok('after saveGraph, loadGraph returns updated data', g['a.md']?.links.length === 2);
      // Cache hit: identity must match what saveGraph stored.
      ok('after saveGraph, loadGraph returns same object (cache hit)', g === updated);
    }

    // 21e. After external file change with newer mtime, loadGraph reloads.
    {
      const external = { 'x.md': { links: [], backlinks: ['y.md'] } };
      writeFileSync(p, JSON.stringify(external), 'utf8');
      // Advance mtime by 1 second so it differs from what saveGraph recorded.
      const { atime } = statSync(p);
      const newMtime = new Date(atime.getTime() + 1000);
      utimesSync(p, atime, newMtime);

      const g = loadGraph(col);
      ok('external file change with newer mtime causes reload', g['x.md'] !== undefined);
      ok('reloaded data reflects external write', g['x.md']?.backlinks[0] === 'y.md');
    }

  } finally {
    if (existsSync(p)) unlinkSync(p);
  }
}
