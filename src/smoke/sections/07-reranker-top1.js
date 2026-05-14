export default async function ({ ok }) {
  console.log('\n[7] Reranker top-1 protection');

  // Set env vars before the first import of rerank.js so envFloat() picks them up.
  // Scenario: rank-1 source_file has 1 token match with BOOST=1.3 → baseScore 0.5+1.3=1.8,
  // which flips past rank-0's baseScore of 1.0. Gap=0.8 < PROTECT_TOP1_DELTA=0.9, so
  // protection must fire and keep rank-0 (x.md) first.
  process.env.RERANK_BOOST_SOURCE_FILE      = '1.3';
  process.env.RERANK_PROTECT_TOP1_DELTA     = '0.9';
  // Zero out other boost signals so only source_file matters.
  process.env.RERANK_BOOST_SECTION          = '0';
  process.env.RERANK_BOOST_TAGS             = '0';
  process.env.RERANK_BOOST_TEXT             = '0';
  process.env.RERANK_BOOST_BACKLINK         = '0';

  const { rerankResults } = await import('../../core/rerank.js');

  const input = [
    { score: 0.9, payload: { source_file: 'original', section: '', tags: [], text: '' } },
    { score: 0.5, payload: { source_file: 'boostme',  section: '', tags: [], text: '' } },
  ];
  const result = await rerankResults(input, 'boostme', { finalLimit: 2, collection: null });
  ok('top-1 protection keeps original RRF rank-0 when advantage < delta', result[0].payload.source_file === 'original');

  for (const k of ['RERANK_BOOST_SOURCE_FILE', 'RERANK_PROTECT_TOP1_DELTA',
                    'RERANK_BOOST_SECTION', 'RERANK_BOOST_TAGS',
                    'RERANK_BOOST_TEXT', 'RERANK_BOOST_BACKLINK']) {
    delete process.env[k];
  }
}
