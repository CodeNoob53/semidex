#!/usr/bin/env node
// semidex-lite CLI — thin argument router. Sets SEMIDEX_HOME + the cloud
// hard pins in process.env FIRST, before bootstrapEnv() or any other
// runtime import, so a stray local env var can never re-enable a
// local-only code path (see hard-pins.js's own header comment). No
// subcommand exposes local-runtime flags — the settings/jobs APIs reject
// any attempt to configure a local provider at the HTTP layer, and the CLI
// itself never accepts one on the command line either.
import { mkdirSync } from 'node:fs';
import { applyLiteHardPins } from '../lite-src/hard-pins.js';
import { applySemidexHomeEnv } from '../lite-src/semidex-home.js';

const paths = applySemidexHomeEnv();
applyLiteHardPins();
mkdirSync(paths.semidexHome, { recursive: true });
mkdirSync(paths.tokenizerCacheDir, { recursive: true });

const [, , command, ...rest] = process.argv;

function printHelp() {
  console.log(`semidex-lite — cloud-only Semidex CLI (Qdrant Cloud + Gemini)

Usage:
  semidex-lite doctor [--probe-inference]   Read-only environment health check
  semidex-lite serve                        Start the Lite admin API + dashboard
  semidex-lite index <path>                 Index a file or folder into Qdrant Cloud
  semidex-lite key add --name <n> --collection <c>
                                            Create an Integration API key (search, generate, or both)
  semidex-lite key list                     List Integration API keys
  semidex-lite key revoke <id>              Revoke an Integration API key
  semidex-lite --help                       Show this help

Environment:
  SEMIDEX_HOME   Application data directory (config, settings, tokenizer cache).
                 Default: ${paths.semidexHome}
  QDRANT_URL, QDRANT_KEY           Qdrant Cloud connection.
  GEMINI_API_KEY                   Gemini API key for Ask/generation.
  COLLECTION                       Target collection name (index command).

Semidex Lite is cloud-only: it never downloads or initializes a local ONNX
or Ollama runtime. See the README for the full list of unsupported
full-Semidex features.`);
}

switch (command) {
  case undefined:
  case '--help':
  case '-h':
  case 'help': {
    printHelp();
    process.exitCode = 0;
    break;
  }
  case 'doctor': {
    const { runDoctor } = await import('../lite-src/doctor-lite.js');
    const probeInference = rest.includes('--probe-inference');
    process.exitCode = await runDoctor({ probeInference, semidexHome: paths.semidexHome });
    break;
  }
  case 'serve': {
    const { startLite } = await import('../lite-src/serve-lite.js');
    const { server, host, port, auditSink } = await startLite({ settingsPath: paths.settingsPath });
    server.listen(port, host, () => {
      console.log(`[semidex-lite] listening on http://${host}:${port}`);
      console.log(`[semidex-lite] SEMIDEX_HOME: ${paths.semidexHome}`);
    });
    // Idempotent: SIGTERM and SIGINT (or a supervisor/docker stop sending
    // both) must not race a double server.close()/double process.exit().
    // auditSink.close() waits for every queued event (a request denial, a
    // job-lifecycle event) to become durable BEFORE the process exits — the
    // fix for a real gap where shutdown never waited for the async queue to
    // drain at all, so a final event could still be lost on exit.
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => {
        auditSink.close().finally(() => process.exit(0));
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    break;
  }
  case 'index': {
    const target = rest.find((arg) => !arg.startsWith('-'));
    if (!target) {
      console.error('Usage: semidex-lite index <file|folder>');
      process.exitCode = 1;
      break;
    }
    const { runIndex } = await import('../lite-src/index-lite.js');
    process.exitCode = await runIndex(target, { semidexHome: paths.semidexHome, settingsPath: paths.settingsPath });
    break;
  }
  case 'key': {
    const { runKeyCommand } = await import('../src/core/auth/key-cli.js');
    const { resolveAuditSink } = await import('../src/core/audit/resolve-sink.js');
    // sync: a one-shot CLI process — see resolve-sink.js/jsonl-sink.js for
    // why the CLI uses the synchronous sink variant. No `dir` override
    // needed here (unlike src/key.js): applySemidexHomeEnv() above already
    // set process.env.SEMIDEX_HOME to paths.semidexHome before this switch
    // ran, so resolveAuditSink()'s own default resolution already agrees
    // with paths.keyStorePath's directory.
    process.exitCode = runKeyCommand(rest, {
      keyStorePath: paths.keyStorePath,
      cliName: 'semidex-lite',
      auditSink: resolveAuditSink({ sync: true, edition: 'lite' }),
    });
    break;
  }
  default: {
    console.error(`Unknown command: "${command}"\n`);
    printHelp();
    process.exitCode = 1;
  }
}
