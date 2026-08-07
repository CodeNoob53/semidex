export default async function ({ ok }) {
  console.log('\n[30] TAG_GEN=1 opt-in flag (shouldGenerateTags helper)');

  const { shouldGenerateTags, resolveTagModel } = await import('../../shared/indexer/phases/tag.js');

  ok('30a: unset env → disabled', shouldGenerateTags({}) === false);
  ok('30b: TAG_GEN=1 → enabled', shouldGenerateTags({ TAG_GEN: '1' }) === true);
  ok('30c: TAG_GEN=false → disabled', shouldGenerateTags({ TAG_GEN: 'false' }) === false);
  ok('30d: TAG_GEN=0 → disabled', shouldGenerateTags({ TAG_GEN: '0' }) === false);
  ok('30e: TAG_GEN="" → disabled', shouldGenerateTags({ TAG_GEN: '' }) === false);
  ok('30f: TAG_GEN=00 → disabled (only exact "1" enables)', shouldGenerateTags({ TAG_GEN: '00' }) === false);
  ok('30g: tag model default -> gemma3:4b', resolveTagModel({}) === 'gemma3:4b');
  ok('30h: tag model inherits CONTEXT_MODEL', resolveTagModel({ CONTEXT_MODEL: 'ctx:1b' }) === 'ctx:1b');
  ok('30i: TAG_MODEL overrides CONTEXT_MODEL', resolveTagModel({ CONTEXT_MODEL: 'ctx:1b', TAG_MODEL: 'tag:1b' }) === 'tag:1b');
}
