export default async function ({ ok, withConfig }) {
  console.log('\n[15] bootstrap-docs helpers (pure, no Qdrant)');

  const {
    resolveRepoRoot,
    getBootstrapSources,
    checkCollisionGuard,
    buildIndexerEnv,
    applyManagedConfig,
  } = await import('../../bootstrap-docs.js');
  const { isAbsolute, basename } = await import('path');

  // 15a. resolveRepoRoot() returns an absolute path
  const root = resolveRepoRoot();
  ok('resolveRepoRoot returns absolute path', isAbsolute(root));

  // 15b. source list contains README.md, AGENTS.md, and docs/en
  const sources = getBootstrapSources(root);
  ok('bootstrap sources include README.md',  sources.some(s => basename(s) === 'README.md'));
  ok('bootstrap sources include AGENTS.md',  sources.some(s => basename(s) === 'AGENTS.md'));
  ok('bootstrap sources include docs/en',    sources.some(s => s.endsWith('docs' + (process.platform === 'win32' ? '\\' : '/') + 'en') || s.includes('docs/en') || s.includes('docs\\en')));
  ok('bootstrap sources has exactly 3 entries', sources.length === 3);
  ok('all source entries are non-empty strings', sources.every(s => typeof s === 'string' && s.length > 0));

  // 15c. buildIndexerEnv defaults to ONNX but respects explicit opt-out
  {
    const envDefault = buildIndexerEnv({}, root);
    ok('buildIndexerEnv default sets ONNX_EMBED=1', envDefault.ONNX_EMBED === '1');
    ok('buildIndexerEnv sets COLLECTION=semidex-docs', envDefault.COLLECTION === 'semidex-docs');
    ok('buildIndexerEnv sets SOURCE_ROOT to repo root', envDefault.SOURCE_ROOT === root);

    const envOptOut = buildIndexerEnv({ ONNX_EMBED: '0' }, root);
    ok('buildIndexerEnv respects ONNX_EMBED=0 opt-out', envOptOut.ONNX_EMBED === '0');
  }

  // 15d. applyManagedConfig writes provider + management metadata
  {
    const cfg = applyManagedConfig({ collections: {} }, buildIndexerEnv({}, root));
    const entry = cfg.collections?.['semidex-docs'];
    ok('applyManagedConfig writes semidexManaged:true', entry?.semidexManaged === true);
    ok('applyManagedConfig writes ONNX denseProvider by default', entry?.denseProvider === 'bge-m3-onnx');
    ok('applyManagedConfig writes ONNX sparseProvider by default', entry?.sparseProvider === 'bge-m3-onnx');

    const fallback = applyManagedConfig({ collections: {} }, buildIndexerEnv({ ONNX_EMBED: '0' }, root));
    ok('applyManagedConfig respects ONNX_EMBED=0 dense fallback',
      fallback.collections?.['semidex-docs']?.denseProvider === 'ollama');
    ok('applyManagedConfig respects ONNX_EMBED=0 sparse fallback',
      fallback.collections?.['semidex-docs']?.sparseProvider === 'hashed-tf');
  }

  // 15e. semidexManaged config field round-trips through loadConfig/saveConfig
  await withConfig(
    { collections: { 'semidex-docs': { semidexManaged: true, description: 'test' } } },
    async () => {
      const { loadConfig } = await import('../../core/config.js');
      const cfg = loadConfig();
      ok('semidexManaged:true survives loadConfig round-trip',
        cfg.collections?.['semidex-docs']?.semidexManaged === true);
    },
  );

  // 15f. Collision guard: non-managed existing collection → returns error string
  {
    const existsButNotManaged = true;
    const configNoManaged = { collections: { 'semidex-docs': { denseProvider: 'ollama' } } };
    const err = checkCollisionGuard(existsButNotManaged, configNoManaged);
    ok('non-managed existing collection → returns error string', typeof err === 'string' && err.length > 0);
    ok('error string mentions semidex-docs',   err.includes('semidex-docs'));
    ok('error string mentions semidexManaged',  err.includes('semidexManaged'));
  }

  // 15g. Collision guard: collection does not exist → returns null (safe to proceed)
  {
    const err = checkCollisionGuard(false, {});
    ok('collection absent → no collision (null)', err === null);
  }

  // 15h. Collision guard: exists + semidexManaged:true → returns null (safe to re-run)
  {
    const configManaged = { collections: { 'semidex-docs': { semidexManaged: true } } };
    const err = checkCollisionGuard(true, configManaged);
    ok('semidexManaged:true existing collection → no collision (null)', err === null);
  }
}
