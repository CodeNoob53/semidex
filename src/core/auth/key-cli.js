// Shared `key add|list|revoke` CLI implementation, used by BOTH the Semidex
// Lite entry point (packages/lite/bin/semidex-lite.js) and full Semidex
// (src/key.js). One implementation, so the two editions cannot drift into
// different validation or different output.
//
// Deliberately not wired into the browser dashboard: key material must never
// reach static JS, localStorage, or the Settings API.
import { createKeyStore, SUPPORTED_OPERATIONS, KeyStoreError } from './key-store.js';
import {
  DEFAULT_REQUESTS_PER_MINUTE, DEFAULT_BURST,
  MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE, MIN_BURST, MAX_BURST,
  isValidLimitValue,
} from './rate-limiter.js';
import {
  DEFAULT_TOKEN_BUDGET_PER_HOUR, DEFAULT_TOKEN_BUDGET_BURST_TOKENS,
  MIN_TOKEN_BUDGET_PER_HOUR, MAX_TOKEN_BUDGET_PER_HOUR, MIN_TOKEN_BUDGET_BURST_TOKENS, MAX_TOKEN_BUDGET_BURST_TOKENS,
  isValidTokenBudgetValue,
} from './token-budget.js';
import { createNoopAuditSink, recordAuditEvent } from '../audit/sink.js';
import { AUDIT_EVENT_TYPE } from '../audit/event.js';

const USAGE = `Usage:
  <cli> key add --name <name> --collection <name> [--collection <name>...]
                [--operation generate] [--expires <ISO-8601 date | duration>]
                [--requests-per-minute <n>] [--burst <n>]
                [--token-budget-per-hour <n>] [--token-budget-burst <n>]
  <cli> key list
  <cli> key revoke <id>

Options:
  --name                 Human-readable label for the key (required).
  --collection           Collection this key may access. Repeatable. Required.
                          Use --collection "*" to grant ALL collections explicitly.
  --operation             Operation scope. Repeatable. Defaults to "generate".
                          Supported: ${SUPPORTED_OPERATIONS.join(', ')}.
  --expires               Expiry as an ISO-8601 date (2027-01-01), an ISO instant, or a
                          duration such as 30d, 12h, 90m. Omit for no expiry.
  --requests-per-minute   Sustained rate limit for this key, an integer in
                          [${MIN_REQUESTS_PER_MINUTE}, ${MAX_REQUESTS_PER_MINUTE}]. Omit for the default
                          (${DEFAULT_REQUESTS_PER_MINUTE}/min).
  --burst                 Burst allowance (token bucket capacity) for this key,
                          an integer in [${MIN_BURST}, ${MAX_BURST}]. Omit for the default (${DEFAULT_BURST}).
  --token-budget-per-hour Sustained Ask spend/token ceiling for this key
                          (estimated+reserved tokens across all Ask v1/v2
                          generation calls), an integer in
                          [${MIN_TOKEN_BUDGET_PER_HOUR}, ${MAX_TOKEN_BUDGET_PER_HOUR}]. Omit for the
                          default (${DEFAULT_TOKEN_BUDGET_PER_HOUR}/hour). Process-local, resets on
                          restart — see the token budget design doc.
  --token-budget-burst    Burst allowance (token bucket capacity) for the
                          spend/token ceiling above, an integer in
                          [${MIN_TOKEN_BUDGET_BURST_TOKENS}, ${MAX_TOKEN_BUDGET_BURST_TOKENS}]. Omit for the default
                          (${DEFAULT_TOKEN_BUDGET_BURST_TOKENS}).`;

/**
 * Parses a `--requests-per-minute`/`--burst` flag value into an integer
 * within [min, max], or null when the flag was not supplied. Throws
 * KeyStoreError for anything present but invalid — same error type
 * createKey() itself throws, so the CLI's catch-all handles both uniformly.
 * @param {string|undefined} raw
 * @param {string} flagName
 * @param {number} min
 * @param {number} max
 */
export function parseLimitFlag(raw, flagName, min, max) {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!isValidLimitValue(n, min, max)) {
    throw new KeyStoreError('invalid_argument',
      `--${flagName} "${raw}" must be an integer in [${min}, ${max}].`);
  }
  return n;
}

