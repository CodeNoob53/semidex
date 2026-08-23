// npm run key -- <add|list|revoke> — Integration API key management for full
// Semidex. Thin entry point: all behavior lives in the shared
// src/core/auth/key-cli.js, which Semidex Lite's own `semidex-lite key`
// command uses too, so the two editions cannot drift into different
// validation, different output, or different security properties.
//
// Manages credentials for the INTEGRATION API only (POST /api/v1/ask,
// POST /api/v2/ask). The Admin API/dashboard stays loopback-bound and
// credential-free — see docs/security/integration-api-auth-design-note.md.
import { join } from 'node:path';
import { resolveSemidexHomePaths } from './local/core/semidex-home.js';
import { runKeyCommand } from './core/auth/key-cli.js';
import { resolveAuditSink } from './core/audit/resolve-sink.js';

const { keyStorePath, semidexHome } = resolveSemidexHomePaths();

// sync: this is a one-shot CLI process, not the long-running admin server —
// see resolve-sink.js/jsonl-sink.js for why the CLI uses the synchronous
// sink variant (a durable write before the process exits, no drain to
// remember to await). `dir` is derived from THIS call's own resolved
// `semidexHome` (not resolveAuditSink()'s own independent env lookup),
// so the audit log always lands beside integration-keys.json even when
// SEMIDEX_HOME itself is unset in the environment and both resolvers fall
// back to their own per-OS default — resolveSemidexHomePaths() already
// computed that default once, above; a second, independent resolution
// inside resolveAuditSink() could silently disagree with it.
process.exitCode = runKeyCommand(process.argv.slice(2), {
  keyStorePath,
  cliName: 'npm run key --',
  auditSink: resolveAuditSink({ sync: true, edition: 'full', dir: join(semidexHome, 'audit') }),
});
