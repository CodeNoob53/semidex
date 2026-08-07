#!/usr/bin/env node
// Validates the Phase 8A target dependency directions against the generated
// semantic manifest. This script never reclassifies modules.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, 'full-lite-module-classification.json');

// Code review fix (Phase 8B Step 6, second pass): 'composition' was
// previously forbidden as a target for both cloud and local sources too —
// but a composition root is, by construction, the thing every other
// category is allowed to feed INTO (e.g. spawn-indexer-full.js, a `local`
// spawn wrapper, importing its own edition's indexer CLI entry point,
// index-full.js, a `composition-full` root — a normal same-edition
// "launch my own entry point" relationship, never a boundary crossing).
// This rule previously never triggered in practice because the manifest
// builder's old propagation pass reclassified any such source module to
// 'mixed' before this check ever ran (see find-dependency-violations.mjs's
// header comment and build-shared-cloud-local-manifest.mjs's declaredCategory
// field for the fix that stopped that masking) — shared->composition stays
// forbidden: shared code must never depend on a specific edition's
// composition root.
export const DIRECTION_RULES = Object.freeze({
  shared: new Set(['cloud', 'local', 'composition', 'tooling', 'mixed', 'unclassified']),
  cloud: new Set(['local', 'tooling', 'mixed', 'unclassified']),
  local: new Set(['cloud', 'tooling', 'mixed', 'unclassified']),
});

// Deliberately empty. Any future exception must name one exact edge and be
// justified in the architecture report instead of weakening a whole rule.
export const JUSTIFIED_LOCAL_TO_CLOUD_EDGES = Object.freeze([]);

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

// Both functions below read declaredCategory, not the propagation-refined
// category (falling back to category for any manifest — e.g. a test fixture
// — that only supplies the older, single-category shape). Code review fix
// (Phase 8B Step 6, second pass): the manifest builder's own propagation
// pass rewrites a module's `category` to 'mixed' the moment it finds a
// forbidden dependency — reading THAT field here would mean a real
// shared->cloud edge silently reclassifies its source module to 'mixed'
// before this check ever runs, hiding the exact violation this script
// exists to find. declaredCategory is fixed at classification time,
// independent of dependency-direction correctness, so it can't be erased
// by the very violation it's supposed to reveal.
function declaredOf(module) {
  return module.declaredCategory ?? module.category;
}

export function findDirectionViolations(manifest = loadManifest()) {
  const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
  const justified = new Set(JUSTIFIED_LOCAL_TO_CLOUD_EDGES.map((edge) => `${edge.from}->${edge.to}`));
  const violations = [];
  for (const module of manifest.modules) {
    const fromCategory = declaredOf(module);
    const forbidden = DIRECTION_RULES[fromCategory];
    if (!forbidden) continue;
    for (const dependency of module.directDependencies) {
      const target = byPath.get(dependency);
      if (!target) continue;
      const toCategory = declaredOf(target);
      if (!forbidden.has(toCategory)) continue;
      if (justified.has(`${module.path}->${dependency}`)) continue;
      violations.push({
        type: `${fromCategory}_to_${toCategory}`,
        from: module.path,
        to: dependency,
      });
    }
  }
  return violations;
}

export function findSharedToCloudEdges(manifest = loadManifest()) {
  const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
  const edges = [];
  for (const module of manifest.modules) {
    if (declaredOf(module) !== 'shared') continue;
    for (const dependency of module.directDependencies) {
      if (declaredOf(byPath.get(dependency) ?? {}) === 'cloud') {
        edges.push({ from: module.path, to: dependency });
      }
    }
  }
  return edges;
}

// Exported so tests can exercise the real exit-code contract directly
// (assert on process.exitCode after calling this with a synthetic
// manifest) rather than spawning a real subprocess or mutating the
// on-disk manifest file.
export function main(manifest = loadManifest()) {
  const violations = findDirectionViolations(manifest);
  const sharedToCloud = findSharedToCloudEdges(manifest);
  console.log(`[violations] dependency-direction violations: ${violations.length}`);
  if (violations.length) console.log(JSON.stringify(violations, null, 2));
  console.log(`[violations] shared->cloud edges: ${sharedToCloud.length}`);
  // Code review fix: this script used to only print counts — a non-empty
  // violations list still exited 0, so CI (or any script chaining `&&`
  // after this one) treated a real architectural violation as success.
  // Any unjustified violation is now a hard failure.
  if (violations.length > 0 || sharedToCloud.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
