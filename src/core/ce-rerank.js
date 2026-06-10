// Cross-encoder reranker — production integration of the benchmark-validated
// CE path (docs/en/ce-rerank-design.md). Opt-in via RERANK_CE_ENABLED=1.
//
// Model: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (multilingual, ~120 MB).
// Gate results (custom-50, 2026-05-15): MRR@10 0.760 vs hybrid 0.665,
// chunkRecall@5 95.9%, zero regressions — but ~3.5 s p50 on CPU for 40
// candidates. Interactive use requires GPU (RERANK_CE_DEVICE=dml) or an
// explicit latency acceptance. See design §6.
//
// Design contracts implemented here:
//   - Lazy, promise-guarded model load; no work at import time (§3).
//   - ceRerank never throws: load failure disables CE for the session and
//     returns pre-CE candidates (§5 "Model load failure").
//   - Busy flag: one CE inference in flight at a time; concurrent queries
//     skip CE and return pre-CE results (§5 "Compute cancellation caveat").
//   - Timeout is the CALLER's job via withCETimeout() (§5): ceRerank has no
//     internal deadline.
//   - Passage construction ports the exact benchmark-validated format from
//     benchmarks/retrieval/custom-50/cross-encoder-bench.js (gate parity).
//
// Test hooks (__test) allow smoke tests to inject stub tokenizer/model and a
// failing loader without any network access (src/smoke/sections/41-ce-rerank-stub.js).

import 'dotenv/config';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

