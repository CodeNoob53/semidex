// Smoke tests for token-count.js and the production BGE-M3 tokenizer path.
// Tokenizer-dependent tests skip gracefully if cache is absent.
export default async function ({ ok, throwsAsync }) {
  console.log('\n[36] token-count.js and production BGE-M3 chunking');

  const { CHUNKING_SCHEMA_VERSION, heuristicTokenCount, resolveTokenCountMode, getTokenCounter, countTokens, takeLastTokens } =
    await import('../../core/token-count.js');

  // 36a. Production default is bge-m3; heuristic remains an explicit opt-out.
  ok('CHUNKING_SCHEMA_VERSION === 1', CHUNKING_SCHEMA_VERSION === 1);
  ok('resolveTokenCountMode default → bge-m3', resolveTokenCountMode({}) === 'bge-m3');
  ok('resolveTokenCountMode bge-m3 → bge-m3', resolveTokenCountMode({ TOKEN_COUNT: 'bge-m3' }) === 'bge-m3');
  ok('resolveTokenCountMode heuristic → heuristic', resolveTokenCountMode({ TOKEN_COUNT: 'heuristic' }) === 'heuristic');
  try {
    resolveTokenCountMode({ TOKEN_COUNT: 'invalid' });
    ok('resolveTokenCountMode invalid throws', false);
  } catch (err) {
    ok('resolveTokenCountMode invalid throws', err.message.includes('Unsupported TOKEN_COUNT'));
  }

  // 36b. heuristicTokenCount matches original Math.ceil(length / 4).
  ok('heuristicTokenCount("") === 0', heuristicTokenCount('') === 0);
  ok('heuristicTokenCount("abc") === 1', heuristicTokenCount('abc') === 1);
  ok('heuristicTokenCount("abcd") === 1', heuristicTokenCount('abcd') === 1);
  ok('heuristicTokenCount("abcde") === 2', heuristicTokenCount('abcde') === 2);
  ok('heuristicTokenCount agrees with Math.ceil(len/4)',
    ['', 'x', 'hello world', 'A'.repeat(400)].every(
      t => heuristicTokenCount(t) === Math.ceil(t.length / 4)
    ));

  // 36c. Explicit heuristic mode returns a sync function.
  {
    const counter = await getTokenCounter({ mode: 'heuristic' });
    ok('getTokenCounter({mode:"heuristic"}) returns a function', typeof counter === 'function');
    ok('heuristic counter("hello") === 2', counter('hello') === 2);
    const result = counter('test');
    ok('heuristic counter returns a number (not a Promise)', typeof result === 'number');
  }

  // 36d. countTokens with heuristic mode is async-wrapped but returns number.
  {
    const n = await countTokens('hello world', { mode: 'heuristic' });
    ok('countTokens heuristic returns number', typeof n === 'number');
    ok('countTokens heuristic agrees with Math.ceil(len/4)', n === Math.ceil('hello world'.length / 4));
  }

  // 36e. takeLastTokens heuristic mode.
  {
    const text = 'A'.repeat(100);
    const suffix = await takeLastTokens(text, 10, { mode: 'heuristic' });
    ok('takeLastTokens returns string', typeof suffix === 'string');
    ok('takeLastTokens suffix fits within maxTokens (heuristic)',
      Math.ceil(suffix.length / 4) <= 10);
    ok('takeLastTokens is a suffix of original', text.endsWith(suffix));
    ok('takeLastTokens empty text returns ""', await takeLastTokens('', 10, { mode: 'heuristic' }) === '');
    ok('takeLastTokens maxTokens=0 returns ""', await takeLastTokens('hello', 0, { mode: 'heuristic' }) === '');
    const short = 'hi';
    const shortResult = await takeLastTokens(short, 100, { mode: 'heuristic' });
    ok('takeLastTokens short text (fits) returns full text', shortResult === short);
  }

  // 36f. TOKEN_COUNT=bge-m3 path fails clearly when the tokenizer is unavailable.
  // If it is available, run tokenizer-dependent tests. Do not infer availability
  // from directory existence alone: a partial cache must skip gracefully too.
  {
    let counter = null;
    try {
      counter = await getTokenCounter({ mode: 'bge-m3', localFilesOnly: true });
    } catch (err) {
      ok('getTokenCounter bge-m3 unavailable throws actionable error',
        err.message.includes('BGE-M3 tokenizer not cached locally'));
      console.log('  [36] tokenizer cache absent — tokenizer-dependent tests skipped');
    }

    if (counter) {
      // Cache present: verify async counter works and returns real token counts.
      console.log('  [36] tokenizer cache found — running tokenizer-dependent tests');
      ok('bge-m3 counter is a function', typeof counter === 'function');

      const asciiText = 'The quick brown fox jumps over the lazy dog.';
      const asciiCount = await counter(asciiText);
      ok('bge-m3 counter returns a number', typeof asciiCount === 'number');
      ok('bge-m3 count > 0 for non-empty text', asciiCount > 0);

      // For ASCII text, real count should be in rough range of heuristic.
      const heur = Math.ceil(asciiText.length / 4);
      ok('bge-m3 count plausible for ASCII (within 3× of heuristic)',
        asciiCount > 0 && asciiCount < heur * 3);

      // Second call reuses cached tokenizer (consistent results, no reload).
      const counter2 = await getTokenCounter({ mode: 'bge-m3', localFilesOnly: true });
      const count1 = await counter(asciiText);
      const count2 = await counter2(asciiText);
      ok('getTokenCounter bge-m3 second call produces consistent token count',
        count1 === count2);

      // Verify that the chunker async path runs and produces chunks within token budget.
      const { chunkFile, chunkFileAsync } = await import('../../indexer/phases/chunk.js');
      ok('chunkFileAsync is exported for production tokenizer path', typeof chunkFileAsync === 'function');

      // Use chunkFile (sync) output as reference, then compare with async on a small fixture.
      const fixture = `# Section A\nThis is a test paragraph for the BGE-M3 tokenizer smoke test.\n\n# Section B\nAnother paragraph here.`;
      const syncChunks = chunkFile('test.md', fixture, 'test.md');
      ok('sync chunkFile still works with async path present', syncChunks.length >= 2);

      // Exercise the env-routed async path via chunkFileFromPath by injecting
      // TOKEN_COUNT into env for this test only, then restoring.
      const prevTokenCount = process.env.TOKEN_COUNT;
      process.env.TOKEN_COUNT = 'bge-m3';
      try {
        const { chunkFileFromPath } = await import('../../indexer/phases/chunk.js');
        const fixtureFile = new URL('../../../benchmarks/retrieval/fixtures/ua-prose-synthetic.md', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        const { existsSync: exists } = await import('fs');
        if (exists(fixtureFile)) {
          const asyncChunks = await chunkFileFromPath(fixtureFile, 'ua-prose-synthetic.md');
          ok('bge-m3 chunkFileFromPath returns chunks array', Array.isArray(asyncChunks));
          ok('bge-m3 chunks have text field', asyncChunks.every(c => typeof c.text === 'string'));
          // Verify no chunk grossly exceeds MAX_CHUNK_TOKENS in real tokens.
          const MAX = parseInt(process.env.MAX_CHUNK_TOKENS ?? '400');
          let oversized = 0;
          for (const c of asyncChunks) {
            const count = await counter(c.text);
            // Allow single-word/unsplittable overruns — test only that most chunks fit.
            if (count > MAX * 1.5) oversized++;
          }
          ok('bge-m3 chunks: no chunk exceeds 1.5× MAX_CHUNK_TOKENS in real tokens',
            oversized === 0);
        } else {
          console.log('  [36] ua-prose-synthetic.md not found — skipping live async chunk test');
        }
      } finally {
        if (prevTokenCount === undefined) delete process.env.TOKEN_COUNT;
        else process.env.TOKEN_COUNT = prevTokenCount;
      }
    }
  }

  // 36g. Sync chunkFile() stays heuristic for legacy callers.
  {
    const prevTokenCount = process.env.TOKEN_COUNT;
    delete process.env.TOKEN_COUNT;
    try {
      const { chunkFile } = await import('../../indexer/phases/chunk.js');
      const md = `# Alpha\nFirst section content.\n\n# Beta\nSecond section content.`;
      const chunks = chunkFile('test.md', md, 'test.md');
      ok('default chunkFile: section Alpha present', chunks.some(c => c.section === 'Alpha'));
      ok('default chunkFile: section Beta present', chunks.some(c => c.section === 'Beta'));
      ok('default chunkFile: chunkIndex assigned', chunks.every(c => typeof c.chunkIndex === 'number'));
    } finally {
      if (prevTokenCount === undefined) delete process.env.TOKEN_COUNT;
      else process.env.TOKEN_COUNT = prevTokenCount;
    }
  }
}
