// POST /api/jobs/index, GET /api/jobs, GET /api/jobs/:id,
// POST /api/jobs/:id/cancel — indexing job control. No StorageAdapter call
// needed here (jobs are a process-management concern, not storage), but the
// endpoints still speak semidex domain shapes only — no indexer internals,
// no raw child_process objects, ever serialized to the client.
//
// checkOllamaFn has NO static-import default (Semidex Lite composition
// split, admin/register-neutral-routes.js's registerNeutralRoutes()) —
// this module must
// never statically pull in admin/system/ollama.js (-> local/core/ollama.js),
// since a cloud-only Lite composition root never registers a check at all.
// The FULL composition root (createApp() in server-full.js) is the one place
// that imports the real checkOllama and passes it in; Lite's composition
// root passes none, and jobPolicy.allowLlmSummaries=false makes the
// llmSummaries branch unreachable anyway (see registerJobsRoutes below).
import { sendJson, badRequest, notFound, conflict, dependencyUnavailable, HttpError } from '../../core/http/http.js';
import { readJsonBody } from '../../core/http/http.js';

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
  'onnxEmbed', 'llmSummaries', 'pruneStale', 'tagGen',
];

// jobPolicy (Semidex Lite composition split): which of the four known
// options a composition root allows AT ALL. FULL_JOB_POLICY (every option
// allowed) is the exact pre-existing behavior and is the default — full
// Semidex's createApp() never has to pass one explicitly.
//
// pruneStale is Qdrant-only stale-cleanup (deleteByFilter/
// deleteBySourceFile — no local model involved, fully Qdrant-Cloud-
// compatible), so it stays allowed even under a cloud-only policy — only
// onnxEmbed/llmSummaries/tagGen are local-model-shaped and rejected there.
export const FULL_JOB_POLICY = Object.freeze({
  allowOnnxEmbed: true, allowLlmSummaries: true, allowTagGen: true, allowPruneStale: true,
});

const POLICY_KEY_BY_OPTION = Object.freeze({
  onnxEmbed: 'allowOnnxEmbed', llmSummaries: 'allowLlmSummaries', tagGen: 'allowTagGen', pruneStale: 'allowPruneStale',
});

// A policy-disallowed option is rejected the SAME way REMOVED_OPTION_NAMES
// already is below — a loud 400 naming exactly which option and why, never
// a silent ignore that could let a caller believe an unsupported local mode
// actually ran.
function requireOptionsAllowedByPolicy(o, jobPolicy) {
  const disallowed = Object.keys(o).filter((name) => name in POLICY_KEY_BY_OPTION && o[name] !== undefined && !jobPolicy[POLICY_KEY_BY_OPTION[name]]);
  if (disallowed.length) {
    throw new HttpError(
      400, 'not_available_in_lite',
      `Indexing option(s) ${disallowed.map((n) => `"${n}"`).join(', ')} are not available in this deployment.`,
    );
  }
}

// skeletonChunking/skeletonNav were removed as job options — skeleton-first
// chunking and navigation-point generation are unconditional architecture
// now, not a per-job choice. Compatibility policy: an explicit, loud 400
// rejection if a caller still sends either (regardless of its value,
// including false), rather than silently accepting and ignoring it —
// silently pretending a removed option still works would let a caller
// believe they successfully disabled skeleton chunking when they did not.
const REMOVED_OPTION_NAMES = ['skeletonChunking', 'skeletonNav'];

function parseOptions(body, jobPolicy) {
  const o = body?.options;
  if (o === undefined || o === null) return {};
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw badRequest('Body field "options" must be an object when provided');
  }
  const removed = REMOVED_OPTION_NAMES.filter((name) => name in o);
  if (removed.length) {
    throw badRequest(
      `Indexing option(s) ${removed.map((n) => `"${n}"`).join(', ')} are no longer supported — skeleton-first indexing is always on and cannot be disabled per job.`
    );
  }
  requireOptionsAllowedByPolicy(o, jobPolicy);
  const bool = (name) => {
    const v = o[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw badRequest(`Body field "options.${name}" must be a boolean`);
    return v;
  };
  return {
    onnxEmbed: bool('onnxEmbed'),
    llmSummaries: bool('llmSummaries'),
    pruneStale: bool('pruneStale'),
    tagGen: bool('tagGen'),
  };
}

// A known option sent at the top level of the body (instead of nested
// under "options") used to be silently ignored — parseOptions() only reads
// body.options, so the request would "succeed" with every option at its
// default, producing a wrong-shape collection (e.g. tagGen silently off)
// with no indication anything was misconfigured. Reject it loudly instead.
function requireOptionsNotMisnested(body) {
  const misnested = KNOWN_OPTION_NAMES.filter((name) => name in body);
  if (misnested.length) {
    throw badRequest(`Indexing options must be nested under "options" (found at top level: ${misnested.join(', ')}).`);
  }
}