// ── Env knobs (design §2) ─────────────────────────────────────────────────────

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[ce-rerank] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}\n`);
    return defaultVal;
  }
  return v;
}

function envEnum(name, defaultVal, allowed) {
  const v = process.env[name];
  if (v === undefined) return defaultVal;
  if (!allowed.includes(v)) {
    process.stderr.write(`[ce-rerank] ${name}="${v}" is invalid — using default ${defaultVal}\n`);
    return defaultVal;
  }
  return v;
}

export const RERANK_CE_MODEL      = process.env.RERANK_CE_MODEL || 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
export const RERANK_CE_INPUT      = envEnum('RERANK_CE_INPUT', 'text+meta', ['text', 'text+section', 'text+meta']);
export const RERANK_CE_TOP_N      = envInt('RERANK_CE_TOP_N', 40, 1, 500);
export const RERANK_CE_TIMEOUT_MS = envInt('RERANK_CE_TIMEOUT_MS', 10000, 100, 120000);
export const RERANK_CE_DEVICE     = envEnum('RERANK_CE_DEVICE', 'cpu', ['cpu', 'dml', 'cuda']);
export const RERANK_CE_CACHE_DIR  = process.env.RERANK_CE_CACHE_DIR || './models';
export const RERANK_CE_BATCH_SIZE = envInt('RERANK_CE_BATCH_SIZE', 16, 1, 256);
const DEBUG = process.env.RERANK_CE_DEBUG === '1';

function debug(msg) {
  if (DEBUG) process.stderr.write(`[ce-rerank] ${msg}\n`);
}

// ── Module state ──────────────────────────────────────────────────────────────

let _ceTokenizer    = null;
let _ceModel        = null;
let _ceNumLabels    = null;
let _ceModelFailed  = false;
let _ceFailureLogged = false;
let _ceInFlight     = false;
let _loadPromise    = null;

// Overridable loader implementation — replaced by tests via __test.setLoadImpl.
let _loadImpl = _realLoad;

// ── Passage construction (exact port of the benchmark-validated format) ──────

export function buildPassage(payload, inputMode = RERANK_CE_INPUT) {
  const p = payload ?? {};
  if (inputMode === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (inputMode === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

// ── Model load ────────────────────────────────────────────────────────────────

// Probe a (tokenizer, model) pair: determine numLabels from logits dims and
// reject unsupported head layouts. Shared by the real loader and test stubs.
async function _initFromPair(tokenizer, model) {
  const probe = tokenizer(['probe'], {
    text_pair: ['probe'], truncation: true,
    max_length: 16, return_tensors: 'pt', padding: true,
  });
  const { logits } = await model(probe);
  const numLabels = logits.dims[1];

  if (numLabels !== 1 && numLabels !== 2) {
    _ceModelFailed = true;
    throw new Error(
      `unsupported numLabels=${numLabels} for "${RERANK_CE_MODEL}" — expected 1 or 2`
    );
  }

  _ceTokenizer  = tokenizer;
  _ceModel      = model;
  _ceNumLabels  = numLabels;
  process.stderr.write(
    `[ce-rerank] ready. numLabels=${numLabels} ` +
    `(${numLabels === 1 ? 'regression head, raw logit' : 'binary classification, logit[:,1]'})\n`
  );
}

async function _realLoad() {
  const { AutoTokenizer, AutoModelForSequenceClassification, env: hfEnv } =
    await import('@huggingface/transformers');

  const cacheDir = resolve(RERANK_CE_CACHE_DIR);
  mkdirSync(cacheDir, { recursive: true });
  hfEnv.cacheDir = cacheDir;

  process.stderr.write(`[ce-rerank] loading ${RERANK_CE_MODEL} (device=${RERANK_CE_DEVICE})...\n`);
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_CE_MODEL);

  const opts = { dtype: 'fp32' };
  let model;
  if (RERANK_CE_DEVICE !== 'cpu') {
    try {
      model = await AutoModelForSequenceClassification.from_pretrained(
        RERANK_CE_MODEL, { ...opts, device: RERANK_CE_DEVICE });
    } catch (err) {
      const oneLine = String(err?.message ?? err).replace(/\r?\n.*/s, '').trim().slice(0, 120);
      process.stderr.write(
        `[ce-rerank] device "${RERANK_CE_DEVICE}" unavailable (${oneLine}) — falling back to cpu. ` +
        `Expect ~3.5 s p50 for ${RERANK_CE_TOP_N} candidates.\n`
      );
    }
  }
  if (!model) {
    model = await AutoModelForSequenceClassification.from_pretrained(RERANK_CE_MODEL, opts);
  }

  await _initFromPair(tokenizer, model);
}

/**
 * Load the CE model. Idempotent and promise-guarded: concurrent callers share
 * one load; a settled successful load returns immediately.
 * Throws on failure (network, corrupt model, unsupported numLabels) — and
 * marks the session failed so subsequent calls do not retry.
 * ceRerank() catches this internally; warmup callers must handle the throw.
 */
export async function loadCEModel() {
  if (_ceModel) return;
  if (_ceModelFailed) throw new Error('CE model previously failed to load — disabled for this session');
  if (!_loadPromise) {
    _loadPromise = _loadImpl().catch(err => {
      _ceModelFailed = true;
      _loadPromise = null;
      throw err;
    });
  }
  await _loadPromise;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function extractScores(logits, batchSize) {
  const data = logits.data;
  if (data.length !== batchSize * _ceNumLabels) {
    throw new Error(`logits.data length ${data.length} !== batchSize(${batchSize}) × numLabels(${_ceNumLabels})`);
  }
  const col = _ceNumLabels === 2 ? 1 : 0;
  const scores = [];
  for (let row = 0; row < batchSize; row++) scores.push(data[row * _ceNumLabels + col]);
  return scores;
}

async function _scoreAll(query, candidates) {
  const rawScores = [];
  for (let i = 0; i < candidates.length; i += RERANK_CE_BATCH_SIZE) {
    const batch    = candidates.slice(i, i + RERANK_CE_BATCH_SIZE);
    const passages = batch.map(r => buildPassage(r.payload));
    const queries  = Array(batch.length).fill(query);
    const inputs = _ceTokenizer(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    const { logits } = await _ceModel(inputs);
    for (const v of extractScores(logits, batch.length)) rawScores.push(v);
  }
  return rawScores;
}

/**
 * Score and reorder candidates using cross-encoder logits.
 * Returns candidates sliced to finalLimit, sorted by CE score descending,
 * with `.score` replaced by the CE logit.
 *
 * Never throws:
 *   - empty input → []
 *   - model load failure → pre-CE candidates, CE disabled for the session
 *   - another CE call in flight → pre-CE candidates (busy skip)
 *
 * No internal deadline — callers wanting a timeout use withCETimeout().
 *
 * @param {Array}  candidates — hybrid/det-rerank results (with .payload)
 * @param {string} query
 * @param {{ finalLimit?: number }} opts
 */
export async function ceRerank(candidates, query, { finalLimit } = {}) {
  const limit = finalLimit ?? candidates.length;

  if (!candidates.length) {
    debug('empty candidate pool — skipping CE inference');
    return [];
  }
  if (_ceModelFailed) return candidates.slice(0, limit);

  if (_ceInFlight) {
    process.stderr.write('[ce-rerank] busy — skipping CE for this query\n');
    return candidates.slice(0, limit);
  }

  _ceInFlight = true;
  try {
    try {
      await loadCEModel();
    } catch (err) {
      if (!_ceFailureLogged) {
        _ceFailureLogged = true;
        process.stderr.write(`[ce-rerank] model load failed: ${err.message} — CE disabled for this session\n`);
      }
      return candidates.slice(0, limit);
    }

    let pool = candidates;
    if (pool.length > RERANK_CE_TOP_N) {
      debug(`truncated pool from ${pool.length} to ${RERANK_CE_TOP_N} candidates (RERANK_CE_TOP_N cap)`);
      pool = pool.slice(0, RERANK_CE_TOP_N);
    }
    if (pool.length < limit) {
      debug(`pool size ${pool.length} < top=${limit} — returning all scored candidates`);
    }

    const scores = await _scoreAll(query, pool);
    if (DEBUG) {
      pool.forEach((r, i) => debug(
        `${r.payload?.source_file}#${r.payload?.chunk_index}  ce=${scores[i].toFixed(4)}`));
    }

    return pool
      .map((r, i) => ({ ...r, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } finally {
    _ceInFlight = false;
  }
}

/**
 * Response-fallback timeout wrapper (design §5). Races `promise` against a
 * deadline; on expiry returns `fallback()` instead. The in-flight inference
 * is NOT cancelled (no mechanism in JS) — the busy flag in ceRerank prevents
 * pile-up while it drains.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {() => any} fallback — invoked only on timeout
 * @param {{ label?: string }} [opts] — label for the timeout log line
 */
export async function withCETimeout(promise, ms, fallback, { label = 'ce-rerank' } = {}) {
  let timer;
  const sentinel = new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout('__ce_timeout__'), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const winner = await Promise.race([promise, sentinel]);
    if (winner === '__ce_timeout__') {
      const fb = fallback();
      process.stderr.write(`[${label}] timeout after ${ms}ms — returning pre-CE results (${fb?.length ?? 0} candidates)\n`);
      return fb;
    }
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

// ── Test hooks — smoke tests only, never used by production code ─────────────

export const __test = {
  reset() {
    _ceTokenizer = null; _ceModel = null; _ceNumLabels = null;
    _ceModelFailed = false; _ceFailureLogged = false;
    _ceInFlight = false; _loadPromise = null;
    _loadImpl = _realLoad;
  },
  setLoadImpl(fn) { _loadImpl = fn; },
  // Install a stub (tokenizer, model) pair through the same probe path the
  // real loader uses — numLabels validation included.
  initFromPair: (tokenizer, model) => _initFromPair(tokenizer, model),
  state: () => ({ failed: _ceModelFailed, loaded: _ceModel !== null, numLabels: _ceNumLabels }),
};
