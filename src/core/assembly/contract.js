// Assembly service contract (Phase 3V) — constants and JSDoc typedefs for
// the storage-independent document assembly layer. No backend imports: this
// file (like storage/adapter.js) must stay importable with zero
// configuration, zero SDKs, and zero Qdrant knowledge.
//
// The assembly service consumes DOMAIN Chunk objects (camelCase, as returned
// by a StorageAdapter — see storage/adapter.js) and produces an ordered
// segment array describing a continuous document representation. Consumers:
// the admin file/section view, future MCP content assembly, future Ask/chat
// source rendering — one service, not one per surface.

/** How the assembly was derived — always reported, never silently guessed. */
export const ASSEMBLY_MODES = Object.freeze({
  /** Stored entityRefs (Phase 3U payloads) drove placeholder removal. */
  ENTITY_REFS: 'entity_refs',
  /**
   * Skeleton collection whose points have no backfilled entity_refs yet —
   * references were derived deterministically from placeholder lines via the
   * canonical matcher (core/entity-reference.js), and a machine-readable
   * warning marks the degradation.
   */
  PLACEHOLDER_FALLBACK: 'placeholder_fallback',
  /** Legacy non-skeleton collection — ordered prose only, no entities. */
  PLAIN_CHUNKS: 'plain_chunks',
});

export const SEGMENT_KINDS = Object.freeze({
  PROSE: 'prose',
  ENTITY: 'entity',
});

/** Machine-readable warning codes (each warning also carries a message). */
export const ASSEMBLY_WARNINGS = Object.freeze({
  /** Mode-level: no stored refs; derived from placeholder text instead. */
  PLACEHOLDER_FALLBACK: 'placeholder_fallback',
  /** A placeholder-shaped line resolves to no entity in this scope. */
  ORPHAN_PLACEHOLDER: 'orphan_placeholder',
  /** A listed entityRef's placeholder is not in the chunk's text as a standalone line. */
  REF_PLACEHOLDER_NOT_FOUND: 'ref_placeholder_not_found',
  /** A listed entityRef points at an entity chunk absent from the input set. */
  REF_ENTITY_MISSING: 'ref_entity_missing',
});

/**
 * @typedef {Object} ProseSegment
 * @property {'prose'} kind
 * @property {number|null} chunkIndex
 * @property {string|null} nodeType
 * @property {string} text — final prose with resolved standalone placeholder
 *   lines removed; surrounding prose byte-identical except newline
 *   normalization made unavoidable by line removal
 * @property {string|null} context
 * @property {string|null} section
 * @property {string[]|null} headingPath
 */

/**
 * @typedef {Object} EntitySegment
 * @property {'entity'} kind
 * @property {number|null} chunkIndex
 * @property {string|null} nodeId
 * @property {string|null} nodePath
 * @property {string} nodeType — one of the structural types (table, code_block, checklist)
 * @property {string|null} rawContent — the authoritative raw markdown/source,
 *   never a context or summary substitute
 * @property {string|null} lang
 * @property {string|null} context
 * @property {string|null} section
 * @property {string[]|null} headingPath
 */

/**
 * @typedef {Object} AssemblyWarning
 * @property {string} code — one of ASSEMBLY_WARNINGS
 * @property {string} message
 * @property {number|null} [chunkIndex]
 * @property {string} [placeholder]
 * @property {string} [nodePath]
 */

/**
 * @typedef {Object} AssemblyResult
 * @property {string} collection
 * @property {'file'|'section'} scope
 * @property {string|null} sourceFile
 * @property {string|null} nodePath — the section skeleton nodePath for
 *   scope=section, null for scope=file
 * @property {string} assemblyMode — one of ASSEMBLY_MODES
 * @property {Array<ProseSegment|EntitySegment>} segments
 * @property {AssemblyWarning[]} warnings
 */
