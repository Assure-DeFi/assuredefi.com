'use strict';
/**
 * output-guard.cjs — the only code allowed to delete anything during a build.
 *
 * The site IS the repository root: index.html and projects/ sit next to
 * build.cjs, tools/, inputs/ and data/. A wipe-and-rebuild step pointed one
 * directory wrong would delete the generator or the raw data, so every removal
 * goes through removeGenerated(), which refuses anything that is not a DECLARED
 * generated path directly under the repository root.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Generated output that a rebuild may clear. Everything else is refused.
const GENERATED = Object.freeze(['projects']);

// Named explicitly as well, so a future edit that adds one of these to
// GENERATED is still refused rather than trusted.
const PROTECTED = Object.freeze([
  '.git', '.gitignore', '.nojekyll', 'CNAME', 'README.md',
  'build.cjs', 'tools', 'inputs', 'data', 'qa',
]);

/** Throws unless outDir is the repository root. */
function assertOutputRoot(outDir, root = REPO_ROOT) {
  const out = path.resolve(outDir);
  if (out !== path.resolve(root)) {
    throw new Error(`output-guard: output root must be the repository root (${root}), got ${out}`);
  }
  return out;
}

/**
 * The absolute path removeGenerated() would delete, or a throw. Pure: touches
 * nothing, so the refusals can be tested without deleting anything.
 */
function checkRemoval(outDir, rel, root = REPO_ROOT) {
  const out = assertOutputRoot(outDir, root);
  const target = path.resolve(out, rel);
  const relFromRoot = path.relative(out, target);
  if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot) ||
      relFromRoot.includes(path.sep)) {
    throw new Error(`output-guard: refusing to remove ${target}: not a direct child of the repository root`);
  }
  if (PROTECTED.includes(relFromRoot)) {
    throw new Error(`output-guard: refusing to remove protected path ${relFromRoot}`);
  }
  if (!GENERATED.includes(relFromRoot)) {
    throw new Error(`output-guard: refusing to remove ${relFromRoot}: not a declared generated path (${GENERATED.join(', ')})`);
  }
  return target;
}

function removeGenerated(outDir, rel) {
  fs.rmSync(checkRemoval(outDir, rel), { recursive: true, force: true });
}

module.exports = { REPO_ROOT, GENERATED, PROTECTED, assertOutputRoot, checkRemoval, removeGenerated };
