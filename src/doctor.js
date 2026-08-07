// npm run doctor — read-only environment health check.
// Never mutates Qdrant, config.json, or any local file (except writing the report).
// Exit code: 0 = PASS/WARN/SKIP only; 1 = any FAIL.

// bootstrapEnv() must run before any import below could transitively load
// .env via a static 'dotenv/config' import — same reasoning as sync.js.
//
// doctor.js DOES construct a SettingsService and applies its write-back
// before any check runs (code review fix — an earlier version of this file
// deliberately skipped this, reasoning that doctor should show "raw
// environment truth" rather than an effective value; that was wrong: a
// settings.json-saved OLLAMA_URL/CONTEXT_MODEL/etc. IS what the rest of the
// system will actually use, so a doctor run that only checked raw env
// could diagnose entirely the wrong endpoint/model — the opposite of
// "accurate diagnosis"). Every check below still reads process.env.X same
// as before; applyEnvWriteBack() makes those reads reflect the resolved
// EFFECTIVE value (env > dotenv > settings.json > default), and the new
// provenance line for each field states which tier actually won, so a
// stray/misconfigured OS env var is still fully visible, not hidden by
// settings.json.
const { bootstrapEnv } = await import('./core/env-bootstrap.js');
const { osEnv, dotenvValues } = bootstrapEnv();
const { createSettingsService, applyEnvWriteBack } = await import('./core/settings/service.js');
const settingsService = createSettingsService({ osEnv, dotenvValues });
applyEnvWriteBack(settingsService);

const { existsSync, readdirSync, mkdirSync, writeFileSync } = await import('fs');
const { resolve, dirname, relative, join } = await import('path');
const { fileURLToPath } = await import('url');

