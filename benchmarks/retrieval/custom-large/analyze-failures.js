import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { scroll, listCollections, hybridSearch } from '../../../src/shared/core/qdrant.js';
import { embedForSearch } from '../../../src/shared/core/embeddings.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveExistingCollectionProfile } from '../../../src/core/embedding-profile/resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const RESULTS_DIR = resolve(__dirname, '../results');

const COLLECTION = 'bench-retrieval-custom-large';
const TOP_K = 10;
const BENCH_WINDOW = parseInt(process.env.BENCH_WINDOW ?? '1', 10);
if (isNaN(BENCH_WINDOW) || BENCH_WINDOW < 0) {
  console.error(`Error: BENCH_WINDOW must be a non-negative integer`);
  process.exit(1);
}
const ANCHOR_RE = /\[\[BENCH_ANCHOR:\s*(\w+)\]\]/g;

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  return { sourceFile: chunkId.slice(0, hash), chunkIndex: parseInt(chunkId.slice(hash + 1), 10) };
}

function getChunkId(payload) {
  if (!payload) return null;
  const sf = payload.source_file;
  const ci = payload.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

async function main() {
  console.log(`\n=== custom-large failure analysis ===`);
  
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) {
    console.error(`Error: Collection "${COLLECTION}" does not exist.`);
    console.error(`Analyze requires an already indexed collection. Run the benchmark first.`);
    process.exit(1);
  }

  // embedForSearch requires a resolved profile object, not a bare collection
  // name (src/core/embeddings.js). Read the collection's own recorded
  // profile — never re-derive from current env — since this is read-only
  // analysis over an already-indexed collection.
  const storageAdapter = createStorageAdapter();
  const profileResolution = await resolveExistingCollectionProfile(storageAdapter, COLLECTION);
  if (!profileResolution.resolved) {
    console.error(
      `Error: Cannot resolve embedding profile for "${COLLECTION}" (reason: ${profileResolution.reason}). ` +
      `The collection may be legacy/unmigrated.`
    );
    process.exit(1);
  }
  const PROFILE = profileResolution.profile;
  const denseProvider  = PROFILE.embedding.dense.provider;
  const sparseProvider = PROFILE.embedding.sparse?.provider ?? null;
  const providerLabel = `${denseProvider}/${sparseProvider}`;
  console.log(`Provider: ${providerLabel}`);

  console.log(`[1/4] Fetching chunks from ${COLLECTION}...`);
  const points = await scroll(COLLECTION, undefined, 5000, ['source_file', 'chunk_index', 'text', 'section', 'dense_provider', 'sparse_provider']);
  if (points.length > 0) {
    const p0 = points[0].payload;
    if (p0.dense_provider !== denseProvider || p0.sparse_provider !== sparseProvider) {
      console.error(`Error: Collection was indexed with ${p0.dense_provider}/${p0.sparse_provider}, but env is ${denseProvider}/${sparseProvider}`);
      process.exit(1);
    }
  }
  const chunkData = [];
  for (const p of points) {
    const chunkId = getChunkId(p.payload);
    if (chunkId) {
      chunkData.push({
        chunkId,
        sourceFile: p.payload.source_file,
        chunkIndex: p.payload.chunk_index,
        text: p.payload.text ?? '',
        section: p.payload.section ?? ''
      });
    }
  }
  
  if (chunkData.length === 0) {
    console.error(`Error: No chunks found in ${COLLECTION}.`);
    process.exit(1);
  }

  console.log(`[2/4] Building anchor map...`);
  const anchorMap = new Map();
  const chunkMap = new Map();
  const duplicateAnchors = new Set();
  for (const c of chunkData) {
    chunkMap.set(c.chunkId, c);
    const matches = [...c.text.matchAll(ANCHOR_RE)];
    for (const m of matches) {
      if (anchorMap.has(m[1])) {
        duplicateAnchors.add(m[1]);
      } else {
        anchorMap.set(m[1], c.chunkId);
      }
    }
  }

  if (duplicateAnchors.size > 0) {
    console.error(`\nError: ${duplicateAnchors.size} duplicate anchor(s) found in indexed chunks.`);
    console.error(`Each BENCH_ANCHOR name must appear in exactly one chunk.`);
    console.error(`Duplicates: ${[...duplicateAnchors].join(', ')}\n`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  if (raw.schemaVersion !== 4) {
    console.error(`Error: queries.json schemaVersion must be 4`);
    process.exit(1);
  }

  console.log(`[3/4] Running searches...`);
  const positives = [];
  const anchorErrors = [];
  
  for (const q of raw.queries) {
    if (q.shouldHaveNoStrongHit) continue;
    if (!q.expectedAnchors || q.expectedAnchors.length === 0) {
      anchorErrors.push(`  [${q.id}] positive query has no expectedAnchors`);
      continue;
    }
    
    const qrels = new Map();
    const expectedDetails = [];
    for (const ea of (q.expectedAnchors ?? [])) {
      const chunkId = anchorMap.get(ea.anchor);
      if (chunkId) {
        const rel = ea.relevance ?? 3;
        qrels.set(chunkId, Math.max(qrels.get(chunkId) ?? 0, rel));
        
        const c = chunkMap.get(chunkId);
        expectedDetails.push({
          anchor: ea.anchor,
          relevance: rel,
          chunkId,
          section: c?.section ?? '',
          textSnippet: (c?.text ?? '').slice(0, 100).replace(/\n/g, ' ')
        });
      } else {
        anchorErrors.push(`  [${q.id}] anchor "${ea.anchor}" not found in any indexed chunk`);
      }
    }
    
    if (qrels.size > 0) positives.push({ q, qrels, expectedDetails });
  }

  if (anchorErrors.length > 0) {
    console.error(`\nError: ${anchorErrors.length} anchor(s) not found in indexed chunks:\n` + anchorErrors.join('\n') + '\n');
    process.exit(1);
  }

  for (const item of positives) {
    process.stdout.write(`  ${item.q.id}... `);
    const { dense, sparse } = await embedForSearch(PROFILE, item.q.query);
    item.results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
    process.stdout.write(`done\n`);
  }

  console.log(`[4/4] Classifying failures...`);
  
  const stats = {
    'exact@5': 0, 'exact@10': 0, 'window@5': 0, 'window@10': 0,
    'supportOnly@10': 0, 'fileOnly@10': 0, 'miss': 0
  };
  const typeStats = {};
  const nonExactByFile = {};
  const heuristicsStats = {};
  let exactRankSum = 0;
  let exactRankCount = 0;
  const window5MissExact5 = [];
  
  const reportLines = [];
  const date = new Date().toISOString().slice(0, 10);
  reportLines.push(`=== semidex custom-large failure analysis ===`);
  reportLines.push(`Date: ${date}`);
  reportLines.push(`Provider: ${providerLabel}`);
  reportLines.push(`Collection: ${COLLECTION}`);
  reportLines.push(``);
  
  for (const item of positives) {
    const { q, qrels, expectedDetails, results } = item;
    const exactIds = new Set([...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id));
    const supportIds = new Set([...qrels.entries()].filter(([, r]) => r >= 2).map(([id]) => id));
    const exactFiles = new Set([...exactIds].map(id => parseChunkId(id)?.sourceFile).filter(Boolean));
    
    const resultIds = results.map(r => getChunkId(r.payload));
    const top5Ids = resultIds.slice(0, 5);
    
    const isExact = (ids) => ids.some(id => exactIds.has(id));
    const isWindow = (ids) => ids.some(id => {
      const p = parseChunkId(id);
      if (!p) return false;
      return [...exactIds].some(eid => {
        const ep = parseChunkId(eid);
        return ep && ep.sourceFile === p.sourceFile && Math.abs(ep.chunkIndex - p.chunkIndex) <= BENCH_WINDOW;
      });
    });
    
    let cls = 'miss';
    if (isExact(top5Ids)) cls = 'exact@5';
    else if (isExact(resultIds)) cls = 'exact@10';
    else if (isWindow(top5Ids)) cls = 'window@5';
    else if (isWindow(resultIds)) cls = 'window@10';
    else if (resultIds.some(id => supportIds.has(id))) cls = 'supportOnly@10';
    else if (resultIds.some(id => {
      const p = parseChunkId(id);
      return p && exactFiles.has(p.sourceFile);
    })) cls = 'fileOnly@10';
    
    stats[cls]++;
    const qType = q.type ?? 'unknown';
    typeStats[qType] = (typeStats[qType] || 0) + 1;
    
    if (cls === 'window@5') {
      window5MissExact5.push(q.id);
    }
    
    if (['exact@5', 'exact@10'].includes(cls)) {
      const exactIndex = resultIds.findIndex(id => exactIds.has(id));
      if (exactIndex !== -1) {
        exactRankSum += (exactIndex + 1);
        exactRankCount++;
      }
    }
    
    if (cls !== 'exact@5') {
      for (const ef of exactFiles) {
        nonExactByFile[ef] = (nonExactByFile[ef] || 0) + 1;
      }
      
      let heuristic = null;
      if (cls === 'exact@10') heuristic = 'exact-ranked-low';
      else if (cls.startsWith('window')) heuristic = 'boundary-neighbor';
      else if (cls === 'supportOnly@10') heuristic = 'support-ranked-above-exact';
      else if (cls === 'fileOnly@10') {
        const files = results.map(r => r.payload?.source_file).filter(Boolean);
        const fileCounts = files.reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc; }, {});
        if (Object.values(fileCounts).some(c => c >= 3)) heuristic = 'ambiguous-section';
        else heuristic = 'same-file-ranking';
      } else if (cls === 'miss') {
        heuristic = 'query-fixture-mismatch';
      }
      
      if (heuristic) heuristicsStats[heuristic] = (heuristicsStats[heuristic] || 0) + 1;
      
      reportLines.push(`--------------------------------------------------`);
      reportLines.push(`[${q.id}] (${qType}) ${q.query}`);
      reportLines.push(`Class: ${cls}`);
      if (heuristic) reportLines.push(`Cause: ${heuristic}`);
      reportLines.push(`\nExpected Anchors:`);
      
      // Deduplicate expectedDetails by chunkId so we show max relevance when multiple anchors map to same chunk
      const seenChunks = new Set();
      for (const ed of expectedDetails) {
        if (seenChunks.has(ed.chunkId)) continue;
        seenChunks.add(ed.chunkId);
        const maxRel = qrels.get(ed.chunkId) ?? ed.relevance;
        reportLines.push(`  - Anchor: ${ed.anchor} (max-rel: ${maxRel})`);
        reportLines.push(`    ChunkId: ${ed.chunkId}`);
        reportLines.push(`    Section: ${ed.section}`);
        reportLines.push(`    Snippet: ${ed.textSnippet}...`);
      }
      
      reportLines.push(`\nTop 10 Results:`);
      results.forEach((r, idx) => {
        const cid = getChunkId(r.payload);
        const isEx = exactIds.has(cid);
        const isSup = supportIds.has(cid);
        const p = parseChunkId(cid);
        const isWin = p && [...exactIds].some(eid => {
          const ep = parseChunkId(eid);
          return ep && ep.sourceFile === p.sourceFile && Math.abs(ep.chunkIndex - p.chunkIndex) <= BENCH_WINDOW;
        });
        const isFile = p && exactFiles.has(p.sourceFile);
        
        let matchType = '';
        if (isEx) matchType = 'exact';
        else if (isSup) matchType = 'support';
        else if (isWin) matchType = 'window';
        else if (isFile) matchType = 'fileOnly';
        
        const score = r.score?.toFixed(4) ?? '0.0000';
        const section = r.payload?.section ?? '';
        const snippet = (r.payload?.text ?? '').slice(0, 80).replace(/\n/g, ' ');
        reportLines.push(`  ${idx + 1}. [${score}] ${cid} | ${matchType}`);
        reportLines.push(`     Section: ${section}`);
        reportLines.push(`     Snippet: ${snippet}...`);
      });

      if (cls === 'window@5') {
        reportLines.push(`\nClosest Neighbor Candidate (top-5):`);
        let bestCandidate = null;
        let minDistance = Infinity;
        for (const cid of top5Ids) {
          const p = parseChunkId(cid);
          if (!p) continue;
          for (const eid of exactIds) {
            const ep = parseChunkId(eid);
            if (ep && ep.sourceFile === p.sourceFile) {
              const dist = p.chunkIndex - ep.chunkIndex;
              if (Math.abs(dist) <= BENCH_WINDOW && Math.abs(dist) < minDistance) {
                minDistance = Math.abs(dist);
                bestCandidate = {
                  returnedId: cid,
                  expectedId: eid,
                  distance: dist > 0 ? `+${dist}` : `${dist}`,
                  returnedSection: results.find(r => getChunkId(r.payload) === cid)?.payload?.section ?? '',
                  expectedSection: expectedDetails.find(ed => ed.chunkId === eid)?.section ?? ''
                };
              }
            }
          }
        }
        if (bestCandidate) {
          reportLines.push(`  Returned: ${bestCandidate.returnedId} (Section: ${bestCandidate.returnedSection})`);
          reportLines.push(`  Expected: ${bestCandidate.expectedId} (Section: ${bestCandidate.expectedSection})`);
          reportLines.push(`  Distance: ${bestCandidate.distance}`);
        } else {
          reportLines.push(`  (None found within window in top-5)`);
        }
      }

      reportLines.push('');
    }
  }
  
  const avgExactRank = exactRankCount > 0 ? (exactRankSum / exactRankCount).toFixed(2) : 'n/a';
  const hardestFile = Object.entries(nonExactByFile).sort((a, b) => b[1] - a[1])[0];
  
  // Console aggregate output
  console.log(`\n--- Aggregate Summary ---`);
  console.log(`Counts by class:`);
  for (const [cls, count] of Object.entries(stats)) {
    console.log(`  ${cls.padEnd(15)} : ${count}`);
  }
  
  console.log(`\nCounts by query type:`);
  for (const [typ, count] of Object.entries(typeStats)) {
    console.log(`  ${typ.padEnd(15)} : ${count}`);
  }
  
  if (hardestFile) {
    console.log(`\nHardest fixture file (by non-exact failures): ${hardestFile[0]} (${hardestFile[1]} failures)`);
  }
  
  console.log(`\nTop repeated failure causes:`);
  Object.entries(heuristicsStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cause, count]) => {
      console.log(`  ${cause.padEnd(30)} : ${count}`);
    });
    
  console.log(`\nAvg exact rank (when in top-10) : ${avgExactRank}`);
  
  if (window5MissExact5.length > 0) {
    console.log(`\nQueries with window@5 success but exact@5 fail:`);
    console.log(`  ${window5MissExact5.join(', ')}`);
  }
  
  // Write result file
  const outPath = resolve(RESULTS_DIR, `${date}-custom-large-failure-analysis.txt`);
  reportLines.unshift(
    `--- Aggregate Summary ---`,
    `Counts by class: ${JSON.stringify(stats)}`,
    `Counts by type: ${JSON.stringify(typeStats)}`,
    `Failure causes: ${JSON.stringify(heuristicsStats)}`,
    `Avg exact rank: ${avgExactRank}`,
    `Hardest file by non-exact failures: ${hardestFile ? hardestFile[0] : 'n/a'}`,
    `window@5 queries: ${window5MissExact5.join(', ')}`,
    `\n--- Detailed Non-Exact Results ---\n`
  );
  
  writeFileSync(outPath, reportLines.join('\n'), 'utf8');
  console.log(`\nAnalysis saved to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
