// Ollama availability check for the admin UI's "LLM summaries" indexing
// option. Read-only: this module never starts Ollama on its own. If Ollama
// isn't reachable, the caller (POST /api/jobs/index) rejects the request
// with a clear, actionable error — the user runs `ollama serve` themselves,
// the same way they would for any other local dependency. No background
// process is ever spawned just because a checkbox was toggled or a job was
// submitted.
//
// Reachability/model-list logic is shared with the indexer's own preflight
// (src/indexer/preflight.js) via src/local/core/ollama.js — one
// implementation, not two drifting copies.
import { isOllamaReachable, listOllamaModels, validateOllamaModels } from '../../core/ollama.js';

const DEFAULT_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

/**
 * @typedef {'available' | 'missing' | 'model_missing'} OllamaStatus
 */

/**
 * Check whether Ollama is reachable and, if `requiredModel` is given,
 * whether that model is pulled. Never starts or stops any process.
 *
 * @param {{ baseUrl?: string, requiredModel?: string }} [opts]
 * @returns {Promise<{ status: OllamaStatus, message: string, missingModel?: string }>}
 */
export async function checkOllama({ baseUrl = DEFAULT_URL, requiredModel } = {}) {
  if (!(await isOllamaReachable(baseUrl))) {
    return {
      status: 'missing',
      message: 'Ollama is not running. Start Ollama and retry: ollama serve',
    };
  }

  if (!requiredModel) {
    return { status: 'available', message: 'Ollama is running.' };
  }

  let models;
  try {
    models = await listOllamaModels(baseUrl);
  } catch (err) {
    return { status: 'missing', message: `Ollama is running but its model list could not be read: ${err.message}` };
  }
  if (validateOllamaModels([requiredModel], models)) {
    return {
      status: 'model_missing',
      message: `Ollama is running, but the model "${requiredModel}" is not pulled. Run: ollama pull ${requiredModel}`,
      missingModel: requiredModel,
    };
  }
  return { status: 'available', message: 'Ollama is running with the required model available.' };
}
