// Skeleton warnings writer — JSONL inspect artifact, NEVER stored in Qdrant.
// Contract: docs/design/skeleton-first-chunking.md §5.2, impl spec §3.7.
//
// One line per event:
//   { source_file, kind, mdast_type, node_type, position, reason, raw_excerpt, chunking_model }
//
// Purpose: accumulate statistics of real unknown nodes / parse issues so the
// mapping table is extended from evidence, not guesses. The log is an analysis
// tool, not a runtime dependency: a write failure must never break indexing.

import { mkdirSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const RAW_EXCERPT_MAX = 200;

export function warningsPathFor(collection) {
  return join(ROOT, '.tmp', 'semidex-inspect', collection || 'unknown-collection', 'skeleton-warnings.jsonl');
}

let _writeFailureLogged = false;

/**
 * Append one warning event as a JSONL line. Failure-safe: any I/O error is
 * logged to stderr once per process and swallowed — indexing continues.
 *
 * @param {Object} event
 * @param {string} event.collection
 * @param {string} event.source_file
 * @param {'unknown_node'|'parse_error'} event.kind
 * @param {string} [event.mdast_type]
 * @param {string} [event.node_type]
 * @param {{ start_line?: number, end_line?: number }} [event.position]
 * @param {string} [event.reason]
 * @param {string} [event.raw_excerpt] — truncated to 200 chars
 * @param {string} [event.chunking_model] — defaults to "skeleton-v1"
 */
export function logSkeletonWarning(event) {
  try {
    const path = warningsPathFor(event?.collection);
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      source_file:    event?.source_file ?? '',
      kind:           event?.kind ?? 'unknown_node',
      mdast_type:     event?.mdast_type ?? null,
      node_type:      event?.node_type ?? 'unknown',
      position:       event?.position ?? null,
      reason:         event?.reason ?? '',
      raw_excerpt:    String(event?.raw_excerpt ?? '').slice(0, RAW_EXCERPT_MAX),
      chunking_model: event?.chunking_model ?? 'skeleton-v1',
    });
    appendFileSync(path, line + '\n', 'utf8');
  } catch (err) {
    if (!_writeFailureLogged) {
      _writeFailureLogged = true;
      process.stderr.write(`[skeleton] warning log write failed (${err.message}) — continuing without log\n`);
    }
  }
}

// Test hook: reset the once-per-process failure latch.
export function _resetWarningsForTest() { _writeFailureLogged = false; }
