// core/materialize.mjs — offline, real filesystem writes to a scratch
// temp dir (never src/, never a real indexing run).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { docIdToFilename, materializeDataset } from './core/materialize.mjs';
import { materializedDir } from './core/isolated-config.mjs';

const writtenDirs = [];
afterEach(() => {
  for (const dir of writtenDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('docIdToFilename()', () => {
  it('produces a "doc-<id>.md" filename for a simple alnum ID', () => {
    assert.equal(docIdToFilename('31715818'), 'doc-31715818.md');
  });

  it('sanitizes unsafe characters conservatively', () => {
    assert.equal(docIdToFilename('a/b:c*d'), 'doc-a_b_c_d.md');
  });
});

describe('materializeDataset()', () => {
  it('writes one file per corpus document under .cache/materialized/, never a tracked source path', () => {
    const runSuffix = `test-${Date.now()}`;
    const corpus = new Map([
      ['doc-1', { title: 'A', text: 'first document' }],
      ['doc-2', { title: 'B', text: 'second document' }],
    ]);
    const { dir, sourceFileToDocId, docIdToSourceFile } = materializeDataset({
      suiteId: 'unit-test-suite',
      profileId: 'local',
      runSuffix,
      corpus,
      toMarkdown: (doc) => `# ${doc.title}\n\n${doc.text}`,
    });
    writtenDirs.push(dir);

    const expectedDir = materializedDir('unit-test-suite', 'local', runSuffix);
    assert.equal(dir, expectedDir);
    assert.ok(dir.includes('.cache'), 'materialized dir must live under .cache/');
    assert.ok(dir.includes('materialized'));

    assert.equal(sourceFileToDocId.size, 2);
    assert.equal(sourceFileToDocId.get('doc-doc-1.md'), 'doc-1');
    assert.equal(docIdToSourceFile.get('doc-1'), 'doc-doc-1.md');

    const content = readFileSync(resolve(dir, 'doc-doc-1.md'), 'utf-8');
    assert.equal(content, '# A\n\nfirst document');
  });

  it('filename<->docID round-trip is exact for every entry', () => {
    const runSuffix = `test-${Date.now()}-roundtrip`;
    const corpus = new Map([['x', { text: '1' }], ['y', { text: '2' }], ['z', { text: '3' }]]);
    const { dir, sourceFileToDocId, docIdToSourceFile } = materializeDataset({
      suiteId: 'unit-test-suite', profileId: 'cloud', runSuffix, corpus,
      toMarkdown: (doc) => doc.text,
    });
    writtenDirs.push(dir);
    for (const [docId, sourceFile] of docIdToSourceFile) {
      assert.equal(sourceFileToDocId.get(sourceFile), docId);
    }
  });

  it('throws on a filename collision — two distinct doc IDs sanitizing to the same filename — rather than silently losing a document', () => {
    const runSuffix = `test-${Date.now()}-collision`;
    // "a/b" and "a_b" both sanitize to "doc-a_b.md".
    const corpus = new Map([['a/b', { text: '1' }], ['a_b', { text: '2' }]]);
    assert.throws(() => materializeDataset({
      suiteId: 'unit-test-suite', profileId: 'local', runSuffix, corpus,
      toMarkdown: (doc) => doc.text,
    }), /collision/);
  });

  it('accepts a plain array of [docId, doc] entries, not only a Map', () => {
    const runSuffix = `test-${Date.now()}-array`;
    const corpus = [['a', { text: 'x' }], ['b', { text: 'y' }]];
    const { dir, sourceFileToDocId } = materializeDataset({
      suiteId: 'unit-test-suite', profileId: 'local', runSuffix, corpus,
      toMarkdown: (doc) => doc.text,
    });
    writtenDirs.push(dir);
    assert.equal(sourceFileToDocId.size, 2);
  });

  it('writes files that actually exist on disk under the returned dir', () => {
    const runSuffix = `test-${Date.now()}-exists`;
    const corpus = new Map([['q', { text: 'content' }]]);
    const { dir, docIdToSourceFile } = materializeDataset({
      suiteId: 'unit-test-suite', profileId: 'local', runSuffix, corpus,
      toMarkdown: (doc) => doc.text,
    });
    writtenDirs.push(dir);
    assert.ok(existsSync(resolve(dir, docIdToSourceFile.get('q'))));
  });
});
