// Thin CLI entry point (Global Settings phase) — the ONLY job of this file
// is to bootstrap env correctly BEFORE any dotenv-tainted module loads,
// then hand off to run.js. This split exists because run.js (and its many
// transitive imports — core/config.js, core/qdrant.js, core/embeddings.js,
// context.js/tag.js via core/ollama.js, skeleton-summary.js) do
// `import 'dotenv/config'`, and static imports hoist above all other code
// in a module — so bootstrapEnv() can only run before those imports if it
// lives in a DIFFERENT module that is evaluated first. This file is that
// module: it has no dotenv-tainted static imports of its own, calls
// bootstrapEnv() as its first real statement, constructs the one
// SettingsService this process uses, applies every setting run.js and its
// phase dependencies consume, and only THEN dynamically imports run.js
// (guaranteeing run.js's own module graph — and its `dotenv/config`
// imports — evaluates after the OS-env snapshot is already safely taken).
//
// Usage: COLLECTION=my-collection node src/indexer/index.js <file|folder>
import { pathToFileURL } from 'url';

// Run only when executed directly, not when imported for testing.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { bootstrapEnv } = await import('../core/env-bootstrap.js');
  const { osEnv, dotenvValues } = bootstrapEnv();

  const { createSettingsService } = await import('../core/settings/service.js');
  const settingsService = createSettingsService({ osEnv, dotenvValues });

  const { applyAllSettings, run } = await import('./run.js');
  applyAllSettings(settingsService);

  run().catch(err => { console.error(err); process.exit(1); });
}
