export default async function ({ ok }) {
  console.log('\n[25] zipOrderedLinks — order preservation for qdrant_related');

  const { zipOrderedLinks } = await import('../../mcp/tools/related.js');

  // 25a. Graph order preserved: links[0] → lines[0], links[1] → lines[1]
  const links   = ['b.md', 'a.md', 'c.md'];
  const results = [
    [{ payload: { context: 'about b', section: '' } }],
    [{ payload: { context: 'about a', section: '' } }],
    [{ payload: { context: 'about c', section: '' } }],
  ];
  const lines = zipOrderedLinks(links, results);
  ok('25a: output length matches links length',  lines.length === 3);
  ok('25b: first line is b.md (graph order)',    lines[0].includes('b.md'));
  ok('25c: second line is a.md',                 lines[1].includes('a.md'));
  ok('25d: third line is c.md',                  lines[2].includes('c.md'));

  // 25e. Payload context is included in the line
  ok('25e: context appears in line',             lines[0].includes('about b'));

  // 25f. Missing scroll result (file not in Qdrant) → line without description
  const sparseResults = [
    [],  // b.md: not found in Qdrant
    [{ payload: { context: 'about a', section: '' } }],
  ];
  const sparse = zipOrderedLinks(['b.md', 'a.md'], sparseResults);
  ok('25f: missing result → line without dash-description', !sparse[0].includes(' — '));
  ok('25g: present result → line with description',         sparse[1].includes('about a'));
  ok('25h: order preserved even when first is missing',     sparse[0].includes('b.md') && sparse[1].includes('a.md'));

  // 25i. Section fallback when context is empty
  const sectionResults = [
    [{ payload: { context: '', section: 'Setup' } }],
  ];
  const sec = zipOrderedLinks(['x.md'], sectionResults);
  ok('25i: section used when context is empty',  sec[0].includes('Setup'));

  // 25j. Both context and section empty → no description appended
  const emptyResults = [
    [{ payload: { context: '', section: '' } }],
  ];
  const emp = zipOrderedLinks(['y.md'], emptyResults);
  ok('25j: empty context+section → no description', !emp[0].includes(' — '));
}
