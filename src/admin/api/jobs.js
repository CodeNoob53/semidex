// POST /api/jobs/index, GET /api/jobs, GET /api/jobs/:id,
// POST /api/jobs/:id/cancel — indexing job control. No StorageAdapter call
// needed here (jobs are a process-management concern, not storage), but the
// endpoints still speak semidex domain shapes only — no indexer internals,
// no raw child_process objects, ever serialized to the client.
import { sendJson, badRequest, notFound, conflict, dependencyUnavailable } from '../http.js';
import { readJsonBody } from '../http.js';
import { checkOllama } from '../system/ollama.js';

const DEFAULT_CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';

const MAX_LOG_LINES_IN_RESPONSE = 200;

function requireStringField(body, name) {
  const v = body?.[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`Body field "${name}" is required and must be a non-empty string`);
  }
  return v;
}

// Collection names can now be human-readable (spaces, Cyrillic, etc. — the
// UI/API already round-trip these fine via encodeURIComponent), but "/" and
// "\" are still rejected: the router matches route segments literally, so a
// name containing either would either fail to match ":name" as a single
// segment or, if percent-encoded, create a collection whose name can't be
// cleanly round-tripped back through GET/DELETE /api/collections/:name.
const PATH_SEPARATOR_RE = /[/\\]/;

function requireCollectionNameField(body, name) {
  const raw = requireStringField(body, name);
  const trimmed = raw.trim();
  if (PATH_SEPARATOR_RE.test(trimmed)) {
    throw badRequest(`Body field "${name}" must not contain "/" or "\\": "${trimmed}"`);
  }
  return trimmed;
}

// This MVP indexes local paths only (task spec: "Do not accept remote URLs
// as source path"). A URL-shaped string (any scheme://) would otherwise
// pass the non-empty-string check above and reach the indexer's own
// argument parsing, which has no such guard — reject it here instead of
// relying on the indexer to fail safely on an input it was never designed
// to receive.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function requireLocalPathField(body, name) {
  const v = requireStringField(body, name);
  if (URL_SCHEME_RE.test(v)) {
    throw badRequest(`Body field "${name}" must be a local filesystem path, not a URL: "${v}"`);
  }
  return v;
}

// Known option names — used both to build the validated options object and
// to detect the misnesting mistake below (sending these at the top level
// of the body instead of under "options").
const KNOWN_OPTION_NAMES = [
  'onnxEmbed', 'skeletonChunking', 'skeletonNav', 'llmSummaries', 'pruneStale', 'tagGen',
];

function parseOptions(body) {
  const o = body?.options;
  if (o === undefined || o === null) return {};
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw badRequest('Body field "options" must be an object when provided');
  }
  const bool = (name) => {
    const v = o[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw badRequest(`Body field "options.${name}" must be a boolean`);
    return v;
  };
  return {
    onnxEmbed: bool('onnxEmbed'),
    skeletonChunking: bool('skeletonChunking'),
    skeletonNav: bool('skeletonNav'),
    llmSummaries: bool('llmSummaries'),
    pruneStale: bool('pruneStale'),
    tagGen: bool('tagGen'),
  };
}

// A known option sent at the top level of the body (instead of nested
// under "options") used to be silently ignored — parseOptions() only reads
// body.options, so the request would "succeed" with every option at its
// default, producing a wrong-shape collection (e.g. skeletonChunking
// silently off) with no indication anything was misconfigured. Reject it
// loudly instead.
function requireOptionsNotMisnested(body) {
  const misnested = KNOWN_OPTION_NAMES.filter((name) => name in body);
  if (misnested.length) {
    throw badRequest(`Indexing options must be nested under "options" (found at top level: ${misnested.join(', ')}).`);
  }
}

export function parseIndexJobRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  requireOptionsNotMisnested(body);
  const collection = requireCollectionNameField(body, 'collection');
  const path = requireLocalPathField(body, 'path');
  const options = parseOptions(body);
  return { collection, path, options };
}

// Derives the { processedFiles, totalFiles, currentFile, percent } shape
// from the registry's raw job.progress. percent is computed here (not
// stored) so there's exactly one place that decides "known total" vs
// "indeterminate" — only every() reduce to a percent when totalFiles is a
// positive number; otherwise percent stays null and the UI shows an
// indeterminate progress indicator instead of a fabricated 0%.
function toProgressSummary(progress) {
  const processedFiles = progress?.processedFiles ?? null;
  const totalFiles = progress?.totalFiles ?? null;
  const currentFile = progress?.currentFile ?? null;
  const percent = (typeof totalFiles === 'number' && totalFiles > 0 && typeof processedFiles === 'number')
    ? (processedFiles / totalFiles) * 100
    : null;
  return { processedFiles, totalFiles, currentFile, percent };
}

// snake_case-free domain shape (design doc §4 IndexingJob), no `child`
// process handle, no raw env, no secrets — only what a UI needs to render.
export function toJobSummary(job) {
  return {
    id: job.id,
    collection: job.collection,
    path: job.path,
    options: job.options,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    progress: toProgressSummary(job.progress),
  };
}

export function toJobDetail(job) {
  const lines = job.log.slice(-MAX_LOG_LINES_IN_RESPONSE).map(l => `[${l.stream}] ${l.line}`);
  return { ...toJobSummary(job), log: lines };
}

export function registerJobsRoutes(router, registry, { checkOllamaFn = checkOllama } = {}) {
  router.post('/api/jobs/index', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const { collection, path, options } = parseIndexJobRequest(body);

    // LLM summaries need Ollama running with the context model pulled — the
    // indexer's own preflight only discovers this *after* the job has
    // already been spawned (failure buried in job logs). Check here first
    // (read-only — never starts Ollama) so the user gets an actionable 503
    // instead of a job that starts and immediately fails.
    if (options.llmSummaries) {
      const ollama = await checkOllamaFn({ requiredModel: DEFAULT_CONTEXT_MODEL });
      if (ollama.status !== 'available') {
        throw dependencyUnavailable(`LLM summaries require Ollama: ${ollama.message}`);
      }
    }

    let started;
    try {
      started = registry.startIndexJob({ collection, path, options });
    } catch (err) {
      if (err.code === 'JOB_ALREADY_RUNNING') throw conflict(err.message);
      throw err;
    }

    const job = registry.getJob(started.id);
    sendJson(res, 202, { job: toJobSummary(job) });
  });

  router.get('/api/jobs', ({ res }) => {
    sendJson(res, 200, { jobs: registry.listJobs().map(toJobSummary) });
  });

  router.get('/api/jobs/:id', ({ res, params }) => {
    const job = registry.getJob(params.id);
    if (!job) throw notFound(`Job "${params.id}" not found`);
    sendJson(res, 200, { job: toJobDetail(job) });
  });

  router.post('/api/jobs/:id/cancel', ({ res, params }) => {
    const job = registry.getJob(params.id);
    if (!job) throw notFound(`Job "${params.id}" not found`);
    const updated = registry.cancelJob(params.id);
    sendJson(res, 200, { job: toJobSummary(updated) });
  });
}
