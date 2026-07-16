import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsService, applyEnvWriteBack } from '../../../../src/core/settings/service.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

describe('SettingsService — precedence', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('os_env > dotenv > settings.json > default, for a next_search field (not frozen)', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');

    // default only
    let svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(join(dir, 'nope')) });
    // (nonexistent path -> empty settings, so RRF_K falls to default)
    assert.equal(svc.getActiveValue('RRF_K'), 60);

    // settings.json wins over default
    svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 90);
    assert.equal(svc.get('RRF_K').source, 'config_json');

    // dotenv wins over settings.json
    svc = createSettingsService({ osEnv: {}, dotenvValues: { RRF_K: '70' }, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 70);
    assert.equal(svc.get('RRF_K').source, 'dotenv');

    // os_env wins over dotenv and settings.json
    svc = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: { RRF_K: '70' }, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 50);
    assert.equal(svc.get('RRF_K').source, 'os_env');
  });

  test('get() returns null for an unknown key', () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    assert.equal(svc.get('NOT_A_REAL_KEY'), null);
  });

  test('getActiveValue() throws for an unknown key', () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    assert.throws(() => svc.getActiveValue('NOT_A_REAL_KEY'));
  });
});

describe('SettingsService — next_restart freezing', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('activeValue for a next_restart field is frozen at construction and does not change after a later settings.json write', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.getActiveValue('OLLAMA_URL'), 'http://localhost:11434');

    await svc.setMany({ OLLAMA_URL: 'http://changed:11434' });

    // configuredValue reflects the write, activeValue stays frozen
    const entry = svc.get('OLLAMA_URL');
    assert.equal(entry.configuredValue, 'http://changed:11434');
    assert.equal(entry.activeValue, 'http://localhost:11434');
    assert.equal(entry.pendingRestart, true);
    assert.equal(svc.getActiveValue('OLLAMA_URL'), 'http://localhost:11434');
  });

  test('a fresh service instance (simulating a restart) picks up the new value with pendingRestart false', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc1 = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await svc1.setMany({ OLLAMA_URL: 'http://changed:11434' });

    const svc2 = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc2.getActiveValue('OLLAMA_URL'), 'http://changed:11434');
    assert.equal(svc2.get('OLLAMA_URL').pendingRestart, false);
  });

  test('a non-frozen (next_search) field is NOT affected by freezing — resolves live', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 60);
    await svc.setMany({ RRF_K: 90 });
    assert.equal(svc.getActiveValue('RRF_K'), 90);
    assert.equal(svc.get('RRF_K').pendingRestart, false);
  });

  test('configuredSource/activeSource split (code review): after PATCHing a next_restart field, configuredValue/configuredSource are live while activeValue/activeSource stay frozen — the exact scenario a single "source" field cannot express', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    // ASK_MODEL starts unset -> resolves from default.
    const before = svc.get('ASK_MODEL');
    assert.equal(before.configuredValue, 'gemma3:4b');
    assert.equal(before.configuredSource, 'default');
    assert.equal(before.activeSource, 'default');

    await svc.setMany({ ASK_MODEL: 'llama3' });

    const after = svc.get('ASK_MODEL');
    assert.equal(after.configuredValue, 'llama3');
    assert.equal(after.configuredSource, 'config_json');
    assert.equal(after.activeValue, 'gemma3:4b');
    assert.equal(after.activeSource, 'default');
    assert.equal(after.pendingRestart, true);
    // Deprecated alias stays equal to activeSource, never silently drops the distinction.
    assert.equal(after.source, after.activeSource);
  });
});

describe('SettingsService — refreshIfChanged', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('does not pick up an external settings.json write until refreshIfChanged is called', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 60);

    // Simulate a second process writing settings.json directly.
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 99 }), 'utf-8');
    // mtime resolution can be coarse on some filesystems — wait briefly to
    // guarantee a distinguishable mtime.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 99 }), 'utf-8');

    assert.equal(svc.getActiveValue('RRF_K'), 60, 'must not auto-pick-up external writes');
    const changed = svc.refreshIfChanged();
    assert.equal(changed, true);
    assert.equal(svc.getActiveValue('RRF_K'), 99);
  });

  test('returns false and does not re-read when nothing changed', () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.refreshIfChanged(), false);
  });
});

