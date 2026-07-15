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
 * @property {string|null} nodeId — Phase 3X (additive): the prose chunk's
 *   own stable node identity (a real skeleton node_id, same as an entity
 *   segment's), null for legacy (plain_chunks) collections with no node
 *   identity at all
 * @property {string|null} nodePath — Phase 3X (additive), same null rule
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

// ── Bounded assembly window (Phase 3X) ───────────────────────────────────────
// buildAssemblyWindow() (./window.js) projects an already-assembled
// AssemblyResult down to a token-bounded, anchor-centered page — for MCP's
// qdrant_get_content, which must never load an entire large document into an
// agent's context window. Lives in contract.js alongside the rest of this
// module's shared vocabulary; the algorithm itself is in window.js so this
// file stays pure constants/typedefs.

export const CURSOR_VERSION = 1;

/**
 * @typedef {Object} WindowItem
 * A bounded-window item is a normal ProseSegment/EntitySegment, UNLESS the
 * segment alone exceeds the token budget — then it is replaced by an
 * OversizedDescriptor (see below). Every item that made it into `items`
 * counts toward `returnedTokens`.
 */

/**
 * @typedef {Object} OversizedDescriptor
 * A single structural entity that alone exceeds maxTokens is never dumped or
 * truncated mid-row/mid-block — it is replaced by this bounded descriptor.
 * `content` is always null; the full entity is only ever available through
 * the separate qdrant_get_node tool (primarily for user display, not
 * evidence assembly).
 * @property {true} oversized
 * @property {string|null} nodeId
 * @property {string|null} nodePath
 * @property {number|null} chunkIndex
 * @property {string|null} nodeType
 * @property {number} tokenCount — the segment's OWN (excluded) token count
 *   (diagnostic metadata; this number itself does not count against
 *   maxTokens — but a separate, small, FIXED cost for the descriptor's own
 *   note text does count against maxTokens, same as any other included
 *   item; see window.js's OVERSIZED_NOTE — code review, round 1: this used
 *   to be silently ~0, letting an unbounded run of oversized entities ride
 *   for free)
 * @property {null} content
 * @property {string} note — human-readable explanation of the oversized
 *   policy and how to retrieve the full entity
 */

/**
 * @typedef {Object} AssemblyWindowResult
 * @property {Array<WindowItem|OversizedDescriptor>} items — ordered
 *   (source order), the bounded page actually returned
 * @property {string|null} anchorNodeId
 * @property {number} totalTokens — exact token count of the full serialized
 *   assembled scope (diagnostic metadata only — NOT bounded by maxTokens)
 * @property {number} returnedTokens — exact token count of the page's
 *   serialized budget representation: normal segment content plus the fixed
 *   note text substituted for each oversized descriptor. This is counted in
 *   one tokenizer call because BPE tokenization is not additive; it never
 *   exceeds maxTokens. With no oversized descriptors it equals the token
 *   count of the reconstructed response text.
 * @property {boolean} hasMoreBefore
 * @property {boolean} hasMoreAfter
 * @property {string|null} cursorBefore — opaque, base64url; null when
 *   hasMoreBefore is false
 * @property {string|null} cursorAfter — opaque, base64url; null when
 *   hasMoreAfter is false
 */
