// Full Semidex admin UI entry point (Phase 6 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md). Built by
// vite.config.js into dist/admin-ui/. The ONLY file in the Full build that
// imports local-features.js — wiring it into global-settings-view.js's,
// jobs-view.js's, and settings-view.js's capability seams is what makes
// the ONNX probe panel/Ollama model discovery/Ollama readiness check/
// onnxEmbed-llmSummaries-tagGen job options reachable at all in this
// build. index.html's own <script type="module" src="/entries/full.js">
// is what makes this file the real entry Rollup starts its module graph
// from.
import '../app.css';
import { startAdminApp } from '../app.js';
import { setLocalSettingsCapabilities } from '../global-settings-view.js';
import { setJobsLocalCapabilities } from '../jobs-view.js';
import { setSettingsLocalCapabilities } from '../settings-view.js';
import * as localFeatures from '../local-features.js';

setLocalSettingsCapabilities(localFeatures);
setJobsLocalCapabilities(localFeatures);
setSettingsLocalCapabilities(localFeatures);
startAdminApp();
