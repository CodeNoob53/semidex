// Citation and node-marker validation (Phase 4A) — pure post-processing of
// a generation provider's raw answer text against the evidence set that
// produced it. No LLM calls, no I/O. Never treats absolute RRF retrieval
// score as an answer-confidence signal — grounding is judged only by
// whether cited numbers/paths actually exist in the supplied evidence, per
// this project's standing retrieval-safety doctrine.
import { REFUSAL_SENTINEL } from './prompt.js';

const CITATION_RE = /\[(\d+)\]/g;
const NODE_MARKER_RE = /^\s*\[node:\s*([^\]]+?)\s*\]\s*$/gm;

// Mirrors prompt.js's STRUCTURAL_NODE_TYPES — a [node: path] marker is only
// ever a valid reference to a table/code_block/checklist, the entity types
// the prompt instruction actually invites the model to reference. A plain
// paragraph's nodePath must not validate a marker even if it happens to
// match, since the model was never told that path could be shown this way.
const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

/**
 * @param {string} rawText — the provider's raw generated text
 * @param {Array<{ n: number, nodePath?: string|null }>} sources
 * @returns {{
 *   refused: boolean,
 *   text: string,               — sentinel stripped, ready for the client
 *   citations: number[],        — valid citation numbers found, in order, deduped
 *   invalidCitations: number[], — cited numbers with no matching source, deduped
 *   nodeReferences: string[],   — valid [node: path] paths found, in order, deduped
 *   strippedMarkers: string[],  — [node: path] markers removed because path wasn't in evidence
 * }}
 */
export function validateCitations(rawText, sources) {
  const text = rawText ?? '';
  const trimmed = text.trim();

  if (trimmed === REFUSAL_SENTINEL) {
    return { refused: true, text: '', citations: [], invalidCitations: [], nodeReferences: [], strippedMarkers: [] };
  }

  const validNumbers = new Set(sources.map(s => s.n));
  const citations = [];
  const invalidCitations = [];
  const seenValid = new Set();
  const seenInvalid = new Set();

  for (const match of text.matchAll(CITATION_RE)) {
    const n = Number(match[1]);
    if (validNumbers.has(n)) {
      if (!seenValid.has(n)) { seenValid.add(n); citations.push(n); }
    } else if (!seenInvalid.has(n)) {
      seenInvalid.add(n);
      invalidCitations.push(n);
    }
  }

  const validPaths = new Set(
    sources.filter(s => s.nodePath && STRUCTURAL_NODE_TYPES.has(s.nodeType)).map(s => s.nodePath)
  );
  const nodeReferences = [];
  const strippedMarkers = [];
  const seenValidPath = new Set();
  const seenStripped = new Set();

  const cleanedText = text.replace(NODE_MARKER_RE, (full, path) => {
    if (validPaths.has(path)) {
      if (!seenValidPath.has(path)) { seenValidPath.add(path); nodeReferences.push(path); }
      return full; // keep valid markers in the visible text
    }
    if (!seenStripped.has(path)) { seenStripped.add(path); strippedMarkers.push(path); }
    return ''; // strip markers referencing evidence that doesn't exist
  });

  return {
    refused: false,
    text: cleanedText.replace(REFUSAL_SENTINEL, '').trim(),
    citations,
    invalidCitations,
    nodeReferences,
    strippedMarkers,
  };
}
