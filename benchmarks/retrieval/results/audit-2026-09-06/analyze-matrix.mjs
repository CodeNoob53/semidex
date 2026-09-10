import { readFileSync, writeFileSync } from 'node:fs';
import { ndcgAtK, recallAtK, reciprocalRankAtK } from '../../../external/beir/metrics.mjs';
import { pairedBootstrap } from '../../../external/miracl/bootstrap.mjs';
const dir = new URL('./', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('live-matrix.json', dir)));
if (!raw.complete || raw.rows.length !== 50) throw new Error('Not a complete 50-query run');
const positives = raw.rows.filter(r => !r.negative);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const quantile = (a, p) => [...a].sort((a,b) => a-b)[Math.ceil(a.length*p)-1];
const metrics = (r, mode, k) => {
  const hits = r.runs[mode].hits.slice(0, k).map(h => h.chunkId);
  if (new Set(hits).size !== hits.length) throw new Error('Duplicate chunk IDs');
  const exact = new Map((r.relevantChunks ?? []).filter(q => q.relevance >= 3).map(q => [q.chunkId,1]));
  const graded = new Map((r.relevantChunks ?? []).map(q => [q.chunkId,2**q.relevance-1]));
  return { hit: Number(hits.some(h => exact.has(h))), recall: recallAtK(exact,hits,k), ndcg: ndcgAtK(graded,hits,k), mrr: reciprocalRankAtK(exact,hits,k), distinctSources: new Set(hits.map(h => h.split('#')[0])).size };
};
const report = { caveat: raw.scope, n: positives.length, summaries: {}, comparisons: {}, failures: [], top3Changes: [], qrelTokenWarnings: [], negatives: [] };
for (const mode of raw.modes) {
  const cuts = [1,3,5,10].filter(k => k <= mode.top);
  report.summaries[mode.id] = Object.fromEntries(cuts.map(k => {
    const rows = positives.map(r => metrics(r,mode.id,k));
    return [k, Object.fromEntries(Object.keys(rows[0]).map(key => [key, mean(rows.map(r=>r[key]))]))];
  }));
  report.summaries[mode.id].retrievalMs = { p50: quantile(positives.map(r=>r.runs[mode.id].retrievalMs),.5), p95: quantile(positives.map(r=>r.runs[mode.id].retrievalMs),.95), note: 'Embedding cached; sequential interleaved modes, diagnostic not load benchmark.' };
}
for(const mode of ['prod-top50','rrf-k2-top10','dense-top10','sparse-top10']) {
  report.comparisons[mode] = pairedBootstrap(positives.map(r=>metrics(r,'prod-top10',10).ndcg), positives.map(r=>metrics(r,mode,10).ndcg), { iterations: 5000 });
}
for (const r of positives) {
  if (!metrics(r,'prod-top3',3).hit) report.failures.push({id:r.id, query:r.query, expected:r.relevantChunks, top3:r.runs['prod-top3'].hits, deepTop3:r.runs['prod-top50'].hits.slice(0,3)});
  const a=r.runs['prod-top3'].hits.map(h=>h.chunkId).join('|'), b=r.runs['prod-top50'].hits.slice(0,3).map(h=>h.chunkId).join('|');
  if(a!==b) report.top3Changes.push({id:r.id,nativeTop3:a,deepTop3:b,hitBefore:metrics(r,'prod-top3',3).hit,hitAfter:metrics(r,'prod-top50',3).hit});
}
const snapshot=JSON.parse(readFileSync(new URL('custom50-payload-snapshot.json',dir)));
const byId=new Map(snapshot.map(p=>[`${p.payload.source_file}#${p.payload.chunk_index}`,p.payload]));
for(const r of positives) {
  const exact=(r.relevantChunks??[]).filter(q=>q.relevance>=3).map(q=>byId.get(q.chunkId));
  const text=exact.map(p=>[p.text,p.section,p.context].join(' ')).join(' ').toLowerCase();
  const absent=(r.expectedTokens??[]).filter(t=>!text.includes(t.toLowerCase()));
  if(absent.length) report.qrelTokenWarnings.push({id:r.id,query:r.query,absent,note:'Review hint only; tokens absent does not prove incorrect qrel.'});
}
report.negatives=raw.rows.filter(r=>r.negative).map(r=>({id:r.id,query:r.query,expectedTokens:r.expectedTokens,top1:r.runs['prod-top3'].hits[0]}));
writeFileSync(new URL('matrix-analysis.json',dir),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,failures:report.failures.map(r=>({id:r.id,query:r.query})),negatives:report.negatives.map(r=>({...r,top1:{chunkId:r.top1.chunkId,score:r.top1.score}}))},null,2));
