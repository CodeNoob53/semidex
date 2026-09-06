// Qrel <-> corpus validation for custom-50 v4 (audit 2026-09-06, P1/B:
// "Пошкодження content при збереженому chunk ID більше не проходить
// validation"; "Skip-index повинен відхиляти несумісний корпус").
//
// Two checks, both hash-based, neither of which the v3 "does this chunkId
// exist" check could do:
//
//  1. structural — every relevantChunks[].chunkId in queries.v4.json must
//     exist in corpus.frozen.json.
//  2. content-integrity — every relevantChunks[].contentHash must still
//     equal the frozen chunk's contentHash. A chunkId that resolves to
//     DIFFERENT text now (the doc was edited, the chunker changed, a table
//     row moved) fails here even though the chunkId is unchanged.
//
// validateLiveCollection() additionally rebuilds the per-file content
// hashes from a LIVE collection's chunks and rejects a skip-index run
// whose collection no longer matches the frozen corpus.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, chunkContentHash } from './corpus-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export { sha256, chunkContentHash };

export function loadFrozenCorpus(path = resolve(__dirname, 'corpus.frozen.json')) {
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const byChunkId = new Map();
  for (const file of Object.values(corpus.files)) {
    for (const ch of file.chunks) byChunkId.set(ch.chunkId, ch);
  }
  return { corpus, byChunkId };
}

export function loadV4Qrels(path = resolve(__dirname, 'queries.v4.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Structural + content-integrity validation of the v4 qrels against the
 * frozen corpus. Returns { ok, errors } — never throws.
 * @param {object} [opts]
 * @param {object} [opts.qrels] parsed queries.v4.json (default: read from disk)
 * @param {Map} [opts.byChunkId] frozen chunk index (default: read from disk)
 * @param {object} [opts.manifest] parsed corpus.manifest.json (default: read from disk)
 */
export function validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest } = {}) {
  qrels ??= loadV4Qrels();
  byChunkId ??= loadFrozenCorpus().byChunkId;
  manifest ??= JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8'));
  const errors = [];

  if (qrels.corpusHash && manifest.corpusHash && qrels.corpusHash !== manifest.corpusHash) {
    errors.push(`qrels.corpusHash (${qrels.corpusHash.slice(0, 12)}…) != corpus manifest corpusHash (${manifest.corpusHash.slice(0, 12)}…) — the qrels were reviewed against a different corpus build.`);
  }

  for (const q of qrels.queries) {
    for (const rc of q.relevantChunks ?? []) {
      const ch = byChunkId.get(rc.chunkId);
      if (!ch) {
        errors.push(`[${q.id}] chunkId "${rc.chunkId}" is not in the frozen corpus.`);
        continue;
      }
      if (rc.contentHash && rc.contentHash !== ch.contentHash) {
        errors.push(`[${q.id}] chunkId "${rc.chunkId}" still exists but its content changed (qrel hash ${rc.contentHash.slice(0, 12)}… != corpus hash ${ch.contentHash.slice(0, 12)}…). The evidence span the label was assigned to is gone — re-review this query.`);
      }
      if (![1, 2, 3].includes(rc.relevance)) {
        errors.push(`[${q.id}] chunkId "${rc.chunkId}" has relevance ${rc.relevance} — must be 1, 2, or 3.`);
      }
    }
    for (const group of q.requiredEvidence ?? []) {
      for (const id of group) {
        if (!(q.relevantChunks ?? []).some((rc) => rc.chunkId === id)) {
          errors.push(`[${q.id}] requiredEvidence names "${id}" which is not in this query's relevantChunks.`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Rejects a skip-index run whose LIVE collection no longer matches the
 * frozen corpus. `getFileChunksFn(sourceFile) -> Promise<Array<point>>` is
 * injected (the production getFileChunks bound to the collection) so this
 * stays testable offline. Compares per-file content-hash sequences.
 * Returns { ok, errors, perFile }.
 */
export async function validateLiveCollectionMatchesFrozen({ corpus, getFileChunksFn }) {
  const errors = [];
  const perFile = {};
  for (const [sourceFile, frozenFile] of Object.entries(corpus.files)) {
    const points = await getFileChunksFn(sourceFile);
    const liveHashes = points
      .slice()
      .sort((a, b) => (a.payload?.chunk_index ?? 0) - (b.payload?.chunk_index ?? 0))
      .map((p) => chunkContentHash({
        nodeType: p.payload?.node_type ?? p.nodeType ?? null,
        text: p.payload?.text ?? '',
        rawContent: p.payload?.raw_content ?? p.payload?.rawContent ?? null,
      }));
    const frozenHashes = frozenFile.chunks.map((c) => c.contentHash);
    const match = liveHashes.length === frozenHashes.length
      && liveHashes.every((h, i) => h === frozenHashes[i]);
    perFile[sourceFile] = { match, live: liveHashes.length, frozen: frozenHashes.length };
    if (!match) {
      errors.push(`${sourceFile}: live collection has ${liveHashes.length} chunks / frozen has ${frozenHashes.length}${liveHashes.length === frozenHashes.length ? ' (same count, content differs)' : ''} — skip-index would evaluate against a corpus the qrels were not reviewed for.`);
    }
  }
  return { ok: errors.length === 0, errors, perFile };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { ok, errors } = validateQrelsAgainstFrozenCorpus();
  if (ok) {
    console.error('validate-qrels OK — every v4 qrel chunk exists and its content hash matches the frozen corpus.');
  } else {
    for (const e of errors) console.error(`  ${e}`);
    console.error(`\n${errors.length} validation error(s).`);
    process.exitCode = 1;
  }
}
