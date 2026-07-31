import { createStorageAdapter } from '../../core/storage/factory.js';
import { resolveExistingCollectionProfile } from '../../core/embedding-profile/resolve.js';
import { resolveAvailability } from '../../core/embedding-profile/availability.js';
import { checkOnnxModelCached } from '../../core/embedding-profile/onnx-lane.js';
import { isOllamaReachable, listOllamaModels, validateOllamaModels } from '../../core/ollama.js';

export const schema = {
  name: 'qdrant_collection_info',
  description: 'List all Qdrant collections with point counts, vector size, description, and search availability.',
  inputSchema: { type: 'object', properties: {} },
};

// MCP resolves availability through the SAME resolveExistingCollectionProfile
// + resolveAvailability path admin/search/Ask use — no separate/duplicated
// provider-fallback logic (the old denseProvider/sparse ?? envProv reads this
// file used to have). Lazily constructed, mirroring search.js's
// setStorageAdapter() DI seam so a test importing this module directly never
// touches a real Qdrant connection unless handle() actually runs.
let storageAdapter = null;
let storageAdapterOverride = null;
export function setStorageAdapter(adapter) { storageAdapterOverride = adapter; }
let availabilityChecksOverride = null;
export function setAvailabilityChecks(checks) { availabilityChecksOverride = checks; }
function getStorageAdapter() {
  if (storageAdapterOverride) return storageAdapterOverride;
  if (!storageAdapter) storageAdapter = createStorageAdapter();
  return storageAdapter;
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// A tiny inline equivalent of src/admin/system/ollama.js's checkOllama() —
// built directly from core/ollama.js's three primitives rather than
// importing across the mcp/ -> admin/ boundary, so this MCP tool module
// stays independent of the admin server. Same status/message contract
// resolveLaneAvailability()'s checkOllamaLane DI expects.
async function checkOllamaLane({ requiredModel }) {
  if (!(await isOllamaReachable(OLLAMA_URL))) {
    return { status: 'missing', message: 'Ollama is not running. Start Ollama and retry: ollama serve' };
  }
  let models;
  try {
    models = await listOllamaModels(OLLAMA_URL);
  } catch (err) {
    return { status: 'missing', message: `Ollama is running but its model list could not be read: ${err.message}` };
  }
  if (validateOllamaModels([requiredModel], models)) {
    return { status: 'model_missing', message: `Ollama is running, but the model "${requiredModel}" is not pulled. Run: ollama pull ${requiredModel}` };
  }
  return { status: 'available', message: 'Ollama is running with the required model available.' };
}

// Per Part F's corrected logic: NEVER claims verified availability from
// searchAttemptable/MODEL_CACHED/NOT_CACHED alone, and never claims a
// dense-only search mode is available, since none is implemented — a
// dense-only profile or a broken sparse lane both simply report search as
// unavailable, with the reason distinguishing why. Gated on
// aggregate.hybridSearchAvailable specifically (not availability.status
// alone) — resolveAvailability()'s own `status` collapses onto
// COLLECTION_STATUS.AVAILABLE for a fully-verified DENSE-ONLY profile too
// (there is no separate "dense-only available" status value), but Semidex's
// only implemented search mode is hybrid dense+sparse, so this suffix must
// not call that "available".
function availabilitySuffix(availability) {
  if (availability.aggregate?.hybridSearchAvailable) return ', search: available';
  const status = availability.status;
  if (status === 'runtime_unverified') return ', search: model cached, runtime not verified';
  if (status === 'download_required') return ', search: model will download on first use';
  // availability.dense is null only for a genuinely non-resolved profile
  // (legacy_unmigrated/invalid/unsupported_profile_schema/ambiguous_legacy —
  // resolveAvailability's early return, no lane checks ever ran). Once
  // dense is non-null, a null sparse specifically means "resolved, but no
  // sparse lane configured" — distinct from a resolution failure.
  const reason = availability.dense === null ? status
    : !availability.sparse ? 'no sparse lane configured'
    : (availability.dense?.reason ?? availability.sparse?.reason ?? status);
  return `, search: unavailable (${reason})`;
}

export async function handle() {
  const adapter = getStorageAdapter();
  const availabilityChecks = availabilityChecksOverride ?? { checkOllamaLane, checkOnnxModelCached };
  const collections = await adapter.listCollections();
  const lines = await Promise.all(collections.map(async (col) => {
    const resolution = await resolveExistingCollectionProfile(adapter, col.name);
    const availability = await resolveAvailability(resolution, availabilityChecks);
    const denseProvider = col.provider?.denseProvider ?? 'unknown';
    const denseModel = col.provider?.denseModel ?? 'unknown';
    const sparse = col.provider?.sparseProvider ?? 'none';
    const desc = col.description;
    return `- **${col.name}** — ${col.pointCount ?? 0} points, dense: ${denseProvider}/${denseModel}, sparse: ${sparse}${desc ? `, ${desc}` : ''}${availabilitySuffix(availability)}`;
  }));
  return '## Collections\n\n' + lines.join('\n');
}
