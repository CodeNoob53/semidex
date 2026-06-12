// Smoke: MCP skeleton nav tools — formatSkeleton, formatNode, formatChildren,
// and the validateIdentifier pure helpers.
// Pure — no Qdrant, no embeddings. Uses fake in-memory nav point payloads.

export default async function ({ ok }) {
  console.log('\n[53] skeleton nav tools — getSkeleton / getSkeletonNode / getSkeletonChildren');

  const { formatSkeleton }                          = await import('../../mcp/tools/getSkeleton.js');
  const { formatNode, validateIdentifier: validateNode }  = await import('../../mcp/tools/getSkeletonNode.js');
  const { formatChildren, validateIdentifier: validateChildren } = await import('../../mcp/tools/getSkeletonChildren.js');

  // ── fake nav payloads ────────────────────────────────────────────────────────

  const colNode = {
    point_kind:  'skeleton_nav',
    node_type:   'collection',
    node_id:     'col-uuid',
    node_path:   'col',
    parent_id:   null,
    summary:     'Test collection summary',
    inventory:   '3 topics, 10 files',
    children:    ['col#dir/Topic 1', 'col#dir/Topic 2'],
    source_file: '',
    heading_path: null,
  };

  const dirNode1 = {
    point_kind:  'skeleton_nav',
    node_type:   'directory',
    node_id:     'dir1-uuid',
    node_path:   'col#dir/Topic 1',
    parent_id:   'col-uuid',
    summary:     'Topic 1 directory',
    inventory:   null,
    children:    ['Topic 1/Intro.md#file', 'Topic 1/Guide.md#file'],
    source_file: '',
    heading_path: null,
  };

  const dirNode2 = {
    point_kind:  'skeleton_nav',
    node_type:   'directory',
    node_id:     'dir2-uuid',
    node_path:   'col#dir/Topic 2',
    parent_id:   'col-uuid',
    summary:     'Topic 2 directory',
    inventory:   null,
    children:    [],
    source_file: '',
    heading_path: null,
  };

  const fileNode = {
    point_kind:  'skeleton_nav',
    node_type:   'file',
    node_id:     'file1-uuid',
    node_path:   'Topic 1/Intro.md#file',
    parent_id:   'dir1-uuid',
    summary:     'Intro file summary',
    inventory:   null,
    children:    ['Topic 1/Intro.md#sec/Overview'],
    source_file: 'Topic 1/Intro.md',
    heading_path: null,
  };

  const sectionNode = {
    point_kind:  'skeleton_nav',
    node_type:   'section',
    node_id:     'sec1-uuid',
    node_path:   'Topic 1/Intro.md#sec/Overview',
    parent_id:   'file1-uuid',
    summary:     'Overview section summary',
    inventory:   null,
    children:    [],
    source_file: 'Topic 1/Intro.md',
    heading_path: 'Overview',
  };

  // ── validateIdentifier (shared contract for node + children) ─────────────────

  ok('validateNode: both ids → error',   validateNode({ node_id: 'x', node_path: 'y' }) !== null);
  ok('validateNode: neither id → error', validateNode({ node_id: undefined, node_path: undefined }) !== null);
  ok('validateNode: only node_id → ok',  validateNode({ node_id: 'x', node_path: undefined }) === null);
  ok('validateNode: only node_path → ok', validateNode({ node_id: undefined, node_path: 'y' }) === null);
  ok('validateNode: error message exact', validateNode({ node_id: 'x', node_path: 'y' }) === 'Error: provide exactly one of node_id or node_path.');

  ok('validateChildren: both ids → error',    validateChildren({ node_id: 'x', node_path: 'y' }) !== null);
  ok('validateChildren: neither id → error',  validateChildren({ node_id: undefined, node_path: undefined }) !== null);
  ok('validateChildren: only node_id → ok',   validateChildren({ node_id: 'x' }) === null);
  ok('validateChildren: only node_path → ok', validateChildren({ node_path: 'y' }) === null);

  // ── formatSkeleton ───────────────────────────────────────────────────────────

  const skeleton = formatSkeleton(colNode, [dirNode1, dirNode2]);

  ok('formatSkeleton: returns node_type',  skeleton.node_type === 'collection');
  ok('formatSkeleton: returns node_id',    skeleton.node_id === 'col-uuid');
  ok('formatSkeleton: returns summary',    skeleton.summary === 'Test collection summary');
  ok('formatSkeleton: returns inventory',  skeleton.inventory === '3 topics, 10 files');
  ok('formatSkeleton: root child_count reflects collectionNode.children length',
     skeleton.child_count === 2);
  ok('formatSkeleton: children array length matches resolved children', skeleton.children.length === 2);
  ok('formatSkeleton: child has node_type',    skeleton.children[0].node_type === 'directory');
  ok('formatSkeleton: child has node_path',    skeleton.children[0].node_path === 'col#dir/Topic 1');
  ok('formatSkeleton: child has child_count',  skeleton.children[0].child_count === 2);
  ok('formatSkeleton: empty-children dir has child_count 0', skeleton.children[1].child_count === 0);

  ok('formatSkeleton: returns null for null collection node', formatSkeleton(null, []) === null);
  ok('formatSkeleton: empty resolved children list is valid',
     formatSkeleton(colNode, []).child_count === 2 &&
     formatSkeleton(colNode, []).children.length === 0);

  // root child_count when collectionNode.children is missing
  const colNoChildren = { ...colNode, children: undefined };
  ok('formatSkeleton: child_count 0 when children field absent',
     formatSkeleton(colNoChildren, []).child_count === 0);

  // ── formatNode ───────────────────────────────────────────────────────────────

  const node = formatNode(fileNode);

  ok('formatNode: returns node_type',    node.node_type === 'file');
  ok('formatNode: returns node_id',      node.node_id === 'file1-uuid');
  ok('formatNode: returns node_path',    node.node_path === 'Topic 1/Intro.md#file');
  ok('formatNode: returns parent_id',    node.parent_id === 'dir1-uuid');
  ok('formatNode: returns summary',      node.summary === 'Intro file summary');
  ok('formatNode: returns source_file',  node.source_file === 'Topic 1/Intro.md');
  ok('formatNode: returns children arr', Array.isArray(node.children) && node.children.length === 1);
  ok('formatNode: heading_path null on file node', node.heading_path === null);

  const secNode = formatNode(sectionNode);
  ok('formatNode: heading_path populated on section node', secNode.heading_path === 'Overview');

  ok('formatNode: returns null for null input', formatNode(null) === null);

  const nodeNoParent = formatNode({ ...fileNode, parent_id: undefined });
  ok('formatNode: parent_id defaults to null', nodeNoParent.parent_id === null);

  const nodeNoSummary = formatNode({ ...fileNode, summary: undefined });
  ok('formatNode: summary defaults to empty string', nodeNoSummary.summary === '');

  // ── formatChildren ───────────────────────────────────────────────────────────

  const file2 = { ...fileNode, node_id: 'file2-uuid', node_path: 'Topic 1/Guide.md#file', children: [] };
  const result = formatChildren(dirNode1, [fileNode, file2], 2);

  ok('formatChildren: parent node_type',         result.parent.node_type === 'directory');
  ok('formatChildren: parent node_id',           result.parent.node_id === 'dir1-uuid');
  ok('formatChildren: children array length',    result.children.length === 2);
  ok('formatChildren: total_children matches',   result.total_children === 2);
  ok('formatChildren: returned_children matches', result.returned_children === 2);
  ok('formatChildren: truncated false when all returned', result.truncated === false);
  ok('formatChildren: child node_type',          result.children[0].node_type === 'file');
  ok('formatChildren: child source_file',        result.children[0].source_file === 'Topic 1/Intro.md');
  ok('formatChildren: child child_count from array length', result.children[0].child_count === 1);
  ok('formatChildren: leaf child has child_count 0', result.children[1].child_count === 0);

  // truncation: parent has 5 children but only 2 returned
  const truncated = formatChildren(dirNode1, [fileNode, file2], 5);
  ok('formatChildren: total_children = declared parent total',  truncated.total_children === 5);
  ok('formatChildren: returned_children = actual returned',     truncated.returned_children === 2);
  ok('formatChildren: truncated true when returned < total',    truncated.truncated === true);

  // edge: empty children
  const empty = formatChildren(dirNode2, [], 0);
  ok('formatChildren: empty children gives total_children 0',    empty.total_children === 0);
  ok('formatChildren: empty children gives returned_children 0', empty.returned_children === 0);
  ok('formatChildren: empty children not truncated',             empty.truncated === false);
  ok('formatChildren: empty children gives empty array',         empty.children.length === 0);

  // edge: child with undefined summary
  const noSum = formatChildren(dirNode1, [{ ...fileNode, summary: undefined }], 1);
  ok('formatChildren: child summary defaults to empty string', noSum.children[0].summary === '');

  // edge: child with no children field
  const noChildField = formatChildren(dirNode1, [{ ...fileNode, children: undefined }], 1);
  ok('formatChildren: child_count 0 when children field absent', noChildField.children[0].child_count === 0);

  // totalChildPaths omitted (backward-compat path): falls back to children.length
  const noTotal = formatChildren(dirNode1, [fileNode]);
  ok('formatChildren: omitting totalChildPaths falls back to children.length',
     noTotal.total_children === 1 && noTotal.returned_children === 1 && noTotal.truncated === false);
}
