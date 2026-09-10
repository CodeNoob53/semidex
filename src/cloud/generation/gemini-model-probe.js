// Explicit, user-triggered verification that a Gemini model is actually
// usable RIGHT NOW — not merely present in models.list().
//
// WHY THIS EXISTS (a real, confirmed gap, not a hypothetical)
// ----------------------------------------------------------
// The Gemini API gives NO programmatic signal that a model is deprecated or
// retired. Confirmed against the official documentation on 2026-09-10:
//   - ai.google.dev/api/models — the Model resource has no `deprecated`,
//     `state`, `lifecycleStage`, `retirementDate` or `launchStage` field.
//   - ai.google.dev/gemini-api/docs/models — deprecations are published on
//     the website; no API-based detection is documented.
//   - ai.google.dev/gemini-api/docs/deprecations — lists dates and
//     replacements only; says nothing about API behavior.
//
// And models.list() actively disagrees with reality. Confirmed live against
// the real API: `gemini-2.5-flash` is returned by list() with
// displayName "Gemini 2.5 Flash", description "Stable version of Gemini 2.5
// Flash …", and supportedActions including 'generateContent' — yet calling
// it returns 404 "This model … is no longer available to new users."
//
// So the ONLY reliable signal is an actual call. This module makes exactly
// one minimal (1-output-token) generateContent request and classifies the
// outcome. It is never run automatically: routine Settings rendering stays
// on models.list(), exactly like the Qdrant Cloud Inference probe stays on
// Tier 1 until a user clicks "Test".
//
// CLASSIFICATION IS FAIL-OPEN BY DESIGN
// -------------------------------------
// Only an unambiguous "this model is gone" answer is reported as
// unavailable. A quota error (429) means the KEY is throttled, not that the
// MODEL is dead — reporting that as unavailable would hide a perfectly good
// model. Anything unrecognized is reported as `unknown`, never as a
// failure, so a future error shape cannot silently turn into a wrong
// "unavailable" verdict.
import { sanitiseErrorMessage } from '../../shared/core/doctor-checks.js';

/** Verification outcomes. `unknown` is a real, expected state — not an error. */
export const MODEL_PROBE_STATUS = Object.freeze({
  AVAILABLE: 'available',       // a real generateContent call succeeded
  RETIRED: 'retired',           // the API said this model is gone/not found
  UNSUPPORTED: 'unsupported',   // reachable, but rejects this call shape (a different API surface)
  UNAUTHORIZED: 'unauthorized', // the key is rejected — not a statement about the model
  UNKNOWN: 'unknown',           // quota, network, or anything unrecognized — NOT a verdict
});

/**
 * Extracts an HTTP-ish status code from a @google/genai error. The SDK
 * surfaces the upstream JSON body inside `message`, so the numeric code is
 * read from the structured field when present and from the body text only
 * as a fallback.
 */
function extractStatusCode(err) {
  if (Number.isInteger(err?.status)) return err.status;
  if (Number.isInteger(err?.code)) return err.code;
  const match = /"code"\s*:\s*(\d{3})/.exec(String(err?.message ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Classifies one failed probe call.
 *
 * The 404 branch is deliberately NOT "any 404 means retired": a wrong model
 * NAME also 404s, and both genuinely mean "you cannot use this model", so
 * they share the verdict — but the message the API returns is preserved
 * verbatim (redacted) because for a real retirement it names the
 * replacement model, which is the single most useful thing to show an
 * operator.
 *
 * @param {unknown} err
 * @param {string} apiKey redacted out of any surfaced message
 * @returns {{ status: string, detail: string|null }}
 */
export function classifyModelProbeError(err, apiKey) {
  const code = extractStatusCode(err);
  const raw = sanitiseErrorMessage(String(err?.message ?? ''), [apiKey]);
  const detail = extractApiMessage(raw);

  if (code === 404) return { status: MODEL_PROBE_STATUS.RETIRED, detail };
  if (code === 400) return { status: MODEL_PROBE_STATUS.UNSUPPORTED, detail };
  if (code === 401 || code === 403) return { status: MODEL_PROBE_STATUS.UNAUTHORIZED, detail };
  // 429 (quota) and 5xx (transient) say nothing about the MODEL. Reporting
  // either as unavailable would hide a working model behind a temporary
  // condition — the one failure mode this whole feature exists to avoid.
  return { status: MODEL_PROBE_STATUS.UNKNOWN, detail };
}

/**
 * Pulls the human-readable `"message"` out of the nested JSON error body the
 * SDK embeds in its own message, falling back to the whole string. Keeps the
 * operator-facing text short and specific ("… is no longer available to new
 * users. Please update your code to use models/gemini-3.6-flash …") instead
 * of a wall of escaped JSON.
 */
function extractApiMessage(raw) {
  if (!raw) return null;
  // The body is JSON-escaped inside the outer message, so the inner
  // "message" value appears with escaped quotes. Try the unescaped form
  // first, then the escaped one.
  const direct = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (direct) {
    const decoded = direct[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    // The outer wrapper's own "message" is the escaped body itself; if what
    // we extracted still looks like JSON, dig one level further.
    const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(decoded);
    if (inner) return inner[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
    return decoded;
  }
  return raw.slice(0, 400);
}

/**
 * Probes ONE model with a minimal real generateContent call.
 *
 * @param {{
 *   apiKey?: string,
 *   model: string,
 *   createClientFn?: (opts: { apiKey: string }) => Object,
 * }} opts createClientFn is DI-only (tests stub the SDK; production callers
 *   never pass it).
 * @returns {Promise<{ model: string, status: string, detail: string|null }>}
 */
export async function probeGeminiModel({ apiKey = '', model, createClientFn } = {}) {
  if (!model) {
    return { model: '', status: MODEL_PROBE_STATUS.UNKNOWN, detail: 'No model was specified.' };
  }
  if (!apiKey) {
    return {
      model,
      status: MODEL_PROBE_STATUS.UNAUTHORIZED,
      detail: 'GEMINI_API_KEY is not set, so this model cannot be verified.',
    };
  }

  let client;
  try {
    if (createClientFn) {
      client = createClientFn({ apiKey });
    } else {
      const { GoogleGenAI } = await import('@google/genai');
      client = new GoogleGenAI({ apiKey });
    }
  } catch (err) {
    return {
      model,
      status: MODEL_PROBE_STATUS.UNKNOWN,
      detail: sanitiseErrorMessage(`Failed to initialize the Gemini client: ${err?.message ?? ''}`, [apiKey]),
    };
  }

  try {
    // The smallest call that still exercises the real model route:
    // one trivial prompt, a 1-token output ceiling. This is a billed
    // request, which is exactly why it only ever runs on an explicit click.
    await client.models.generateContent({
      model,
      contents: 'ping',
      config: { maxOutputTokens: 1 },
    });
    return { model, status: MODEL_PROBE_STATUS.AVAILABLE, detail: null };
  } catch (err) {
    const { status, detail } = classifyModelProbeError(err, apiKey);
    return { model, status, detail };
  }
}
