// Stable internal node ID for skeleton-first chunking.
// Contract: docs/design/skeleton-first-chunking-impl-spec.md §3.6 and design §6.
//
// Stability boundaries (design §6, fixed honestly):
//   - STABLE on identical reindex of an unchanged file.
//   - NOT guaranteed across structural edits: inserting a sibling above shifts
//     ordinalWithinParent and changes the node_id of every following sibling.
//     Acceptable for MVP — reindexing a file rebuilds its whole subtree.
//     Long-lived references need a content-fingerprint strategy (separate design).
//
// The name layout deliberately differs from makePointId so the two ID spaces
// can never collide: point IDs join 4 fields, node IDs join 5 and include a
// "node:" domain prefix.

import { uuidv5 } from './point-id.js';

/**
 * Derive a stable node_id for a skeleton structural node.
 *
 * @param {Object} parts
 * @param {string} parts.collection           — collection name (cross-collection isolation)
 * @param {string} parts.sourceFile           — relative path, forward-slash normalised
 * @param {string} parts.structuralPath       — slug path without ordinal, e.g. "install/table"
 * @param {string} parts.nodeType             — table | code_block | paragraph | section | ...
 * @param {number} parts.ordinalWithinParent  — 1-based ordinal among same-type siblings
 * @returns {string} UUID
 */
export function makeNodeId({ collection, sourceFile, structuralPath, nodeType, ordinalWithinParent }) {
  const normalizedFile = String(sourceFile ?? '').replace(/\\/g, '/');
  const name = [
    'node:',
    collection ?? '',
    normalizedFile,
    structuralPath ?? '',
    nodeType ?? '',
    String(ordinalWithinParent ?? 0),
  ].join('\x00');
  return uuidv5(name);
}
