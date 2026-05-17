export default async function ({ ok }) {
  console.log('\n[26] extractContextTagsArray (combined context+tags parser)');

  const { extractContextTagsArray } = await import(
    '../../../benchmarks/retrieval/combined-context-tags-helpers.js'
  );

  // --- Happy paths ---

  ok('direct array, length 2 → normalized items',
    JSON.stringify(extractContextTagsArray(
      '[{"context":"About chunking","tags":["chunk","split"]},{"context":"About tags","tags":["tag","label"]}]',
      2,
    )) === JSON.stringify([
      { context: 'About chunking', tags: ['chunk', 'split'] },
      { context: 'About tags', tags: ['tag', 'label'] },
    ]),
  );

  ok('wrapper object {"items":[...]} → unwrapped',
    extractContextTagsArray(
      '{"items":[{"context":"Hello","tags":["a"]}]}',
      1,
    )?.[0]?.context === 'Hello',
  );

  ok('single object {context, tags} when expectedLength=1 → wrapped',
    extractContextTagsArray(
      '{"context":"Direct object","tags":["direct","object"]}',
      1,
    )?.[0]?.context === 'Direct object',
  );

  ok('markdown fenced JSON → parsed',
    extractContextTagsArray(
      '```json\n[{"context":"fenced","tags":["x"]}]\n```',
      1,
    )?.[0]?.context === 'fenced',
  );

  ok('tags normalized: spaces→hyphens, uppercase→lowercase, deduped',
    JSON.stringify(
      extractContextTagsArray('[{"context":"c","tags":["Node JS","NODE JS","ok-tag"]}]', 1)?.[0]?.tags,
    ) === '["node-js","ok-tag"]',
  );

  ok('tags with length < 2 filtered out',
    (extractContextTagsArray('[{"context":"c","tags":["a","ok"]}]', 1)?.[0]?.tags ?? []).includes('a') === false,
  );

  ok('tags with length > 40 filtered out', (() => {
    const long = 'x'.repeat(41);
    const result = extractContextTagsArray(`[{"context":"c","tags":["${long}","ok"]}]`, 1);
    return !(result?.[0]?.tags ?? []).includes(long);
  })());

  // --- Failure paths ---

  ok('wrong length → null',
    extractContextTagsArray('[{"context":"a","tags":["x"]},{"context":"b","tags":["y"]}]', 3) === null,
  );

  ok('missing context field → null',
    extractContextTagsArray('[{"tags":["x"]}]', 1) === null,
  );

  ok('empty context string → null',
    extractContextTagsArray('[{"context":"","tags":["x"]}]', 1) === null,
  );

  ok('missing tags field → null',
    extractContextTagsArray('[{"context":"hello"}]', 1) === null,
  );

  ok('empty string → null',
    extractContextTagsArray('', 1) === null,
  );

  ok('invalid JSON → null',
    extractContextTagsArray('not json', 1) === null,
  );

  ok('empty object → null',
    extractContextTagsArray('{}', 1) === null,
  );
}
