// Semidex Lite admin UI entry point (Phase 6 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md). Built by
// vite.config.lite.js into dist/admin-ui-lite/. Deliberately never imports
// local-features.js or calls any of setLocalSettingsCapabilities()/
// setJobsLocalCapabilities()/setSettingsLocalCapabilities() — every one of
// those three capability seams (global-settings-view.js, jobs-view.js,
// settings-view.js) stays null, so onnxProbePanel()/wireOnnxProbePanel()/
// categoryNeedsOllamaModels()/refreshOllamaModels()/loadOllamaStatus()/
// collectLocalJobOptions() all no-op. This is what makes Lite's real
// physical isolation from local-runtime UI code: local-features.js is
// simply never reachable from this module graph at all, not merely
// dead-code-eliminated.
import '../app.css';
import { startAdminApp } from '../app.js';

startAdminApp();
