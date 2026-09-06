// The ONE definition of a custom-50 chunk's content hash, shared by
// build-corpus.mjs (which writes it into corpus.frozen.json) and
// validate-qrels.mjs (which re-derives it from a live collection). Keeping
// it in one place means the two can never drift apart.
import { createHash } from 'node:crypto';

export const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical retrieval body for hashing — the text a retriever actually
 * matches against, whitespace-normalized so an incidental reflow never
 * reads as content drift. For a structural node (table/code_block/
 * checklist) the authoritative content is raw_content; for prose it is the
 * embedded text. raw_content on a prose node is redundant with text and is
 * NOT used (its presence proved unstable across index runs).
 * @param {{ nodeType: string|null, text: string, rawContent: string|null }} chunk
 */
export function canonicalBody({ nodeType, text, rawContent }) {
  const body = STRUCTURAL_NODE_TYPES.has(nodeType) && rawContent != null ? rawContent : (text ?? '');
  return String(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** contentHash for a frozen-corpus chunk record or a live payload. */
export function chunkContentHash({ nodeType, text, rawContent }) {
  return sha256(canonicalBody({ nodeType, text, rawContent }));
}
