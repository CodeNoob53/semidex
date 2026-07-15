// GET /api/generation/status — public, backend-neutral generation
// readiness/config status (Phase 4A.5a). This is the ONE place Ask and any
// future Settings UI both read from — the route delegates entirely to the
// same generationRuntime instance createApp() shares with the Ask
// coordinator, so this endpoint and POST /api/ask can never observe
// different readiness for the same server process.
//
// Not a Qdrant health check (that's GET /api/health) and not a replacement
// for GET /api/system/ollama-status (which stays scoped to its existing
// indexing-summary role — Ask/Settings should never read that route for
// generation status).
import { sendJson } from '../http.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

// Same redaction helper used by api/ask.js — a readiness "reason" string
// can embed a raw configured baseUrl (e.g. "Ollama is not reachable at
// http://host:port") or other request/response text from the provider, and
// this route is not behind the router's uncaught-exception catch-all (it
// never throws), so it must redact explicitly before responding.
function safeMessage(message) {
  return message == null ? null : sanitiseErrorMessage(message, process.env.QDRANT_KEY);
}

/**
 * @param {Object} router
 * @param {{ generationRuntime: ReturnType<typeof import('../../core/generation/runtime.js').createGenerationRuntime> }} deps
 */
export function registerGenerationRoutes(router, { generationRuntime }) {
  router.get('/api/generation/status', async ({ res }) => {
    const status = await generationRuntime.getStatus();
    // Always 200 — an unavailable provider or invalid configuration is
    // reported as ready:false in the body, never an HTTP error status.
    // (POST /api/ask is the endpoint that returns a pre-stream 503 for the
    // same underlying condition — this status endpoint's job is only to
    // report state, not to gate an action.)
    sendJson(res, 200, { ...status, reason: safeMessage(status.reason) });
  });
}
