// Grounded prompt assembly (Phase 4A) — pure, deterministic, no I/O. Builds
// the exact system+evidence+question text sent to the generation provider,
// and defines the refusal sentinel the model is instructed to emit when the
// supplied evidence does not answer the question.
//
// Evidence token counting (evidence.js) uses the real BGE-M3 tokenizer,
// which is EXACT for the indexed chunk text it measures but is only a PROXY
// for the generation model's own tokenizer (e.g. Gemma's SentencePiece
// vocab differs from BGE-M3's). RESERVED_HEADROOM_TOKENS below is
// deliberately conservative for that reason — this module never claims
// exact accounting against the generation model's context window.

// Deterministic, language-independent refusal marker. The model is
// instructed to emit this exact literal token when evidence is
// insufficient, so refusal detection never depends on guessing phrasing in
// the question's language. citations.js strips this sentinel from the
// user-visible answer before it ever reaches the client.
export const REFUSAL_SENTINEL = '[[INSUFFICIENT_EVIDENCE]]';

export const RESERVED_HEADROOM_TOKENS = 1024;

// Only these node types are ever rendered via the compact raw form
// (table/code block/checklist) the [node: <path>] marker exists to
// reference — a plain paragraph's nodePath is retrieval metadata, not a
// structural entity the model should be told it can "show" in place of
// re-typing it. Mirrors STRUCTURAL_CONTENT_TYPES in
// src/indexer/phases/node-policy.js.
const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

function isStructuralSource(source) {
  return Boolean(source.nodePath) && STRUCTURAL_NODE_TYPES.has(source.nodeType);
}

function formatSourceHeader(source) {
  const parts = [source.sourceFile ?? 'unknown'];
  if (source.section) parts.push(`§ ${source.section}`);
  if (isStructuralSource(source)) parts.push(`[node: ${source.nodePath}]`);
  return `[${source.n}] (${parts.join(' ')})`;
}

/**
 * @param {Array<{ n: number, sourceFile: string|null, section: string|null, snippet: string, nodePath?: string|null, nodeType?: string|null }>} sources
 * @param {string} question
 * @returns {string}
 */
export function buildPrompt(sources, question) {
  const hasStructuralNodes = sources.some(isStructuralSource);

  const rules = [
    'You answer questions using ONLY the numbered evidence below.',
    'Rules:',
    '- Every factual claim must carry an inline citation like [1] or [2][4].',
    `- If the evidence does not contain the answer, respond with exactly ${REFUSAL_SENTINEL} and nothing else. Do not guess. Do not use outside knowledge.`,
    '- Answer in the language of the question.',
  ];
  if (hasStructuralNodes) {
    rules.push(
      '- To show an original table or code block from the evidence, emit [node: <node_path>] on its own line instead of re-typing it. Only use a node_path that appears in the evidence below.'
    );
  }
  rules.push('- Be concise.');

  const evidenceBlock = sources
    .map(s => `${formatSourceHeader(s)}\n${s.snippet}`)
    .join('\n\n');

  return [
    'System:',
    rules.join('\n'),
    '',
    'Evidence:',
    evidenceBlock,
    '',
    `Question: ${question}`,
  ].join('\n');
}