/**
 * Parses a duration like "30d" / "12h" / "90m" / "45s" into milliseconds, or
 * null when the input is not a duration (the caller then tries a date).
 */
export function parseDuration(input) {
  const m = /^(\d+)([smhd])$/.exec(String(input).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n * unit;
}

/**
 * Resolves --expires into an ISO string or null. Accepts a duration relative
 * to `now`, or an absolute date. Rejects anything unparseable, and any date
 * already in the past (a key that is born expired is far more likely a typo
 * than an intention).
 */
export function resolveExpiry(raw, now = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return null;
  const durationMs = parseDuration(raw);
  if (durationMs !== null) return new Date(now + durationMs).toISOString();

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new KeyStoreError('invalid_argument',
      `--expires "${raw}" is not a valid ISO-8601 date or duration (examples: 2027-01-01, 2027-01-01T00:00:00Z, 30d, 12h).`);
  }
  if (parsed <= now) {
    throw new KeyStoreError('invalid_argument', `--expires "${raw}" is in the past.`);
  }
  return new Date(parsed).toISOString();
}

/** Minimal repeated-flag argv parser. Returns { _: positional[], flags }. */
export function parseArgs(argv) {
  const positional = [];
  const flags = { collection: [], operation: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new KeyStoreError('invalid_argument', `--${name} requires a value.`);
    }
    i++;
    if (name === 'collection' || name === 'operation') flags[name].push(value);
    else flags[name] = value;
  }
  return { _: positional, flags };
}

function formatRow(key) {
  const status = key.revokedAt ? 'revoked'
    : (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) ? 'expired'
      : 'active';
  return [
    key.id.padEnd(18),
    status.padEnd(8),
    key.name.padEnd(24),
    key.collections.join(',').padEnd(28),
    key.operations.join(',').padEnd(12),
    // Effective limits (toPublicKey() already resolves a legacy/unset key
    // to the default) — never the raw stored null, so "what does this key
    // actually do" never requires cross-referencing the default separately.
    `${key.requestsPerMinute}/min burst ${key.burst}`.padEnd(22),
    `${key.tokenBudgetPerHour} tok/hr burst ${key.tokenBudgetBurst}`,
  ].join(' ');
}

/**
 * Runs a `key ...` subcommand.
 *
 * @param {string[]} argv arguments AFTER the "key" token
 * @param {{ keyStorePath: string, cliName?: string, out?: Function, err?: Function, now?: () => number, keyStore?: Object, auditSink?: import('../audit/sink.js').AuditSink }} ctx
 *   auditSink defaults to a no-op — this module never constructs a REAL
 *   sink itself (that would mean every test calling runKeyCommand() without
 *   overriding it starts writing real files under SEMIDEX_HOME/cwd as a
 *   side effect). The two real CLI entry points (src/key.js,
 *   packages/lite/bin/semidex-lite.js) each construct a real one via
 *   resolveAuditSink({ sync: true }) and pass it in explicitly, matching
 *   how they already resolve `keyStorePath` themselves rather than letting
 *   this module guess it.
 * @returns {number} process exit code
 */