describe('SettingsService — setMany all-or-nothing', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('one bad key aborts the whole batch (zero partial writes)', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await assert.rejects(
      () => svc.setMany({ RRF_K: 90, MAX_CHUNK_TOKENS: 999999 }), // MAX_CHUNK_TOKENS out of bounds
      (err) => err.code === 'invalid_value'
    );
    assert.equal(svc.getActiveValue('RRF_K'), 60, 'RRF_K must not have been written');
  });

  test('unknown key is rejected with code unknown_key', async () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await assert.rejects(() => svc.setMany({ NOT_A_REAL_KEY: 1 }), (err) => err.code === 'unknown_key');
  });

  test('non-writable key is rejected with code not_writable', async () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await assert.rejects(() => svc.setMany({ QDRANT_KEY: 'secret-value' }), (err) => err.code === 'not_writable');
  });

  test('409-equivalent: writing a real value to an os_env-overridden key is rejected with code setting_overridden', async () => {
    const svc = createSettingsService({ osEnv: { RRF_K: '99' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await assert.rejects(
      () => svc.setMany({ RRF_K: 70 }),
      (err) => err.code === 'setting_overridden' && err.overriddenKey === 'RRF_K' && err.overriddenSource === 'os_env'
    );
  });

  test('successful batch writes all keys atomically to settings.json', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    const entries = await svc.setMany({ RRF_K: 90, HYBRID_PREFETCH_LIMIT: 5 });
    assert.equal(entries.length, 2);
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(onDisk.RRF_K, 90);
    assert.equal(onDisk.HYBRID_PREFETCH_LIMIT, 5);
  });
});

describe('SettingsService — null (remove local override) semantics', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('reset-to-default: no env override, settings.json has a stored value; PATCH null removes it and falls to default', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    assert.equal(svc.getActiveValue('RRF_K'), 90);

    await svc.setMany({ RRF_K: null });

    assert.equal(svc.getActiveValue('RRF_K'), 60);
    assert.equal(svc.get('RRF_K').source, 'default');
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal('RRF_K' in onDisk, false);
  });

  test('reset-to-env: an OS-env value exists; after reset, active value/source reflects os_env, not default', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const svc = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: {}, settingsPath });
    assert.equal(svc.get('RRF_K').source, 'os_env'); // env already wins even before reset
    assert.equal(svc.get('RRF_K').hasLocalOverride, true);

    await svc.setMany({ RRF_K: null });

    assert.equal(svc.getActiveValue('RRF_K'), 50);
    assert.equal(svc.get('RRF_K').source, 'os_env');
    assert.equal(svc.get('RRF_K').hasLocalOverride, false);
  });

  test('batch reset: one PATCH with a null and a real value, neither overridden, both apply atomically', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });

    await svc.setMany({ RRF_K: null, HYBRID_PREFETCH_LIMIT: 5 });

    assert.equal(svc.getActiveValue('RRF_K'), 60);
    assert.equal(svc.getActiveValue('HYBRID_PREFETCH_LIMIT'), 5);
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal('RRF_K' in onDisk, false);
    assert.equal(onDisk.HYBRID_PREFETCH_LIMIT, 5);
  });

  test('reset of a hidden local fallback under an active env override succeeds (no 409) even though activeValue is unchanged', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const svc = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: {}, settingsPath });

    const before = svc.getActiveValue('RRF_K');
    await assert.doesNotReject(() => svc.setMany({ RRF_K: null }));
    const after = svc.getActiveValue('RRF_K');

    assert.equal(before, 50);
    assert.equal(after, 50);
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal('RRF_K' in onDisk, false);
  });

  test('mixed-batch rejection: a null for a non-overridden key alongside a real value for an overridden key 409s the whole batch, including the otherwise-valid null', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90, HYBRID_PREFETCH_LIMIT: 3 }), 'utf-8');
    const svc = createSettingsService({ osEnv: { HYBRID_PREFETCH_LIMIT: '9' }, dotenvValues: {}, settingsPath });

    await assert.rejects(
      () => svc.setMany({ RRF_K: null, HYBRID_PREFETCH_LIMIT: 5 }),
      (err) => err.code === 'setting_overridden'
    );

    // Neither change applied — RRF_K's local value must still be present.
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(onDisk.RRF_K, 90);
  });

  test('hasLocalOverride is independent of source — true + os_env simultaneously is the exact case a naive source check would get wrong', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const svc = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: {}, settingsPath });
    const entry = svc.get('RRF_K');
    assert.equal(entry.source, 'os_env');
    assert.equal(entry.hasLocalOverride, true);
  });

  test('null change for a secret key is still rejected (secrets are never writable, incl. deletion attempts)', async () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await assert.rejects(() => svc.setMany({ QDRANT_KEY: null }), (err) => err.code === 'not_writable');
  });
});

describe('SettingsService — widened entry metadata (UI registry extension)', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a numeric entry carries min/max/description/advanced from the registry', () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const entry = svc.get('MAX_CHUNK_TOKENS');
    assert.equal(entry.min, 1);
    assert.equal(entry.max, 100000);
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0);
    assert.equal(entry.advanced, false);
  });

  test('an enum entry carries options matching its validate() acceptance set', () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const entry = svc.get('TAG_PROVIDER');
    assert.deepEqual(entry.options, [{ value: 'ollama', label: 'ollama' }, { value: 'onnx', label: 'onnx' }]);
  });

  test('a string entry carries allowEmpty', () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const entry = svc.get('QDRANT_URL');
    assert.equal(entry.allowEmpty, false);
  });
});

