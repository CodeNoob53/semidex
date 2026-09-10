import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createStorageAdapter } from '../../../../src/core/storage/factory.js';
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';
import { getQdrantClient } from '../../../../src/core/qdrant/client.js';
import { withNavExcluded } from '../../../../src/core/qdrant/nav-filter.js';
const client = getQdrantClient(), collection = 'bench-retrieval-custom-50';
const sample = await client.scroll(collection, {limit:1,with_vector:true,with_payload:false});
const {dense,sparse}=sample.points[0].vector;
const adapter=createStorageAdapter(), rows=[];
let events=[];
for(const method of ['getCollections','getCollection','scroll','count','query']) {
  const original=client[method].bind(client);
  client[method]=async(...args)=>{const t=performance.now();try{return await original(...args);}finally{events.push({method,ms:performance.now()-t});}};
}
for(let i=0;i<5;i++) {
  for(const mode of (i%2 ? ['raw','core'] : ['core','raw'])) {
    events=[]; const t=performance.now();
    if(mode==='core') {
      const r=await runHybridSearch({adapter,collection,query:'latency-only vector replay',top:10,embedQuery:async()=>({dense,sparse}),settingsService:{getActiveValue:k=>({RRF_K:60,HYBRID_PREFETCH_LIMIT:2})[k]}});
      if(r.error)throw new Error(r.message);
    } else await client.query(collection,{prefetch:[{query:sparse,using:'sparse',limit:20,filter:withNavExcluded(null)},{query:dense,using:'dense',limit:20,filter:withNavExcluded(null)}],query:{rrf:{k:60}},limit:10,with_payload:true});
    rows.push({round:i,mode,ms:performance.now()-t,events});
  }
}
writeFileSync(new URL('metadata-probe.json',import.meta.url),JSON.stringify({note:'Same stored-vector replay through core vs raw hybrid; no embedding, no quality claim, alternating order; concurrent indexing may affect latency.',rows},null,2));
console.log(JSON.stringify(rows,null,2));
