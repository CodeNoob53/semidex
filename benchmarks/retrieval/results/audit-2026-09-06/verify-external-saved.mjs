// Offline re-evaluation of saved external runs; no fresh retrieval/indexing.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { computeMetrics } from '../../../external/beir/metrics.mjs';
import { loadBeirFullQrels, loadMiraclQrels, loadTrecRunAsRanked, validateTrecRun, assertMetricParity } from '../../../external/fusion/analyze-fusion.mjs';
import { DATA_DIR, parseJsonlRows, synthesizeRetrievalTask } from '../../../external/slavic/fetch-belebele.mjs';
const root='benchmarks/external';
const read = name => JSON.parse(readFileSync(`${root}/results/${name}`));
const result={date:new Date().toISOString(),scope:'offline saved-run metric verification, not current live benchmark',runs:[]};
function check(suite,id,block,dataset) {
  for(const [mode,reported] of Object.entries(block.metrics)) {
    const path=`${root}/${suite}/.runs/${id}-${mode}.trec`;
    const row={suite,id,mode,path};
    try {
      const {ranked,byQueryRaw}=loadTrecRunAsRanked(path);
      validateTrecRun(byQueryRaw,{expectedQueryIds:new Set(dataset.queries.keys()),label:path});
      row.metrics=computeMetrics(dataset.qrels,ranked);
      row.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
      assertMetricParity(row.metrics,reported,{label:path,tolerance:1e-6});
      row.status='PASS';
    } catch(e) {row.status='FAIL';row.error=e.message;}
    result.runs.push(row);
  }
}
for(const [id,block] of Object.entries(read('2026-07-21-beir-scifact-provider-comparison.json').runs)) check('beir',id,block,loadBeirFullQrels());
for(const [id,block] of Object.entries(read('2026-07-22-miracl-ru-provider-comparison.json').runs)) check('miracl',id,block,loadMiraclQrels());
for(const [id,block] of Object.entries(read('2026-07-23-slavic-belebele-benchmark.json').languages)) {
  const path=join(DATA_DIR,`${id}.jsonl`);
  check('slavic',id,block,synthesizeRetrievalTask(parseJsonlRows(readFileSync(path,'utf8'),path)));
}
result.passed=result.runs.filter(r=>r.status==='PASS').length;
result.failed=result.runs.filter(r=>r.status==='FAIL').length;
writeFileSync(new URL('external-saved-verification-2026-09-07.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,failed:result.failed,failures:result.runs.filter(r=>r.status==='FAIL')},null,2));
if(result.failed)process.exitCode=1;
