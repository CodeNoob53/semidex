import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MISSING_MODEL_PATH = 'Z:/semidex-provider-registration-probe/no-model.onnx';

export function classifyProviderRegistrationError(error) {
  const message = String(error?.message ?? error ?? '').replace(/\r?\n.*/s, '').trim();

  if (/backend not found|executionProviders.*unsupported/i.test(message)) {
    return { registered: false, message };
  }

  if (/file.*doesn'?t exist|no such file|load model.*failed/i.test(message)) {
    return { registered: true, message };
  }

  return { registered: null, message };
}

export async function probeProviderRegistration(ort, provider) {
  try {
    await ort.InferenceSession.create(MISSING_MODEL_PATH, {
      executionProviders: [provider],
    });
    return {
      provider,
      registered: null,
      message: 'Unexpectedly created a session with the missing probe model.',
    };
  } catch (error) {
    return { provider, ...classifyProviderRegistrationError(error) };
  }
}

export async function runProviderRegistrationProbe(ort) {
  const results = [];
  for (const provider of ['cuda', 'dml', 'cpu']) {
    results.push(await probeProviderRegistration(ort, provider));
  }
  return results;
}

export function resolveProbeRuntime(env = process.env) {
  const customPath = String(env.ONNXRUNTIME_NODE_PATH ?? '').trim();
  return customPath
    ? { modulePath: resolve(customPath), custom: true }
    : { modulePath: 'onnxruntime-node', custom: false };
}

function formatStatus(registered) {
  if (registered === true) return 'registered';
  if (registered === false) return 'not registered';
  return 'unknown';
}

async function main() {
  const require = createRequire(import.meta.url);
  const runtime = resolveProbeRuntime();
  const ort = runtime.custom
    ? require(runtime.modulePath)
    : await import(runtime.modulePath);
  const { version } = runtime.custom
    ? require(join(runtime.modulePath, 'package.json'))
    : require('onnxruntime-node/package.json');
  const results = await runProviderRegistrationProbe(ort);

  console.log(`onnxruntime-node ${version} on ${process.platform}/${process.arch}`);
  console.log(`runtime ${runtime.custom ? runtime.modulePath : 'project dependency'}`);
  for (const result of results) {
    console.log(`${result.provider.padEnd(5)} ${formatStatus(result.registered)}`);
    console.log(`      ${result.message}`);
  }

  const cuda = results.find((result) => result.provider === 'cuda');
  if (process.argv.includes('--require-cuda') && cuda?.registered !== true) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await main();
}
