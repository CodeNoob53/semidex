// GET /api/settings, PATCH /api/settings — read-only typed settings
// inventory + category-batch write path (Global Settings phase). Delegates
// entirely to the shared SettingsService instance createApp() constructs
// (or receives via DI) — this route never touches settings.json or
// process.env directly, and never derives writable/secret/override
// behavior itself; SettingsService is the single source of truth.
import { sendJson, readJsonBody, HttpError } from '../../../core/http/http.js';
import { CATEGORIES } from '../../../core/settings/definitions.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../../core/http/route-audience.js';
import { evaluateDirectLoopbackConnection } from '../../../core/security/direct-loopback-request.js';

// Destination-changing settings require a direct loopback request. Every
// other setting keeps today's behavior unchanged; this is a narrow,
// field-specific boundary, not a general Admin authentication mechanism.
const SENSITIVE_DESTINATION_KEYS = new Set(['QDRANT_URL', 'OLLAMA_URL']);

const ERROR_CODE_STATUS = {
  unknown_key: 400,
  not_writable: 400,
  invalid_value: 400,
  setting_overridden: 409,
  // Thrown by the Lite settings wrapper (service.lite.js) for a key that
  // exists in full Semidex but is outside Lite's allow-list — distinct
  // from unknown_key (a key that was never a real setting at all).
  not_available_in_lite: 400,
};

/**
 * @param {Object} router
 * @param {{ settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService> }} deps
 */
export function registerSettingsRoutes(router, { settingsService }) {
  router.get('/api/settings', async ({ res }) => {
    sendJson(res, 200, { categories: CATEGORIES, settings: settingsService.getAll() });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, resourceType: 'settings', costClass: COST_CLASS.LOW });

  router.patch('/api/settings', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const changes = body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
      throw new HttpError(400, 'bad_request', 'Request body must be { changes: { key: value|null, ... } } with at least one key.');
    }

    // Checked BEFORE settingsService.setMany() and regardless of whether
    // the change is a real value or a null deletion — both change what the
    // NEXT restart's Qdrant/Ollama traffic targets. Deliberately keyed only
    // by presence in `changes`, never by whether the new value differs from
    // the current one, so this cannot be bypassed by round-tripping through
    // an intermediate no-op value.
    const touchesSensitiveDestination = Object.keys(changes).some((key) => SENSITIVE_DESTINATION_KEYS.has(key));
    if (touchesSensitiveDestination) {
      const verdict = evaluateDirectLoopbackConnection(req);
      if (!verdict.ok) {
        throw new HttpError(
          403,
          'loopback_required',
          'QDRANT_URL and OLLAMA_URL can only be changed over a direct loopback connection to this process with no proxy-forwarding signals present — not from a remote caller, regardless of ADMIN_ALLOW_REMOTE. A headerless L4/stream-mode proxy relaying a remote caller cannot be distinguished from this and is not protected against; do not front this endpoint with one.'
        );
      }
    }

    try {
      const updated = await settingsService.setMany(changes);
      sendJson(res, 200, { settings: updated });
    } catch (err) {
      const status = ERROR_CODE_STATUS[err.code];
      if (!status) throw err; // unexpected — let the router's catch-all redact/500 it

      // badRequest()/conflict() hardcode their own `code` field
      // ('bad_request'/'conflict'), which would lose the specific
      // machine-readable code (setting_overridden/unknown_key/not_writable/
      // invalid_value) the UI needs to distinguish these cases — construct
      // the HttpError directly instead of going through those generic
      // helpers for this route.
      throw new HttpError(status, err.code, err.message);
    }
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.MUTATE, resourceType: 'settings', costClass: COST_CLASS.LOW });
}
