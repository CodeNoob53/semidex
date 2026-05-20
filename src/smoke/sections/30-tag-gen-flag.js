export default async function ({ ok }) {
  console.log('\n[30] TAG_GEN=0 opt-out flag (shouldGenerateTags helper)');

  const { shouldGenerateTags } = await import('../../indexer/phases/tag.js');

  ok('30a: unset env → enabled', shouldGenerateTags({}) === true);
  ok('30b: TAG_GEN=1 → enabled', shouldGenerateTags({ TAG_GEN: '1' }) === true);
  ok('30c: TAG_GEN=false → enabled', shouldGenerateTags({ TAG_GEN: 'false' }) === true);
  ok('30d: TAG_GEN=0 → disabled', shouldGenerateTags({ TAG_GEN: '0' }) === false);
  ok('30e: TAG_GEN="" → enabled', shouldGenerateTags({ TAG_GEN: '' }) === true);
  ok('30f: TAG_GEN=00 → enabled (only exact "0" disables)', shouldGenerateTags({ TAG_GEN: '00' }) === true);
}
