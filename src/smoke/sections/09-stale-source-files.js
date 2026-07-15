export default async function ({ ok }) {
  console.log('\n[9] computeStaleSourceFiles (no Qdrant)');

  // computeStaleSourceFiles is pure and lives in indexer/run.js (the
  // implementation module) — indexer/index.js is now a bootstrap-only
  // entry point with no exports of its own (Global Settings phase).
  const { computeStaleSourceFiles } = await import('../../indexer/run.js');

  // 9a. Both sets empty → no stale
  ok('empty indexed + empty stored → []',
    computeStaleSourceFiles([], []).length === 0);

  // 9b. Standard stale case: c is in stored but not indexed
  const stale = computeStaleSourceFiles(['a.md', 'b.md'], ['a.md', 'b.md', 'c.md']);
  ok('stored has extra c.md → stale = [c.md]',
    stale.length === 1 && stale[0] === 'c.md');

  // 9c. Rename: old path stale, new path indexed
  const renamed = computeStaleSourceFiles(['renamed-new.md'], ['old.md', 'renamed-new.md']);
  ok('renamed: old.md stale, renamed-new.md kept',
    renamed.length === 1 && renamed[0] === 'old.md');

  // 9d. Sets equal → no stale
  ok('equal sets → []',
    computeStaleSourceFiles(['a.md', 'b.md'], ['a.md', 'b.md']).length === 0);

  // 9e. Inputs not mutated
  const inp1 = ['x.md'];
  const inp2 = ['x.md', 'y.md'];
  computeStaleSourceFiles(inp1, inp2);
  ok('inputs not mutated',
    inp1.length === 1 && inp2.length === 2);
}
