#!/usr/bin/env node
// Validates the Phase 8A target dependency directions against the generated
// semantic manifest. This script never reclassifies modules.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, 'full-lite-module-classification.json');

export const DIRECTION_RULES = Object.freeze({
  shared: new Set(['cloud', 'local', 'composition', 'tooling', 'mixed', 'unclassified']),
  cloud: new Set(['local', 'composition', 'tooling', 'mixed', 'unclassified']),
  local: new Set(['cloud', 'composition', 'tooling', 'mixed', 'unclassified']),
});

// Deliberately empty. Any future exception must name one exact edge and be
// justified in the architecture report instead of weakening a whole rule.
export const JUSTIFIED_LOCAL_TO_CLOUD_EDGES = Object.freeze([]);

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

export function findDirectionViolations(manifest = loadManifest()) {
  const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
  const justified = new Set(JUSTIFIED_LOCAL_TO_CLOUD_EDGES.map((edge) => `${edge.from}->${edge.to}`));
  const violations = [];
  for (const module of manifest.modules) {
    const forbidden = DIRECTION_RULES[module.category];
    if (!forbidden) continue;
    for (const dependency of module.directDependencies) {
      const target = byPath.get(dependency);
      if (!target || !forbidden.has(target.category)) continue;
      if (justified.has(`${module.path}->${dependency}`)) continue;
      violations.push({
        type: `${module.category}_to_${target.category}`,
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
    if (module.category !== 'shared') continue;
    for (const dependency of module.directDependencies) {
      if (byPath.get(dependency)?.category === 'cloud') {
        edges.push({ from: module.path, to: dependency });
      }
    }
  }
  return edges;
}

function main() {
  const manifest = loadManifest();
  const violations = findDirectionViolations(manifest);
  const sharedToCloud = findSharedToCloudEdges(manifest);
  console.log(`[violations] dependency-direction violations: ${violations.length}`);
  if (violations.length) console.log(JSON.stringify(violations, null, 2));
  console.log(`[violations] shared->cloud edges: ${sharedToCloud.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
