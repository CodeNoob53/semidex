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
//
// Code review fix (Phase 8B Step 6): this file used to statically import
// src/cloud/generation/gemini-provider.js and register it unconditionally
// in BACKENDS — a real `shared -> cloud IMPLEMENTATION` edge, exactly what
// the cloud-boundary task forbids (a physical file move alone does not
// create an architectural boundary if every shared consumer still reaches
// through it directly). Only `ollama` (a `local`-classified but
// zero-heavy-dependency REST client — no ONNX/Transformers.js concern of
// its own) is registered by default now; a cloud (or any future) backend
// is supplied via the optional `providers` override, populated by a
// composition root — never by this shared registry file itself. See
// core/generation/cloud-generation-capability.js for the narrow contract
// a `providers.gemini` entry must satisfy, and
// src/cloud/generation/gemini-provider-registration.js for the one real
// factory a composition root imports to obtain it.
import { createOllamaProvider } from './ollama-provider.js';

const DEFAULT_BACKENDS = { ollama: createOllamaProvider };

/**
 * @param {{ backend?: string, options?: Object, providers?: Record<string, (options: Object) => import('./provider.js').GenerationProvider> }} [opts]
 *   `backend` selects the factory (default 'ollama'); `options` is passed
 *   through verbatim to that factory (e.g. { model, baseUrl, numCtx } for
 *   ollama) — this function does not know or validate the shape of
 *   provider-specific options, only which factory to call. `providers` is
 *   an optional map merged ON TOP of the built-in `{ ollama }` default —
 *   this is the ONLY way a non-ollama backend (e.g. 'gemini') becomes
 *   available; a composition root supplies it explicitly (see
 *   generation/runtime.js's own `createGenerationProviderFn` DI seam,
 *   which is where a real caller actually threads this through).
 * @returns {import('./provider.js').GenerationProvider}
 * @throws {Error} for an unknown backend name
 */
export function createGenerationProvider({ backend = 'ollama', options = {}, providers = {} } = {}) {
  const backends = { ...DEFAULT_BACKENDS, ...providers };
  const make = backends[backend];
  if (!make) {
    const known = Object.keys(backends).join(', ');
    throw new Error(`createGenerationProvider: unknown backend "${backend}" (known backends: ${known})`);
  }
  return make(options);
}
