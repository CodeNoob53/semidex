// Skeleton smoke 2/4 + 3/4 (impl spec §7): node policy mapping and the
// isContentBearing gate against empty/placeholder-only retrieval chunks.

export default async function ({ ok }) {
  console.log('\n[43] skeleton — node policy mapping + isContentBearing gate');

  const { NODE_POLICY, applyNodePolicy, isContentBearing, isTinyCodeBlock, POINT_KINDS } =
    await import('../../shared/indexer/phases/node-policy.js');
  const { parseSkeleton } = await import('../../shared/indexer/phases/skeleton.js');

  const node = (nodeType, text = '') => ({ nodeType, text });
  // Substantial code body: the tiny-code rule (vault-validated) routes small
  // fences to merge_with_parent, so mapping tests use a real multi-line block.
  const BIG_CODE = [
    'const service = require("./service");',
    'const result = service.start({ retries: 3, timeout: 5000 });',
    'if (!result.ok) throw new Error("startup failed: " + result.reason);',
    'console.log("started", result.pid);',
  ].join('\n'); // 4 lines, ~20 tokens — clearly above the entity floor

  // ── mapping matrix (design §7.2) ─────────────────────────────────────────────
  const expect = [
    ['paragraph',   'chunk_text',                POINT_KINDS.RETRIEVAL],
    ['list',        'chunk_text',                POINT_KINDS.RETRIEVAL],
    ['blockquote',  'chunk_text',                POINT_KINDS.RETRIEVAL],
    ['table',       'payload_raw_embed_context', POINT_KINDS.RETRIEVAL],
    ['code_block',  'payload_raw_embed_context', POINT_KINDS.RETRIEVAL, 'BIG_CODE'],
    ['checklist',   'payload_raw_embed_context', POINT_KINDS.RETRIEVAL],
    ['section',     'nav_summary',               POINT_KINDS.NAV],
    ['file',        'nav_summary',               POINT_KINDS.NAV],
    ['collection',  'nav_summary',               POINT_KINDS.NAV],
    ['image',       'future_processor',          POINT_KINDS.NAV],
    ['frontmatter', 'payload_metadata_only',     null],
    ['unknown',     'chunk_text',                POINT_KINDS.RETRIEVAL],
  ];
  for (const [type, policy, pointKind, body] of expect) {
    const out = applyNodePolicy(node(type, body === 'BIG_CODE' ? BIG_CODE : ''));
    ok(`${type} → ${policy} / ${pointKind ?? 'no point'}`,
       out.policy === policy && out.pointKind === pointKind);
  }

  // ── tiny-code rule (merge_with_parent) ──────────────────────────────────────
  const tiny = t => applyNodePolicy(node('code_block', t));
  ok('one-word fence → merge_with_parent',    tiny('LTS').policy === 'merge_with_parent' && tiny('LTS').pointKind === null);
  ok('short command → merge_with_parent',     tiny('node -v').policy === 'merge_with_parent');
  ok('long one-liner (>=16 tok) stays entity', tiny('curl -fsSL -o- --retry 3 --retry-delay 2 --max-time 30 -H "Accept: text/plain" https://x/install.sh | bash -s -- --yes').policy === 'payload_raw_embed_context');
  ok('short one-liner (<16 tok) merges',       tiny('curl -o- -L --silent --show-error --fail https://x/install.sh | bash').policy === 'merge_with_parent');
  ok('two-line low-token pair merges',         tiny('mkdir topic_01\ncd topic_01').policy === 'merge_with_parent');
  ok('multi-line >=12 tokens stays entity',    tiny('docker run -d --name qdrant \\\n  -p 6333:6333 \\\n  -v ./data:/qdrant/storage qdrant/qdrant:latest').policy === 'payload_raw_embed_context');
  ok('isTinyCodeBlock only matches code',     isTinyCodeBlock({ nodeType: 'paragraph', text: 'x' }) === false);
  ok('tiny code never content-bearing alone', !isContentBearing(tiny('node -v')));
  ok('unmapped type degrades to unknown row',
     applyNodePolicy(node('martian-block')).policy === 'chunk_text');
  ok('NODE_POLICY is frozen', Object.isFrozen(NODE_POLICY));

  // ── unknown fallback preserves text (design §5.1: nothing is lost) ───────────
  const parsed = parseSkeleton('<div class="x">embedded html content here</div>\n');
  const unk = parsed.find(n => n.nodeType === 'unknown');
  ok('unknown node carries warning', unk?.warning?.kind === 'unknown_node');
  ok('unknown node keeps its text',  (unk?.text ?? '').includes('embedded html content'));
  ok('unknown is retrieval content after policy',
     applyNodePolicy(unk).pointKind === POINT_KINDS.RETRIEVAL);

  // ── isContentBearing (design §7.3) ───────────────────────────────────────────
  const bearing = n => isContentBearing(applyNodePolicy(n));

  ok('structural: table always content-bearing',     bearing(node('table')));
  ok('structural: code_block (real) content-bearing', bearing(node('code_block', BIG_CODE)));
  ok('nav: section never content-bearing',           !bearing(node('section', 'Heading text words words')));
  ok('nav: image never content-bearing',             !bearing(node('image', 'diagram alt text words')));
  ok('frontmatter never content-bearing',            !bearing(node('frontmatter', 'tags: a, b, c, d')));

  ok('prose with enough tokens passes',
     bearing(node('paragraph', 'Це звичайний параграф із достатньою кількістю слів.')));
  ok('empty prose fails',          !bearing(node('paragraph', '')));
  ok('whitespace prose fails',     !bearing(node('paragraph', '  \n\t  ')));
  ok('punctuation-only fails',     !bearing(node('paragraph', '--- *** ... !!! ---')));
  ok('short prose below MIN fails', !bearing(node('paragraph', 'two words')));

  // Placeholder-only prose must NOT become a retrieval point (design §11 rule).
  ok('placeholder-only prose fails', !bearing(node('paragraph',
     '[table node: guide.md#install/table-1 — directives]\n[code block node: guide.md#install/code-1 — example]')));
  ok('placeholder + real prose passes', bearing(node('paragraph',
     '[table node: guide.md#install/table-1 — directives]\nReal explanation sentence with several meaningful words here.')));
  ok('bare heading line not counted', !bearing(node('paragraph', '## Just A Heading')));

  // Heading-only section end-to-end: section node exists, no retrieval emission.
  const headingOnly = parseSkeleton('# Lonely\n\n## Also Lonely\n');
  const sections = headingOnly.filter(n => n.nodeType === 'section');
  ok('heading-only doc keeps sections in skeleton', sections.length === 2);
  ok('heading-only doc emits zero retrieval nodes',
     headingOnly.map(applyNodePolicy).filter(isContentBearing).length === 0);
}
