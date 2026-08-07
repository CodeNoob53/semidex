// semidex-lite doctor — read-only environment health check. STRICTLY never
// creates/mutates a Qdrant collection, runs inference, loads ONNX, probes
// CUDA/DML, or contacts Ollama — even indirectly (never imports
// core/ollama.js/core/onnx-*.js). Checks: Node version, .env presence,
// QDRANT_URL/QDRANT_KEY presence + reachability (Tier 1 —
// checkQdrantReachable(), never inference), Gemini config presence
// (redacted), profile compatibility. The disposable-collection inference
// round-trip (probeQdrantCloudInference — Tier 2, creates+deletes a real
// collection) runs ONLY when the caller passes probeInference: true
// (bin/semidex-lite.js's --probe-inference flag), and this function prints
// an explicit warning before doing so.
import {
  redactKey, redactUrl, sanitiseErrorMessage,
  makeResult, aggregateExitCode, formatResult,
  checkNodeVersion, STATUS,
} from '../src/core/doctor-checks.js';
import { checkQdrantReachable, probeQdrantCloudInference } from '../src/cloud/admin/qdrant-cloud-system.js';
import {
  QDRANT_CLOUD_DENSE_MODELS,
  findDenseModel,
} from '../src/cloud/embedding/qdrant-cloud-catalog.js';
import { resolveNewCollectionProfile } from '../src/core/embedding-profile/resolve.js';

function safe(msg) {
  return sanitiseErrorMessage(String(msg ?? ''), [process.env.QDRANT_KEY, process.env.GEMINI_API_KEY]);
}

/**
 * checkQdrantReachableFn/probeQdrantCloudInferenceFn are dependency-
 * injectable so unit tests never issue a real Qdrant Cloud request — same
 * DI convention as cloud/admin/qdrant-cloud-api.js's own runProbeFn.
 * @param {{ probeInference?: boolean, semidexHome?: string, checkQdrantReachableFn?: typeof checkQdrantReachable, probeQdrantCloudInferenceFn?: typeof probeQdrantCloudInference }} [opts]
 * @returns {Promise<number>} process exit code (0 = PASS/WARN/SKIP only, 1 = any FAIL)
 */
export async function runDoctor({
  probeInference = false, semidexHome,
  checkQdrantReachableFn = checkQdrantReachable,
  probeQdrantCloudInferenceFn = probeQdrantCloudInference,
} = {}) {
  const results = [];
  const report = (r) => { results.push(r); console.log(formatResult(r)); };

  console.log('\n[A] Runtime environment');
  report(checkNodeVersion(process.version));
  report(makeResult(STATUS.PASS, `SEMIDEX_HOME: ${semidexHome ?? '(not set)'}`));

  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantKey = process.env.QDRANT_KEY;
  report(qdrantUrl
    ? makeResult(STATUS.PASS, `QDRANT_URL: ${redactUrl(qdrantUrl)}`)
    : makeResult(STATUS.FAIL, 'QDRANT_URL not set', 'Set QDRANT_URL=https://... (Qdrant Cloud cluster URL)'));
  report(qdrantKey
    ? makeResult(STATUS.PASS, `QDRANT_KEY: ${redactKey(qdrantKey)}`)
    : makeResult(STATUS.FAIL, 'QDRANT_KEY not set', 'Set QDRANT_KEY=... (Qdrant Cloud API key)'));

  const geminiKey = process.env.GEMINI_API_KEY;
  report(geminiKey
    ? makeResult(STATUS.PASS, `GEMINI_API_KEY: ${redactKey(geminiKey)}`)
    : makeResult(STATUS.WARN, 'GEMINI_API_KEY not set', 'Ask/generation will be unavailable until this is set'));

  console.log('\n[B] Qdrant Cloud connectivity (read-only)');
  if (!qdrantUrl || !qdrantKey) {
    report(makeResult(STATUS.SKIP, 'Qdrant reachability', 'QDRANT_URL/QDRANT_KEY not set'));
  } else {
    try {
      const result = await checkQdrantReachableFn();
      if (result.status === 'ok') {
        report(makeResult(STATUS.PASS, 'Qdrant Cloud reachable and authenticated'));
      } else if (result.status === 'auth_failed') {
        report(makeResult(STATUS.FAIL, 'Qdrant Cloud auth failed', safe(result.message)));
      } else {
        report(makeResult(STATUS.FAIL, 'Qdrant Cloud unreachable', safe(result.message)));
      }
    } catch (err) {
      report(makeResult(STATUS.FAIL, 'Qdrant Cloud check failed', safe(err.message)));
    }
  }

  console.log('\n[C] Cloud Inference round-trip (--probe-inference)');
  if (!probeInference) {
    report(makeResult(STATUS.SKIP, 'Cloud Inference probe', 'run with --probe-inference to test a real embedding round-trip'));
  } else if (!qdrantUrl || !qdrantKey) {
    report(makeResult(STATUS.SKIP, 'Cloud Inference probe', 'QDRANT_URL/QDRANT_KEY not set'));
  } else {
    console.log('  ⚠ This will temporarily create and delete a disposable collection in your Qdrant Cloud cluster.');
    const defaultDenseModelId = QDRANT_CLOUD_DENSE_MODELS.find((model) => model.status === 'supported')?.id;
    const denseModelId = process.env.QDRANT_CLOUD_DENSE_MODEL || defaultDenseModelId;
    const denseModel = denseModelId ? findDenseModel(denseModelId) : null;
    if (!denseModel || denseModel.status !== 'supported') {
      report(makeResult(STATUS.FAIL, 'Cloud Inference probe skipped',
        `QDRANT_CLOUD_DENSE_MODEL="${denseModelId ?? '(unset)'}" is not a supported Qdrant Cloud dense model`));
    } else {
      try {
        const profile = resolveNewCollectionProfile(
          { denseProvider: 'qdrant-cloud', denseModel: denseModel.id, sparseProvider: 'qdrant-cloud' },
          { embeddingSchemaVersion: 2 },
        );
        const result = await probeQdrantCloudInferenceFn({ profile });
        if (result.status === 'inference_available') {
          report(makeResult(STATUS.PASS, `Cloud Inference round-trip succeeded (${denseModel.id})`));
        } else {
          report(makeResult(STATUS.FAIL, 'Cloud Inference round-trip failed', safe(result.message)));
        }
      } catch (err) {
        report(makeResult(STATUS.FAIL, 'Cloud Inference round-trip failed', safe(err.message)));
      }
    }
  }

  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`\nResults: ${counts.PASS} PASS  ${counts.WARN} WARN  ${counts.FAIL} FAIL  ${counts.SKIP} SKIP`);

  return aggregateExitCode(results);
}
