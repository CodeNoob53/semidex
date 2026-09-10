import { writeFileSync } from 'node:fs';
import { parseSkeleton } from '../../../../src/shared/indexer/phases/skeleton.js';
import { chunkFromSkeleton } from '../../../../src/shared/indexer/phases/skeleton-chunk.js';
import { buildFileSkeleton } from '../../../../src/shared/indexer/phases/skeleton-index.js';
import { loadBgeTokenizer, bgeTokenCount } from '../../../../src/shared/core/bge-tokenizer.js';

const tokenizer = process.env.AUDIT_REAL_TOKENS === '1' ? await loadBgeTokenizer({localFilesOnly:true}) : null;
const fixtures = {
  shortFacts: '# Defaults\n\nTimeout: 30s.\n\n# Security\n\nTLS required.',
  list: '# Steps\n\n- Set the production host\n- Disable the debug logging\n- Restart the application service',
  tinyCode: '# Example\n\nRun these commands in this order.\n\n```sh\nmkdir sample\ncd sample\n```',
  duplicateHeadings: '# API\n\n## Settings\n\nProduction uses the first configuration.\n\n## Settings\n\nStaging uses the second configuration.',
  largeEntity: '# Commands\n\n```sh\n' + 'export VARIABLE=value # repeated configuration command\n'.repeat(2200) + '```',
  minifiedCode: '# JSON\n\nThis is the application configuration object.\n\n```json\n'+JSON.stringify({x:'value'.repeat(1000)})+'\n```',
  nestedCode: '# Install\n\n- Run the setup command:\n\n  ```sh\n  export HOST=production\n  export PORT=443\n  ```\n\n- Restart the running service now.',
  ordinary: '# Service\n\n## Timeout\n\nThe default request timeout is thirty seconds.\n\n| Key | Value |\n| --- | --- |\n| timeout | 30 |',
};
const result=[];
for (const [name,source] of Object.entries(fixtures)) {
  const nodes=parseSkeleton(source,{sourceFile:name+'.md'});
  const {chunks,entityRawPoints}=await chunkFromSkeleton(nodes,{sourceFile:name+'.md'});
  const {navPoints}=buildFileSkeleton(nodes,{sourceFile:name+'.md'});
  result.push({name,source:source.length<1000?source:source.slice(0,120)+'…',sourceChars:source.length,
    nodes:nodes.map(n=>({type:n.nodeType,path:n.structuralPath,text:n.text.slice(0,180)})),
    chunks:await Promise.all(chunks.map(async c=>({type:c.node_type,text:c.text.length<600?c.text:c.text.slice(0,160)+'…',tokens:tokenizer?bgeTokenCount(tokenizer,c.text):null,chars:c.text.length,context:c.context,parent:c.parent_id}))),
    rawCount:entityRawPoints.length,navCount:navPoints.length,uniqueNavIds:new Set(navPoints.map(n=>n.node_id)).size});
}
writeFileSync(new URL('./probe.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
