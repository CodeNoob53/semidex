// The one real CloudGenerationCapability implementation — a thin factory
// wrapping gemini-provider.js's createGeminiProvider() and
// gemini-models.js's discoverGeminiModels() into the shape core/
// generation/cloud-generation-capability.js declares. This is the ONE
// file a composition root (Full or Lite) imports to obtain the real
// capability — generation/registry.js and admin/api/generation-models.js
// each receive a real function reference as an injected parameter, never
// importing this file, gemini-provider.js, or gemini-models.js directly.
import { createGeminiProvider } from './gemini-provider.js';
import { discoverGeminiModels } from './gemini-models.js';
import { validateCloudGenerationCapability } from '../../core/generation/cloud-generation-capability.js';

/**
 * @returns {import('../../core/generation/cloud-generation-capability.js').CloudGenerationCapability}
 */
export function createCloudGenerationCapability() {
  const capability = { createProvider: createGeminiProvider, discoverModels: discoverGeminiModels };
  validateCloudGenerationCapability(capability);
  return capability;
}
