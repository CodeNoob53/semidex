const HEALTH_OK = { ok: true, storage: { backend: 'qdrant', ok: true, detail: 'reachable' } };
const HEALTH_FAIL = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };

const GENERATION_READY = {
  backend: 'ollama', model: 'gemma3:4b', ready: true, reason: null, numCtx: 8192,
  capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'os_env' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const GENERATION_UNAVAILABLE = {
  backend: 'ollama', model: 'gemma3:4b', ready: false,
  reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".',
  numCtx: null, capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'dotenv' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const CATEGORIES = [
  { id: 'status', label: 'Runtime status' },
  { id: 'storage', label: 'Storage & databases' },
  { id: 'ai', label: 'AI providers' },
  { id: 'embeddings', label: 'Embeddings & hardware' },
  { id: 'indexing', label: 'Indexing & document processing' },
  { id: 'retrieval', label: 'Retrieval & ranking' },
  { id: 'system', label: 'System & diagnostics' },
];

function makeEntry(overrides = {}) {
  return {
    key: 'RRF_K', category: 'retrieval', label: 'RRF K constant', type: 'number',
    description: 'Smoothing constant for RRF.', advanced: true,
    min: 1, max: 10000,
    default: 60,
    configuredValue: 60, activeValue: 60,
    configuredSource: 'default', activeSource: 'default', source: 'default',
    writable: true, secret: false, hasLocalOverride: false, pendingRestart: false,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function settingsPayload(settings) {
  return { categories: CATEGORIES, settings };
}

export {
  HEALTH_OK,
  HEALTH_FAIL,
  GENERATION_READY,
  GENERATION_UNAVAILABLE,
  CATEGORIES,
  makeEntry,
  settingsPayload,
};
