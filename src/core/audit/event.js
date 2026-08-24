// Structured security-audit event taxonomy and schema. Zero dependencies
// beyond node:crypto (for the one-way path identifier) — no HTTP, no
// storage, no settings-registry import. See
// docs/security/audit-logging-design-2026-08.md for the full design
// record; this module is the schema half of it.
//
// THE CONTRACT
// ------------
// An audit event is NEVER built from an arbitrary request object, request
// body, caught exception, provider response, or settings snapshot. Every
// call site passes a fixed set of NAMED, TYPED fields; buildAuditEvent()
// validates them against a per-type allow-list and throws on anything
// unknown, missing, or wrong-shaped. This is stricter than (and unrelated
// to) the existing sanitiseErrorMessage()-style redaction used for job
// logs and error responses elsewhere in this codebase — those take an
// arbitrary string and try to strip secrets out of it after the fact;
// this module never accepts an arbitrary string in the first place.
//
// validateAuditEvent() is the second, NON-THROWING check the sink itself
// runs on whatever it is handed (see sink.js) — the two exist for
// different audiences: buildAuditEvent() is the construction-time
// contract every call site is written against (throws early, so a
// mistake surfaces in a unit test); validateAuditEvent() is the
// logging-boundary fail-closed check (never throws, so a malformed event
// — however it arose — is silently dropped rather than crashing the
// request path or being written half-validated).
import { createHash, randomUUID } from 'node:crypto';

export const AUDIT_SCHEMA_VERSION = 1;

/** Stable, typed event names. One per row in the task's required-coverage table. */
export const AUDIT_EVENT_TYPE = Object.freeze({
  REQUEST_HOST_REJECTED: 'request.host_rejected',
  REQUEST_ORIGIN_REJECTED: 'request.origin_rejected',
  AUTH_INTEGRATION_ACCEPTED: 'auth.integration_accepted',
  AUTH_INTEGRATION_DENIED: 'auth.integration_denied',
  AUTH_RATE_LIMITED: 'auth.rate_limited',
  AUTHZ_COLLECTION_DENIED: 'authz.collection_denied',
  BUDGET_RESERVATION_DENIED: 'budget.reservation_denied',
  INDEX_ROOT_DENIED: 'index.root_denied',
  INDEX_JOB_STARTED: 'index.job_started',
  INDEX_JOB_CANCEL_REQUESTED: 'index.job_cancel_requested',
  INDEX_JOB_CANCELLED: 'index.job_cancelled',
  INDEX_JOB_SUCCEEDED: 'index.job_succeeded',
  INDEX_JOB_FAILED: 'index.job_failed',
  ADMIN_SETTINGS_CHANGED: 'admin.settings_changed',
  ADMIN_COLLECTION_SCHEMA_SYNCED: 'admin.collection_schema_synced',
  ADMIN_COLLECTION_DELETED: 'admin.collection_deleted',
  ADMIN_KEY_CREATED: 'admin.key_created',
  ADMIN_KEY_REVOKED: 'admin.key_revoked',
});

const EVENT_TYPE_VALUES = new Set(Object.values(AUDIT_EVENT_TYPE));

/** Coarse, fixed outcome vocabulary shared across every event type. */
const OUTCOME_VALUES = new Set([
  'accepted', 'denied', 'started', 'requested', 'cancelled',
  'succeeded', 'failed', 'changed', 'synced', 'deleted', 'created', 'revoked',
]);

const EDITION_VALUES = new Set(['full', 'lite']);
const AUDIENCE_VALUES = new Set(['admin', 'integration']);