export function runKeyCommand(argv, {
  keyStorePath,
  cliName = 'semidex-lite',
  out = console.log,
  err = console.error,
  now = () => Date.now(),
  keyStore,
  auditSink = createNoopAuditSink(),
} = {}) {
  const store = keyStore ?? createKeyStore({ path: keyStorePath, now });
  const [subcommand, ...rest] = argv;

  try {
    switch (subcommand) {
      case 'add': {
        const { flags } = parseArgs(rest);
        const expiresAt = resolveExpiry(flags.expires, now());
        const operations = flags.operation.length > 0 ? flags.operation : ['generate'];
        const requestsPerMinute = parseLimitFlag(flags['requests-per-minute'], 'requests-per-minute', MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE);
        const burst = parseLimitFlag(flags.burst, 'burst', MIN_BURST, MAX_BURST);
        const tokenBudgetPerHour = parseLimitFlag(flags['token-budget-per-hour'], 'token-budget-per-hour', MIN_TOKEN_BUDGET_PER_HOUR, MAX_TOKEN_BUDGET_PER_HOUR);
        const tokenBudgetBurst = parseLimitFlag(flags['token-budget-burst'], 'token-budget-burst', MIN_TOKEN_BUDGET_BURST_TOKENS, MAX_TOKEN_BUDGET_BURST_TOKENS);
        const { key, token } = store.createKey({
          name: flags.name,
          collections: flags.collection,
          operations,
          expiresAt,
          requestsPerMinute,
          burst,
          tokenBudgetPerHour,
          tokenBudgetBurst,
        });
        // keyId + the operator-assigned name only — never the token or its
        // digest (docs/security/audit-logging-design-2026-08.md §3).
        recordAuditEvent(auditSink, AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, {
          outcome: 'created', keyId: key.id, keyName: key.name,
        });

        out('');
        out(`  Key created: ${key.id}  (${key.name})`);
        out(`  Collections: ${key.collections.join(', ')}`);
        out(`  Operations:  ${key.operations.join(', ')}`);
        out(`  Expires:     ${key.expiresAt ?? 'never'}`);
        out(`  Rate limit:  ${key.requestsPerMinute}/min, burst ${key.burst}`);
        out(`  Token budget: ${key.tokenBudgetPerHour}/hour, burst ${key.tokenBudgetBurst} (estimated Ask spend/token ceiling; process-local, resets on restart)`);
        out('');
        out('  ┌─────────────────────────────────────────────────────────────┐');
        out('  │  COPY THIS TOKEN NOW — IT IS NOT STORED AND CANNOT BE       │');
        out('  │  SHOWN AGAIN. Only a SHA-256 digest is kept on disk.        │');
        out('  └─────────────────────────────────────────────────────────────┘');
        out('');
        out(`  ${token}`);
        out('');
        out('  Send it as:  Authorization: Bearer <token>');
        out('  Store it in your backend\'s secret manager — never in browser');
        out('  JavaScript, localStorage, a query string, or version control.');
        out('');
        return 0;
      }

      case 'list': {
        const keys = store.listKeys();
        if (keys.length === 0) {
          out('No Integration API keys configured.');
          out(`Create one with: ${cliName} key add --name <name> --collection <collection>`);
          return 0;
        }
        // Never prints a digest or a token — only public metadata.
        out(['ID'.padEnd(18), 'STATUS'.padEnd(8), 'NAME'.padEnd(24), 'COLLECTIONS'.padEnd(28), 'OPERATIONS'.padEnd(12), 'RATE LIMIT'.padEnd(22), 'TOKEN BUDGET'].join(' '));
        for (const key of keys) out(formatRow(key));
        return 0;
      }

      case 'revoke': {
        const id = rest[0];
        if (!id || id.startsWith('--')) {
          err(`Usage: ${cliName} key revoke <id>`);
          return 1;
        }
        const result = store.revokeKey(id);
        if (result.status === 'not_found') {
          err(`No key with id "${id}".`);
          return 1;
        }
        // Both 'revoked' and 'already_revoked' are genuine outcomes worth an
        // audit trail (an operator re-running `key revoke` on an already-
        // revoked key is still a real event to record); 'not_found' above
        // revoked nothing and is intentionally not logged.
        recordAuditEvent(auditSink, AUDIT_EVENT_TYPE.ADMIN_KEY_REVOKED, {
          outcome: 'revoked', keyId: result.key.id, keyName: result.key.name, status: result.status,
        });
        if (result.status === 'already_revoked') {
          out(`Key ${id} was already revoked at ${result.key.revokedAt}.`);
          return 0;
        }
        out(`Key ${id} (${result.key.name}) revoked at ${result.key.revokedAt}.`);
        out('It stops working immediately — no restart required.');
        return 0;
      }

      case undefined:
      case '--help':
      case '-h':
      case 'help':
        out(USAGE.replaceAll('<cli>', cliName));
        return subcommand === undefined ? 1 : 0;

      default:
        err(`Unknown key subcommand: ${subcommand}`);
        err(USAGE.replaceAll('<cli>', cliName));
        return 1;
    }
  } catch (error) {
    // KeyStoreError messages are authored here and safe. Anything else is
    // reported without its stack so a filesystem path or similar cannot leak
    // into a shared terminal transcript.
    if (error instanceof KeyStoreError) {
      err(`Error: ${error.message}`);
      return 1;
    }
    err(`Error: ${error?.message ?? 'unknown failure'}`);
    return 1;
  }
}
