'use strict';
// node --test qa/guard.test.cjs
//
// Proves the rebuild can only ever clear projects/ under the repository root:
// every protected path, a wrong output root, and a path escaping the root are
// refused, and neither generator deletes anything except through the guard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const guard = require('../tools/output-guard.cjs');

const ROOT = path.resolve(__dirname, '..');

test('output guard refuses everything but projects/ under the repository root', () => {
  assert.strictEqual(guard.REPO_ROOT, ROOT);

  // The one permitted removal.
  assert.strictEqual(guard.checkRemoval(ROOT, 'projects'), path.join(ROOT, 'projects'));

  // A wrong output root, for the old layout and for the parent folder.
  for (const bad of [path.join(ROOT, 'site'), path.dirname(ROOT), path.join(ROOT, 'projects')]) {
    assert.throws(() => guard.assertOutputRoot(bad), /must be the repository root/);
    assert.throws(() => guard.checkRemoval(bad, 'projects'), /must be the repository root/);
  }

  // Every protected path, by name.
  for (const p of ['build.cjs', 'tools', 'inputs', 'data', 'qa', 'CNAME', '.nojekyll', 'README.md', '.git', '.gitignore']) {
    assert.throws(() => guard.checkRemoval(ROOT, p), /protected path/, p);
  }

  // Escapes and anything not declared as generated.
  for (const p of ['', '.', '..', '../x', 'projects/../inputs', '/etc', 'projects/volt', 'index.html', 'verifications.csv']) {
    assert.throws(() => guard.checkRemoval(ROOT, p), /output-guard: refusing/, JSON.stringify(p));
  }

  // The generators delete only through the guard: no direct rmSync/unlink.
  for (const f of ['build.cjs', 'tools/detail-pages.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\b(rmSync|rmdirSync|unlinkSync)\s*\(/.test(src), `${f} deletes without the guard`);
  }
  assert.ok(/removeGenerated\(outDir, 'projects'\)/.test(
    fs.readFileSync(path.join(ROOT, 'tools/detail-pages.cjs'), 'utf8')));
});
