#!/usr/bin/env node
/* Build the download plan: one row per attachment we must copy locally.
 * Airtable URLs expire within hours, so this runs first and independently
 * of templating. Output: assets-plan.json */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SWEEP = path.resolve(ROOT, '..', 'projects-sweep');

const detail = JSON.parse(fs.readFileSync(path.join(SWEEP, 'api-detail-all.json'), 'utf8'));

// Keep the filename readable but make it safe as a single path segment.
// Never collapse to a hash: the filename is evidence of what the file is.
function safeName(name, fallback) {
  let n = String(name || '').trim();
  n = n.replace(/[\\/\x00-\x1f]/g, '_');     // path separators + control chars
  n = n.replace(/^\.+/, '_');                 // no leading dots (., ..)
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}

function safeSlugSegment(slug) {
  let s = String(slug || '').trim();
  s = s.replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '_');
  return s || 'unknown';
}

const rows = [];
const seenPath = new Map();   // repoPath -> attachment id
const seenUrl = new Map();    // url -> repoPath (identical url reused across versions)

function add(repo, slug, kind, att, ctx) {
  if (!att || !att.url) return;
  const dir = kind === 'nft'
    ? safeSlugSegment(slug)
    : safeSlugSegment(slug) + '/' + kind;
  let file = safeName(att.filename, (att.id || 'file') + '.bin');
  let rel = dir + '/' + file;

  if (seenUrl.has(att.url)) return;           // exact same attachment, already planned

  // Distinct attachments colliding on one path get their attachment id prefixed,
  // so nothing is silently overwritten by a same-named file from another version.
  if (seenPath.has(rel) && seenPath.get(rel) !== att.id) {
    file = (att.id || 'x') + '-' + file;
    rel = dir + '/' + file;
  }
  seenPath.set(rel, att.id);
  seenUrl.set(att.url, rel);

  rows.push({
    repo, slug, kind, key: ctx,
    attachmentId: att.id || null,
    filename: file,
    originalFilename: att.filename || null,
    repoPath: rel,
    url: att.url,
    declaredSize: typeof att.size === 'number' ? att.size : null,
    contentType: att.type || null,
  });
}

for (const key of Object.keys(detail)) {
  const d = detail[key];
  if (!d || d.__error) continue;
  const slug = key.split('|')[0];

  for (const a of d.images || []) add('project-archive-assets', slug, 'logo', a, key);
  for (const a of d.nftImage || []) add('project-nft-images', slug, 'nft', a, key);
  for (const r of d.auditReportList || []) {
    for (const a of r.initialAuditReport || []) add('project-archive-assets', slug, 'audit-initial', a, key);
    for (const a of r.finalAuditReport || []) add('project-archive-assets', slug, 'audit-final', a, key);
  }
}

const out = path.join(ROOT, 'assets-plan.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

const byKind = {};
let bytes = 0;
for (const r of rows) { byKind[r.kind] = (byKind[r.kind] || 0) + 1; bytes += r.declaredSize || 0; }
console.log('planned', rows.length, 'files', JSON.stringify(byKind), (bytes / 1048576).toFixed(1) + 'MB');
console.log('wrote', out);
