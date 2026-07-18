// Generation provider registry: resolves which GenerationProvider
// implementation to construct, keyed by backend name. Mirrors
// storage/factory.js's single-choke-point pattern so future cloud providers
// (Phase 4A.5) plug in here without reworking callers (the Ask coordinator,
// createApp()'s DI wiring).
//
// Cloud-neutral by construction: no process.env reads anywhere in this
// file. The backend name and every provider-specific option (model,
// baseUrl, numCtx, ...) are passed in explicitly by the caller (the
// generation runtime service, generation/runtime.js) — which is the one
// place resolved configuration is allowed to originate from. This keeps a
// future cloud provider's registration free of assumptions about which env
// vars exist or what they're named.
import { createOllamaProvider } from './ollama-provider.js';
import { createGeminiProvider } from './gemini-provider.js';

const BACKENDS = {
  ollama: createOllamaProvider,
  gemini: createGeminiProvider,
};

/**
 * @param {{ backend?: string, options?: Object }} [opts] `backend` selects
 *   the factory (default 'ollama'); `options` is passed through verbatim to
 *   that factory (e.g. { model, baseUrl, numCtx } for ollama) — this
 *   function does not know or validate the shape of provider-specific
 *   options, only which factory to call.
 * @returns {import('./provider.js').GenerationProvider}
 * @throws {Error} for an unknown backend name
 */
export function createGenerationProvider({ backend = 'ollama', options = {} } = {}) {
  const make = BACKENDS[backend];
  if (!make) {
    const known = Object.keys(BACKENDS).join(', ');
    throw new Error(`createGenerationProvider: unknown backend "${backend}" (known backends: ${known})`);
  }
  return make(options);
}
