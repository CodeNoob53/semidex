export default async function ({ ok }) {
  console.log('\n[19] doctor-checks (pure helpers)');

  const {
    redactKey,
    redactUrl,
    sanitiseErrorMessage,
    makeResult,
    aggregateExitCode,
    formatResult,
    checkNodeVersion,
    classifyVectorSchema,
    checkProviderAgreement,
    checkSchemaVersion,
    missingModelCommands,
    cudaProbeGuidance,
    formatCudaProbeFailure,
    STATUS,
  } = await import('../../core/doctor-checks.js');

  // 19a. redactKey
  ok('redactKey present 8-char value', redactKey('abcd1234') === 'present (8 chars)');
  ok('redactKey empty string → missing', redactKey('') === 'missing');
  ok('redactKey null → missing',         redactKey(null) === 'missing');
  ok('redactKey undefined → missing',    redactKey(undefined) === 'missing');
  ok('redactKey long key → correct count', redactKey('x'.repeat(64)) === 'present (64 chars)');

  // 19b. redactUrl
  ok('redactUrl strips path',    redactUrl('https://host.example.com/collections?key=secret') === 'https://host.example.com');
  ok('redactUrl strips port in URL with explicit port', redactUrl('http://localhost:11434/api/version') === 'http://localhost:11434');
  ok('redactUrl strips credentials', redactUrl('https://user:pass@host.com/path') === 'https://host.com');
  ok('redactUrl null → (not set)',    redactUrl(null) === '(not set)');
  ok('redactUrl undefined → (not set)', redactUrl(undefined) === '(not set)');
  ok('redactUrl invalid → (invalid URL)', redactUrl('not-a-url') === '(invalid URL)');

  // 19c. sanitiseErrorMessage
  ok('sanitise replaces key in message',
    sanitiseErrorMessage('auth failed: mySecretKey123 is wrong', 'mySecretKey123') === 'auth failed: [REDACTED] is wrong');
  ok('sanitise no key → message unchanged',
    sanitiseErrorMessage('some error', '') === 'some error');
  ok('sanitise null secret → message unchanged',
    sanitiseErrorMessage('some error', null) === 'some error');
  ok('sanitise null message → empty string',
    sanitiseErrorMessage(null, 'key') === '');
  ok('sanitise replaces multiple occurrences',
    sanitiseErrorMessage('key key key', 'key').split('[REDACTED]').length === 4);
  ok('sanitise strips URL credentials (user:pass@host)',
    sanitiseErrorMessage('error at https://user:pass@host.com/path?q=secret', null) === 'error at https://host.com');
  ok('sanitise strips URL query string with token',
    sanitiseErrorMessage('fetch https://api.example.com/v1?api_key=tok123 failed', null) === 'fetch https://api.example.com failed');
  ok('sanitise strips URL path beyond root',
    sanitiseErrorMessage('GET https://host.example.com/collections/private returned 403', null) === 'GET https://host.example.com returned 403');
  ok('sanitise leaves bare host URL untouched',
    sanitiseErrorMessage('unreachable: https://host.example.com', null) === 'unreachable: https://host.example.com');
  ok('sanitise: key + URL credentials both redacted in same message',
    sanitiseErrorMessage('key=mySecretKey123 url=https://u:p@host.com/path', 'mySecretKey123') === 'key=[REDACTED] url=https://host.com');

  // 19d. aggregateExitCode
  ok('all PASS → exit 0',
    aggregateExitCode([makeResult(STATUS.PASS, 'x'), makeResult(STATUS.WARN, 'y')]) === 0);
  ok('any FAIL → exit 1',
    aggregateExitCode([makeResult(STATUS.PASS, 'x'), makeResult(STATUS.FAIL, 'y')]) === 1);
  ok('only SKIP → exit 0',
    aggregateExitCode([makeResult(STATUS.SKIP, 'x')]) === 0);
  ok('empty array → exit 0',
    aggregateExitCode([]) === 0);

  // 19e. formatResult — status prefix present
  {
    const pass = formatResult(makeResult(STATUS.PASS, 'Node.js v20.0.0'));
    ok('formatResult PASS contains ✓', pass.includes('✓'));
    ok('formatResult PASS contains label', pass.includes('Node.js v20.0.0'));

    const fail = formatResult(makeResult(STATUS.FAIL, 'API key', 'rotate key'));
    ok('formatResult FAIL contains ✗', fail.includes('✗'));
    ok('formatResult FAIL detail line contains →', fail.includes('→'));
    ok('formatResult FAIL detail contains rotate key', fail.includes('rotate key'));

    const warn = formatResult(makeResult(STATUS.WARN, 'Node.js v18', 'v20 recommended'));
    ok('formatResult WARN contains ⚠', warn.includes('⚠'));

    const skip = formatResult(makeResult(STATUS.SKIP, 'empty collection'));
    ok('formatResult SKIP contains ~', skip.includes('~'));
  }

  // 19f. checkNodeVersion
  ok('v25 → PASS',   checkNodeVersion('v25.2.1').status === STATUS.PASS);
  ok('v20 → PASS',   checkNodeVersion('v20.0.0').status === STATUS.PASS);
  ok('v18 → WARN',   checkNodeVersion('v18.0.0').status === STATUS.WARN);
  ok('v17 → FAIL',   checkNodeVersion('v17.0.0').status === STATUS.FAIL);
  ok('v0 → FAIL',    checkNodeVersion('v0.12.0').status === STATUS.FAIL);

  // 19g. classifyVectorSchema
  ok('flat schema: size is number → flat',
    classifyVectorSchema({ size: 1024, distance: 'Cosine' }) === 'flat');
  ok('named schema: dense object → named',
    classifyVectorSchema({ dense: { size: 1024, distance: 'Cosine' } }) === 'named');
  ok('empty object → empty',
    classifyVectorSchema({}) === 'empty');
  ok('null → empty',
    classifyVectorSchema(null) === 'empty');

  // 19h. checkProviderAgreement
  {
    const cfg = { denseProvider: 'ollama', sparseProvider: 'hashed-tf' };
    const matching = { dense_provider: 'ollama', sparse_provider: 'hashed-tf' };
    const mismatch = { dense_provider: 'bge-m3-onnx', sparse_provider: 'bge-m3-onnx' };

    ok('agreement: matching → PASS',
      checkProviderAgreement(cfg, matching).status === STATUS.PASS);
    ok('agreement: mismatch → WARN',
      checkProviderAgreement(cfg, mismatch).status === STATUS.WARN);
    ok('agreement: null sample → SKIP',
      checkProviderAgreement(cfg, null).status === STATUS.SKIP);
  }

  // 19i. checkSchemaVersion
  {
    ok('schema version: current → PASS',
      checkSchemaVersion({ embedding_schema_version: 2 }, 2).status === STATUS.PASS);
    ok('schema version: stale → WARN',
      checkSchemaVersion({ embedding_schema_version: 1 }, 2).status === STATUS.WARN);
    ok('schema version: missing field → WARN',
      checkSchemaVersion({}, 2).status === STATUS.WARN);
    ok('schema version: null sample → SKIP',
      checkSchemaVersion(null, 2).status === STATUS.SKIP);
  }

  // 19j. missingModelCommands
  {
    const cmds = missingModelCommands(['gemma3:4b', 'llama3'], ['gemma3:4b']);
    ok('missing llama3 → one command', cmds.length === 1);
    ok('command is ollama pull llama3', cmds[0] === 'ollama pull llama3');

    const none = missingModelCommands(['gemma3:4b'], ['gemma3:4b', 'llama3']);
    ok('all present → no commands', none.length === 0);

    const deduped = missingModelCommands(['gemma3:4b', 'gemma3:4b'], []);
    ok('duplicate required model → deduped to one command', deduped.length === 1);

    const empty = missingModelCommands([], ['gemma3:4b']);
    ok('empty required list → no commands', empty.length === 0);
  }

  // 19k. cudaProbeGuidance
  {
    const win = cudaProbeGuidance('win32');
    ok('19k: Windows guidance mentions dml',                 win.includes('dml'));
    ok('19k: Windows guidance mentions cpu fallback',        win.includes('ONNX_EXECUTION_PROVIDER=cpu'));
    ok('19k: Windows guidance mentions configuration.md',    win.includes('configuration.md'));

    const linux = cudaProbeGuidance('linux');
    ok('19k: Linux guidance mentions CUDA 12.x',            linux.includes('CUDA 12.x'));
    ok('19k: Linux guidance mentions cuDNN 9',              linux.includes('cuDNN 9'));
    ok('19k: Linux guidance mentions LD_LIBRARY_PATH',      linux.includes('LD_LIBRARY_PATH'));
    ok('19k: Linux guidance mentions cpu fallback',         linux.includes('ONNX_EXECUTION_PROVIDER=cpu'));
    ok('19k: Linux guidance mentions configuration.md',     linux.includes('configuration.md'));
  }

  // 19l. formatCudaProbeFailure
  {
    const withErr = formatCudaProbeFailure('no available backend found', 'linux');
    ok('19l: error message included in output',              withErr.includes('no available backend found'));
    ok('19l: guidance included when error present',          withErr.includes('CUDA 12.x'));

    const withErrWin = formatCudaProbeFailure('provider error', 'win32');
    ok('19l: Windows path includes dml hint',                withErrWin.includes('dml'));

    const noErr = formatCudaProbeFailure('', 'linux');
    ok('19l: empty errMessage → guidance only, no leading blank', noErr.includes('CUDA 12.x') && !noErr.startsWith('\n'));

    // Multi-line stack traces must not pass through — probeOnnxProvider truncates at first newline.
    // Verify the guidance output itself is single-pass (no stray newlines before the first line).
    const firstLine = withErr.split('\n')[0];
    ok('19l: first line contains the one-line error message', firstLine.includes('no available backend found'));
  }
}
