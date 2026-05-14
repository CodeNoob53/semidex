export default async function ({ ok }) {
  console.log('\n[14] Profiler (pure, no I/O)');

  const { Profiler } = await import('../../indexer/profiler.js');
  const savedProfile = process.env.INDEX_PROFILE;

  // 14a. Disabled when INDEX_PROFILE unset
  delete process.env.INDEX_PROFILE;
  {
    const p = new Profiler();
    ok('disabled when unset: enabled=false', p.enabled === false);
    p.mark('x');
    ok('disabled: mark() is no-op (no marks stored)', p.marks.length === 0);
  }

  // 14b. Disabled when INDEX_PROFILE=0
  process.env.INDEX_PROFILE = '0';
  {
    const p = new Profiler();
    ok('disabled when INDEX_PROFILE=0: enabled=false', p.enabled === false);
  }

  // 14c–14h. Enabled when INDEX_PROFILE=1
  process.env.INDEX_PROFILE = '1';
  {
    const p = new Profiler();
    ok('enabled when INDEX_PROFILE=1: enabled=true', p.enabled === true);

    p.mark('chunk');
    p.mark('context');
    p.mark('tag');
    ok('three marks recorded', p.marks.length === 3);
    ok('marks in order: chunk/context/tag',
      p.marks.map(m => m.label).join(',') === 'chunk,context,tag');

    let output = '';
    const orig = console.log;
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    p.report({ chunksIn: 5, chunksOut: 4, tokensEst: 200 });
    console.log = orig;
    ok('report output contains [profile]',    output.includes('[profile]'));
    ok('report output contains chunk label',  output.includes('chunk'));
    ok('report output contains context label', output.includes('context'));
    ok('report output contains tag label',    output.includes('tag'));
    ok('report output contains total',        output.includes('total'));
    ok('report output contains chunks/s',     output.includes('chunks/s'));

    const p2 = new Profiler();
    p2.mark('only');
    let out2 = '';
    console.log = (...args) => { out2 += args.join(' ') + '\n'; };
    p2.report({ chunksIn: 1, chunksOut: 1, tokensEst: 50 });
    console.log = orig;
    ok('single mark: output contains only label', out2.includes('only'));
    ok('single mark: output contains total',      out2.includes('total'));

    const p3 = new Profiler();
    p3.mark('chunk');
    let out3 = '';
    console.log = (...args) => { out3 += args.join(' ') + '\n'; };
    p3.report({ chunksIn: 0, chunksOut: 0, tokensEst: 0 });
    console.log = orig;
    ok('zero chunks: output does not contain NaN',      !out3.includes('NaN'));
    ok('zero chunks: output does not contain Infinity', !out3.includes('Infinity'));
    ok('zero chunks: cps reported as em-dash',          out3.includes('—'));

    const p4 = new Profiler();
    p4.mark('chunk');
    p4.t0 = Date.now() + 9999;
    let out4 = '';
    console.log = (...args) => { out4 += args.join(' ') + '\n'; };
    p4.report({ chunksIn: 3, chunksOut: 3, tokensEst: 100 });
    console.log = orig;
    ok('totalMs≤0 with chunks: no Infinity', !out4.includes('Infinity'));
    ok('totalMs≤0 with chunks: cps is em-dash', out4.includes('—'));
  }

  if (savedProfile !== undefined) process.env.INDEX_PROFILE = savedProfile;
  else delete process.env.INDEX_PROFILE;
}
