// QdrantStorageAdapter: implements the StorageAdapter contract (adapter.js)
// by delegating to src/core/qdrant/ (store.js, schema.js, ensure-schema.js).
//
// This is the ONLY file that translates between Qdrant's snake_case payload
// shapes / filter DSL and semidex domain shapes (camelCase, no Qdrant
// internals). Callers above this layer (a future Local API) must never see
// point_kind, node_type snake_case fields, or Qdrant filter objects.
import * as store from '../qdrant/store.js';
import { isSemidexPayload } from '../qdrant/payload.js';
import { ensureCollectionSchema } from '../qdrant/ensure-schema.js';
import { classifyVectorSchema } from '../doctor-checks.js';
import { withNavExcluded, isNavPoint } from '../qdrant/nav-filter.js';
import { loadConfig, resolveEnvProviders } from '../config.js';
import { mergeCapabilities } from './capabilities.js';

const QDRANT_CAPABILITIES = mergeCapabilities({
  namedVectors:     true,
  sparseVectors:    true,
  hybridSearch:     true,
  payloadIndexes:   true,
  aliases:          false,
  snapshots:        false,
  collectionExists: true,
});

// ── Domain mapping helpers ──────────────────────────────────────────────────
// snake_case Qdrant payload -> camelCase semidex domain shapes.
// Kept as small pure functions so tests can assert on mapping without a
// live Qdrant instance.

export function toChunk(point) {
  const p = point?.payload ?? {};
  return {
    sourceFile:   p.source_file ?? null,
    chunkIndex:   Number.isInteger(p.chunk_index) ? p.chunk_index : null,
    totalChunks:  Number.isInteger(p.total_chunks) ? p.total_chunks : null,
    section:      p.section ?? null,
    text:         p.text ?? null,
    rawContent:   p.raw_content ?? null,
    lang:         p.lang ?? null,
    context:      p.context ?? null,
    tags:         Array.isArray(p.tags) ? p.tags : [],
    nodeType:     p.node_type ?? null,
    nodeId:       p.node_id ?? null,
    nodePath:     p.node_path ?? null,
    score:        typeof point?.score === 'number' ? point.score : null,
    isMatch:      null,
  };
}

export function toSourceDocument(entry) {
  return {
    sourceFile:   entry.source_file,
    chunkCount:   entry.chunkCount,
    firstSection: entry.firstSection || null,
    tags:         entry.tags ?? [],
  };
}

export function toSkeletonNode(payload) {
  if (!payload) return null;
  return {
    nodeType:     payload.node_type ?? null,
    nodeId:       payload.node_id ?? null,
    nodePath:     payload.node_path ?? null,
    parentId:     payload.parent_id ?? null,
    summary:      payload.summary ?? null,
    headingPath:  payload.heading_path ?? null,
    sourceFile:   payload.source_file ?? null,
    childCount:   Array.isArray(payload.children) ? payload.children.length : 0,
    children:     Array.isArray(payload.children) ? payload.children : [],
    inventory:    payload.inventory ?? null,
    keyTopics:    payload.key_topics ?? null,
  };
}

export function toStructuralNodeChunk(payload) {
  if (!payload) return null;
  return {
    sourceFile:   payload.source_file ?? null,
    chunkIndex:   Number.isInteger(payload.chunk_index) ? payload.chunk_index : null,
    totalChunks:  null,
    section:      payload.section ?? null,
    // Structural content nodes (table/code_block/checklist) may not always
    // carry a separate `text` field the way retrieval chunks do — fall back
    // to raw_content so callers still get displayable content, but rawContent
    // below is always the byte-exact source regardless of this fallback.
    text:         payload.text ?? payload.raw_content ?? null,
    rawContent:   payload.raw_content ?? null,
    lang:         payload.lang ?? null,
    context:      payload.context ?? null,
    tags:         [],
    nodeType:     payload.node_type ?? null,
    nodeId:       payload.node_id ?? null,
    nodePath:     payload.node_path ?? null,
    score:        null,
    isMatch:      null,
  };
}

/**
 * Resolve provider metadata for a collection from config.json, falling back
 * to env-derived providers exactly like mcp/tools/collections.js does for
 * qdrant_collection_info. Cheap — no point scroll, just config.json + env.
 */
export function resolveConfigProvider(col, envProv) {
  const denseProvider = col?.denseProvider
    ?? (col?.sparseProvider === 'bge-m3-onnx' ? 'bge-m3-onnx' : envProv.denseProvider);
  const denseModel = col?.denseModel ?? col?.embedModel ?? envProv.denseModel;
  const sparseProvider = col?.sparseProvider ?? envProv.sparseProvider;
  return { denseProvider, denseModel, sparseProvider };
}

