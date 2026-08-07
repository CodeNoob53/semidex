export default async function ({ ok }) {
  console.log('\n[27] combined context+tags phase (pure parser + guard)');

  const { parseCombinedResponse, COMBINED_MIN_CHARS } = await import('../../shared/indexer/phases/combined.js');

  // ── parseCombinedResponse ──────────────────────────────────────────────────

  // Direct object
  ok('27a: direct {context,tags} → parsed',
    parseCombinedResponse('{"context":"About chunking","tags":["chunk","split"]}')?.context === 'About chunking',
  );

  ok('27a: tags normalized from direct object',
    JSON.stringify(parseCombinedResponse('{"context":"c","tags":["Node JS","node-js"]}')?.tags) === '["node-js"]',
  );

  // Single-element array
  ok('27b: single-element array [{...}] → parsed',
    parseCombinedResponse('[{"context":"array form","tags":["a","b"]}]')?.context === 'array form',
  );

  // Markdown fenced
  ok('27c: markdown fenced JSON → parsed',
    parseCombinedResponse('```json\n{"context":"fenced","tags":["x"]}\n```')?.context === 'fenced',
  );

  // Tag normalization
  ok('27d: tags lowercase + hyphenated + deduped',
    JSON.stringify(parseCombinedResponse('{"context":"c","tags":["Node JS","NODE JS","ok-tag"]}')?.tags) === '["node-js","ok-tag"]',
  );

  ok('27d: tag shorter than 2 chars filtered',
    !(parseCombinedResponse('{"context":"c","tags":["a","ok"]}')?.tags ?? []).includes('a'),
  );

  ok('27d: tag longer than 40 chars filtered', (() => {
    const long = 'x'.repeat(41);
    return !(parseCombinedResponse(`{"context":"c","tags":["${long}","ok"]}`)?.tags ?? []).includes(long);
  })());

  // Failure paths
  ok('27e: missing context → null',
    parseCombinedResponse('{"tags":["x"]}') === null,
  );

  ok('27e: empty context string → null',
    parseCombinedResponse('{"context":"","tags":["x"]}') === null,
  );

  ok('27e: missing tags field → null',
    parseCombinedResponse('{"context":"hello"}') === null,
  );

  ok('27e: empty string → null',
    parseCombinedResponse('') === null,
  );

  ok('27e: invalid JSON → null',
    parseCombinedResponse('not json') === null,
  );

  ok('27e: empty object → null',
    parseCombinedResponse('{}') === null,
  );

  // ── COMBINED_MIN_CHARS guard ───────────────────────────────────────────────

  ok('27f: COMBINED_MIN_CHARS is a positive integer',
    Number.isInteger(COMBINED_MIN_CHARS) && COMBINED_MIN_CHARS > 0,
  );
}
