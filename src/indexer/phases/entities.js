// Pure regex/heuristic entity extractor. No LLM, no external I/O.
// Input: chunk object with { text, section, source_file }
// Output: { entities: { paths, symbols, env_vars, commands, heading_path }, doc_role }
//
// All arrays are deduped and sorted for deterministic output.
// This module has no side effects and is safe to call in any order.

// ── Patterns ──────────────────────────────────────────────────────────────────

// Relative project paths: must start with src/, benchmarks/, or docs/
const RE_PATH = /(?:src|benchmarks|docs)\/[\w.\-/]+\.(?:js|md|json)/g;

// camelCase identifiers (at least one uppercase after opening lowercase)
const RE_CAMEL = /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;

// ALL_CAPS constants: 3+ uppercase letters/digits/underscores, must contain underscore
// or be at least 4 chars of uppercase to avoid matching short acronyms like "ID"
const RE_CONST = /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g;

// npm scripts: `npm run <name>` where name is lowercase with colons/hyphens/digits
const RE_COMMAND = /\bnpm run [a-z][a-z0-9:._-]+/g;

// env-var prefix filter — known semidex env-var prefixes
const ENV_VAR_PREFIXES = new Set([
  'BENCH_', 'ONNX_', 'OLLAMA_', 'QDRANT_', 'COLLECTION', 'VECTOR_',
  'SOURCE_', 'FORCE_', 'SKIP_', 'KEEP_', 'PRUNE_', 'LINK_',
  'RERANK_', 'HYBRID_', 'RRF_', 'MMR_', 'TAG_', 'COMBINED_', 'CONTEXT_',
  'DENSE_', 'SPARSE_', 'LLM_', 'CHUNKS_', 'APPLY', 'DRY_RUN',
]);

// ── doc_role static map ───────────────────────────────────────────────────────

// Keyed on source_file basename (without extension) or known path segments.
// Order matters: first match wins.
const DOC_ROLE_RULES = [
  // reference: structural maps, API references, config lists
  { test: sf => /project-structure/.test(sf), role: 'reference' },
  { test: sf => /config-env/.test(sf), role: 'reference' },
  { test: sf => /benchmarking/.test(sf), role: 'reference' },
  // workflow: operational how-to docs
  { test: sf => /mcp-workflow/.test(sf), role: 'workflow' },
  { test: sf => /sync\.md/.test(sf), role: 'workflow' },
  // multilingual
  { test: sf => /multilingual/.test(sf), role: 'multilingual' },
  // concept: everything else that isn't explicitly categorised
  { test: sf => /providers/.test(sf), role: 'concept' },
  { test: sf => /chunking/.test(sf), role: 'concept' },
  { test: sf => /qdrant\.md/.test(sf), role: 'concept' },
  { test: sf => /obsidian/.test(sf), role: 'concept' },
];

function classifyDocRole(source_file) {
  for (const { test, role } of DOC_ROLE_RULES) {
    if (test(source_file)) return role;
  }
  return 'other';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dedupeSort(arr) {
  return [...new Set(arr)].sort();
}

function matchAll(str, re) {
  const results = [];
  let m;
  const reg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  reg.lastIndex = 0;
  while ((m = reg.exec(str)) !== null) {
    results.push(m[0]);
  }
  return results;
}

function isEnvVar(token) {
  return ENV_VAR_PREFIXES.has(token) || [...ENV_VAR_PREFIXES].some(p => token.startsWith(p));
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract entity payload from a chunk.
 *
 * @param {{ text: string, section?: string, source_file: string }} chunk
 * @returns {{ entities: { paths: string[], symbols: string[], env_vars: string[], commands: string[], heading_path: string[] }, doc_role: string }}
 */
export function extractEntities(chunk) {
  const { text = '', section = '', source_file = '' } = chunk;

  // Search in both text and section heading for paths, symbols, commands.
  // Heading contributes to heading_path separately.
  const searchable = `${section}\n${text}`;

  // ── paths ──
  const paths = dedupeSort(matchAll(searchable, RE_PATH));

  // ── symbols + env_vars ──
  // Collect ALL_CAPS tokens first; split them from camelCase symbols.
  const allCapsTokens = matchAll(searchable, RE_CONST);
  const camelTokens = matchAll(searchable, RE_CAMEL);

  const env_vars = dedupeSort(allCapsTokens.filter(isEnvVar));
  // Symbols: camelCase identifiers + ALL_CAPS constants that are not env_vars
  const constSymbols = allCapsTokens.filter(t => !isEnvVar(t));
  const symbols = dedupeSort([...camelTokens, ...constSymbols]);

  // ── commands ──
  const commands = dedupeSort(matchAll(searchable, RE_COMMAND));

  // ── heading_path ──
  // Current chunker stores only the immediate section heading in chunk.section.
  // For now: split on " > " separator if present (future parent-chain format),
  // otherwise use the raw section string as a single-element array.
  // Empty section → empty array.
  let heading_path = [];
  if (section && section.trim()) {
    heading_path = section.split(' > ').map(s => s.trim()).filter(Boolean);
  }

  // ── doc_role ──
  const doc_role = classifyDocRole(source_file);

  return {
    entities: { paths, symbols, env_vars, commands, heading_path },
    doc_role,
  };
}
