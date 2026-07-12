// GET /api/collections/:name/assembly — StorageAdapter-only.
//
// Thin by design: validates parameters, obtains ordered chunks through the
// adapter (file scope: getFileChunks; section scope: skeleton-node identity
// then getSectionChunks), delegates ALL assembly logic to the core assembly
// service, and serializes its result verbatim. No Qdrant imports, no
// segment/ordering/fallback logic here.
import { sendJson, notFound, badRequest } from '../http.js';
import { requireStringParam } from './query-params.js';
import { assembleDocument } from '../../core/assembly/assemble.js';

export function registerAssemblyRoutes(router, adapter, { logFn } = {}) {
  // Real logger by default (the assembly service logs its placeholder
  // fallback once per request through this); tests inject a spy/no-op.
  const log = logFn ?? ((line) => console.warn(line));

  router.get('/api/collections/:name/assembly', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const scope = requireStringParam(query, 'scope');
    if (scope !== 'file' && scope !== 'section') {
      throw badRequest(`Query param "scope" must be "file" or "section", got "${scope}"`);
    }

    if (scope === 'file') {
      // Conflicting selectors rejected outright — a request carrying both a
      // file selector and a section selector has no single honest answer.
      if (query.get('nodePath')) {
        throw badRequest('scope=file takes "sourceFile", not "nodePath"');
      }
      const sourceFile = requireStringParam(query, 'sourceFile');
      const chunks = await adapter.getFileChunks(params.name, sourceFile);
      if (!chunks.length) throw notFound(`No chunks found for sourceFile="${sourceFile}"`);

      sendJson(res, 200, assembleDocument({
        collection: params.name, scope: 'file', sourceFile, nodePath: null, chunks, logFn: log,
      }));
      return;
    }

    // scope=section — identity is the skeleton node (nodeId under the hood),
    // NEVER a heading-text match: headings can repeat within a file, a
    // node_path cannot.
    if (query.get('sourceFile')) {
      throw badRequest('scope=section takes "nodePath", not "sourceFile"');
    }
    const nodePath = requireStringParam(query, 'nodePath');

    const node = await adapter.getSkeletonNode(params.name, { nodePath });
    if (!node) {
      // Covers both "unknown section" and "legacy collection with no
      // skeleton at all" — either way there is no section identity to
      // assemble against, and inventing one from heading labels or chunk
      // index ranges is exactly what this endpoint refuses to do.
      throw notFound(`Skeleton section not found for nodePath="${nodePath}" (unknown section, or collection has no skeleton)`);
    }
    if (node.nodeType !== 'section') {
      throw badRequest(`nodePath="${nodePath}" identifies a "${node.nodeType}" node — scope=section requires a section node`);
    }

    const chunks = await adapter.getSectionChunks(params.name, { nodeId: node.nodeId });

    // skeleton: true — this route just resolved a REAL skeleton node, so the
    // scope is definitively skeleton even when the section holds zero
    // chunks; without the explicit marker an empty section would be
    // indistinguishable from a legacy collection and mislabeled
    // plain_chunks.
    sendJson(res, 200, assembleDocument({
      collection: params.name, scope: 'section', sourceFile: node.sourceFile ?? null,
      nodePath, chunks: chunks ?? [], skeleton: true, logFn: log,
    }));
  });
}
