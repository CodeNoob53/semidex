// Aggregate runner for all optional live retrieval smoke scripts.
// Runs each script sequentially via spawnSync and stops on first failure.
//
// Usage:
//   node benchmarks/retrieval/smoke-live.js
//   npm run smoke:retrieval-live
//
// NOT part of default CI or npm run smoke.
// Requires: live Qdrant with bench-retrieval-custom-50 and bench-retrieval-custom-raw indexed.

import { spawnSync } from 'child_process';

const SCRIPTS = [
  'smoke:window-live',
  'smoke:source-filter-live',
  'smoke:answer-policy-live',
];

console.log('=== semidex aggregate live retrieval smoke ===');
console.log(`Scripts: ${SCRIPTS.join(', ')}`);
console.log('');

for (const script of SCRIPTS) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Running: npm run ${script}`);
  console.log('─'.repeat(50));

  // On Windows, npm is a .cmd file; spawnSync requires shell invocation.
  // Use cmd /c to avoid the DEP0190 shell:true concatenation warning.
  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'npm', 'run', script], { stdio: 'inherit' })
    : spawnSync('npm', ['run', script], { stdio: 'inherit' });

  if (result.status !== 0) {
    console.error(`\n✗ ${script} failed (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Live retrieval smoke: PASS — ${SCRIPTS.length}/${SCRIPTS.length} scripts passed`);
