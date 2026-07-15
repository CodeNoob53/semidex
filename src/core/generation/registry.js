// Generation provider registry: resolves which GenerationProvider
// implementation to construct, keyed by backend name. Mirrors
// storage/factory.js's single-choke-point pattern so future cloud providers
// (Phase 4A.5) plug in here without reworking callers (the Ask coordinator,
// createApp()'s DI wiring).
import { createOllamaProvider } from './ollama-provider.js';

const BACKENDS = {
  ollama: createOllamaProvider,
};

/**
 * @param {{ backend?: string }} [options] - defaults to
 *   process.env.SEMIDEX_GENERATION_BACKEND, then 'ollama'.
 * @returns {import('./provider.js').GenerationProvider}
 * @throws {Error} for an unknown backend name
 */
export function createGenerationProvider({ backend = process.env.SEMIDEX_GENERATION_BACKEND ?? 'ollama' } = {}) {
  const make = BACKENDS[backend];
  if (!make) {
    const known = Object.keys(BACKENDS).join(', ');
    throw new Error(`createGenerationProvider: unknown backend "${backend}" (known backends: ${known})`);
  }
  return make();
}
