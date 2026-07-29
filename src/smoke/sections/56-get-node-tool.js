// Smoke: qdrant_get_node MCP tool — structural content node resolver.
// Pure — no Qdrant, no real content. Uses fake payloads.

export default async function ({ ok }) {
  console.log('\n[56] qdrant_get_node — structural node resolver');

  const { validateIdentifier, formatNode, clampPreviewChars, resolveCanonicalEntity } = await import('../../mcp/tools/getNode.js');

  // ── validateIdentifier ───────────────────────────────────────────────────────

  ok('validate: both ids → error',    validateIdentifier({ node_id: 'x', node_path: 'y' }) !== null);
  ok('validate: neither id → error',  validateIdentifier({ node_id: undefined, node_path: undefined }) !== null);
  ok('validate: only node_id → ok',   validateIdentifier({ node_id: 'x', node_path: undefined }) === null);
  ok('validate: only node_path → ok', validateIdentifier({ node_id: undefined, node_path: 'y' }) === null);
  ok('validate: error message exact',
     validateIdentifier({ node_id: 'x', node_path: 'y' }) === 'Error: provide exactly one of node_id or node_path.');

  // ── formatNode: table node with raw_content ──────────────────────────────────

  const tablePayload = {
    point_kind:   'retrieval_content',
    node_type:    'table',
    node_id:      'tbl-uuid',
    node_path:    'dir/file.md#section/table-2',
    parent_id:    'sec-uuid',
    source_file:  'dir/file.md',
    heading_path: ['Setup', 'Options'],
    chunk_index:  5,
    section:      'Options',
    lang:         null,
    context:      'Options table — lists all configuration keys.',
    summary:      null,
    raw_content:  '| Key | Value |\n|-----|-------|\n| host | localhost |\n| port | 5432 |',
  };

  const res = formatNode(tablePayload, 'test-col', 2000);
  ok('table: found = true',              res.found === true);
  ok('table: collection set',            res.collection === 'test-col');
  ok('table: node_type = table',         res.node_type === 'table');
  ok('table: node_id present',           res.node_id === 'tbl-uuid');
  ok('table: node_path present',         res.node_path === 'dir/file.md#section/table-2');
  ok('table: parent_id present',         res.parent_id === 'sec-uuid');
  ok('table: source_file present',       res.source_file === 'dir/file.md');
  ok('table: heading_path array',        Array.isArray(res.heading_path) && res.heading_path[0] === 'Setup');
  ok('table: chunk_index present',       res.chunk_index === 5);
  ok('table: section present',           res.section === 'Options');
  ok('table: context present',           res.context !== null);
  ok('table: preview = raw_content',     res.preview === tablePayload.raw_content);
  ok('table: raw_chars correct',         res.raw_chars === tablePayload.raw_content.length);
  ok('table: truncated false (fits)',     res.truncated === false);
  ok('table: raw_available true',        res.raw_available === true);
  ok('table: lang null',                 res.lang === null);
  ok('table: summary null',              res.summary === null);

  // ── formatNode: code node with rawContent (camelCase) ───────────────────────

  const codePayload = {
    point_kind:  'retrieval_content',
    node_type:   'code_block',
    node_id:     'code-uuid',
    node_path:   'dir/file.md#sec/code_block-1',
    parent_id:   'sec-uuid',
    source_file: 'dir/file.md',
    heading_path: ['Section'],
    chunk_index: 3,
    section:     'Section',
    lang:        'python',
    context:     null,
    summary:     null,
    rawContent:  'import asyncio\nasync def main():\n    await asyncio.sleep(1)',
  };

  const codeRes = formatNode(codePayload, 'test-col', 2000);
  ok('code: found = true',              codeRes.found === true);
  ok('code: lang = python',             codeRes.lang === 'python');
  ok('code: preview from rawContent',   codeRes.preview === codePayload.rawContent);
  ok('code: raw_available true',        codeRes.raw_available === true);

  // ── formatNode: fallback to text when no raw_content / rawContent ────────────

  const textPayload = {
    point_kind:  'retrieval_content',
    node_type:   'paragraph',
    node_id:     'para-uuid',
    node_path:   'dir/file.md#sec/para-0',
    parent_id:   'sec-uuid',
    source_file: 'dir/file.md',
    heading_path: null,
    chunk_index: 0,
    section:     'Intro',
    lang:        null,
    context:     null,
    summary:     null,
    text:        'This is the paragraph content used as fallback.',
  };

  const textRes = formatNode(textPayload, 'test-col', 2000);
  ok('text fallback: found = true',     textRes.found === true);
  ok('text fallback: preview from text', textRes.preview === textPayload.text);
  ok('text fallback: raw_available',    textRes.raw_available === true);

  // ── formatNode: preview_chars truncation ─────────────────────────────────────

  const longRaw = 'x'.repeat(5000);
  const longPayload = { ...tablePayload, raw_content: longRaw };

  const truncRes = formatNode(longPayload, 'test-col', 200);
  ok('truncation: preview capped to 200',   truncRes.preview.length === 200);
  ok('truncation: raw_chars = 5000',        truncRes.raw_chars === 5000);
  ok('truncation: truncated = true',        truncRes.truncated === true);
  ok('truncation: preview_chars = 200',     truncRes.preview_chars === 200);

  // ── formatNode: preview_chars clamped ────────────────────────────────────────

  const clampRes = formatNode(longPayload, 'test-col', 50);   // below min 200
  ok('clamp: below min clamped to 200', clampRes.preview_chars === 200);

  const clampZero = formatNode(longPayload, 'test-col', 0);
  ok('clamp: zero clamped to 200', clampZero.preview_chars === 200);

  const clampNegative = formatNode(longPayload, 'test-col', -10);
  ok('clamp: negative clamped to 200', clampNegative.preview_chars === 200);

  const clampHigh = formatNode(longPayload, 'test-col', 99999); // above max 8000
  ok('clamp: above max clamped to 8000', clampHigh.preview_chars === 8000);

  ok('clamp helper: undefined uses default 2000', clampPreviewChars(undefined) === 2000);
  ok('clamp helper: invalid string uses default 2000', clampPreviewChars('abc') === 2000);

  // ── formatNode: no raw content ───────────────────────────────────────────────

  const emptyPayload = {
    point_kind: 'retrieval_content',
    node_type: 'image',
    node_id: 'img-uuid', node_path: 'dir/file.md#sec/image-0',
    parent_id: null, source_file: 'dir/file.md',
    heading_path: null, chunk_index: 0, section: null,
    lang: null, context: null, summary: null,
  };

  const emptyRes = formatNode(emptyPayload, 'test-col', 2000);
  ok('no-raw: found = true',          emptyRes.found === true);
  ok('no-raw: preview = empty str',   emptyRes.preview === '');
  ok('no-raw: raw_chars = 0',         emptyRes.raw_chars === 0);
  ok('no-raw: raw_available = false', emptyRes.raw_available === false);
  ok('no-raw: truncated = false',     emptyRes.truncated === false);

  // ── formatNode: missing optional fields do not crash ─────────────────────────

  const minimalPayload = {
    point_kind: 'retrieval_content',
    node_type: 'table',
    raw_content: '| a | b |',
  };

  const minRes = formatNode(minimalPayload, 'test-col', 2000);
  ok('minimal: found = true',          minRes.found === true);
  ok('minimal: node_id null',          minRes.node_id === null);
  ok('minimal: node_path null',        minRes.node_path === null);
  ok('minimal: parent_id null',        minRes.parent_id === null);
  ok('minimal: source_file null',      minRes.source_file === null);
  ok('minimal: heading_path null',     minRes.heading_path === null);
  ok('minimal: chunk_index null',      minRes.chunk_index === null);
  ok('minimal: section null',          minRes.section === null);
  ok('minimal: lang null',             minRes.lang === null);
  ok('minimal: summary null',          minRes.summary === null);
  ok('minimal: context null',          minRes.context === null);
  ok('minimal: preview = raw_content', minRes.preview === '| a | b |');

  // ── formatNode: nav node rejection ───────────────────────────────────────────

  const navPayload = {
    point_kind: 'skeleton_nav',
    node_type:  'file',
    node_id:    'nav-uuid',
    node_path:  'col#file/guide.md#file',
    summary:    'Nav node summary',
  };

  const navRes = formatNode(navPayload, 'test-col', 2000);
  ok('nav rejection: found = false',                navRes.found === false);
  ok('nav rejection: reason = nav_node_not_content', navRes.reason === 'nav_node_not_content');
  ok('nav rejection: collection set',               navRes.collection === 'test-col');
  ok('nav rejection: no preview field',             !('preview' in navRes));

  // ── formatNode: entity_raw canonical node behaves like ordinary content ─────
  // (never rejected the way skeleton_nav is — it's a real, non-searchable
  // content point, and formatNode's only special-case check is skeleton_nav)

  const entityRawPayload = {
    point_kind:  'entity_raw',
    node_type:   'table',
    node_id:     'tbl-canonical-uuid',
    node_path:   'dir/file.md#section/table-1',
    parent_id:   'sec-uuid',
    source_file: 'dir/file.md',
    heading_path: ['Config'],
    chunk_index: 7,
    section:     'Config',
    lang:        null,
    context:     '',
    summary:     null,
    raw_content: '| Name | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 3 |',
  };
  const entityRawRes = formatNode(entityRawPayload, 'test-col', 2000);
  ok('entity_raw: found = true (not rejected like skeleton_nav)', entityRawRes.found === true);
  ok('entity_raw: preview = full raw_content',                    entityRawRes.preview === entityRawPayload.raw_content);
  ok('entity_raw: raw_available true',                            entityRawRes.raw_available === true);

  // ── resolveCanonicalEntity: fragment → canonical entity_raw resolution ──────

  const fragmentPayload = {
    point_kind:  'retrieval_content',
    node_type:   'table',
    node_id:     'tbl-fragment-2-uuid',
    node_path:   'dir/file.md#section/table-1/fragment-2',
    entity_id:   'tbl-canonical-uuid',
    fragment_index: 1,
    fragment_count: 3,
    raw_content: '| Name | Value |\n|---|---|\n| b | 2 |',
  };

  let lookedUpWith = null;
  const fakeGetContentNodeById = async (collection, nodeId) => {
    lookedUpWith = { collection, nodeId };
    return nodeId === 'tbl-canonical-uuid' ? entityRawPayload : null;
  };

  const resolved = await resolveCanonicalEntity(fragmentPayload, 'test-col', fakeGetContentNodeById);
  ok('resolveCanonicalEntity: fragment resolves to canonical entity_raw payload',
     resolved === entityRawPayload);
  ok('resolveCanonicalEntity: looked up via the fragment\'s entity_id, not its own node_id',
     lookedUpWith?.nodeId === 'tbl-canonical-uuid' && lookedUpWith?.collection === 'test-col');

  ok('resolveCanonicalEntity: non-fragment content (no entity_id) passes through unchanged',
     (await resolveCanonicalEntity(tablePayload, 'test-col', fakeGetContentNodeById)) === tablePayload);

  ok('resolveCanonicalEntity: null content passes through as null',
     (await resolveCanonicalEntity(null, 'test-col', fakeGetContentNodeById)) === null);

  const missingCanonicalLookup = async () => null; // canonical was deleted/never indexed
  const fallback = await resolveCanonicalEntity(fragmentPayload, 'test-col', missingCanonicalLookup);
  ok('resolveCanonicalEntity: falls back to the fragment itself if canonical lookup returns nothing',
     fallback === fragmentPayload);
}
