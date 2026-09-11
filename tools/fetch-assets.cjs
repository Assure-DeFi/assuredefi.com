#!/usr/bin/env node
/* Download every planned attachment to disk and sha256 it.
 * Bounded concurrency, per-request timeout, two retries.
 * A failure is RECORDED per file, never silently skipped. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const ROOT = path.resolve(__dirname, '..');
// Downloads land in gitignored build scratch: the files are published in their
// own repositories (project-archive-assets, project-nft-images), never here.
// The manifest they produce is data/assets-manifest.json, which build.cjs reads.
const ASSETS = path.join(ROOT, '.build', 'assets');
const PLAN = path.join(ROOT, '.build', 'assets-plan.json');
const MANIFEST = path.join(ROOT, 'data', 'assets-manifest.json');

const CONCURRENCY = 6;
const TIMEOUT_MS = 120000;   // a 30MB PDF over a slow hop needs headroom
const RETRIES = 2;

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));

// Resume: an existing manifest's successful rows are kept, so a re-run after a
// partial outage only re-fetches what actually failed.
let prior = {};
if (fs.existsSync(MANIFEST)) {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    for (const r of m.files || []) if (r.status === 'ok') prior[r.repo + '/' + r.repoPath] = r;
  } catch { prior = {}; }
}

function sha256File(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex')));
  });
}

async function fetchOne(row) {
  const dest = path.join(ASSETS, row.repo, row.repoPath);
  const id = row.repo + '/' + row.repoPath;

  if (prior[id] && fs.existsSync(dest)) return prior[id];

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(row.url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body) throw new Error('empty body');
      await pipeline(res.body, fs.createWriteStream(tmp));
      clearTimeout(timer);
      const bytes = fs.statSync(tmp).size;
      if (bytes === 0) throw new Error('zero bytes');
      fs.renameSync(tmp, dest);
      return {
        repo: row.repo, repoPath: row.repoPath, slug: row.slug, kind: row.kind,
        key: row.key, attachmentId: row.attachmentId,
        originalFilename: row.originalFilename, filename: row.filename,
        status: 'ok', bytes,
        declaredSize: row.declaredSize,
        sizeMatchesDeclared: row.declaredSize == null ? null : bytes === row.declaredSize,
        sha256: await sha256File(dest),
        contentType: res.headers.get('content-type') || row.contentType || null,
        attempts: attempt + 1,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch {}
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return {
    repo: row.repo, repoPath: row.repoPath, slug: row.slug, kind: row.kind,
    key: row.key, attachmentId: row.attachmentId,
    originalFilename: row.originalFilename, filename: row.filename,
    status: 'failed', bytes: null, declaredSize: row.declaredSize,
    sha256: null, error: String(lastErr && lastErr.message || lastErr),
    attempts: RETRIES + 1,
  };
}

(async () => {
  const results = new Array(plan.length);
  let next = 0, done = 0;
  const t0 = Date.now();

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= plan.length) return;
      results[i] = await fetchOne(plan[i]);
      done++;
      if (done % 50 === 0 || done === plan.length) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        const failed = results.filter(r => r && r.status === 'failed').length;
        console.log(`[${done}/${plan.length}] ${secs}s failed=${failed}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const files = results.filter(Boolean);
  const ok = files.filter(f => f.status === 'ok');
  const failed = files.filter(f => f.status !== 'ok');

  const bytesByRepo = {};
  for (const f of ok) bytesByRepo[f.repo] = (bytesByRepo[f.repo] || 0) + f.bytes;

  const countByRepo = {};
  for (const f of ok) countByRepo[f.repo] = (countByRepo[f.repo] || 0) + 1;

  const mismatched = ok.filter(f => f.sizeMatchesDeclared === false);

  fs.writeFileSync(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Airtable attachment URLs via apis.assuredefi.com project detail payloads',
    totals: {
      planned: plan.length,
      downloaded: ok.length,
      failed: failed.length,
      bytesByRepo,
      countByRepo,
      sizeMismatches: mismatched.length,
    },
    failures: failed.map(f => ({ repo: f.repo, repoPath: f.repoPath, key: f.key, kind: f.kind, error: f.error })),
    files,
  }, null, 1));

  console.log('---');
  console.log('downloaded', ok.length, 'failed', failed.length);
  for (const [r, b] of Object.entries(bytesByRepo)) {
    console.log(' ', r, countByRepo[r], 'files', (b / 1048576).toFixed(1) + 'MB');
  }
  if (mismatched.length) console.log('size-mismatch (declared vs actual):', mismatched.length);
  for (const f of failed) console.log('FAILED', f.repo + '/' + f.repoPath, f.error);
  console.log('manifest', MANIFEST);
  process.exit(failed.length ? 2 : 0);
})();
