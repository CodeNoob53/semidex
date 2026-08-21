// Provider-aware Ollama model discovery for the admin Settings UI.
// /api/tags supplies the installed model list; /api/show supplies the
// authoritative capabilities and model metadata for each entry.
import { embeddingDimensionFromShow, isOllamaReachable, showModel } from './ollama.js';
import { createOllamaEgressPolicy } from '../../core/security/ollama-egress-policy.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SHOW_CONCURRENCY = 4;

async function inspectModel(modelName, baseUrl, forceRefresh) {
  const data = await showModel(modelName, baseUrl, { forceRefresh });
  if (!Array.isArray(data?.capabilities)) {
    return { capabilities: null, embeddingDimension: null };
  }
  return {
    capabilities: [...new Set(data.capabilities.filter((value) => typeof value === 'string'))],
    embeddingDimension: embeddingDimensionFromShow(data),
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Discover installed models without starting Ollama or loading model weights.
 * A failed /api/show is represented by capabilities:null, never guessed from
 * a model name. Multi-capability models retain their full capability list.
 *
 * @param {string} [baseUrl]
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<{available: boolean, reason: string|null, models: Array<{
 *   name: string,
 *   capabilities: string[]|null,
 *   embeddingDimension: number|null,
 *   parameterSize: string|null,
 *   family: string|null
 * }>}>}
 */
export async function discoverOllamaModels(baseUrl = OLLAMA_URL, { forceRefresh = false } = {}) {
  // Checked explicitly (in addition to isOllamaReachable()'s own internal
  // guard below, which already prevents the fetch this function performs
  // for a blocked baseUrl) so a blocked destination is reported with its
  // real reason instead of a generic "not reachable" message.
  const egressVerdict = createOllamaEgressPolicy({
    allowMetadataAddresses: process.env.OLLAMA_ALLOW_METADATA_EGRESS === '1',
  }).checkUrl(baseUrl);
  if (!egressVerdict.ok) {
    return {
      available: false,
      reason: `Ollama request blocked by egress policy (${egressVerdict.reason}).`,
      models: [],
    };
  }

  if (!(await isOllamaReachable(baseUrl))) {
    return {
      available: false,
      reason: `Ollama is not reachable at ${baseUrl}. Start it with "ollama serve".`,
      models: [],
    };
  }

  let tags;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    tags = data.models ?? [];
  } catch (err) {
    return { available: false, reason: `Failed to list Ollama models: ${err.message}`, models: [] };
  }

  const inspections = await mapWithConcurrency(
    tags,
    SHOW_CONCURRENCY,
    (model) => inspectModel(model.name, baseUrl, forceRefresh)
  );
  const models = tags.map((model, index) => ({
    name: model.name,
    capabilities: inspections[index].capabilities,
    embeddingDimension: inspections[index].embeddingDimension,
    parameterSize: model.details?.parameter_size ?? null,
    family: model.details?.family ?? null,
  }));
  return { available: true, reason: null, models };
}