// ── field-type validators ───────────────────────────────────────────────
// Newline safety (design doc §4 / "newline-safe records"): every
// string-typed field is rejected outright if it contains a literal
// newline, carriage return, or NUL — enforced HERE, generically, rather
// than trusted to each call site, so one JSONL line can never spill across
// two lines regardless of what a future event type's fields happen to
// contain.
const UNSAFE_CHAR_RE = /[\n\r\0]/;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0 && !UNSAFE_CHAR_RE.test(v);
const isNullableNonEmptyString = (v) => v === null || isNonEmptyString(v);
const isBoundedString = (max) => (v) => isNonEmptyString(v) && v.length <= max;
const isNullableBoundedString = (max) => (v) => v === null || isBoundedString(max)(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNullableFiniteNumber = (v) => v === null || isFiniteNumber(v);
const isEnum = (values) => (v) => typeof v === 'string' && values.has(v);
const isNullableEnum = (values) => (v) => v === null || isEnum(values)(v);
// Every setting key in core/settings/definitions.js is UPPER_SNAKE_CASE by
// convention (MAX_CHUNK_TOKENS, QDRANT_URL, ADMIN_ALLOW_REMOTE, ...) — this
// module deliberately does not import that registry (zero dependencies, see
// header), so it enforces the NAMING SHAPE generically. The actual
// allow-list enforcement (a key must be a REAL, known setting) happens at
// the call site: settingsService.setMany() already throws unknown_key for
// anything not in DEFINITIONS, so by construction only real setting keys
// ever reach admin.settings_changed's fields array.
const SETTINGS_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const isSettingsFieldsArray = (v) => Array.isArray(v) && v.length > 0 && v.every(
  (f) => f && typeof f === 'object' && !Array.isArray(f)
    && typeof f.key === 'string' && SETTINGS_KEY_RE.test(f.key)
    && (f.action === 'set' || f.action === 'delete')
    && Object.keys(f).length === 2,
);

/** One-way, bounded identifier for a value that must never be logged in full (a local path). Not a secret-safe construction — see design doc §3. */
export function hashIdentifier(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

/** Envelope fields every event carries. */
const ENVELOPE_SCHEMA = {
  edition: { required: false, validate: isNullableEnum(EDITION_VALUES) },
  requestId: { required: false, validate: isNullableNonEmptyString },
  route: {
    required: false,
    validate: (v) => v === null || (
      v && typeof v === 'object' && !Array.isArray(v)
      && isNonEmptyString(v.method) && isNonEmptyString(v.path)
      && Object.keys(v).length === 2
    ),
  },
  audience: { required: false, validate: isNullableEnum(AUDIENCE_VALUES) },
  operation: { required: false, validate: isNullableBoundedString(64) },
  reason: { required: false, validate: isNullableBoundedString(128) },
};

const KEY_ID_VALIDATE = isNullableBoundedString(32);
const KEY_NAME_VALIDATE = isNullableBoundedString(200);
const COLLECTION_VALIDATE = isBoundedString(512);
const PATH_HASH_VALIDATE = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const JOB_ID_VALIDATE = isNonEmptyString;
const JOB_KIND_VALIDATE = isEnum(new Set(['index', 'reindex']));

// Per-type extra fields, ON TOP of the envelope above. Every field named
// here is the complete allow-list for that event type — buildAuditEvent()
// rejects any field not listed for the type it was called with.
const EVENT_FIELD_SCHEMAS = {
  [AUDIT_EVENT_TYPE.REQUEST_HOST_REJECTED]: {},
  [AUDIT_EVENT_TYPE.REQUEST_ORIGIN_REJECTED]: {},
  [AUDIT_EVENT_TYPE.AUTH_INTEGRATION_ACCEPTED]: {
    keyId: { required: true, validate: KEY_ID_VALIDATE },
    keyName: { required: false, validate: KEY_NAME_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.AUTH_INTEGRATION_DENIED]: {
    keyId: { required: false, validate: KEY_ID_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.AUTH_RATE_LIMITED]: {
    keyId: { required: true, validate: KEY_ID_VALIDATE },
    retryAfterSeconds: { required: true, validate: isFiniteNumber },
  },
  [AUDIT_EVENT_TYPE.AUTHZ_COLLECTION_DENIED]: {
    keyId: { required: false, validate: KEY_ID_VALIDATE },
    collection: { required: true, validate: COLLECTION_VALIDATE },
  },
  // Spend/token budget ceiling (Ask v1/v2) — `reason` (envelope field,
  // above) carries the ledger's own denial code (e.g.
  // 'request_call_ceiling_exceeded', 'key_budget_exceeded',
  // 'key_budget_ceiling_too_small'); `label` identifies WHICH of the up to
  // three generation calls one Ask v2 request may attempt was denied.
  // Deliberately no reservation-success/reconciliation event — mirrors
  // AUTH_RATE_LIMITED's own "only the denial is audited" precedent, not a
  // per-successful-call log line.
  [AUDIT_EVENT_TYPE.BUDGET_RESERVATION_DENIED]: {
    keyId: { required: true, validate: KEY_ID_VALIDATE },
    label: { required: true, validate: isEnum(new Set(['rewrite', 'answer', 'compaction'])) },
    estimatedInputTokens: { required: true, validate: isFiniteNumber },
    maxOutputTokens: { required: true, validate: isFiniteNumber },
    retryAfterSeconds: { required: false, validate: isFiniteNumber },
  },
  [AUDIT_EVENT_TYPE.INDEX_ROOT_DENIED]: {
    pathHash: { required: true, validate: PATH_HASH_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.INDEX_JOB_STARTED]: {
    jobId: { required: true, validate: JOB_ID_VALIDATE },
    collection: { required: true, validate: COLLECTION_VALIDATE },
    pathHash: { required: true, validate: PATH_HASH_VALIDATE },
    kind: { required: true, validate: JOB_KIND_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.INDEX_JOB_CANCEL_REQUESTED]: {
    jobId: { required: true, validate: JOB_ID_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.INDEX_JOB_CANCELLED]: {
    jobId: { required: true, validate: JOB_ID_VALIDATE },
    exitCode: { required: false, validate: isNullableFiniteNumber },
  },
  [AUDIT_EVENT_TYPE.INDEX_JOB_SUCCEEDED]: {
    jobId: { required: true, validate: JOB_ID_VALIDATE },
    exitCode: { required: false, validate: isNullableFiniteNumber },
  },
  [AUDIT_EVENT_TYPE.INDEX_JOB_FAILED]: {
    jobId: { required: true, validate: JOB_ID_VALIDATE },
    exitCode: { required: false, validate: isNullableFiniteNumber },
  },
  [AUDIT_EVENT_TYPE.ADMIN_SETTINGS_CHANGED]: {
    fields: { required: true, validate: isSettingsFieldsArray },
  },
  [AUDIT_EVENT_TYPE.ADMIN_COLLECTION_SCHEMA_SYNCED]: {
    collection: { required: true, validate: COLLECTION_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.ADMIN_COLLECTION_DELETED]: {
    collection: { required: true, validate: COLLECTION_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED]: {
    keyId: { required: true, validate: KEY_ID_VALIDATE },
    keyName: { required: false, validate: KEY_NAME_VALIDATE },
  },
  [AUDIT_EVENT_TYPE.ADMIN_KEY_REVOKED]: {
    keyId: { required: true, validate: KEY_ID_VALIDATE },
    keyName: { required: false, validate: KEY_NAME_VALIDATE },
    status: { required: true, validate: isEnum(new Set(['revoked', 'already_revoked'])) },
  },
};

function schemaFor(type) {
  const extra = EVENT_FIELD_SCHEMAS[type];
  if (!extra) return null;
  return { ...ENVELOPE_SCHEMA, ...extra };
}

/**
 * Validates `fields` against `schema`, throwing (or returning a string
 * reason, per `throwing`) on the first problem found.
 */
function checkFields(schema, fields, fail) {
  for (const [name, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(fields, name);
    if (!present) {
      if (spec.required) return fail(`missing required field "${name}"`);
      continue;
    }
    if (!spec.validate(fields[name])) return fail(`field "${name}" has an invalid value`);
  }
  for (const name of Object.keys(fields)) {
    if (!(name in schema)) return fail(`field "${name}" is not allow-listed for this event type`);
  }
  return null;
}

/**
 * Builds and freezes one audit event. Throws TypeError on any unknown
 * field, missing required field, or wrong-shaped value — the
 * construction-time contract every call site is written against.
 *
 * @param {string} type one of AUDIT_EVENT_TYPE
 * @param {{ outcome: string } & Object} fields envelope + type-specific fields (outcome is always required, ts/schemaVersion/type are never supplied — the builder owns them)
 * @returns {Readonly<Object>}
 */
export function buildAuditEvent(type, fields = {}) {
  if (!EVENT_TYPE_VALUES.has(type)) {
    throw new TypeError(`buildAuditEvent: unknown event type "${type}".`);
  }
  const schema = schemaFor(type);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`buildAuditEvent(${type}): fields must be an object.`);
  }
  const { outcome, ...rest } = fields;
  if (!isEnum(OUTCOME_VALUES)(outcome)) {
    throw new TypeError(`buildAuditEvent(${type}): "outcome" must be one of ${[...OUTCOME_VALUES].join(', ')}.`);
  }
  const problem = checkFields(schema, rest, (msg) => msg);
  if (problem) {
    throw new TypeError(`buildAuditEvent(${type}): ${problem}.`);
  }

  const event = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    type,
    outcome,
    edition: rest.edition ?? null,
    requestId: rest.requestId ?? null,
    route: rest.route ?? null,
    audience: rest.audience ?? null,
    operation: rest.operation ?? null,
    reason: rest.reason ?? null,
  };
  for (const name of Object.keys(schema)) {
    if (name in ENVELOPE_SCHEMA) continue; // already assigned above
    // Only assign when the caller actually supplied it. An optional field
    // the caller omitted entirely must stay genuinely ABSENT from the built
    // event — never present with value `undefined` — because
    // validateAuditEvent() (the sink's own logging-boundary check) uses
    // `hasOwnProperty` to distinguish "absent" (fine for an optional field)
    // from "present but invalid" (rejected, even for `undefined`, per the
    // same JSON-representability reasoning core/http/authorize.js's
    // assertPlainPrincipal() documents). Assigning `rest[name]`
    // unconditionally here used to set `event[name] = undefined` for every
    // omitted optional field, which a REAL sink's record() — which always
    // re-validates via validateAuditEvent() — would then silently drop as
    // malformed. `JSON.stringify` masked this in ad-hoc manual inspection
    // (it drops `undefined` values), which is exactly why this needed a
    // test exercising validateAuditEvent() on a buildAuditEvent() output
    // that omitted an optional field, not just a serialization check.
    if (name in rest) event[name] = rest[name];
  }
  return Object.freeze(event);
}

/**
 * Non-throwing structural check for whatever a sink is handed. Used at the
 * logging boundary (see sink.js) so a malformed event — however it arose —
 * is dropped rather than crashing the caller or being partially written.
 * Intentionally re-validates from scratch rather than trusting
 * Object.isFrozen()/provenance, since a sink must not assume every caller
 * went through buildAuditEvent().
 * @returns {boolean}
 */
export function validateAuditEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.schemaVersion !== AUDIT_SCHEMA_VERSION) return false;
  if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) return false;
  if (!EVENT_TYPE_VALUES.has(event.type)) return false;
  if (!OUTCOME_VALUES.has(event.outcome)) return false;

  const schema = schemaFor(event.type);
  const { schemaVersion, ts, type, outcome, ...rest } = event;
  const known = new Set(Object.keys(schema));
  for (const [name, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(rest, name);
    if (!present) {
      // Envelope optional fields are always assigned (default null) by
      // buildAuditEvent(), so absence here only ever means a required
      // field is missing.
      if (spec.required) return false;
      continue;
    }
    if (!spec.validate(rest[name])) return false;
  }
  for (const name of Object.keys(rest)) {
    if (!known.has(name)) return false;
  }
  return true;
}

/** Exposed for callers that want a correlation id independent of an HTTP request (e.g. a future non-HTTP entry point). Routers generate their own per-request id inline. */
export function generateCorrelationId() {
  return randomUUID();
}
