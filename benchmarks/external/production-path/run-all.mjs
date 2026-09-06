#!/usr/bin/env node
// Thin sequential caller of the four suite runners' exported entry
// functions (imports and calls directly — never subprocess spawns).
//
// THIS IS THE FULL-RUN COMMAND. Documented as approval-gated: never
// auto-invoked by any test, smoke script, or other automation — run only
// after the user has explicitly reviewed and approved the runtime/
// request-volume estimate produced by the pilot run.
//
// Usage:
//   node benchmarks/external/production-path/run-all.mjs [--smoke] [--resume] [--restart] [--cuda]
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStructuralSuite } from './run-structural-prodpath.mjs';
import { runScifactSuite } from './run-scifact-prodpath.mjs';
import { runMiraclRuSuite } from './run-miracl-ru-prodpath.mjs';
import { runSlavicSuite, SLAVIC_CAVEAT } from './run-slavic-prodpath.mjs';
import { exitCodeForManySuiteStates } from './core/cli-exit.mjs';

async function main() {
  const smoke = process.argv.includes('--smoke');
  const resume = process.argv.includes('--resume');
  const restart = process.argv.includes('--restart');
  const cudaRequested = process.argv.includes('--cuda');

  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const opts = { smoke, resume, restart, cudaRequested };
  const results = {};

  console.log('\n=== structural ===');
  results.structural = await runStructuralSuite(opts);

  console.log('\n=== scifact ===');
  results.scifact = await runScifactSuite(opts);

  console.log('\n=== miracl-ru ===');
  results['miracl-ru'] = await runMiraclRuSuite(opts);

  console.log('\n=== slavic (7 languages) ===');
  results.slavic = await runSlavicSuite(opts);

  console.log(`\n${SLAVIC_CAVEAT}`);
  console.log('\n=== summary ===');
  const verdicts = [
    ['structural', results.structural?.verdict],
    ['scifact', results.scifact?.verdict],
    ['miracl-ru', results['miracl-ru']?.verdict],
    ...Object.entries(results.slavic ?? {}).map(([lang, state]) => [`slavic/${lang}`, state?.verdict]),
  ];
  for (const [name, verdict] of verdicts) console.log(`${name}: ${verdict}`);
  // Any non-COMPLETE suite fails the whole run with a nonzero exit.
  process.exitCode = exitCodeForManySuiteStates([
    results.structural, results.scifact, results['miracl-ru'],
    ...Object.values(results.slavic ?? {}),
  ]);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
