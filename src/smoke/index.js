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
import section23 from './sections/23-length-bucket.js';
import section24 from './sections/24-dml-batching-gate.js';
import section26 from './sections/26-extract-context-tags-array.js';
import section27 from './sections/27-combined-phase.js';
import section28 from './sections/28-setext-headings.js';
import section29 from './sections/29-semidex-ignore.js';
import section30 from './sections/30-tag-gen-flag.js';
import section31 from './sections/31-empty-section.js';
import section32 from './sections/32-deterministic-point-id.js';
import section33 from './sections/33-duplicate-repair-helpers.js';
import section34 from './sections/34-mcp-navigation-tools.js';
import section35 from './sections/35-mcp-ux-polish.js';
import section36 from './sections/36-token-count.js';
import section37 from './sections/37-pipeline-primitives.js';
import section38 from './sections/38-tag-onnx-provider.js';
import section39 from './sections/39-dynamic-overlap.js';
import section40 from './sections/40-colbert-guard.js';
import section41 from './sections/41-ce-rerank-stub.js';
import section42 from './sections/42-skeleton-parse.js';
import section43 from './sections/43-skeleton-policy.js';
import section44 from './sections/44-skeleton-warnings.js';
import section45 from './sections/45-skeleton-chunk.js';
import section46 from './sections/46-skeleton-payload.js';
import section47 from './sections/47-skeleton-nav.js';
import section48 from './sections/48-nav-filter.js';
import section49 from './sections/49-skeleton-edge-cases.js';
import section50 from './sections/50-nav-upsert.js';
import section51 from './sections/51-skeleton-summary.js';
import section52 from './sections/52-run-num-ctx.js';
import section53 from './sections/53-skeleton-nav-tools.js';
import section54 from './sections/54-adaptive-skeleton-summaries.js';
import section55 from './sections/55-hierarchical-skeleton-summaries.js';
import section56 from './sections/56-get-node-tool.js';

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
  section06, section07, section08, section09,
  section11, section12, section13, section14, section15,
  section16, section17, section18, section19, section20,
  section23, section24,
  section26, section27, section28, section29, section30,
  section31, section32, section33, section34, section35,
  section36, section37, section38, section39,
  section40, section41, section42, section43, section44, section45, section46,
  section47, section48, section49, section50, section51, section52,
  section53,
  section54,
  section55,
  section56,
];

for (const section of sections) {
  await section(helpers);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
