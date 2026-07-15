// Anchor resolution + bounded assembly orchestration (Phase 3X) — the whole
// chain behind MCP's qdrant_get_content: given one content node's identity
// (anchor_node_id, as surfaced on a qdrant_search hit), resolve it through
// StorageAdapter to its containing section or file, run the SAME
// assembleDocument() the admin document reader uses, locate the anchor's
// own segment in that assembly, and hand the result to buildAssemblyWindow()
// for token-bounded pagination.
//
// Consumes ONLY a StorageAdapter (see storage/adapter.js) — no Qdrant SDK,
// no filter DSL, no MCP-specific re-implementation of any of the above.
// This is what lets qdrant_get_content reuse the exact assembly/windowing
// logic instead of inventing a second one for MCP.
import { assembleDocument } from './assemble.js';
import { buildAssemblyWindow } from './window.js';

/**
 * @typedef {Object} AnchoredContentResult
 * @property {string} collection
 * @property {'section'|'file'} scope
 * @property {string|null} sourceFile
 * @property {string|null} nodePath — the resolved section/file scope's own
 *   nodePath (section scope) or null (file scope)
 * @property {string} assemblyMode — passthrough from assembleDocument()
 * @property {import('./contract.js').AssemblyWindowResult} window
 */

/**
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   collection: string,
 *   anchorNodeId: string,
 *   scope: 'section'|'file',
 *   maxTokens: number,
 *   cursor?: string|null,
 *   countTokens: (text: string) => number|Promise<number>,
 *   separatorText?: string — the caller's literal inter-item join separator,
 *     passed through so buildAssemblyWindow() counts the exact serialized
 *     candidate rather than adding non-additive per-part token counts.
 * }} opts
 * @returns {Promise<AnchoredContentResult & { error?: string }>}
 *   error is one of: 'anchor_not_found' (no content node at that id, or it
 *   resolves to a nav-only node — see below), 'anchor_is_navigation'
 *   (explicit: the id belongs to a skeleton_nav node, which is never
 *   factual content and can never be an anchor), 'no_section_scope' (scope
 *   was requested as 'section' but the anchor's file has no section
 *   structure to resolve — the caller should retry with scope='file'),
 *   'invalid_cursor' (passed through from buildAssemblyWindow()).
 */
export async function getAnchoredContent({ adapter, collection, anchorNodeId, scope, maxTokens, cursor = null, countTokens, separatorText = '' }) {
  // ── 1. Resolve the anchor content node ───────────────────────────────────
  const anchorNode = await adapter.getContentNode(collection, { nodeId: anchorNodeId });
  if (!anchorNode) {
    // getContentNode() itself already excludes skeleton_nav points (its
    // store primitive filters point_kind !== 'skeleton_nav') — so a null
    // result here means either the id genuinely doesn't exist, OR it exists
    // but is nav-only. Distinguish the two so the caller gets an honest
    // reason: a nav node is a navigation-summary node, never retrievable
    // factual content, and can never be an anchor — the task explicitly
    // requires this be rejected, not silently treated as "not found."
    const navCheck = typeof adapter.getSkeletonNode === 'function'
      ? await adapter.getSkeletonNode(collection, { nodeId: anchorNodeId })
      : null;
    if (navCheck) return { error: 'anchor_is_navigation' };
    return { error: 'anchor_not_found' };
  }
  if (!anchorNode.sourceFile) {
    return { error: 'anchor_not_found' };
  }

  // ── 2. Resolve scope: exact section (via parentId) or whole file ─────────
  let assemblyScope = 'file';
  let sectionNode = null;
  if (scope === 'section') {
    sectionNode = anchorNode.parentId
      ? await adapter.getSkeletonNode(collection, { nodeId: anchorNode.parentId })
      : null;
    if (sectionNode && sectionNode.nodeType === 'section') {
      assemblyScope = 'section';
    } else {
      // The anchor's file has no section structure to resolve into (e.g. a
      // flat/legacy file, or a node directly under the file root) — honest
      // rejection rather than silently downgrading to file scope behind the
      // caller's back. qdrant_get_content's own MCP-layer default retry
      // guidance ("use scope=file only when section context is
      // insufficient") is exactly for this case.
      return { error: 'no_section_scope' };
    }
  }

  // ── 3. Fetch chunks for the resolved scope ────────────────────────────────
  let chunks;
  let sourceFile = anchorNode.sourceFile;
  let nodePath = null;
  if (assemblyScope === 'section') {
    chunks = await adapter.getSectionChunks(collection, { nodeId: sectionNode.nodeId });
    if (chunks === null) return { error: 'no_section_scope' };
    sourceFile = sectionNode.sourceFile ?? sourceFile;
    nodePath = sectionNode.nodePath;
  } else {
    chunks = await adapter.getFileChunks(collection, sourceFile);
  }

  // ── 4. Assemble (the SAME core service the admin reader uses) ────────────
  const assembly = assembleDocument({
    collection, scope: assemblyScope, sourceFile, nodePath,
    chunks: chunks ?? [], skeleton: assemblyScope === 'section' ? true : undefined,
  });

  // ── 5. Bounded, anchor-centered window ────────────────────────────────────
  const windowResult = await buildAssemblyWindow({
    assembly, anchorNodeId, maxTokens, cursor, countTokens, separatorText,
  });
  if (windowResult.error) return { error: windowResult.error };

  return {
    collection,
    scope: assemblyScope,
    sourceFile,
    nodePath,
    assemblyMode: assembly.assemblyMode,
    window: windowResult,
  };
}
