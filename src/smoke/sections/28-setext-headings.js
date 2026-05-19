export default async function ({ ok }) {
  console.log('\n[28] Setext heading support in parseMarkdown');

  const { chunkFile } = await import('../../indexer/phases/chunk.js');

  // 28a. h1 setext (===) creates a section boundary.
  const h1 = `Title\n=====\nSome content under title.`;
  const r1 = chunkFile('x.md', h1, 'x.md');
  ok('setext h1 (===) creates named section', r1.some(c => c.section === 'Title'));
  ok('setext h1 content lands in section', r1.some(c => c.section === 'Title' && c.text.includes('Some content under title')));

  // 28b. h2 setext (---) creates a section boundary.
  const h2 = `Section\n-------\nContent under section.`;
  const r2 = chunkFile('x.md', h2, 'x.md');
  ok('setext h2 (---) creates named section', r2.some(c => c.section === 'Section'));
  ok('setext h2 content lands in section', r2.some(c => c.section === 'Section' && c.text.includes('Content under section')));

  // 28c. Multiple setext sections — content stays in correct section.
  const multi = `Alpha\n=====\nAlpha content.\n\nBeta\n----\nBeta content.`;
  const r3 = chunkFile('x.md', multi, 'x.md');
  const alphaChunks = r3.filter(c => c.section === 'Alpha');
  const betaChunks  = r3.filter(c => c.section === 'Beta');
  ok('multi setext: Alpha section exists', alphaChunks.length > 0);
  ok('multi setext: Beta section exists',  betaChunks.length > 0);
  ok('multi setext: Alpha has no Beta text', alphaChunks.every(c => !c.text.includes('Beta content')));
  ok('multi setext: Beta has no Alpha text', betaChunks.every(c => !c.text.includes('Alpha content')));

  // 28d. Frontmatter --- delimiter is not treated as setext h2.
  const withFm = `---\ntitle: test\n---\n# Real Heading\nBody text.`;
  const r4 = chunkFile('x.md', withFm, 'x.md');
  ok('frontmatter --- not parsed as setext section', r4.every(c => c.section !== ''));
  ok('frontmatter --- real heading still works', r4.some(c => c.section === 'Real Heading'));

  // 28e. Horizontal rule (--- alone, no preceding text) is not a setext heading.
  const withHr = `# Heading\nSome text.\n\n---\n\nMore text after hr.`;
  const r5 = chunkFile('x.md', withHr, 'x.md');
  ok('horizontal rule does not create spurious section', r5.every(c => c.section === 'Heading' || c.section === ''));

  // 28f. Setext heading text longer than 120 chars is not treated as a heading.
  const longTitle = 'A'.repeat(121);
  const longSetext = `${longTitle}\n=====\nContent.`;
  const r6 = chunkFile('x.md', longSetext, 'x.md');
  ok('setext heading > 120 chars ignored', !r6.some(c => c.section === longTitle));

  // 28g. ATX headings still work alongside setext.
  const mixed = `# ATX Heading\nATX content.\n\nSetext Section\n==============\nSetext content.`;
  const r7 = chunkFile('x.md', mixed, 'x.md');
  ok('ATX heading still parsed when setext present', r7.some(c => c.section === 'ATX Heading'));
  ok('setext heading still parsed when ATX present', r7.some(c => c.section === 'Setext Section'));
}
