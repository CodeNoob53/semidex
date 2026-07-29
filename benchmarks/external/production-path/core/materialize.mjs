// Materializes benchmark documents as real files on disk (never hand-built
// Qdrant points) so they can be indexed through the real indexer CLI, and
// builds the deterministic filename<->docID mapping core/collapse.mjs
// needs to map chunk hits back to benchmark document IDs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializedDir } from './isolated-config.mjs';

/**
 * Sanitizes an arbitrary benchmark document ID into a safe filename
 * fragment. Conservative allowlist — real BEIR/MIRACL/Belebele doc IDs
 * are already short alnum/hyphen strings, this is a defensive fallback.
 */
function sanitizeForFilename(docId) {
  return String(docId).replace(/[^A-Za-z0-9_-]/g, '_');
}

export function docIdToFilename(docId) {
  return `doc-${sanitizeForFilename(docId)}.md`;
}

/**
 * Writes one Markdown file per corpus document under a fresh, per-
 * (suite, profile, runSuffix) directory inside this harness's own
 * gitignored .cache/materialized/ tree (never a bare OS tmpdir — files
 * must survive across resume/retry, and never a tracked source path).
 *
 * @param {{
 *   suiteId: string, profileId: string, runSuffix: string,
 *   corpus: Map<string, any> | Array<[string, any]>,
 *   toMarkdown: (doc: any, docId: string) => string,
 * }} params
 * @returns {{
 *   dir: string,
 *   sourceFileToDocId: Map<string,string>,
 *   docIdToSourceFile: Map<string,string>,
 * }}
 */
export function materializeDataset({ suiteId, profileId, runSuffix, corpus, toMarkdown }) {
  const dir = materializedDir(suiteId, profileId, runSuffix);
  mkdirSync(dir, { recursive: true });

  const entries = corpus instanceof Map ? [...corpus.entries()] : corpus;
  const sourceFileToDocId = new Map();
  const docIdToSourceFile = new Map();
  const seenFilenames = new Set();

  for (const [docId, doc] of entries) {
    const filename = docIdToFilename(docId);
    if (seenFilenames.has(filename)) {
      throw new Error(`materializeDataset: filename collision for docId "${docId}" -> "${filename}" — two distinct document IDs sanitized to the same filename`);
    }
    seenFilenames.add(filename);
    const markdown = toMarkdown(doc, docId);
    writeFileSync(resolve(dir, filename), markdown, 'utf-8');
    sourceFileToDocId.set(filename, String(docId));
    docIdToSourceFile.set(String(docId), filename);
  }

  return { dir, sourceFileToDocId, docIdToSourceFile };
}