// 'kind' is an optional display-label hint (Phase 3S — distinguishes a
// brand-new collection from a reindex of an existing one in the operation
// modal; both run identically otherwise). Defaults to 'index' so every
// pre-existing caller (and every old client that's never heard of this
// field) keeps behaving exactly as before.
function parseKind(body) {
  const v = body?.kind;
  if (v === undefined) return 'index';
  if (v !== 'index' && v !== 'reindex') {
    throw badRequest('Body field "kind" must be "index" or "reindex" when provided');
  }
  return v;
}

export function parseIndexJobRequest(body, jobPolicy = FULL_JOB_POLICY) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  requireOptionsNotMisnested(body);
  const collection = requireCollectionNameField(body, 'collection');
  const path = requireLocalPathField(body, 'path');
  const options = parseOptions(body, jobPolicy);
  const kind = parseKind(body);
  return { collection, path, options, kind };
}

// Derives the { processedFiles, totalFiles, currentFile, currentStep,
// currentFileProgress, percent } shape from the registry's raw
// job.progress. percent is computed here (not stored) so there's exactly
// one place that decides "known enough to show a real bar" vs
// "indeterminate": processedFiles/totalFiles/currentFileProgress must ALL
// be numbers and totalFiles > 0, or percent stays null and the UI falls
// back to an indeterminate indicator instead of a fabricated number.
//
// This is an estimate, not a measured ETA — currentFileProgress is a fixed
// phase weight (see progress-event.js), not profiled per-run timing. The
// bar moves smoothly and honestly reflects "roughly how far into this file
// are we", which is the whole point for small collections with a few large
// files, where processedFiles/totalFiles alone would jump in big, confusing
// steps (e.g. 0% → 25% → 50%).
function toProgressSummary(progress) {
  const processedFiles = progress?.processedFiles ?? null;
  const totalFiles = progress?.totalFiles ?? null;
  const currentFile = progress?.currentFile ?? null;
  const currentStep = progress?.currentStep ?? null;
  const currentFileProgress = typeof progress?.currentFileProgress === 'number' ? progress.currentFileProgress : null;
  const percent = (
    typeof totalFiles === 'number' && totalFiles > 0
    && typeof processedFiles === 'number'
    && typeof currentFileProgress === 'number'
  ) ? ((processedFiles + currentFileProgress) / totalFiles) * 100 : null;
  return { processedFiles, totalFiles, currentFile, currentStep, currentFileProgress, percent };
}

// snake_case-free domain shape (design doc §4 IndexingJob), no `child`
// process handle, no raw env, no secrets — only what a UI needs to render.
export function toJobSummary(job) {
  return {
    id: job.id,
    collection: job.collection,
    path: job.path,
    options: job.options,
    kind: job.kind ?? 'index', // ?? covers a job created before this field existed (in-memory registry, so only matters within one server process's lifetime)
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

// checkOllamaFn has no default — the full composition root (createApp(),
// server.js) is the only place that imports admin/system/ollama.js's real
// checkOllama and passes it in; this module must never statically import
// it. jobPolicy defaults to FULL_JOB_POLICY (today's exact behavior —
// every option allowed) so an existing caller that doesn't pass one is
// unaffected. A Lite composition root passes a policy with
// allowLlmSummaries:false (making options.llmSummaries unreachable via
// parseIndexJobRequest's own validation, below) and can therefore safely
// omit checkOllamaFn entirely — it is never called in that configuration.
export function registerJobsRoutes(router, registry, { checkOllamaFn, jobPolicy = FULL_JOB_POLICY } = {}) {
  router.post('/api/jobs/index', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const { collection, path, options, kind } = parseIndexJobRequest(body, jobPolicy);

    // LLM summaries need Ollama running with the context model pulled — the
    // indexer's own preflight only discovers this *after* the job has
    // already been spawned (failure buried in job logs). Check here first
    // (read-only — never starts Ollama) so the user gets an actionable 503
    // instead of a job that starts and immediately fails.
    //
    // options.llmSummaries can only be true here if jobPolicy.
    // allowLlmSummaries was true (parseIndexJobRequest already rejected it
    // otherwise) — so a policy that disallows LLM summaries never reaches
    // this branch and checkOllamaFn's absence is safe under that policy.
    if (options.llmSummaries) {
      if (!checkOllamaFn) {
        throw new HttpError(500, 'misconfigured', 'This deployment allows llmSummaries but was not configured with an Ollama availability check.');
      }
      const ollama = await checkOllamaFn({ requiredModel: DEFAULT_CONTEXT_MODEL });
      if (ollama.status !== 'available') {
        throw dependencyUnavailable(`LLM summaries require Ollama: ${ollama.message}`);
      }
    }

    let started;
    try {
      started = registry.startIndexJob({ collection, path, options, kind });
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
