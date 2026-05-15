// Shared query type taxonomy helpers for custom-50 benchmarks.
// Import this in run-v3.js, cross-encoder-bench.js, and ce-routing-bench.js.

export const ALLOWED_TYPES = new Set([
  'exact-token',
  'config-env',
  'provider-activation',
  'source-navigation',
  'conceptual',
  'troubleshooting',
  'cross-lingual-ua-en',
  'english',
  'negative',
  'window-dependent',
  'multi-hop',
]);

// Validate query types and print a summary count.
// Warns (does not hard-fail) so existing ad hoc runs are not broken.
// Returns { typeDistribution: Map<type, count>, warnings: string[] }.
export function validateQueryTypes(queries) {
  const dist = new Map();
  const warnings = [];

  for (const q of queries) {
    const t = q.type;
    if (!t) {
      warnings.push(`[${q.id}] missing type field`);
    } else if (!ALLOWED_TYPES.has(t)) {
      warnings.push(`[${q.id}] unknown type "${t}" (allowed: ${[...ALLOWED_TYPES].join(', ')})`);
    }
    const key = t ?? '(missing)';
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }

  return { typeDistribution: dist, warnings };
}

// Format type distribution as a compact one-liner summary.
export function formatTypeDistribution(dist) {
  return [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}=${n}`)
    .join('  ');
}
