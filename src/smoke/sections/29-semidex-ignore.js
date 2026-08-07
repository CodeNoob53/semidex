import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectFiles, loadIgnorePatterns, isIgnored } from '../../shared/indexer/files.js';

export default async function ({ ok }) {
  console.log('\n[29] .semidexignore — collectFiles exclusion');

  // Build a temp fixture directory:
  //   root/
  //     a.md
  //     raw/
  //       b.md          ← excluded by .semidexignore
  //     assets/
  //       img/
  //         c.md        ← excluded (nested under ignored dir)
  //     sub/
  //       d.md          ← included
  //     .semidexignore  ← raw/, assets/
  const base = join(tmpdir(), `semidex-ignore-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'a.md'), 'A content');
  mkdirSync(join(base, 'raw'), { recursive: true });
  writeFileSync(join(base, 'raw', 'b.md'), 'B content');
  mkdirSync(join(base, 'assets', 'img'), { recursive: true });
  writeFileSync(join(base, 'assets', 'img', 'c.md'), 'C content');
  mkdirSync(join(base, 'sub'), { recursive: true });
  writeFileSync(join(base, 'sub', 'd.md'), 'D content');
  writeFileSync(join(base, '.semidexignore'), `# ignore raw and assets\nraw/\nassets/\n`);

  const files = collectFiles(base);
  const names = files.map(f => f.replace(base, '').replace(/\\/g, '/'));

  ok('.semidexignore: a.md included',              names.includes('/a.md'));
  ok('.semidexignore: sub/d.md included',          names.includes('/sub/d.md'));
  ok('.semidexignore: raw/b.md excluded',          !names.includes('/raw/b.md'));
  ok('.semidexignore: assets/img/c.md excluded',   !names.includes('/assets/img/c.md'));
  ok('.semidexignore: total 2 files',              files.length === 2);

  // 29b. No .semidexignore — all files collected.
  const base2 = join(tmpdir(), `semidex-ignore-test2-${Date.now()}`);
  mkdirSync(base2, { recursive: true });
  writeFileSync(join(base2, 'x.md'), 'X');
  mkdirSync(join(base2, 'sub2'), { recursive: true });
  writeFileSync(join(base2, 'sub2', 'y.md'), 'Y');
  const files2 = collectFiles(base2);
  ok('no .semidexignore: all files collected', files2.length === 2);

  // 29c. Comments and blank lines in .semidexignore are ignored.
  const pats = loadIgnorePatterns(base);
  ok('.semidexignore: comment line not in patterns', !pats.some(p => p.startsWith('#')));
  ok('.semidexignore: blank lines not in patterns',  !pats.some(p => p === ''));
  ok('.semidexignore: raw pattern parsed',           pats.includes('raw/'));
  ok('.semidexignore: assets pattern parsed',        pats.includes('assets/'));

  // 29d. Trailing slash stripped by isIgnored.
  ok('isIgnored: "raw/" pattern matches entry "raw"',       isIgnored('raw',    ['raw/']));
  ok('isIgnored: "assets/" pattern matches entry "assets"', isIgnored('assets', ['assets/']));
  ok('isIgnored: "raw" pattern matches entry "raw"',        isIgnored('raw',    ['raw']));
  ok('isIgnored: non-ignored entry not matched',            !isIgnored('sub',   ['raw/', 'assets/']));

  // 29e. Glob patterns.
  ok('isIgnored: *.txt matches file.txt',              isIgnored('file.txt',         ['*.txt']));
  ok('isIgnored: *.txt does not match file.md',        !isIgnored('file.md',         ['*.txt']));
  ok('isIgnored: **/*.txt matches sub/file.txt',       isIgnored('sub/file.txt',     ['**/*.txt']));
  ok('isIgnored: drafts/*.md matches drafts/x.md',    isIgnored('drafts/x.md',      ['drafts/*.md']));
  ok('isIgnored: drafts/*.md does not match sub/x.md', !isIgnored('sub/x.md',       ['drafts/*.md']));
  ok('isIgnored: path pattern sub/deep.md matches',   isIgnored('sub/deep.md',      ['sub/deep.md']));

  // 29f. Glob collectFiles — *.txt excluded from root.
  const base3 = join(tmpdir(), `semidex-ignore-test3-${Date.now()}`);
  mkdirSync(join(base3, 'sub'), { recursive: true });
  writeFileSync(join(base3, 'keep.md'),     'keep');
  writeFileSync(join(base3, 'skip.txt'),    'skip');
  writeFileSync(join(base3, 'sub', 'a.md'), 'a');
  writeFileSync(join(base3, '.semidexignore'), '*.txt\n');
  const files3 = collectFiles(base3);
  const names3 = files3.map(f => f.replace(base3, '').replace(/\\/g, '/'));
  ok('glob: keep.md included',   names3.includes('/keep.md'));
  ok('glob: skip.txt excluded',  !names3.includes('/skip.txt'));
  ok('glob: sub/a.md included',  names3.includes('/sub/a.md'));

  // Cleanup
  rmSync(base,  { recursive: true, force: true });
  rmSync(base2, { recursive: true, force: true });
  rmSync(base3, { recursive: true, force: true });
}
