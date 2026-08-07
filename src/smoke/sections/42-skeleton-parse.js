// Skeleton smoke 1/4 (impl spec §7): parseSkeleton structure, positions,
// ordinals; tables/code/fences stay whole; CRLF input parses identically.

const FIXTURE = `---
tags: alpha, beta
title: Fixture
---
# Install

Intro paragraph with enough meaningful words to count.

| Directive | Meaning |
|-----------|---------|
| ExecStart | start command. With a period! |

\`\`\`bash
echo "Sentence one. Sentence two? Done!"
systemctl enable foo
\`\`\`

## Steps

- [x] pull the model
- [ ] run the indexer

> A quote block. Short but real.

***

<div class="raw">html block</div>

# Appendix

Plain list:

- one item
- two items
`;

export default async function ({ ok }) {
  console.log('\n[42] skeleton — parseSkeleton structure (AST, positions, ordinals)');

  const { parseSkeleton } = await import('../../indexer/phases/skeleton.js');
  const { makeNodeId } = await import('../../shared/core/node-id.js');

  const nodes = parseSkeleton(FIXTURE, { sourceFile: 'fixture.md' });
  const byType = t => nodes.filter(n => n.nodeType === t);

  // ── type inventory ───────────────────────────────────────────────────────────
  ok('frontmatter recognized',  byType('frontmatter').length === 1);
  ok('frontmatter meta parsed', Array.isArray(byType('frontmatter')[0].meta?.tags) &&
                                byType('frontmatter')[0].meta.tags.join(',') === 'alpha,beta');
  ok('3 sections (Install, Steps, Appendix)', byType('section').length === 3);
  ok('table recognized',        byType('table').length === 1);
  ok('code_block recognized',   byType('code_block').length === 1);
  ok('checklist vs list split', byType('checklist').length === 1 && byType('list').length === 1);
  ok('blockquote recognized',   byType('blockquote').length === 1);
  ok('html → unknown',          byType('unknown').length === 1 && byType('unknown')[0].mdastType === 'html');
  ok('thematicBreak dropped',   nodes.every(n => n.mdastType !== 'thematicBreak'));

  // ── raw preservation: never split, exact slice ───────────────────────────────
  const table = byType('table')[0];
  ok('table raw kept whole (all rows)',  table.rawContent.includes('ExecStart') &&
                                         table.rawContent.includes('Directive') &&
                                         table.rawContent.split('\n').length === 3);
  ok('table raw is exact source slice',  FIXTURE.includes(table.rawContent));

  const code = byType('code_block')[0];
  ok('fenced code with .!? stays whole', code.text.includes('Sentence one.') &&
                                         code.text.includes('systemctl enable foo'));
  ok('code lang captured',               code.lang === 'bash');
  ok('code raw includes fences',         code.rawContent.startsWith('```bash'));

  // ── heading path & structural path ──────────────────────────────────────────
  const steps = byType('section').find(s => s.text === 'Steps');
  ok('nested headingPath',     steps.headingPath.join('>') === 'Install>Steps');
  ok('section structuralPath', steps.structuralPath === 'install/steps');
  const appendix = byType('section').find(s => s.text === 'Appendix');
  ok('h1 after h2 resets stack', appendix.headingPath.join('>') === 'Appendix');
  ok('table under Install',      table.parentStructuralPath === 'install' &&
                                 table.structuralPath === 'install/table');

  // ── positions & ordinals ─────────────────────────────────────────────────────
  ok('document order strictly increasing',
    nodes.every((n, i) => i === 0 || n.position.order > nodes[i - 1].position.order));
  ok('positions carry line numbers',
    nodes.every(n => Number.isInteger(n.position.startLine) && Number.isInteger(n.position.endLine)));
  const paragraphsInInstall = nodes.filter(n => n.nodeType === 'paragraph' && n.parentStructuralPath === 'install');
  ok('ordinals 1-based per (parent,type)', paragraphsInInstall[0]?.ordinalWithinParent === 1);

  // ── CRLF parity (the legacy regex parser breaks on CRLF; AST must not) ──────
  const crlfNodes = parseSkeleton(FIXTURE.replace(/\n/g, '\r\n'), { sourceFile: 'fixture.md' });
  const typesOf = ns => ns.map(n => n.nodeType).join(',');
  ok('CRLF input yields identical node types', typesOf(crlfNodes) === typesOf(nodes));
  ok('CRLF frontmatter still recognized', crlfNodes.some(n => n.nodeType === 'frontmatter'));

  // ── node id determinism ──────────────────────────────────────────────────────
  const idArgs = { collection: 'c', sourceFile: 'fixture.md', structuralPath: 'install/table', nodeType: 'table', ordinalWithinParent: 1 };
  ok('makeNodeId deterministic', makeNodeId(idArgs) === makeNodeId(idArgs));
  ok('makeNodeId is a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(makeNodeId(idArgs)));
  ok('makeNodeId changes with ordinal', makeNodeId(idArgs) !== makeNodeId({ ...idArgs, ordinalWithinParent: 2 }));

  // ── degenerate inputs ────────────────────────────────────────────────────────
  ok('empty input → []',      parseSkeleton('').length === 0);
  ok('whitespace input → []', parseSkeleton('\n\n  \n').length === 0);
}
