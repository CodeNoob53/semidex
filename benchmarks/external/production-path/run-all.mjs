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
  console.log(`structural: ${results.structural?.verdict}`);
  console.log(`scifact: ${results.scifact?.verdict}`);
  console.log(`miracl-ru: ${results['miracl-ru']?.verdict}`);
  for (const [lang, state] of Object.entries(results.slavic ?? {})) {
    console.log(`slavic/${lang}: ${state?.verdict}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
