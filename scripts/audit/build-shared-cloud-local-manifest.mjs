#!/usr/bin/env node
// scripts/audit/build-shared-cloud-local-manifest.mjs — Phase 8A
// (docs/design/full-lite-shared-architecture-audit-2026-08-01.md, "Phase 8A
// — Audit and migration plan for physical shared/cloud/local separation").
//
// Produces scripts/audit/full-lite-module-classification.json — a
// machine-readable, drift-checkable manifest classifying every production
// module under src/ into exactly one of the 7 categories the task
// specifies: shared, cloud, local, composition, tooling, mixed,
// unclassified. Reachability provides initial evidence; direct dependency
// compatibility then refines the result until categories stabilize.
//
// tests/unit/architecture/shared-cloud-local-manifest.test.js is the drift
// test: it regenerates this exact manifest in memory and asserts it is
// byte-identical to what's on disk, so a src/ change that would silently
// re-classify a file (a new import, a new file, a removed file) fails a
// real test instead of leaving a stale committed manifest.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from './build-import-graph.mjs';
import {
  FULL_ROOTS, LITE_SRC_DIR, LITE_UI_ENTRY, computeReachable, collectExternalDeps,
  LOCAL_ONLY_PATH_PATTERNS, CLOUD_ONLY_PATH_PATTERNS, COMPOSITION_FULL_PATTERNS,
} from './classify-modules.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const MANIFEST_PATH = join(SCRIPT_DIR, 'full-lite-module-classification.json');

// MCP is a product runtime surface, not generic tooling. Its server is
// composition; provider-neutral tools are shared; provider-coupled tools
// are refined to mixed below.
const TOOLING_DIR_PREFIXES = ['src/smoke/'];
const TOOLING_ENTRY_FILES = new Set([
  'src/sync.js', 'src/doctor.js', 'src/backfill-tags.js', 'src/backfill-entity-refs.js',
  'src/smoke.js', 'src/bootstrap-docs.js',
]);

function isToolingFile(file, { fullReachable, liteReachable }) {
  if (TOOLING_DIR_PREFIXES.some((p) => file.startsWith(p))) return true;
  if (TOOLING_ENTRY_FILES.has(file)) return true;
  return false;
}

const SHARED_CONTRACT_FILES = new Set([
  'src/core/generation/provider.js',
  'src/core/storage/adapter.js',
  // rerank-capability.js (code review, Phase 8B Step 6 second pass, P1
  // fix): a pure capability contract, zero dependencies, same class as
  // onnx-embed-capability.js/embedding-profile/cloud-embedding-capability.js
  // (both already 'shared' via genuine Full+Lite dual reachability) — but
  // MCP tools (its one real consumer) are not currently reachable from any
  // Lite root at all, so reachability alone would misclassify it 'local'.
  // Explicit override for the same reason provider.js/adapter.js are here.
  // Path updated (Phase 8B Step 7A — physical relocation of stable shared
  // core modules into src/shared/core/).
  'src/shared/core/rerank-capability.js',
]);

const COMPOSITION_COMMON_FILES = new Set([
  // Path updated (Phase 8B Step 7C — physical relocation of shared Admin
  // runtime into src/shared/admin/).
  'src/shared/admin/register-neutral-routes.js',
  'src/admin/composition/lite.js',
  'src/core/settings/lite-policy.js',
  'src/core/settings/service.lite.js',
]);

function directDependencies(graph, file) {
  const node = graph.nodes[file];
  const deps = [];
  for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
    for (const ref of group) {
      if (ref.kind === 'relative' && ref.resolved) deps.push(ref.resolved);
    }
  }
  for (const call of node.forkSpawnCalls) {
    if (call.resolved) deps.push(call.resolved);
  }
  return [...new Set(deps)].sort();
}