describe('applyEnvWriteBack — code-review fix: every writable field reaches process.env, not a hand-picked subset', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('writes QDRANT_URL (the exact field a hand-picked write-back list previously missed) into the target env object', async () => {
    // QDRANT_URL is next_restart — a value saved via settings.json AFTER
    // this process's SettingsService was constructed only becomes the
    // activeValue on the NEXT process (see the "next_restart freezing"
    // describe block above), so this test simulates the real sequence: a
    // value already present in settings.json BEFORE construction, which
    // applyEnvWriteBack() must still successfully write into the target env.
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ QDRANT_URL: 'http://saved-host:6333' }), 'utf-8');
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });

    const fakeEnv = {};
    applyEnvWriteBack(svc, fakeEnv);
    assert.equal(fakeEnv.QDRANT_URL, 'http://saved-host:6333');
  });

  test('writes every writable, non-secret, genuinely-overridden field with a real envVar — not a hand-curated subset', () => {
    // Every field below has a real OS-env override, so all are "genuine",
    // non-default sources — this proves coverage isn't a hand-picked list,
    // without tripping the new default-skip behavior (tested separately
    // below).
    const svc = createSettingsService({
      osEnv: { RRF_K: '90', MAX_CHUNK_TOKENS: '600', OLLAMA_URL: 'http://x:11434', QDRANT_URL: 'http://y:6333', ADMIN_PORT: '9000', TOKEN_COUNT: 'heuristic' },
      dotenvValues: {}, settingsPath: tempSettingsPath(dir),
    });
    const fakeEnv = {};
    applyEnvWriteBack(svc, fakeEnv);
    for (const key of ['RRF_K', 'MAX_CHUNK_TOKENS', 'OLLAMA_URL', 'QDRANT_URL', 'ADMIN_PORT', 'TOKEN_COUNT']) {
      assert.ok(key in fakeEnv, `${key} was not written back`);
    }
  });

  test('never writes a secret field (QDRANT_KEY) even if it has a real active value', () => {
    const svc = createSettingsService({ osEnv: { QDRANT_KEY: 'super-secret' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const fakeEnv = {};
    applyEnvWriteBack(svc, fakeEnv);
    assert.equal('QDRANT_KEY' in fakeEnv, false);
  });

  test('defaults to writing into process.env when no target env object is supplied', async () => {
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await svc.setMany({ RRF_K: 77 });
    const original = process.env.RRF_K;
    try {
      applyEnvWriteBack(svc);
      assert.equal(process.env.RRF_K, '77');
    } finally {
      if (original === undefined) delete process.env.RRF_K;
      else process.env.RRF_K = original;
    }
  });

  test('code review fix (P1): never writes a field whose source is "default" — a materialized default looks like an explicit override to presence-checking readers', () => {
    // Nothing set anywhere -> DENSE_PROVIDER resolves to its own default
    // ('ollama'). Writing that into env would make
    // core/config.js's `if (process.env.DENSE_PROVIDER)` presence-check
    // treat it as an explicit user choice, silently overriding the
    // ONNX_EMBED=1 shorthand (the exact reproduced bug from code review).
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    assert.equal(svc.get('DENSE_PROVIDER').source, 'default');
    const fakeEnv = {};
    applyEnvWriteBack(svc, fakeEnv);
    assert.equal('DENSE_PROVIDER' in fakeEnv, false);
  });

  test('reproduces the exact ONNX_EMBED=1 scenario from code review: DENSE_PROVIDER must not leak into env, so the shorthand still resolves to bge-m3-onnx', () => {
    const svc = createSettingsService({ osEnv: { ONNX_EMBED: '1' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const fakeEnv = { ONNX_EMBED: '1' };
    applyEnvWriteBack(svc, fakeEnv);
    assert.equal('DENSE_PROVIDER' in fakeEnv, false, 'DENSE_PROVIDER must not be materialized from its own default');

    // Mirrors core/config.js's resolveEnvProviders() precedence exactly.
    function resolveEnvProviders(env) {
      if (env.DENSE_PROVIDER) return { denseProvider: env.DENSE_PROVIDER };
      if (env.ONNX_EMBED === '1') return { denseProvider: 'bge-m3-onnx' };
      return { denseProvider: 'ollama' };
    }
    assert.equal(resolveEnvProviders(fakeEnv).denseProvider, 'bge-m3-onnx');
  });

  test('still writes a field whose source is os_env/dotenv/config_json — only "default" is skipped', async () => {
    const settingsPath = tempSettingsPath(dir);
    const svc = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await svc.setMany({ RRF_K: 90 }); // config_json tier
    const fakeEnv = {};
    applyEnvWriteBack(svc, fakeEnv);
    assert.equal(fakeEnv.RRF_K, '90');
  });
});
