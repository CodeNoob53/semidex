// Shared path constant for this suite's .runs/ directory (checkpoints +
// .trec run files) — small enough to not warrant folding into
// checkpoint.mjs, but needed by both checkpoint.mjs and run-suite.mjs.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR_PATH = resolve(__dirname, '../.runs');
