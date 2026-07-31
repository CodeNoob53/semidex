import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkUiAssets, stageDist } from '../../../packages/lite/build.mjs';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-ui-assets-'));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(root, relativePath, content = '') {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Semidex Lite UI package validation', () => {
  it('fails staging when the Vite output is missing', () => {
    const root = makeTempDir();
    assert.throws(
      () => stageDist({ source: join(root, 'missing'), destination: join(root, 'staged') }),
      /admin:build:lite/,
    );
  });

  it('rejects an empty staged UI', () => {
    const uiDir = makeTempDir();
    const errors = checkUiAssets(uiDir);
    assert.ok(errors.some((error) => error.includes('index.html')));
    assert.ok(errors.some((error) => error.includes('ui-asset:empty')));
  });

  it('rejects an index that references a missing local asset', () => {
    const uiDir = makeTempDir();
    writeFixture(uiDir, 'index.html', '<script type="module" src="/assets/app.js"></script>');
    const errors = checkUiAssets(uiDir);
    assert.ok(errors.some((error) => error.includes('missing-reference') && error.includes('/assets/app.js')));
  });

  it('accepts a complete UI and stageDist copies it', () => {
    const root = makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'staged');
    writeFixture(source, 'index.html', '<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>');
    writeFixture(source, 'assets/app.css', 'body { color: black; }');
    writeFixture(source, 'assets/app.js', 'console.log("lite");');

    stageDist({ source, destination });

    const uiDir = join(destination, 'admin-ui');
    assert.equal(existsSync(join(uiDir, 'assets', 'app.js')), true);
    assert.deepEqual(checkUiAssets(uiDir), []);
  });

  it('rejects local-only controls in a staged asset', () => {
    const uiDir = makeTempDir();
    writeFixture(uiDir, 'index.html', '<script type="module" src="/app.js"></script>');
    writeFixture(uiDir, 'app.js', 'fetch("/api/system/onnx-probe");');
    const errors = checkUiAssets(uiDir);
    assert.ok(errors.some((error) => error.includes('forbidden-marker')));
  });
});
