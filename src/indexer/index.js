// Backward-compatible launcher (code review, round 4) — indexer/index.js
// used to be the ONE shared spawn target for both Full and Lite editions,
// branching on SEMIDEX_INDEXER_EDITION internally. It is no longer a
// composition root at all: admin/jobs/registry.js now spawns index-full.js
// or index-lite.js directly, selected once per edition (never a runtime
// branch inside a shared file — see index-full.js's own header comment for
// why the Lite package closure validator required this split). This file
// exists only so `node src/indexer/index.js <path>` (a direct CLI
// invocation outside the admin job registry, e.g. from a script or a
// developer's shell) keeps working, unchanged, as Full's own entry point.
// It carries no capability-building imports and no capability-selection
// logic of its own — index-full.js itself recognizes this file's own path
// as an alias for its own isIndexerMainModule() guard (see that file's own
// LAUNCHER_ALIAS_URL), so this import is the entire delegation.
import './index-full.js';
