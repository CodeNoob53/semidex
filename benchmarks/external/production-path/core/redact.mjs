// Secret/path redaction for the production-path benchmark harness.
// Mirrors benchmarks/spikes/qdrant-cloud-inference-accept.mjs's own
// redact() pattern: wrap sanitiseErrorMessage() (production code) for
// secrets/credentialed URLs, plus a narrow regex for this harness's own
// local path shapes (materialized fixture dirs, isolated config.json
// copies, telemetry JSONL files) — never a general path scrubber.
import { sanitiseErrorMessage } from '../../../../src/shared/core/doctor-checks.js';

// Matches this harness's own .cache/{materialized,config,telemetry}/
// path segments wherever they appear (e.g. embedded in a spawned
// indexer subprocess's stdout/stderr captured into an Error message).
const HARNESS_CACHE_PATH_RE = /[^\s"']*production-path[\\/]\.cache[\\/][^\s"']*/g;

export function redact(value, secret = process.env.QDRANT_KEY) {
  const text = value instanceof Error ? (value.stack || value.message || String(value)) : String(value ?? '');
  return sanitiseErrorMessage(text, secret).replace(HARNESS_CACHE_PATH_RE, '<production-path-cache>');
}
