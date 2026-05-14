// Pure validation helper — testable without network.
// required: string[] of model names needed (e.g. ['gemma3:4b', 'gemma3:4b'])
// available: string[] of model names returned by GET /api/tags (name field)
// Returns null if ok, or an array of missing model names (deduped).
// Exact match only — if you pull gemma3:4b, set CONTEXT_MODEL=gemma3:4b.
export function validateOllamaModels(required, available) {
  const availSet = new Set(available);
  const missing = [];
  for (const model of new Set(required)) {
    if (!availSet.has(model)) missing.push(model);
  }
  return missing.length ? missing : null;
}

// Impure: fetches /api/version and /api/tags, throws with actionable message on failure.
export async function checkOllamaPreflight(ollamaUrl, contextModel, tagModel) {
  const base = ollamaUrl.replace(/\/$/, '');

  // 1. Reachability check
  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    const isLocalhost = /localhost/i.test(base);
    const hint = isLocalhost
      ? `\n  Tip: on Windows, Node.js may route localhost through a proxy.\n  Try: OLLAMA_URL=http://127.0.0.1:11434`
      : '';
    throw new Error(
      `[preflight] Ollama unreachable at ${base}\n` +
      `  Start Ollama with: ollama serve${hint}\n` +
      `  Original error: ${err.message}`
    );
  }

  // 2. Model availability check
  let available;
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    available = (data.models ?? []).map(m => m.name);
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models from ${base}/api/tags: ${err.message}`);
  }

  const missing = validateOllamaModels([contextModel, tagModel], available);
  if (missing) {
    const cmds = missing.map(m => `  ollama pull ${m}`).join('\n');
    throw new Error(
      `[preflight] Required Ollama model(s) not pulled:\n${cmds}\n` +
      `  Then retry indexing.`
    );
  }
}

// Process-level cache: runs preflight at most once per indexer invocation.
// Subsequent calls (one per changed file) are no-ops after the first success.
let _preflightDone = false;
export async function ensureOllamaPreflight(ollamaUrl, contextModel, tagModel) {
  if (_preflightDone) return;
  await checkOllamaPreflight(ollamaUrl, contextModel, tagModel);
  _preflightDone = true;
}
