import 'dotenv/config';
import { withConfig } from './helpers.js';

import section01 from './sections/01-default-provider.js';
import section02 from './sections/02-onnx-embed.js';
import section03 from './sections/03-invalid-combo-resolve.js';
import section04 from './sections/04-embed-runtime-guard.js';
import section05 from './sections/05-reindex-detection.js';
import section06 from './sections/06-chunking-edge-cases.js';
import section07 from './sections/07-reranker-top1.js';
import section08 from './sections/08-compact-window.js';
import section09 from './sections/09-stale-source-files.js';
import section10 from './sections/10-link-collections.js';
import section11 from './sections/11-recursive-chunk-text.js';
import section12 from './sections/12-onnx-providers.js';
import section13 from './sections/13-semidex-payload.js';
import section14 from './sections/14-profiler.js';
import section15 from './sections/15-bootstrap-docs.js';
import section16 from './sections/16-extract-json-array.js';
import section17 from './sections/17-pdf-fixture.js';
import section18 from './sections/18-validate-ollama-models.js';
import section19 from './sections/19-doctor-checks.js';
import section20 from './sections/20-colbert-math.js';
import section21 from './sections/21-graph-cache.js';
import section22 from './sections/22-build-links-precomputed.js';
import section23 from './sections/23-length-bucket.js';
import section24 from './sections/24-dml-batching-gate.js';
import section25 from './sections/25-zip-ordered-links.js';
import section26 from './sections/26-extract-context-tags-array.js';
import section27 from './sections/27-combined-phase.js';

let passed = 0;
let failed = 0;

function ok(label, result) {
  if (result) { console.log(`  ✓ ${label}`); passed++; }
  else        { console.error(`  ✗ ${label}`); failed++; }
}

function throws(label, fn, expectedSubstring) {
  try {
    fn();
    console.error(`  ✗ ${label} — expected throw, got none`);
    failed++;
  } catch (e) {
    if (!expectedSubstring || e.message.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`); passed++;
    } else {
      console.error(`  ✗ ${label} — wrong error: ${e.message}`); failed++;
    }
  }
}

async function throwsAsync(label, fn, expectedSubstring) {
  try {
    await fn();
    console.error(`  ✗ ${label} — expected throw, got none`);
    failed++;
  } catch (e) {
    if (!expectedSubstring || e.message.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`); passed++;
    } else {
      console.error(`  ✗ ${label} — wrong error: ${e.message}`); failed++;
    }
  }
}

const helpers = { ok, throws, throwsAsync, withConfig };

const sections = [
  section01, section02, section03, section04, section05,
  section06, section07, section08, section09, section10,
  section11, section12, section13, section14, section15,
  section16, section17, section18, section19, section20,
  section21, section22, section23, section24, section25,
  section26, section27,
];

for (const section of sections) {
  await section(helpers);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
