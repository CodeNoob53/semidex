// npm run key -- <add|list|revoke> — Integration API key management for full
// Semidex. Thin entry point: all behavior lives in the shared
// src/core/auth/key-cli.js, which Semidex Lite's own `semidex-lite key`
// command uses too, so the two editions cannot drift into different
// validation, different output, or different security properties.
//
// Manages credentials for the INTEGRATION API only (POST /api/v1/ask,
// POST /api/v2/ask). The Admin API/dashboard stays loopback-bound and
// credential-free — see docs/security/integration-api-auth-design-note.md.
import { resolveSemidexHomePaths } from './local/core/semidex-home.js';
import { runKeyCommand } from './core/auth/key-cli.js';

const { keyStorePath } = resolveSemidexHomePaths();

// process.argv: [node, key.js, <subcommand>, ...rest]
process.exitCode = runKeyCommand(process.argv.slice(2), {
  keyStorePath,
  cliName: 'npm run key --',
});
