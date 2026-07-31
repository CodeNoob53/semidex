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
    const { server, host, port } = await startLite({ settingsPath: paths.settingsPath });
    server.listen(port, host, () => {
      console.log(`[semidex-lite] listening on http://${host}:${port}`);
      console.log(`[semidex-lite] SEMIDEX_HOME: ${paths.semidexHome}`);
    });
    const shutdown = () => server.close(() => process.exit(0));
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
  default: {
    console.error(`Unknown command: "${command}"\n`);
    printHelp();
    process.exitCode = 1;
  }
}