// Maps classify-modules.mjs's richer classification vocabulary onto the
// task's exact 7-category vocabulary. 'composition-full'/'composition-lite'
// both collapse to 'composition' (the task's own vocabulary does not
// distinguish which edition a composition root belongs to — that
// information is preserved separately in this manifest's own
// `compositionEdition` field, computed below, not lost). 'unclear' (files
// reachable from neither traced root set — dead code, test-only helpers)
// maps to 'unclassified', matching the task's own naming.
function mapToTaskCategory(richClassification, isTooling) {
  if (isTooling) return 'tooling';
  switch (richClassification) {
    case 'composition-full':
    case 'composition-lite':
      return 'composition';
    case 'unclear':
      return 'unclassified';
    default:
      return richClassification; // shared | cloud | local | mixed
  }
}

function compositionEdition(richClassification) {
  if (richClassification === 'composition-full') return 'full';
  if (richClassification === 'composition-lite') return 'lite';
  return null;
}

export function buildManifest() {
  const graph = buildGraph();
  const fullReachable = computeReachable(graph, FULL_ROOTS);
  const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
  const liteReachabilityRoots = [...liteSyntheticRoots, LITE_UI_ENTRY];
  const liteReachable = computeReachable(graph, liteReachabilityRoots);

  // Build a task-specific baseline from explicit boundaries and real
  // reachability. A dependency-aware pass below then exposes incompatible
  // imports as mixed instead of treating reachability as architecture.
  const modules = [];
  for (const file of graph.files) {
    if (file.startsWith(LITE_SRC_DIR)) continue; // packages/lite/lite-src/*.js — not a src/ production module, out of this manifest's scope (classify-modules.mjs's own inventory still covers it separately)
    if (!file.startsWith('src/')) continue;
    if (!file.endsWith('.js')) continue;

    const inFull = fullReachable.has(file);
    const inLite = liteReachable.has(file);
    const tooling = isToolingFile(file, { fullReachable: inFull, liteReachable: inLite });

    // Explicit contracts and composition roots take precedence. Remaining
    // files use Full/Lite reachability only as a baseline classification.
    //
    // mcp/onnx-runtime-resolution.js (review finding, P1 fix — MCP now
    // resolves ONNX_MANAGED_RUNTIME the same way indexer/admin do):
    // pulled OUT of mcp/server.js's own top level specifically so it has
    // real behavioral test coverage (mcp/server.js itself is a
    // self-starting script with no isMainModule guard, so it can never be
    // imported by a test). It performs the SAME kind of decision
    // mcp/server.js's own composition-root body does — choosing between
    // the real onnxEmbed capability and a typed-unavailable one — so it
    // is classified alongside mcp/server.js as composition-full, not
    // 'local' by bare reachability. Without this, its own real
    // (and correct) local/core -> onnx-embed.js import edge would be
    // flagged as a local_to_local direction violation purely because it
    // lives in its own file instead of inline in mcp/server.js.
    let richClassification;
    if (LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(file))) richClassification = 'local';
    else if (file === 'src/mcp/server.js' || file === 'src/mcp/onnx-runtime-resolution.js') richClassification = 'composition-full';
    else if (COMPOSITION_COMMON_FILES.has(file)) richClassification = 'composition';
    // index-full.js/index-lite.js (code review, Phase 8B Step 6 — second
    // pass): each is the real per-edition indexer CLI composition root
    // (builds and injects its own capability bundle — see run.js's own
    // buildRunContext()), not a "local implementation" or "cloud
    // implementation" file. Without this, index-full.js's fullReachable-
    // only/liteReachable:false baseline previously mapped it to 'local'
    // purely from reachability, which then masked its genuine (and
    // correct) composition-root imports of local/core/ollama-capability.js/
    // onnx-embed.js/local/indexer/phases/tag-onnx.js/cloud-embedding-provider.js
    // as 'local_to_local'/'local_to_cloud' violations — they are not
    // violations; a composition root importing every capability
    // implementation it composes is exactly its job.
    else if (file === 'src/indexer/index-full.js') richClassification = 'composition-full';
    else if (file === 'src/indexer/index-lite.js') richClassification = 'composition-lite';
    else if (COMPOSITION_FULL_PATTERNS.some((p) => p.test(file)) || file === 'src/admin/ui-src/entries/full.js') richClassification = 'composition-full';
    else if (file === 'src/admin/ui-src/entries/lite.js') richClassification = 'composition-lite';
    else if (CLOUD_ONLY_PATH_PATTERNS.some((p) => p.test(file))) richClassification = 'cloud';
    else if (SHARED_CONTRACT_FILES.has(file)) richClassification = 'shared';
    else if (file.startsWith('src/mcp/tools/')) richClassification = 'shared';
    else if (inFull && inLite) richClassification = 'shared';
    else if (inFull && !inLite) richClassification = 'local';
    else if (!inFull && inLite) richClassification = 'cloud';
    else richClassification = 'unclear';

    const declaredCategory = mapToTaskCategory(richClassification, tooling);
    modules.push({
      path: file,
      // declaredCategory: this module's OWN classification, from explicit
      // boundaries (LOCAL_ONLY/CLOUD_ONLY_PATH_PATTERNS, composition roots,
      // reachability) only — never rewritten by the propagation pass below.
      // Code review fix (Phase 8B Step 6, second pass): an earlier version
      // of this script overwrote `category` in place the moment a forbidden
      // dependency was found, which meant a shared module that reached into
      // src/cloud/ was silently relabeled 'mixed' BEFORE
      // find-dependency-violations.mjs ever got to see it as 'shared' — a
      // module's own ownership can never be determined by which imports it
      // happens to have; that circularity is exactly what let a real
      // shared->cloud edge hide behind a clean-looking violation count.
      // declaredCategory is that ownership fact, fixed at classification
      // time, independent of dependency-direction correctness.
      declaredCategory,
      // category: the EFFECTIVE, propagation-refined classification —
      // 'mixed' once a module (transitively) depends on something outside
      // its own declared category's allowed targets. This is the field
      // most consumers (tests asserting "is this provider-coupled
      // orchestration classified mixed") should keep reading; it describes
      // real packaging/coupling, not ownership. find-dependency-violations.mjs
      // reads declaredCategory instead, specifically so a shared->cloud edge
      // is reported as a violation rather than pre-absorbed into 'mixed'.
      category: declaredCategory,
      compositionEdition: tooling ? null : compositionEdition(richClassification),
      fullReachable: inFull,
      liteReachable: inLite,
      directDependencies: directDependencies(graph, file),
    });
  }

  // Reachability describes packaging, not architectural identity. Propagate
  // incompatible provider dependencies up to the nearest composition root
  // by refining `category` (never `declaredCategory` — see above); otherwise
  // callers of mixed modules would still be mislabeled shared.
  const byPath = new Map(modules.map((module) => [module.path, module]));
  const allowedTargets = {
    shared: new Set(['shared']),
    cloud: new Set(['shared', 'cloud']),
    local: new Set(['shared', 'local']),
  };
  let changed;
  do {
    changed = false;
    for (const module of modules) {
      const allowed = allowedTargets[module.category];
      if (!allowed) continue;
      const incompatible = module.directDependencies.some((dep) => {
        const target = byPath.get(dep);
        return target && !allowed.has(target.category);
      });
      if (incompatible) {
        module.category = 'mixed';
        changed = true;
      }
    }
  } while (changed);

  modules.sort((a, b) => a.path.localeCompare(b.path));

  const counts = modules.reduce((acc, m) => { acc[m.category] = (acc[m.category] ?? 0) + 1; return acc; }, {});

  return {
    generatedBy: 'scripts/audit/build-shared-cloud-local-manifest.mjs',
    categories: ['shared', 'cloud', 'local', 'composition', 'tooling', 'mixed', 'unclassified'],
    counts,
    modules,
  };
}

function main() {
  const manifest = buildManifest();
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[manifest] classified ${manifest.modules.length} production modules under src/`);
  console.log('[manifest] category counts:', JSON.stringify(manifest.counts, null, 2));
  console.log(`[manifest] wrote ${MANIFEST_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