/**
 * Translate the semidex-level search filter into a Qdrant filter object.
 * This is the ONLY place a Qdrant filter DSL shape is built from adapter
 * inputs — callers pass { sourceFile?, tags?, excludeNav? }, never Qdrant
 * `must`/`should` clauses directly.
 *
 * @param {{ sourceFile?: string, tags?: string[], excludeNav?: boolean }} [filter]
 * @returns {Object|null}
 */
export function translateSearchFilter(filter) {
  if (!filter) return null;
  const must = [];
  if (filter.sourceFile) must.push({ key: 'source_file', match: { value: filter.sourceFile } });
  if (filter.tags?.length) must.push({ should: filter.tags.map(t => ({ key: 'tags', match: { value: t } })) });

  let qdrantFilter = must.length ? { must } : null;
  if (filter.excludeNav) qdrantFilter = withNavExcluded(qdrantFilter);
  return qdrantFilter;
}

export function createQdrantStorageAdapter() {
  return {
    name() {
      return 'qdrant';
    },

    capabilities() {
      return { ...QDRANT_CAPABILITIES };
    },

    async ping() {
      try {
        await store.listCollections();
        return { ok: true, detail: 'Qdrant reachable' };
      } catch (err) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },

    async listCollections() {
      const names = await store.listCollections();
      const config = loadConfig();
      const envProv = resolveEnvProviders();
      return Promise.all(names.map(async (name) => {
        const info = await store.getCollectionInfo(name);
        const col = config.collections?.[name];
        const { denseProvider, denseModel, sparseProvider } = resolveConfigProvider(col, envProv);
        return {
          name,
          pointCount: info.points_count ?? 0,
          vectorSchema: classifyVectorSchema(info.config?.params?.vectors ?? {}),
          provider: { denseProvider, denseModel, sparseProvider },
          description: col?.description || null,
        };
      }));
    },

    async getCollection(name) {
      const collections = await store.listCollections();
      if (!collections.includes(name)) return null;

      const config = loadConfig();
      const col = config.collections?.[name];
      const info = await store.getCollectionInfo(name);
      const vectorsCfg = info.config?.params?.vectors ?? {};
      const vectorSchemaKind = classifyVectorSchema(vectorsCfg);
      const denseSize = vectorSchemaKind === 'named'
        ? (vectorsCfg.dense?.size ?? null)
        : (vectorSchemaKind === 'flat' ? vectorsCfg.size ?? null : null);
      const hasSparse = Boolean(info.config?.params?.sparse_vectors?.sparse);

      const samplePoints = await store.scroll(name, null, 1, true);
      const samplePayload = samplePoints[0]?.payload ?? null;
      const skeletonRoot = await store.getCollectionSkeletonNode(name);
      // info.points_count is Qdrant's raw total and includes skeleton_nav
      // points on any collection with skeleton navigation on — using it to
      // label "N chunks" in the admin UI would overstate real content by
      // however many nav points exist. chunkCount is the exact server-side
      // count of real content points only.
      const chunkCount = await store.countContentPoints(name);

      const warnings = [];
      if (vectorSchemaKind === 'flat') warnings.push('legacy flat vector schema — hybrid search unavailable');
      if (vectorSchemaKind === 'empty') warnings.push('no vector schema found on this collection');

      return {
        name,
        pointCount: info.points_count ?? 0,
        chunkCount,
        vectorSchema: {
          dense: { size: denseSize, distance: vectorsCfg.dense?.distance ?? vectorsCfg.distance ?? null },
          sparse: hasSparse,
        },
        provider: {
          denseProvider: samplePayload?.dense_provider ?? null,
          denseModel: samplePayload?.dense_model ?? null,
          sparseProvider: samplePayload?.sparse_provider ?? null,
        },
        versions: {
          embeddingSchema: samplePayload?.embedding_schema_version ?? null,
          chunkingSchema: samplePayload?.chunking_schema_version ?? null,
          indexingSchema: samplePayload?.indexing_schema_version ?? null,
          tokenCountMode: samplePayload?.token_count_mode ?? null,
        },
        description: col?.description || null,
        // The skeleton root's own generated summary is a better
        // library-overview description than the config-level `description`
        // above when both exist, since it's generated from the actual
        // indexed content rather than typed once at index time and often
        // left stale/unset. But the root's `summary` field is not always a
        // real overview — skeleton-summary.js stamps summary_kind, and only
        // 'collection_overview' means an actual generated blurb (LLM rollup
        // or a single-child propagation); 'inventory' means a plain fallback
        // like "N files" with no real narrative content. Only surface the
        // former as overviewSummary — an inventory-kind summary is worse
        // than the admin UI's own "no overview yet" empty state, and must
        // not shadow a real config description. See collection-view.js for
        // the fallback chain (overviewSummary -> description -> empty state).
        overviewSummary: skeletonRoot?.summary_kind === 'collection_overview'
          ? skeletonRoot.summary ?? null
          : null,
        semidexManaged: isSemidexPayload(samplePayload),
        hasSkeleton: Boolean(skeletonRoot),
        warnings,
      };
    },

    async createCollection(name, { vectorSize = 1024 } = {}) {
      await store.createCollection(name, vectorSize);
    },

    async deleteCollection(name) {
      await store.deleteCollection(name);
    },

    async ensureCollectionSchema(name) {
      return ensureCollectionSchema(name);
    },

    async listSourceDocuments(name, { prefix = null, limit = 100 } = {}) {
      const points = await store.scrollAllPoints(name, ['source_file', 'chunk_index', 'section', 'point_kind', 'tags']);
      const normalizedPrefix = prefix ? prefix.replace(/\\/g, '/') : null;

      const fileMap = new Map();
      for (const p of points) {
        if (isNavPoint(p)) continue;
        const sf = (p.payload?.source_file ?? '').replace(/\\/g, '/');
        if (!sf) continue;
        if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

        if (!fileMap.has(sf)) {
          fileMap.set(sf, { source_file: sf, chunkCount: 0, firstSection: '', minChunkIndex: Infinity, tags: new Set() });
        }
        const entry = fileMap.get(sf);
        entry.chunkCount++;
        const ci = p.payload?.chunk_index ?? Infinity;
        if (ci < entry.minChunkIndex) {
          entry.minChunkIndex = ci;
          entry.firstSection = p.payload?.section || '';
        }
        for (const t of p.payload?.tags ?? []) entry.tags.add(t);
      }

      const entries = [...fileMap.values()]
        .map(e => ({ ...e, tags: [...e.tags] }))
        .sort((a, b) => a.source_file.localeCompare(b.source_file))
        .slice(0, limit);

      return entries.map(toSourceDocument);
    },

    async getChunk(name, sourceFile, chunkIndex, { window = 0 } = {}) {
      const points = await store.fetchWindowChunks(name, sourceFile, chunkIndex, window);
      return points.map(toChunk);
    },

    // Every retrieval-content chunk for one file, in order — the primitive
    // the admin UI's file view needs to open a file directly and see its
    // real content, rather than approximating "the whole file" with a
    // window centered on chunk 0 (getChunk() above, which is a genuinely
    // different retrieval-context concept, not a file-listing one).
    async getFileChunks(name, sourceFile) {
      const points = await store.getFileChunks(name, sourceFile);
      return points.map(toChunk);
    },

    async searchHybrid(name, { dense, sparse, limit = 5, filter } = {}) {
      const qdrantFilter = translateSearchFilter(filter);
      const points = await store.hybridSearch(name, dense, sparse, limit, qdrantFilter);
      return points.map(toChunk);
    },

    async getSkeletonRoot(name) {
      const node = await store.getCollectionSkeletonNode(name);
      return toSkeletonNode(node);
    },

    async getSkeletonNode(name, { nodeId, nodePath } = {}) {
      const node = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      return toSkeletonNode(node);
    },

    async getSkeletonChildren(name, { nodeId, nodePath, limit = 50 } = {}) {
      const parent = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      if (!parent) return [];
      const childPaths = Array.isArray(parent.children) ? parent.children : [];
      const children = await store.getSkeletonChildren(name, childPaths, limit);
      return children.map(toSkeletonNode);
    },

    async getStructuralNode(name, { nodeId, nodePath } = {}) {
      const node = nodeId
        ? await store.getContentNodeById(name, nodeId)
        : await store.getContentNodeByPath(name, nodePath);
      return toStructuralNodeChunk(node);
    },

    // Resolves a skeleton nav node (e.g. a section) to the earliest content
    // chunk anchored under it, so "open this section" can jump to a real
    // chunkIndex instead of guessing chunk 0 for the whole file. A section
    // nav node and its content chunks are separate Qdrant points linked only
    // by parent_id === section's node_id (design: skeleton-index.js) — this
    // is the one place that link is followed.
    async getSectionAnchor(name, { nodeId, nodePath } = {}) {
      const navNode = nodeId
        ? await store.getSkeletonNodeById(name, nodeId)
        : await store.getSkeletonNodeByPath(name, nodePath);
      if (!navNode?.node_id) return null;
      const chunk = await store.getFirstContentChunkByParent(name, navNode.node_id);
      return chunk ? toChunk({ payload: chunk }) : null;
    },
  };
}
