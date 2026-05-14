export default async function ({ ok }) {
  console.log('\n[18] validateOllamaModels (pure, no network)');

  const { validateOllamaModels } = await import('../../indexer/preflight.js');

  // All models present — exact match
  ok('all present (exact) → null',
    validateOllamaModels(['gemma3:4b', 'gemma3:4b'], ['gemma3:4b', 'llama3']) === null);

  // Exact match only — gemma3 is NOT satisfied by gemma3:4b (use exact tag in env)
  ok('exact-only: gemma3 not satisfied by gemma3:4b (missing)',
    validateOllamaModels(['gemma3'], ['gemma3:4b', 'llama3']) !== null);
  ok('exact-only: gemma3:4b satisfied by gemma3:4b → null',
    validateOllamaModels(['gemma3:4b'], ['gemma3:4b', 'llama3']) === null);

  // One model missing
  {
    const result = validateOllamaModels(['gemma3:4b', 'llama3'], ['gemma3:4b']);
    ok('one missing → non-null result', result !== null);
    ok('one missing → reports llama3', Array.isArray(result) && result.includes('llama3'));
    ok('one missing → does not report gemma3:4b', Array.isArray(result) && !result.includes('gemma3:4b'));
  }

  // Both models missing
  {
    const result = validateOllamaModels(['gemma3:4b', 'llama3'], []);
    ok('both missing → 2 entries', Array.isArray(result) && result.length === 2);
  }

  // Same model for context and tag — missing → reported once, not duplicated
  {
    const result = validateOllamaModels(['gemma3:4b', 'gemma3:4b'], []);
    ok('same model missing twice → reported once (deduped)', Array.isArray(result) && result.length === 1);
  }

  // Empty required list → ok
  ok('no required models → null', validateOllamaModels([], ['gemma3:4b']) === null);

  // Available list empty, nothing required → ok
  ok('no required, no available → null', validateOllamaModels([], []) === null);
}
