// Smoke: adaptive skeleton summary tiers.
// Tests chooseTier, sanitizeStructured, generateAdaptiveSummary (stubbed LLM),
// payload passthrough in buildNavPointPayload, and summary_kind stamps.
// Pure — no Ollama, no Qdrant.

export default async function ({ ok }) {
  console.log('\n[54] adaptive skeleton summaries — tiers, structured output, payload shape');

  const {
    chooseTier, summaryTierThresholds, sanitizeStructured,
    generateAdaptiveSummary, generateNavSummaries, buildCollectionSummary,
    SUMMARY_VERSION,
  } = await import('../../indexer/phases/skeleton-summary.js');

  const { buildNavPointPayload } = await import('../../indexer/skeleton-payload.js');
  const { parseSkeleton }       = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton }   = await import('../../indexer/phases/skeleton-chunk.js');
  const { buildFileSkeleton }   = await import('../../indexer/phases/skeleton-index.js');

  // ── summaryTierThresholds ────────────────────────────────────────────────────
  const defaults = summaryTierThresholds({});
  ok('default small threshold = 300',  defaults.small  === 300);
  ok('default medium threshold = 1500', defaults.medium === 1500);
  ok('env override small',  summaryTierThresholds({ SUMMARY_SMALL_TOKENS: '100' }).small  === 100);
  ok('env override medium', summaryTierThresholds({ SUMMARY_MEDIUM_TOKENS: '800' }).medium === 800);
  ok('invalid env ignored — small',  summaryTierThresholds({ SUMMARY_SMALL_TOKENS: 'bad' }).small  === 300);
  ok('invalid env ignored — medium', summaryTierThresholds({ SUMMARY_MEDIUM_TOKENS: '-1' }).medium === 1500);

  // ── chooseTier ───────────────────────────────────────────────────────────────
  ok('0 tokens → short',        chooseTier(0,    {}) === 'short');
  ok('299 tokens → short',      chooseTier(299,  {}) === 'short');
  ok('300 tokens → medium',     chooseTier(300,  {}) === 'medium');
  ok('1499 tokens → medium',    chooseTier(1499, {}) === 'medium');
  ok('1500 tokens → structured', chooseTier(1500, {}) === 'structured');
  ok('9999 tokens → structured', chooseTier(9999, {}) === 'structured');

  // env override for thresholds affects chooseTier
  const envSmall = { SUMMARY_SMALL_TOKENS: '100', SUMMARY_MEDIUM_TOKENS: '500' };
  ok('custom thresholds: 50 → short',      chooseTier(50,  envSmall) === 'short');
  ok('custom thresholds: 150 → medium',    chooseTier(150, envSmall) === 'medium');
  ok('custom thresholds: 600 → structured', chooseTier(600, envSmall) === 'structured');

  // ── sanitizeStructured ───────────────────────────────────────────────────────

  // Valid JSON
  const validJson = JSON.stringify({
    summary: 'Документ описує налаштування системи збірки Python-проєкту.',
    key_topics: ['poetry', 'uv', 'package management'],
    notable_terms: ['pyproject.toml', 'ONNX', 'bge-m3'],
  });
  const parsed = sanitizeStructured(validJson);
  ok('valid JSON parsed',              parsed !== null);
  ok('summary extracted',              parsed.summary.includes('налаштування'));
  ok('key_topics extracted',           Array.isArray(parsed.key_topics) && parsed.key_topics.includes('poetry'));
  ok('notable_terms extracted',        Array.isArray(parsed.notable_terms) && parsed.notable_terms.includes('ONNX'));
  ok('child_overview absent if not in input', !('child_overview' in parsed));

  // With child_overview
  const withChild = sanitizeStructured(JSON.stringify({
    summary: 'Describes authentication and authorization flows in FastAPI.',
    key_topics: ['JWT', 'OAuth2'],
    notable_terms: ['access_token', 'refresh_token'],
    child_overview: ['Section 1: login flow', 'Section 2: token refresh'],
  }));
  ok('child_overview present when in input', Array.isArray(withChild?.child_overview));
  ok('child_overview items preserved',       withChild?.child_overview?.[0]?.includes('login'));

  // Caps: max 6 key_topics, 8 notable_terms, 10 child_overview
  const tooMany = sanitizeStructured(JSON.stringify({
    summary: 'A long document with many identifiers and topics.',
    key_topics:    Array.from({ length: 10 }, (_, i) => `topic${i}`),
    notable_terms: Array.from({ length: 12 }, (_, i) => `term${i}`),
    child_overview: Array.from({ length: 15 }, (_, i) => `section ${i}`),
  }));
  ok('key_topics capped at 6',     tooMany?.key_topics?.length    === 6);
  ok('notable_terms capped at 8',  tooMany?.notable_terms?.length === 8);
  ok('child_overview capped at 10', tooMany?.child_overview?.length === 10);

  // Markdown-wrapped JSON (model may add ```json ... ```)
  const mdWrapped = '```json\n' + validJson + '\n```';
  ok('markdown-wrapped JSON parsed', sanitizeStructured(mdWrapped) !== null);

  // JSON: prefix echo
  const withPrefix = 'JSON:\n' + validJson;
  ok('JSON: prefix stripped', sanitizeStructured(withPrefix) !== null);

  // Bad summary inside JSON → reject
  const badSummary = sanitizeStructured(JSON.stringify({
    summary: 'Okay, here is a breakdown:',   // conversational preamble
    key_topics: ['x'],
    notable_terms: [],
  }));
  ok('bad summary inside JSON → null', badSummary === null);

  // Not JSON at all → null
  ok('plain text → null',  sanitizeStructured('This is not JSON.')  === null);
  ok('null input → null',  sanitizeStructured(null)                 === null);
  ok('empty string → null', sanitizeStructured('')                  === null);

  // ── generateAdaptiveSummary (stubbed LLM) ────────────────────────────────────

  const shortCtx = {
    generateFn: async (_m, p) => {
      // short prompt → ends with SUMMARY:
      if (p.includes('SUMMARY:')) return 'Describes setup steps for the project.';
      return 'fallback';
    },
    model: 'stub', budget: 8000, numCtx: 4096, thinking: false,
  };
  const medCtx = {
    generateFn: async (_m, p) => {
      if (p.includes('SUMMARY:')) return 'Covers async programming with asyncio. Includes task management and error handling patterns for production use.';
      return 'fallback';
    },
    model: 'stub', budget: 8000, numCtx: 4096, thinking: false,
  };
  const structCtx = {
    generateFn: async (_m, p) => {
      if (p.includes('JSON:')) {
        return JSON.stringify({
          summary: 'Covers SQLAlchemy ORM setup and advanced query patterns for FastAPI applications.',
          key_topics: ['SQLAlchemy', 'ORM', 'migrations', 'Alembic'],
          notable_terms: ['Session', 'declarative_base', 'relationship', 'ForeignKey'],
          child_overview: ['Chapter 1: models', 'Chapter 2: queries'],
        });
      }
      // fallback medium
      return 'Covers SQLAlchemy ORM patterns for FastAPI development and database migrations.';
    },
    model: 'stub', budget: 8000, numCtx: 4096, thinking: false,
  };

  // Force tier via token count using tiny env thresholds
  const tinyEnv = { SUMMARY_SMALL_TOKENS: '5', SUMMARY_MEDIUM_TOKENS: '10' };

  // Short tier (0 tokens → always short regardless of env)
  const shortResult = await generateAdaptiveSummary('section "Setup"', 'short text', ['short text'], false, shortCtx, {});
  ok('short tier returns result',         shortResult !== null);
  ok('short tier summary_kind=llm_short', shortResult?.summary_kind === 'llm_short');
  ok('short tier no key_topics',          !('key_topics' in (shortResult ?? {})));

  // Medium tier
  const medResult = await generateAdaptiveSummary('section "Async"', 'medium text'.repeat(5), ['medium text'], false, medCtx, tinyEnv);
  ok('medium tier returns result',          medResult !== null);
  ok('medium tier summary_kind=llm_medium', medResult?.summary_kind === 'llm_medium');

  // Structured tier — force via tinyEnv (small=5, medium=10), any non-trivial text → structured
  const bigText = 'large content for structured summary generation test '.repeat(5);
  const structResult = await generateAdaptiveSummary('file "sqlalchemy.md"', bigText, ['part'], true, structCtx, tinyEnv);
  ok('structured tier returns result',              structResult !== null);
  ok('structured summary_kind=llm_structured',      structResult?.summary_kind === 'llm_structured');
  ok('structured has key_topics',                   Array.isArray(structResult?.key_topics));
  ok('structured has notable_terms',                Array.isArray(structResult?.notable_terms));
  ok('structured file node has child_overview',     Array.isArray(structResult?.child_overview));

  // Structured tier — isFile=false → no child_overview
  const structNoChild = await generateAdaptiveSummary('section "ORM"', bigText, ['part'], false, structCtx, {});
  ok('structured section has no child_overview', !('child_overview' in (structNoChild ?? {})));

  // Failure → null
  const failCtx = {
    generateFn: async () => { throw new Error('ollama down'); },
    model: 'stub', budget: 8000, numCtx: 4096, thinking: false,
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const failResult = await generateAdaptiveSummary('section "fail"', 'some text here and more', [], false, failCtx, {});
  process.stderr.write = origWrite;
  ok('error → null (caller keeps inventory)', failResult === null);

  // ── generateNavSummaries — summary_kind stamps on nav points ────────────────

  const DOC = '# Guide\n\nThis document explains how to deploy the service.\n\n## Setup\n\nInstall the runtime and configure the unit.\n';
  const nodes  = parseSkeleton(DOC, { sourceFile: 'g.md' });
  const { chunks } = await chunkFromSkeleton(nodes, { sourceFile: 'g.md' });
  const { navPoints } = buildFileSkeleton(nodes, { sourceFile: 'g.md' });

  // Inventory stamps from buildFileSkeleton
  ok('buildFileSkeleton stamps summary_kind=inventory on file node',
     navPoints.find(n => n.node_type === 'file')?.summary_kind === 'inventory');
  ok('buildFileSkeleton stamps summary_kind=inventory on section nodes',
     navPoints.filter(n => n.node_type === 'section').every(n => n.summary_kind === 'inventory'));

  const enriched = await generateNavSummaries(navPoints, chunks, {
    generateFn: async (_m, p) => {
      if (p.includes('JSON:')) {
        return JSON.stringify({
          summary: 'Describes deployment of the service with setup instructions.',
          key_topics: ['deployment', 'setup'],
          notable_terms: ['runtime'],
        });
      }
      return 'Covers service deployment and setup configuration for production environments.';
    },
    model: 'stub', windowTokens: 8000,
  });

  ok('enriched nodes have summary_kind', enriched.every(n => typeof n.summary_kind === 'string'));
  ok('enriched nodes have summary_version', enriched.every(n => n.summary_version === SUMMARY_VERSION));
  ok('inventory still preserved', enriched.every(n => typeof n.inventory === 'string'));
  ok('summary changed from inventory', enriched.every(n => n.summary !== n.inventory));

  // ── buildCollectionSummary — summary_kind in result ─────────────────────────

  const inv = await buildCollectionSummary('col', [{ source_file: 'a.md', summary: 's.' }], { llm: false });
  ok('inventory mode: summary_kind=inventory', inv.summary_kind === 'inventory');

  const fileNodes = [
    { source_file: 'a.md', summary: 'About deployment.' },
    { source_file: 'b.md', summary: 'About configuration.' },
  ];
  const rollup = await buildCollectionSummary('col', fileNodes, {
    llm: true,
    generateFn: async () => 'Collection covers deployment and configuration topics for the project.',
  });
  ok('llm mode: summary_kind=collection_overview', rollup.summary_kind === 'collection_overview');
  ok('llm mode: summary_version stamped',     rollup.summary_version === SUMMARY_VERSION);

  // ── buildNavPointPayload — new fields pass through ──────────────────────────

  const baseNav = {
    point_kind: 'skeleton_nav', node_type: 'file',
    node_id: 'test-id', node_path: 'test#file',
    source_file: 'test.md', heading_path: [],
    summary: 'Describes SQLAlchemy ORM setup.',
    summary_kind: 'llm_structured',
    summary_version: SUMMARY_VERSION,
    key_topics: ['SQLAlchemy', 'ORM'],
    notable_terms: ['Session', 'ForeignKey'],
    child_overview: ['Chapter 1: models'],
    inventory: 'test — 3 sections',
    children: [],
    chunking_model: 'skeleton-v1',
  };
  const payload = buildNavPointPayload(baseNav, {
    fileHash: 'abc', vectorSize: 1024,
    tokenCountMode: 'bge-m3', chunkingSchemaVersion: 4,
  });

  ok('payload.summary_kind passes through',    payload.summary_kind    === 'llm_structured');
  ok('payload.summary_version passes through', payload.summary_version === SUMMARY_VERSION);
  ok('payload.key_topics passes through',      Array.isArray(payload.key_topics) && payload.key_topics[0] === 'SQLAlchemy');
  ok('payload.notable_terms passes through',   Array.isArray(payload.notable_terms));
  ok('payload.child_overview passes through',  Array.isArray(payload.child_overview));
  ok('payload.inventory passes through',       payload.inventory === 'test — 3 sections');
  ok('payload.summary still present',          typeof payload.summary === 'string');

  // Node without optional fields — they must be absent (not undefined/null)
  const minimalNav = {
    point_kind: 'skeleton_nav', node_type: 'section',
    node_id: 'sec-id', node_path: 'f.md#sec/Intro',
    source_file: 'f.md', heading_path: ['Intro'],
    summary: 'Intro section summary', summary_kind: 'inventory',
    children: [], chunking_model: 'skeleton-v1',
  };
  const minPayload = buildNavPointPayload(minimalNav, {});
  ok('minimal node: no key_topics in payload',     !('key_topics'      in minPayload));
  ok('minimal node: no notable_terms in payload',  !('notable_terms'   in minPayload));
  ok('minimal node: no child_overview in payload', !('child_overview'  in minPayload));
  ok('minimal node: no summary_version in payload (!summary_version → absent)',
     !('summary_version' in minPayload));
}
