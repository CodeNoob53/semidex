// Thin cross-platform launcher for the opt-in ONNX real-tokenizer
// integration test (tests/integration/onnx-embed-real-tokenizer.integration.test.js).
// Exists only so `npm run test:integration:onnx-tokenizer` sets the
// opt-in env var identically on Windows (cmd/PowerShell) and POSIX
// shells without adding a cross-env dependency — `VAR=1 command` syntax
// works in bash but not cmd.exe, and this repo's npm scripts must run on
// both.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--max-old-space-size=512', '--test', '--test-concurrency=1', 'tests/integration/onnx-embed-real-tokenizer.integration.test.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, SEMIDEX_RUN_ONNX_TOKENIZER_INTEGRATION: '1' },
  },
);
process.exitCode = result.status ?? 1;
