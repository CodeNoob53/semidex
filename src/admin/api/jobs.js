// POST /api/jobs/index, GET /api/jobs, GET /api/jobs/:id,
// POST /api/jobs/:id/cancel — indexing job control. No StorageAdapter call
// needed here (jobs are a process-management concern, not storage), but the
// endpoints still speak semidex domain shapes only — no indexer internals,
// no raw child_process objects, ever serialized to the client.
import { sendJson, badRequest, notFound, conflict } from '../http.js';
import { readJsonBody } from '../http.js';

const MAX_LOG_LINES_IN_RESPONSE = 200;

function requireStringField(body, name) {
  const v = body?.[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`Body field "${name}" is required and must be a non-empty string`);
  }
  return v;
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
    pruneStale: bool('pruneStale'),
    tagGen: bool('tagGen'),
  };
}

export function parseIndexJobRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const collection = requireStringField(body, 'collection');
  const path = requireLocalPathField(body, 'path');
  const options = parseOptions(body);
  return { collection, path, options };
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
  };
}

export function toJobDetail(job) {
  const lines = job.log.slice(-MAX_LOG_LINES_IN_RESPONSE).map(l => `[${l.stream}] ${l.line}`);
  return { ...toJobSummary(job), log: lines };
}

export function registerJobsRoutes(router, registry) {
  router.post('/api/jobs/index', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const { collection, path, options } = parseIndexJobRequest(body);

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