const {
  redactKey, redactUrl, sanitiseErrorMessage,
  makeResult, aggregateExitCode, formatResult,
  checkNodeVersion, classifyVectorSchema,
  checkProviderAgreement, checkSchemaVersion,
  missingModelCommands, formatCudaProbeFailure, formatCudaDiagnosis, STATUS,
  resolveCombinedLlmConfig,
} = await import('./core/doctor-checks.js');
const { loadConfig } = await import('./core/config.js');
const { SCHEMA_VERSION } = await import('./core/embeddings.js');
const { getOnnxModelPath } = await import('./core/onnx-paths.js');
const { probeOnnxProvider } = await import('./local/core/onnx-provider-probe.js');
const { diagnoseCudaFailure } = await import('./local/core/cuda-diagnosis.js');
const { checkPrerequisites } = await import('./local/core/onnx-cuda-prereq-check.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY  = process.env.QDRANT_KEY ?? '';

// Human-readable provenance label for a settings-registry field, used to
// annotate the [A] runtime-environment checks below with WHERE the
// effective value came from (os_env / dotenv / config_json / default) —
// makes a settings.json override visible instead of silently blended in.
const PROVENANCE_LABEL = {
  os_env: 'OS environment', dotenv: '.env file', config_json: 'saved setting (settings.json)', default: 'built-in default',
};
function provenance(key) {
  const entry = settingsService.get(key);
  return entry ? PROVENANCE_LABEL[entry.source] ?? entry.source : null;
}

// Sanitise an error message before printing — strip the API key literal if present.
function safe(msg) { return sanitiseErrorMessage(String(msg ?? ''), KEY); }

// All collected results across all groups.
const allResults = [];

function collect(group, result) {
  allResults.push({ group, ...result });
}

// Print a group header + result, and also push to allResults.
function report(group, result) {
  collect(group, result);
  console.log(formatResult(result));
}

// ── A: Runtime environment ────────────────────────────────────────────────────

console.log('\n[A] Runtime environment');

report('A', checkNodeVersion(process.version));

{
  let ver = '?';
  try {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    ver = req('../package.json').version;
  } catch { /* ignore */ }
  report('A', makeResult(ver !== '?' ? STATUS.PASS : STATUS.WARN, `semidex v${ver}`));
}

{
  const envPath = resolve(ROOT, '.env');
  report('A', existsSync(envPath)
    ? makeResult(STATUS.PASS, '.env file present')
    : makeResult(STATUS.WARN, '.env file missing', 'Copy .env.example → .env and fill in values'));
}

{
  const url = process.env.QDRANT_URL;
  const key = process.env.QDRANT_KEY;
  report('A', url
    ? makeResult(STATUS.PASS, `QDRANT_URL: ${redactUrl(url)} (source: ${provenance('QDRANT_URL') ?? 'unknown'})`)
    : makeResult(STATUS.FAIL, 'QDRANT_URL not set', 'Add QDRANT_URL=https://... to .env'));
  report('A', key
    ? makeResult(STATUS.PASS, `QDRANT_KEY: ${redactKey(key)}`)
    : makeResult(STATUS.FAIL, 'QDRANT_KEY not set', 'Add QDRANT_KEY=... to .env'));
}

{
  const ollamaUrl = process.env.OLLAMA_URL;
  report('A', ollamaUrl
    ? makeResult(STATUS.PASS, `OLLAMA_URL: ${redactUrl(ollamaUrl)} (source: ${provenance('OLLAMA_URL') ?? 'unknown'})`)
    : makeResult(STATUS.WARN, `OLLAMA_URL not set (will default to http://localhost:11434)`));
}

{
  const ctxModel = process.env.CONTEXT_MODEL ?? 'gemma3:4b';
  const ctx    = process.env.CONTEXT_MODEL ?? '(not set — default gemma3:4b)';
  const tag    = process.env.TAG_MODEL     ?? `(not set — default CONTEXT_MODEL: ${ctxModel})`;
  const tagGen = process.env.TAG_GEN === '1' ? 'enabled (TAG_GEN=1)' : 'disabled (default)';
  const onnx   = process.env.ONNX_EMBED    ?? '(not set)';
  const ep     = process.env.ONNX_EXECUTION_PROVIDER ?? '(not set — default cpu)';
  // Provenance is shown for every field the settings registry actually
  // resolves (CONTEXT_MODEL/TAG_MODEL/TAG_GEN/ONNX_EXECUTION_PROVIDER) —
  // ONNX_EMBED has no registry entry (legacy shorthand, deliberately
  // excluded from the registry — see core/settings/definitions.js), so it
  // stays a plain env read with no provenance line, same as before.
  report('A', makeResult(STATUS.PASS, `CONTEXT_MODEL: ${ctx} (source: ${provenance('CONTEXT_MODEL') ?? 'unknown'})`));
  report('A', makeResult(STATUS.PASS, `TAG_MODEL: ${tag} (source: ${provenance('TAG_MODEL') ?? 'unknown'})`));
  report('A', makeResult(STATUS.PASS, `TAG_GEN: ${tagGen} (source: ${provenance('TAG_GEN') ?? 'unknown'})`));
  report('A', makeResult(STATUS.PASS, `ONNX_EMBED: ${onnx}`));
  report('A', makeResult(STATUS.PASS, `ONNX_EXECUTION_PROVIDER: ${ep} (source: ${provenance('ONNX_EXECUTION_PROVIDER') ?? 'unknown'})`));

  const combinedCfg = resolveCombinedLlmConfig(process.env);
  if (combinedCfg.enabled) {
    report('A', makeResult(STATUS.PASS, `COMBINED_LLM: enabled (model: ${combinedCfg.model})`));
    if (combinedCfg.warning) {
      report('A', makeResult(STATUS.WARN, `COMBINED_LLM: ${combinedCfg.warning}`));
    }
  } else {
    report('A', makeResult(STATUS.PASS, 'COMBINED_LLM: disabled (default separate context+tag path)'));
  }
}

// ── B: Qdrant connectivity ────────────────────────────────────────────────────

console.log('\n[B] Qdrant connectivity');

const qdrantUrl  = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const qdrantKey  = process.env.QDRANT_KEY ?? '';
const qdrantHdrs = { 'api-key': qdrantKey, 'Content-Type': 'application/json' };

let qdrantReachable = false;
let qdrantCollections = [];

if (!qdrantUrl) {
  report('B', makeResult(STATUS.SKIP, 'Qdrant reachability', 'QDRANT_URL not set'));
} else {
  try {
    const r = await fetch(`${qdrantUrl}/collections`, {
      headers: qdrantHdrs,
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      qdrantReachable = true;
      const data = await r.json();
      qdrantCollections = data.result?.collections?.map(c => c.name) ?? [];
      report('B', makeResult(STATUS.PASS, `Qdrant reachable — ${qdrantCollections.length} collection(s)`));
    } else if (r.status === 401 || r.status === 403) {
      report('B', makeResult(STATUS.FAIL, `Qdrant auth failed (HTTP ${r.status})`,
        'Regenerate QDRANT_KEY in Qdrant Cloud dashboard and update .env'));
    } else {
      report('B', makeResult(STATUS.FAIL, `Qdrant returned HTTP ${r.status}`,
        safe(await r.text())));
    }
  } catch (err) {
    report('B', makeResult(STATUS.FAIL, 'Qdrant unreachable',
      `${safe(err.message)} — verify QDRANT_URL and network`));
  }
}

// ── C: Per-collection schema audit ───────────────────────────────────────────

const config = loadConfig();
const configCollections = config.collections ?? {};

if (qdrantReachable && qdrantCollections.length > 0) {
  // Collections known in Qdrant but not in config (foreign)
  const foreign = qdrantCollections.filter(n => !configCollections[n]);
  if (foreign.length) {
    console.log(`\n[C] Foreign collections (not in config.json, skipped): ${foreign.join(', ')}`);
  }

  for (const name of qdrantCollections) {
    if (!configCollections[name]) continue; // foreign — already noted above
    console.log(`\n[C] Collection: ${name}`);

    let info;
    try {
      const r = await fetch(`${qdrantUrl}/collections/${name}`, {
        headers: qdrantHdrs,
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${safe(await r.text())}`);
      const d = await r.json();
      info = d.result;
    } catch (err) {
      report('C', makeResult(STATUS.FAIL, `${name}: could not fetch collection info`, safe(err.message)));
      continue;
    }

    const vectorsCfg = info.config?.params?.vectors ?? {};
    const schemaKind = classifyVectorSchema(vectorsCfg);
    const pointCount = info.points_count ?? info.vectors_count ?? '?';

    if (schemaKind === 'flat') {
      report('C', makeResult(STATUS.FAIL, `${name}: legacy flat schema (no named "dense" vector)`,
        'Run npm run sync — reports LEGACY SCHEMA, then drop + reindex'));
    } else if (schemaKind === 'empty') {
      report('C', makeResult(STATUS.WARN, `${name}: no vector config found in collection info`));
    } else {
      report('C', makeResult(STATUS.PASS, `${name}: named dense vector present`));
      // Check sparse_vectors config separately — flat/absent sparse causes hybrid search fallback
      const sparseCfg = info.config?.params?.sparse_vectors ?? {};
      const hasSparseConfig = typeof sparseCfg.sparse === 'object' && sparseCfg.sparse !== null;
      report('C', hasSparseConfig
        ? makeResult(STATUS.PASS, `${name}: sparse vector config present`)
        : makeResult(STATUS.WARN, `${name}: sparse vector config missing`,
            'Run npm run sync to add sparse vector support'));
    }

    // Point count
    if (typeof pointCount === 'number') {
      report('C', pointCount === 0
        ? makeResult(STATUS.WARN, `${name}: 0 points (empty collection)`)
        : makeResult(STATUS.PASS, `${name}: ${pointCount.toLocaleString()} points`));
    }

    // Payload indexes
    const payloadSchema = info.payload_schema ?? {};
    const requiredIndexes = ['source_file', 'tags', 'chunk_index'];
    for (const field of requiredIndexes) {
      report('C', payloadSchema[field]
        ? makeResult(STATUS.PASS, `${name}: payload index "${field}"`)
        : makeResult(STATUS.WARN, `${name}: payload index "${field}" missing`,
            `Run npm run sync to create it`));
    }

    // Sample one payload point for provider + schema version checks (skip if empty)
    let sample = null;
    if (pointCount !== 0) {
      try {
        const r = await fetch(`${qdrantUrl}/collections/${name}/points/scroll`, {
          method: 'POST',
          headers: qdrantHdrs,
          signal: AbortSignal.timeout(7000),
          body: JSON.stringify({ limit: 1, with_payload: true, with_vectors: false }),
        });
        if (r.ok) {
          const d = await r.json();
          const pt = d.result?.points?.[0];
          // Strip text/context/tags content — keep only metadata fields
          if (pt?.payload) {
            const { text: _t, context: _c, tags: _tg, ...meta } = pt.payload;
            sample = meta;
          }
        }
      } catch { /* skip checks that need sample */ }
    }

    report('C', checkProviderAgreement(configCollections[name], sample));
    report('C', checkSchemaVersion(sample, SCHEMA_VERSION));
  }
} else if (!qdrantReachable) {
  console.log('\n[C] Collection schema — SKIPPED (Qdrant unreachable)');
  collect('C', makeResult(STATUS.SKIP, 'Collection schema checks', 'Qdrant unreachable'));
} else {
  console.log('\n[C] Collection schema — no collections in Qdrant');
}

// ── D: Ollama ─────────────────────────────────────────────────────────────────

// CONTEXT_MODEL always defaults to gemma3:4b regardless of dense provider.
// TAG_MODEL is required only when TAG_GEN=1 and TAG_PROVIDER=ollama.
// The indexer uses Ollama for context even when ONNX_EMBED=1 for embeddings.
// Always check Ollama to avoid false-green before indexing.
const useOnnx = process.env.ONNX_EMBED === '1' || process.env.DENSE_PROVIDER === 'bge-m3-onnx';

console.log('\n[D] Ollama');

{
  const ollamaBase = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  let ollamaReachable = false;
  let availableModels = [];

  try {
    const r = await fetch(`${ollamaBase}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      ollamaReachable = true;
      const d = await r.json();
      report('D', makeResult(STATUS.PASS, `Ollama reachable (v${d.version ?? '?'})`));
    } else {
      report('D', makeResult(STATUS.FAIL, `Ollama returned HTTP ${r.status}`,
        'Check OLLAMA_URL or start Ollama with: ollama serve'));
    }
  } catch (err) {
    report('D', makeResult(STATUS.FAIL, `Ollama unreachable at ${redactUrl(ollamaBase)}`,
      `Start Ollama with: ollama serve${ollamaBase.includes('localhost') ? '\n             → On Windows try OLLAMA_URL=http://127.0.0.1:11434 if localhost is proxied' : ''}`));
  }

  if (ollamaReachable) {
    try {
      const r = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        availableModels = (d.models ?? []).map(m => m.name);
        report('D', makeResult(STATUS.PASS, `${availableModels.length} model(s) available`));
      }
    } catch (err) {
      report('D', makeResult(STATUS.WARN, 'Could not list Ollama models', safe(err.message)));
    }

    const contextModel = process.env.CONTEXT_MODEL ?? 'gemma3:4b';
    const tagModel     = process.env.TAG_MODEL     ?? contextModel;
    const combinedCfg  = resolveCombinedLlmConfig(process.env);
    const genTags      = process.env.TAG_GEN === '1';
    const tagViaOnnx   = process.env.TAG_PROVIDER === 'onnx';
    const required     = (genTags && !combinedCfg.enabled && !tagViaOnnx)
      ? [contextModel, tagModel]
      : [contextModel];
    const pullCmds     = availableModels.length > 0
      ? missingModelCommands(required, availableModels)
      : [];

    if (availableModels.length > 0) {
      for (const model of [...new Set(required)]) {
        report('D', availableModels.includes(model)
          ? makeResult(STATUS.PASS, `Model ${model} — pulled`)
          : makeResult(STATUS.FAIL, `Model ${model} — not pulled`,
              `Run: ollama pull ${model}`));
      }
    } else {
      report('D', makeResult(STATUS.SKIP, 'Model presence checks', 'could not fetch model list'));
    }
  }
}

// ── E: Local files ────────────────────────────────────────────────────────────

console.log('\n[E] Local files');

{
  const cfgPath = resolve(ROOT, 'config.json');
  if (existsSync(cfgPath)) {
    const n = Object.keys(configCollections).length;
    report('E', makeResult(STATUS.PASS, `config.json (${n} collection${n === 1 ? '' : 's'})`));
  } else {
    report('E', makeResult(STATUS.WARN, 'config.json missing',
      'Run npm run sync to generate it'));
  }
}

{
  // ONNX model cache — directory-level WARN only
  const needsOnnx = useOnnx
    || Object.values(configCollections).some(c => c.denseProvider === 'bge-m3-onnx');
  const modelsDir = resolve(ROOT, 'models');
  if (needsOnnx) {
    if (!existsSync(modelsDir)) {
      report('E', makeResult(STATUS.WARN, 'ONNX models/ directory missing',
        'First ONNX run will download ~2.3 GB; or run: npm run bootstrap:docs'));
    } else {
      let entries = 0;
      try { entries = readdirSync(modelsDir).length; } catch { /* ignore */ }
      report('E', entries > 0
        ? makeResult(STATUS.PASS, 'ONNX models/ cache present')
        : makeResult(STATUS.WARN, 'ONNX models/ directory empty — model not yet downloaded'));
    }
  } else {
    report('E', makeResult(STATUS.SKIP, 'ONNX models/ cache', 'ONNX not in use'));
  }
}

// ── F: ONNX / GPU ─────────────────────────────────────────────────────────────

const needsOnnxF = useOnnx
  || Object.values(configCollections).some(c => c.denseProvider === 'bge-m3-onnx');

if (needsOnnxF) {
  console.log('\n[F] ONNX / GPU');

  const ep = (process.env.ONNX_EXECUTION_PROVIDER ?? '').trim().toLowerCase() || 'cpu';
  report('F', makeResult(STATUS.PASS, `ONNX_EXECUTION_PROVIDER: ${ep}`));

  if (ep === 'cuda') {
    const modelPath     = getOnnxModelPath();
    const modelDataPath = modelPath + '.data';
    const hasModel      = existsSync(modelPath);
    const hasData       = existsSync(modelDataPath);

    if (!hasModel && !hasData) {
      report('F', makeResult(STATUS.SKIP,
        'CUDA session probe',
        'model not cached — first ONNX run downloads ~2.3 GB; probe will run after that'));
    } else if (!hasModel || !hasData) {
      const missing = !hasModel ? 'model.onnx' : 'model.onnx.data';
      report('F', makeResult(STATUS.WARN,
        'CUDA session probe skipped — ONNX model cache incomplete',
        `${missing} missing; re-run indexing to complete the download`));
    } else {
      // Runs in an ISOLATED CHILD PROCESS (local/core/onnx-provider-probe.js) —
      // doctor.js itself never loads onnxruntime-node. Uses the SAME
      // ONNXRUNTIME_NODE_PATH resolution as the real embedding path
      // (already write-backed into process.env above), so this probe
      // genuinely tests the configured custom CUDA runtime when one is set
      // — not just whatever the default npm package happens to support.
      const result = await probeOnnxProvider('cuda', { secret: KEY || undefined });
      const runtimeNote = result.runtimeSource === 'custom' ? ` (custom runtime: ${result.runtimeVersion ?? 'unknown version'})` : '';
      if (result.ok) {
        report('F', makeResult(STATUS.PASS, `CUDA session probe — CUDA is available${runtimeNote}`));
      } else if (result.modelCached === false) {
        report('F', makeResult(STATUS.SKIP, 'CUDA session probe', 'model not cached'));
      } else {
        // Real system checks (nvidia-smi, CUDA_PATH/toolkit dir, cuDNN DLL
        // presence) explain WHY, beyond the raw ORT error string —
        // diagnoseCudaFailure() never throws (see its own header comment),
        // but this stays defensive belt-and-braces, matching this file's
        // existing style, so a diagnosis bug can never turn this WARN into
        // an uncaught crash.
        let detail;
        try {
          const diagnosis = await diagnoseCudaFailure({
            errMessage: result.message, runtimeSource: result.runtimeSource,
          });
          detail = formatCudaDiagnosis(diagnosis) || formatCudaProbeFailure(result.message, process.platform);
        } catch {
          detail = formatCudaProbeFailure(result.message, process.platform);
        }
        report('F', makeResult(STATUS.WARN,
          `CUDA session probe failed — CUDA provider unavailable${runtimeNote}`,
          detail));

        // Raw GPU-stack prerequisite state (nvidia-smi driver, CUDA
        // Toolkit, cuDNN) — the same composed check
        // scripts/install-onnxruntime-cuda-windows.ps1 uses to decide
        // whether it's even worth attempting a managed CUDA build. Never
        // throws (checkPrerequisites() composes cuda-diagnosis.js's own
        // already-defensive checks), but kept in its own try/catch as
        // belt-and-braces, matching this block's existing style, so a
        // prerequisite-check bug can never turn this WARN into an
        // uncaught doctor crash.
        try {
          const prereqs = await checkPrerequisites();
          const driverNote = prereqs.nvidiaDriver.available
            ? `driver ${prereqs.nvidiaDriver.driverVersion ?? 'unknown'} (${prereqs.nvidiaDriver.gpuName ?? 'unknown GPU'})`
            : 'not detected';
          const toolkitNote = prereqs.cudaToolkit.found ? (prereqs.cudaToolkit.path ?? 'found') : 'not found';
          const cudnnNote = prereqs.cudnn.found === true ? 'found' : prereqs.cudnn.found === false ? 'not found' : 'unknown (no CUDA Toolkit path to search under)';
          report('F', makeResult(STATUS.PASS,
            'GPU-stack prerequisites (informational)',
            `NVIDIA driver: ${driverNote} | CUDA Toolkit: ${toolkitNote} | cuDNN: ${cudnnNote}`));
        } catch { /* purely informational — never escalate a check-of-a-check failure */ }
      }
    }
  } else if (ep === 'dml') {
    report('F', makeResult(STATUS.PASS,
      'Execution provider: dml — CUDA probe not applicable'));
  } else {
    report('F', makeResult(STATUS.PASS,
      'Execution provider: cpu — CUDA probe not applicable'));
  }
} else {
  console.log('\n[F] ONNX / GPU — SKIPPED (ONNX not in use)');
  collect('F', makeResult(STATUS.SKIP, 'ONNX / GPU checks', 'ONNX not in use'));
}

// ── Summary ───────────────────────────────────────────────────────────────────

const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
for (const r of allResults) counts[r.status] = (counts[r.status] ?? 0) + 1;

const exitCode = aggregateExitCode(allResults);
const line = `─`.repeat(50);

console.log(`\n${line}`);
console.log(`Results: ${counts.PASS} PASS  ${counts.WARN} WARN  ${counts.FAIL} FAIL  ${counts.SKIP} SKIP`);

// Write report to diagnostics/
const now = new Date();
const ts  = now.toISOString().replace(/[:.]/g, '').replace('T', 'T').slice(0, 15);
const diagDir = resolve(ROOT, 'diagnostics');
mkdirSync(diagDir, { recursive: true });
const reportPath = join(diagDir, `${ts}-doctor.md`);

const lines = [
  `# semidex doctor — ${now.toISOString()}`,
  '',
  '## Environment summary',
  '',
  `- Node.js: ${process.version}`,
  `- QDRANT_URL: ${redactUrl(process.env.QDRANT_URL)} (source: ${provenance('QDRANT_URL') ?? 'unknown'})`,
  `- QDRANT_KEY: ${redactKey(process.env.QDRANT_KEY)}`,
  `- OLLAMA_URL: ${redactUrl(process.env.OLLAMA_URL ?? 'http://localhost:11434')} (source: ${provenance('OLLAMA_URL') ?? 'unknown'})`,
  `- CONTEXT_MODEL: ${process.env.CONTEXT_MODEL ?? 'gemma3:4b (default)'} (source: ${provenance('CONTEXT_MODEL') ?? 'unknown'})`,
  `- TAG_MODEL: ${process.env.TAG_MODEL ?? `CONTEXT_MODEL (${process.env.CONTEXT_MODEL ?? 'gemma3:4b'})`} (source: ${provenance('TAG_MODEL') ?? 'unknown'})`,
  `- TAG_GEN: ${process.env.TAG_GEN === '1' ? 'enabled (TAG_GEN=1)' : 'disabled (default)'} (source: ${provenance('TAG_GEN') ?? 'unknown'})`,
  `- ONNX_EMBED: ${process.env.ONNX_EMBED ?? '(not set)'}`,
  '',
  '## Check results',
  '',
];

let currentGroup = '';
for (const r of allResults) {
  if (r.group !== currentGroup) {
    const groupNames = { A: 'Runtime environment', B: 'Qdrant connectivity', C: 'Collection schema', D: 'Ollama', E: 'Local files', F: 'ONNX / GPU' };
    lines.push(`### [${r.group}] ${groupNames[r.group] ?? r.group}`);
    lines.push('');
    currentGroup = r.group;
  }
  lines.push(formatResult(r).trimStart());
}

lines.push('');
lines.push('## Summary');
lines.push('');
lines.push(`Results: ${counts.PASS} PASS  ${counts.WARN} WARN  ${counts.FAIL} FAIL  ${counts.SKIP} SKIP`);
lines.push(`Exit code: ${exitCode}`);
lines.push('');

writeFileSync(reportPath, lines.join('\n'), 'utf-8');
const relReport = relative(ROOT, reportPath).replace(/\\/g, '/');
console.log(`Report: ${relReport}`);
console.log(`Exit code: ${exitCode}`);

// Set exit code without calling process.exit() — lets AbortSignal timer handles
// drain naturally, avoiding a Windows libuv assertion on Node.js v25.
process.exitCode = exitCode;
