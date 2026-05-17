export default async function ({ ok }) {
  console.log('\n[22] buildLinks — precomputedDense API');

  const { buildLinks } = await import('../../indexer/phases/link.js');

  // 22a. buildLinks is exported and is a function.
  ok('buildLinks is a function', typeof buildLinks === 'function');

  // 22b. precomputedDense=null — reaches embedForSearch asynchronously (no sync throw).
  // Actual fallback correctness is covered by the live equivalence harness.
  {
    let noSyncThrow = true;
    let isPromise = false;
    try {
      const p = buildLinks(
        { context: 'x', text: 'y', source_file: 'a.md', links: [] },
        [],
        {},
        '_smoke_invalid_col_',
        null,
      );
      isPromise = p instanceof Promise;
      p.catch(() => {}); // ignore async rejection from invalid collection
    } catch {
      noSyncThrow = false;
    }
    ok('buildLinks with null precomputedDense does not throw synchronously', noSyncThrow);
    ok('buildLinks with null precomputedDense returns a Promise',            isPromise);
  }

  // 22c. precomputedDense provided + empty collections → resolves with chunk, no embed call.
  {
    const chunk = { context: 'ctx', text: 'body', source_file: 'a.md', links: [] };
    const fakeDense = new Array(1024).fill(0.1);
    let result;
    let threw = false;
    try {
      result = await buildLinks(chunk, [], {}, '_smoke_col_', fakeDense);
    } catch {
      threw = true;
    }
    ok('buildLinks with precomputedDense + empty collections resolves without error', !threw);
    ok('result preserves source_file', result?.source_file === 'a.md');
    ok('result has links array',       Array.isArray(result?.links));
  }
}
