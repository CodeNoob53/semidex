// Skeleton edge-case smoke: placeholder placement, section boundaries,
// long-prose splitting, heading-stack resets, node_id isolation,
// collectSkeletonWarnings, path traversal guard. Fills gaps not covered by 42–46.

import { makeNodeId } from '../../core/node-id.js';

export default async function ({ ok }) {
  console.log('\n[49] skeleton edge cases — placeholder placement, boundaries, splitting, warnings');

  const { parseSkeleton, collectSkeletonWarnings } = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../indexer/phases/skeleton-chunk.js');

  // ── 47a. Placeholder placement: entity at START of section (no preceding prose)
  // Entity comes first → placeholder must go into the FOLLOWING prose run.
  {
    const md = '# Install\n\n| Col | Val |\n|-----|-----|\n| A   | 1   |\n\nThis prose follows the table.\n';
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    const prosePh = chunks.find(c => c.node_type === 'paragraph' && c.text.includes('[table node:'));
    const tableChunk = chunks.find(c => c.node_type === 'table');
    ok('entity-first: table chunk emitted',           tableChunk !== undefined);
    ok('entity-first: placeholder in following prose', prosePh !== undefined);
    ok('entity-first: table chunk has no placeholder', !tableChunk.text.includes('[table node:'));
  }

  // ── 47b. Placeholder placement: entity at END of section (no following prose)
  // Entity last → placeholder appended to lastProseIdx.
  {
    const md = '# Install\n\nSome intro text with enough real words here.\n\n| Col | Val |\n|-----|-----|\n| A   | 1   |\n';
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    const proseWithPh = chunks.find(c => c.node_type === 'paragraph' && c.text.includes('[table node:'));
    ok('entity-last: placeholder in preceding prose', proseWithPh !== undefined);
    ok('entity-last: table chunk still emitted',      chunks.some(c => c.node_type === 'table'));
  }

  // ── 47c. Entity-after-entity: two tables in a row, each gets exactly one placeholder
  {
    const md = '# S\n\nIntro with real words.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |\n';
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    const tables = chunks.filter(c => c.node_type === 'table');
    const phs = chunks.filter(c => c.node_type === 'paragraph' && c.text.includes('[table node:'));
    ok('entity-after-entity: two table chunks emitted', tables.length === 2);
    // Each table gets exactly one placeholder (may be in the same prose chunk or separate).
    const allPhs = chunks.flatMap(c => {
      const m = c.text?.match(/\[table node:/g);
      return m ? m : [];
    });
    ok('entity-after-entity: exactly two placeholders total', allPhs.length === 2);
  }

  // ── 47d. Section boundary: prose from one section must not appear in another
  {
    const md = '# Alpha\n\nAlpha paragraph with enough meaningful words here.\n\n# Beta\n\nBeta paragraph with enough meaningful words here.\n';
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    const alpha = chunks.filter(c => c.section === 'Alpha');
    const beta  = chunks.filter(c => c.section === 'Beta');
    ok('section boundary: alpha chunks exist',                alpha.length > 0);
    ok('section boundary: beta chunks exist',                 beta.length > 0);
    ok('section boundary: no alpha text in beta chunks',
       beta.every(c => !c.text.includes('Alpha paragraph')));
    ok('section boundary: no beta text in alpha chunks',
       alpha.every(c => !c.text.includes('Beta paragraph')));
  }

  // ── 47e. Long prose split: text exceeding chunk threshold produces multiple chunks
  // with correct chunkIndex / totalChunks
  {
    // Build prose long enough to force a split (>512 tokens heuristic = >~2000 chars).
    const sentence = 'This is a representative sentence with enough real words to count toward the token budget. ';
    const longProse = sentence.repeat(30);
    const md = `# Long\n\n${longProse}\n`;
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    const proseChunks = chunks.filter(c => c.node_type === 'paragraph');
    ok('long prose: split into multiple paragraph chunks', proseChunks.length >= 2);
    ok('long prose: chunkIndex sequential',
       chunks.every((c, i) => c.chunkIndex === i));
    ok('long prose: totalChunks consistent',
       chunks.every(c => c.totalChunks === chunks.length));
    ok('long prose: all chunks pass isContentBearing (no empty pieces)',
       proseChunks.every(c => c.text.trim().length > 0));
  }

  // ── 47f. Heading stack reset: h1 > h2 > h3, new h1 pops all
  {
    const md = '# Root\n\n## Child\n\n### Deep\n\nDeep content with enough meaningful words to pass gate.\n\n# NewRoot\n\nNew root content with enough meaningful words to pass gate.\n';
    const nodes = parseSkeleton(md, { sourceFile: 'f.md' });
    const sections = nodes.filter(n => n.nodeType === 'section');
    const deep    = sections.find(s => s.text === 'Deep');
    const newRoot = sections.find(s => s.text === 'NewRoot');
    ok('heading stack: deep section has full path',
       deep?.headingPath.join('>') === 'Root>Child>Deep');
    ok('heading stack: new h1 resets path to just itself',
       newRoot?.headingPath.join('>') === 'NewRoot');
    ok('heading stack: new h1 structural path is just its slug',
       newRoot?.structuralPath === 'newroot');
    // Content under NewRoot must be isolated
    const chunks = chunkFromSkeleton(nodes, { sourceFile: 'f.md' });
    const deepChunk = chunks.find(c => c.text.includes('Deep content'));
    const newChunk  = chunks.find(c => c.text.includes('New root content'));
    ok('heading stack: deep content has heading_path length 3', deepChunk?.heading_path?.length === 3);
    ok('heading stack: new root content has heading_path length 1', newChunk?.heading_path?.length === 1);
  }

  // ── 47g. node_id isolation: same structuralPath in different sourceFiles → different ids
  {
    const args1 = { collection: '', sourceFile: 'a.md', structuralPath: 'install/table', nodeType: 'table', ordinalWithinParent: 1 };
    const args2 = { collection: '', sourceFile: 'b.md', structuralPath: 'install/table', nodeType: 'table', ordinalWithinParent: 1 };
    ok('node_id: different sourceFile → different id', makeNodeId(args1) !== makeNodeId(args2));

    // Same args, different collection → different id
    const args3 = { collection: 'col-a', sourceFile: 'a.md', structuralPath: 'install/table', nodeType: 'table', ordinalWithinParent: 1 };
    const args4 = { collection: 'col-b', sourceFile: 'a.md', structuralPath: 'install/table', nodeType: 'table', ordinalWithinParent: 1 };
    ok('node_id: different collection → different id', makeNodeId(args3) !== makeNodeId(args4));

    // Determinism: same args always same id
    ok('node_id: fully deterministic', makeNodeId(args1) === makeNodeId(args1));
  }

  // ── 47h. collectSkeletonWarnings: unknown nodes + parse errors → JSONL events
  {
    const md = '<div class="x">html block</div>\n\n# Section\n\nNormal paragraph.\n';
    const nodes = parseSkeleton(md, { sourceFile: 'warn.md' });
    const events = collectSkeletonWarnings(nodes, { collection: 'c', sourceFile: 'warn.md' });
    ok('collectSkeletonWarnings: at least one event for unknown node', events.length >= 1);
    const e = events[0];
    ok('warning event has collection',         e.collection === 'c');
    ok('warning event has source_file',        e.source_file === 'warn.md');
    ok('warning event has kind',               typeof e.kind === 'string' && e.kind.length > 0);
    ok('warning event has position',           Number.isInteger(e.position?.start_line));
    ok('warning event has chunking_model',     e.chunking_model === 'skeleton-v1');
    ok('no warning for normal paragraph',
       events.every(ev => ev.kind !== 'unknown_node' || ev.node_type === 'unknown'));
  }

  // ── 47i. Image-only paragraph: recognized as image, not paragraph
  {
    const md = '# S\n\n![Alt text](diagram.png)\n\nRegular prose follows.\n';
    const nodes = parseSkeleton(md, { sourceFile: 'f.md' });
    ok('image-only paragraph → image node', nodes.some(n => n.nodeType === 'image'));
    ok('image node has alt text', nodes.find(n => n.nodeType === 'image')?.text === 'Alt text');
    ok('image not emitted as retrieval chunk',
       chunkFromSkeleton(nodes, { sourceFile: 'f.md' }).every(c => c.node_type !== 'image'));
  }

  // ── 47j. skeletonArtifactPathFor — path traversal guard
  {
    const { skeletonArtifactPathFor } = await import('../../indexer/phases/skeleton-index.js');

    // Normal path must not throw and must stay under .tmp/semidex-inspect.
    let normalPath;
    try { normalPath = skeletonArtifactPathFor('my-col', 'docs/guide.md'); } catch { normalPath = null; }
    ok('artifact path: normal input accepted',         normalPath !== null);
    ok('artifact path: normal path ends with .skeleton.json', normalPath?.endsWith('.skeleton.json'));
    ok('artifact path: contains collection segment',   normalPath?.includes('my-col'));

    // Path traversal attempts must throw.
    let threw1 = false;
    try { skeletonArtifactPathFor('my-col', '../../etc/passwd'); } catch { threw1 = true; }
    ok('artifact path: ../ in sourceFile throws', threw1);

    let threw2 = false;
    try { skeletonArtifactPathFor('../../../evil', 'safe.md'); } catch { threw2 = true; }
    ok('artifact path: ../ in collection throws', threw2);

    let threw3 = false;
    try { skeletonArtifactPathFor('col', '/absolute/path/file.md'); } catch { threw3 = true; }
    ok('artifact path: absolute sourceFile throws', threw3);
  }

  // ── 47l. Frontmatter meta propagates to ALL chunks in the file
  {
    const md = '---\ntags: foo, bar\ntitle: Guide\n---\n# Sec\n\nParagraph with real content words.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const chunks = chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'f.md' }), { sourceFile: 'f.md' });
    ok('frontmatter meta on all chunks',
       chunks.length > 0 && chunks.every(c => Array.isArray(c.meta?.tags) && c.meta.tags.includes('foo')));
    ok('frontmatter title propagated',
       chunks.every(c => c.meta?.title === 'Guide'));
  }
}
