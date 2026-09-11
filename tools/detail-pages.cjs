#!/usr/bin/env node
/**
 * detail-pages.cjs — one static archive page per project verification.
 *
 * Content spec is the OLD SITE's own React components (projects-sweep/components):
 * ProjectOverview, KYCDate, KYCVerification + KycDetailData, CountryTier,
 * VerificationDetailData, ContractAdress, AuditScore, NoKYCAditModal.
 * Visual spec is the closure landing page (dark navy + gold).
 *
 * Never fabricates. A blank source value renders "N/A" the way the old site did.
 * A record whose detail payload could not be fetched gets a page built from its
 * list record and says so on the page.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { removeGenerated } = require('./output-guard.cjs');

const ROOT = path.resolve(__dirname, '..');
// The raw API sweep and the asset manifest live in the repository's own data/.
const DATA = path.join(ROOT, 'data');

const ASSET_REPOS = {
  archive: 'project-archive-assets',
  nft: 'project-nft-images',
};

// ------------------------------------------------------------------ escaping

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Default-DENY on the scheme. Every URL on these pages is dataset-sourced and
 * lands in an href/src, so anything that is not http(s) is dropped rather than
 * rendered — javascript:, data: and vbscript: never reach the attribute.
 */
function safeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}
function rawUrl(repo, p) {
  return `https://raw.githubusercontent.com/Assure-DeFi/${repo}/main/${encodePath(p)}`;
}
function blobUrl(repo, p) {
  return `https://github.com/Assure-DeFi/${repo}/blob/main/${encodePath(p)}`;
}

// ------------------------------------------------------------------ helpers

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** date-fns "MMMM do yyyy", the format the old site used. */
function formatDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = d % 100 >= 11 && d % 100 <= 13 ? 'th'
    : d % 10 === 1 ? 'st' : d % 10 === 2 ? 'nd' : d % 10 === 3 ? 'rd' : 'th';
  return `${MONTHS[mo - 1]} ${d}${t} ${y}`;
}

/** VerificationDetailData.normalizeLink, verbatim in behaviour. */
function normalizeSocial(link, kind) {
  if (!link || link === 'N/A') return null;
  let s = String(link).trim();
  if (!s) return null;
  const isFull = /^https?:\/\//i.test(s);
  if (kind === 'twitter') {
    if (isFull) return safeUrl(s);
    if (s.startsWith('@')) return safeUrl('https://x.com/' + s);
  }
  if (kind === 'telegram') {
    if (isFull) return safeUrl(s);
    if (s.startsWith('@')) return safeUrl('https://t.me/' + s.slice(1));
  }
  return isFull ? safeUrl(s) : safeUrl('https://' + s);
}

const NA = '<span class="na">N/A</span>';

function textOr(v, fallback) {
  const s = v == null ? '' : String(v).trim();
  return s ? esc(s) : (fallback === undefined ? NA : fallback);
}

function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }

// -------------------------------------------------------------- page pieces

/** The three country-tier definitions, copied verbatim from CountryTier.js. */
const TIER_DEFINITIONS = `
<details class="tiers">
  <summary>Assure DeFi&reg; country tier rankings are as follows</summary>
  <p><strong>Tier 1:</strong> Strong law enforcement with resources and capabilities to effectively legislate &amp; pursue crypto-related cybercrime.</p>
  <p><strong>Tier 2:</strong> Moderately effective law enforcement, lacking some resources &amp; capabilities to effectively pursue crypto-related cybercrime.</p>
  <p><strong>Tier 3:</strong> Law enforcement &amp; legislative resources severely lacking. In most cases would prove ineffective at pursuing crypto-related cybercrime.</p>
</details>`;

function chips(values, emptyLabel) {
  const list = arr(values).map((v) => String(v).trim()).filter(Boolean);
  if (!list.length) return `<span class="chip">${esc(emptyLabel)}</span>`;
  return list.map((v) => `<span class="chip">${esc(v)}</span>`).join('');
}

function socialRow(entries) {
  const out = entries
    .map(([label, href]) => href
      ? `<a class="soc" href="${esc(href)}" rel="noopener nofollow">${esc(label)}</a>`
      : null)
    .filter(Boolean);
  return out.length ? out.join('') : NA;
}

function memberBlock(m) {
  const tg = normalizeSocial(m.telegram || m.telegramHandle, 'telegram');
  const tw = normalizeSocial(m.twitter || m.twitterHandle, 'twitter');
  const dc = normalizeSocial(m.discord || m.discordHandle, 'discord');
  // Handles are trimmed for display only: several carry a leading space, which
  // renders as a double space next to their label. The value itself is not
  // otherwise altered.
  const handles = [
    m.telegramHandle ? ['Telegram', String(m.telegramHandle).trim()] : null,
    m.twitterHandle ? ['X', String(m.twitterHandle).trim()] : null,
    m.discordHandle ? ['Discord', String(m.discordHandle).trim()] : null,
  ].filter((h) => h && h[1]);

  const tier = String(m.countryTier == null ? '' : m.countryTier).trim();

  return `<div class="member">
  <div class="mhead">
    <p class="mname">${textOr(m.name)}</p>
    <span class="mrole">${textOr(m.role)}</span>
  </div>
  <dl class="mfacts">
    <dt>Has control over:</dt>
    <dd class="chips">${chips(m.controlOver, 'No Access')}</dd>
    <dt>Country Tier:</dt>
    <dd>${tier ? `<span class="tier">Tier ${esc(tier)}</span>` : NA}</dd>
    <dt>Verified socials:</dt>
    <dd class="socs">${socialRow([['Telegram', tg], ['X', tw], ['Discord', dc]])}</dd>
    ${handles.length ? `<dt>Handles:</dt><dd class="handles">${handles
      .map(([l, h]) => `<span class="handle">${esc(l)} ${esc(h)}</span>`).join('')}</dd>` : ''}
  </dl>
</div>`;
}

function contractBlock(address, renounced, label) {
  const a = address == null ? '' : String(address).trim();
  // The old site compared against the literal "N/A"; the corpus also carries
  // "n/a" and "N/a", which slipped through as a copyable address.
  if (!a || /^n\s*\/?\s*a$/i.test(a)) {
    return `<div class="addr">
  <p class="alabel">${esc(label)}:</p>
  <p class="avalue na">Not Available</p>
</div>`;
  }
  // A few records hold prose here ("Contract address N/A at time of
  // verification") rather than an address. It is rendered verbatim, because it
  // is what the record says, but it gets no copy button.
  const isAddress = !/\s/.test(a);
  return `<div class="addr">
  <p class="alabel">${esc(label)}:${renounced === 'Yes' ? ' <span class="renounced">Renounced</span>' : ''}</p>
  <p class="avalue"><code>${esc(a)}</code>${isAddress ? `<button class="copy" type="button" data-copy="${esc(a)}">Copy</button>` : ''}</p>
</div>`;
}

function auditReportCard(r, assetsFor) {
  const gh = safeUrl(r.githubReportLink);
  const initials = arr(r.initialAuditReport);
  const finals = arr(r.finalAuditReport);

  const fileLink = (att, label) => {
    const local = assetsFor(att);
    if (local) return `<a class="btn" href="${esc(blobUrl(local.repo, local.repoPath))}" rel="noopener">${esc(label)}</a>`;
    return `<span class="btn dead" title="Attachment was not archived">${esc(label)} (unavailable)</span>`;
  };

  return `<div class="report">
  <div class="rhead">
    <p class="rscore">Assure Audit Score: <strong>${r.auditScore == null || r.auditScore === '' ? 'N/A' : esc(r.auditScore)}</strong></p>
    <p class="rchain">Blockchain: ${textOr(arr(r.blockchain).join(', '))}</p>
  </div>
  ${contractBlock(r.contractAddress, null, 'Contract Address')}
  <dl class="mfacts">
    <dt>Type:</dt><dd>${r.auditDescription ? esc(r.auditDescription) : '<span class="na">-------</span>'}</dd>
    ${r.auditDate ? `<dt>Audit date:</dt><dd>${esc(formatDate(r.auditDate) || r.auditDate)}</dd>` : ''}
    ${r.auditStatus ? `<dt>Audit status:</dt><dd>${esc(r.auditStatus)}</dd>` : ''}
  </dl>
  <div class="btns">
    ${gh ? `<a class="btn" href="${esc(gh)}" rel="noopener">GitHub report</a>` : ''}
    ${initials.map((a, i) => fileLink(a, initials.length > 1 ? `Initial report ${i + 1}` : 'Initial report')).join('')}
    ${finals.map((a, i) => fileLink(a, finals.length > 1 ? `Final report ${i + 1}` : 'Final report')).join('')}
  </div>
</div>`;
}

// ------------------------------------------------------------------ page CSS

const PAGE_CSS = `
:root{
  --bg1:#090822; --bg2:#04030e; --bg3:#050411; --card:#12122b;
  --gold:#E2D243; --gold-bright:#ffe627; --gold-dark:#968929; --gold-mid:#d1b933;
  --light:#F2F2F2; --line:rgba(226,210,67,.16); --line-soft:rgba(255,255,255,.08);
  --muted:rgba(242,242,242,.62); --muted-2:rgba(242,242,242,.42);
  --red:#ff9b9b; --green:#9ede6a;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg2); color:var(--light);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px; line-height:1.55; overflow-x:hidden;
}
.wrap{max-width:920px; margin:0 auto; padding-inline:20px}
a{color:var(--gold-mid); text-decoration:none}
a:hover{color:var(--gold-bright); text-decoration:underline}
header{background:linear-gradient(to bottom,var(--bg1),var(--bg2)); border-bottom:1px solid var(--line)}
.hd{padding-block:30px 34px}
.back{font-size:13.5px; display:inline-block; margin-bottom:16px}
h1{margin:0 0 10px; font-size:clamp(24px,5vw,40px); line-height:1.15; font-weight:800; letter-spacing:-.02em; overflow-wrap:anywhere}
h1 .g{background:linear-gradient(to right,var(--gold-dark),var(--gold-bright));
  -webkit-background-clip:text; background-clip:text; color:transparent}
.stamp{display:inline-flex; align-items:center; gap:9px; border:1px solid var(--line);
  border-radius:999px; padding:6px 14px; font-size:12px; letter-spacing:.08em;
  text-transform:uppercase; color:var(--gold); background:rgba(226,210,67,.05); margin-right:8px}
.stamp.warn{color:var(--red); border-color:rgba(255,120,120,.3); background:rgba(255,120,120,.07)}
.stamp.ok{color:var(--green); border-color:rgba(158,222,106,.28); background:rgba(158,222,106,.06)}
main{padding-block:26px 10px}
.card{background:var(--card); border:1px solid var(--line-soft); border-radius:14px;
  padding:20px; margin-bottom:16px}
.card > h2{margin:0 0 14px; font-size:16px; font-weight:700; letter-spacing:-.01em;
  padding-bottom:10px; border-bottom:1px solid var(--line-soft)}
.ident{display:flex; gap:14px; align-items:center; flex-wrap:wrap}
.ident img{width:56px; height:56px; border-radius:50%; object-fit:cover;
  border:2px solid var(--line); background:#0a0923; flex:0 0 auto}
.ident-noimg{width:56px; height:56px; border-radius:50%; border:2px solid var(--line-soft);
  background:rgba(255,255,255,.03); flex:0 0 auto}
.ident .nm{font-size:20px; font-weight:700; margin:0; overflow-wrap:anywhere}
.ident .tk{margin:0; font-size:12.5px; color:var(--muted-2);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.desc{margin:14px 0 0; color:var(--muted); font-size:14px; overflow-wrap:anywhere}
.socs, .socrow{display:flex; flex-wrap:wrap; gap:8px; margin-top:14px}
.soc{border:1px solid var(--line-soft); border-radius:8px; padding:5px 11px; font-size:13px;
  color:var(--gold-mid); background:rgba(255,255,255,.02)}
.soc:hover{border-color:var(--line); text-decoration:none}
.dates{display:flex; flex-wrap:wrap; gap:22px}
.dates div{min-width:130px}
.dates .l{margin:0; font-size:12px; color:var(--muted-2); text-transform:uppercase; letter-spacing:.07em}
.dates .v{margin:3px 0 0; font-size:16px; font-weight:600; color:var(--gold)}
.notice{border:1px solid rgba(255,120,120,.24); background:rgba(255,120,120,.06);
  border-radius:11px; padding:16px}
.notice p{margin:0 0 8px} .notice p:last-child{margin-bottom:0}
.notice .t{font-weight:700; color:var(--red)}
.addr{margin-bottom:12px}
.alabel{margin:0 0 5px; font-size:13px; color:var(--muted)}
.avalue{margin:0; background:rgba(255,255,255,.04); border:1px solid var(--line-soft);
  border-radius:9px; padding:9px 11px; display:flex; gap:10px; align-items:center;
  flex-wrap:wrap; justify-content:space-between}
.avalue code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px;
  color:var(--gold-mid); overflow-wrap:anywhere; min-width:0; flex:1 1 180px}
.avalue.na{color:var(--muted-2); display:block}
.renounced{color:var(--gold); font-weight:600}
.copy{background:transparent; border:1px solid var(--line); color:var(--gold);
  border-radius:7px; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; flex:0 0 auto}
.copy:hover{background:rgba(226,210,67,.08)}
.chips{display:flex; flex-wrap:wrap; gap:6px}
.chip{display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px;
  background:rgba(226,210,67,.1); color:var(--gold); border:1px solid var(--line)}
.member{border:1px solid var(--line-soft); border-radius:11px; padding:15px; margin-bottom:12px;
  background:rgba(255,255,255,.015)}
.member:last-child{margin-bottom:0}
.mhead{display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;
  padding-bottom:10px; margin-bottom:10px; border-bottom:1px solid var(--line-soft)}
.mname{margin:0; font-size:17px; font-weight:700; color:var(--gold); overflow-wrap:anywhere}
.mrole{font-size:12.5px; color:var(--muted); border:1px solid var(--line-soft);
  border-radius:999px; padding:2px 10px}
.mfacts{display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:0; font-size:13.5px}
.mfacts dt{color:var(--muted-2); white-space:nowrap}
.mfacts dd{margin:0; overflow-wrap:anywhere}
.tier{font-weight:700}
.handle{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;
  color:var(--muted); margin-right:10px; overflow-wrap:anywhere}
.tiers{margin-top:14px; border:1px solid var(--line-soft); border-radius:10px; padding:10px 13px;
  font-size:13px; color:var(--muted)}
.tiers summary{cursor:pointer; color:var(--gold-mid); font-size:13px}
.tiers p{margin:9px 0 0}
.tiers strong{color:var(--gold)}
.report{border:1px solid var(--line-soft); border-radius:11px; padding:15px; margin-bottom:12px;
  background:rgba(255,255,255,.015)}
.report:last-child{margin-bottom:0}
.rhead{display:flex; gap:10px; justify-content:space-between; flex-wrap:wrap;
  padding-bottom:10px; margin-bottom:12px; border-bottom:1px solid var(--line-soft)}
.rscore{margin:0; font-size:15px} .rscore strong{color:var(--green)}
.rchain{margin:0; font-size:13px; color:var(--muted)}
.btns{display:flex; flex-wrap:wrap; gap:9px; margin-top:12px}
.btn{display:inline-block; border:1px solid var(--line); color:var(--gold); border-radius:9px;
  padding:8px 14px; font-size:13.5px; background:rgba(226,210,67,.05)}
.btn:hover{background:rgba(226,210,67,.11); text-decoration:none}
.btn.dead{color:var(--muted-2); border-color:var(--line-soft); background:transparent}
.nft{margin-top:14px}
.nft img{max-width:220px; width:100%; height:auto; border-radius:11px; border:1px solid var(--line-soft)}
.facts{display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:0; font-size:13.5px}
.facts dt{color:var(--muted-2); white-space:nowrap}
.facts dd{margin:0; overflow-wrap:anywhere}
.na{color:var(--muted-2)}
.gap{border:1px solid var(--line-soft); background:rgba(255,255,255,.03); border-radius:11px;
  padding:13px 15px; font-size:13.5px; color:var(--muted); margin-bottom:16px}
footer{border-top:1px solid var(--line-soft); margin-top:26px; padding-block:24px 40px;
  color:var(--muted-2); font-size:13px}
footer p{margin:0 0 6px}
@media (max-width:560px){
  .wrap{padding-inline:14px}
  .mfacts,.facts{grid-template-columns:1fr; gap:3px 0}
  .mfacts dt,.facts dt{margin-top:7px}
  .btn{flex:1 1 100%; text-align:center}
}
`;

const PAGE_JS = `
(function(){
  document.addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest("button.copy") : null;
    if(!b) return;
    var v = b.getAttribute("data-copy") || "";
    var done = function(){ var t=b.textContent; b.textContent="Copied"; setTimeout(function(){ b.textContent=t; },1600); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(v).then(done, function(){ b.textContent="Copy failed"; });
    } else { b.textContent="Copy failed"; }
  });
})();
`;

// ---------------------------------------------------------------- the module

/**
 * @param {object} opts
 * @param {string} opts.outDir            the repository root (the site is served from it)
 * @param {string} opts.logoDataUri       inlined Assure DeFi logo
 * @param {string} opts.closureStatement
 * @returns {{pages:Array, index:Map, stats:object}}
 */
function buildDetailPages(opts) {
  const outDir = opts.outDir;
  // Regenerate from scratch: a slug that stops existing must not leave a stale
  // page behind, and a renamed slug must not leave the old directory served.
  // The guard refuses anything but projects/ directly under the repository root.
  removeGenerated(outDir, 'projects');
  const listAll = JSON.parse(fs.readFileSync(path.join(DATA, 'api-list-all.json'), 'utf8'));
  const detailAll = JSON.parse(fs.readFileSync(path.join(DATA, 'api-detail-all.json'), 'utf8'));

  // Downloaded-asset lookup, keyed by attachment id. A file that failed to
  // download is simply absent, and the template says "unavailable" rather than
  // linking a path that will 404.
  const assetByAttId = new Map();
  const manifestPath = path.join(DATA, 'assets-manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const f of manifest.files || []) {
      if (f.status === 'ok' && f.attachmentId) assetByAttId.set(f.attachmentId, f);
    }
  }
  const assetsFor = (att) => (att && att.id ? assetByAttId.get(att.id) || null : null);

  // ---------------------------------------------------------- page inventory

  // A handful of seoSlug values are not usable as a URL path segment: a trailing
  // space, an uppercase form, a percent-escape, an ampersand. Those get a
  // sanitised page slug, and the ORIGINAL is kept as a redirect alias so the old
  // /projects/<seoSlug> URL still lands on the right page.
  const aliasToPage = new Map();     // original seoSlug -> page slug
  function pageSlugFor(seoSlug, used) {
    const raw = String(seoSlug);
    const clean = raw.trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|-+$/g, '');
    let s = clean || 'project';
    if (s !== raw) {
      let n = 2;
      while (used.has(s) && used.get(s) !== raw) s = clean + '-' + (n++);
    }
    return s;
  }

  const bySlug = new Map();          // page slug -> [{key, version, detail, list}]
  const listByKey = new Map();
  for (const p of listAll) {
    if (!p.seoSlug) continue;
    const key = p.seoSlug + '|' + (p.verificationVersion === undefined ? '' : p.verificationVersion);
    if (!listByKey.has(key)) listByKey.set(key, p);
  }

  const slugOwner = new Map();       // page slug -> originating seoSlug
  for (const key of Object.keys(detailAll)) {
    const d = detailAll[key];
    const seoSlug = key.slice(0, key.lastIndexOf('|'));
    const version = key.slice(key.lastIndexOf('|') + 1);
    const slug = pageSlugFor(seoSlug, slugOwner);
    slugOwner.set(slug, seoSlug);
    if (slug !== seoSlug) aliasToPage.set(seoSlug, slug);
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({
      key, slug, seoSlug, version,
      detail: d && !d.__error ? d : null,
      detailError: d && d.__error ? d.__error : null,
      list: listByKey.get(key) || null,
    });
  }

  // List records with no seoSlug get a page too, at a slug derived from
  // lowerCaseProjectName. Derived slugs can never collide with a real seoSlug.
  const usedSlugs = new Set(bySlug.keys());
  const listOnlyRecords = [];
  for (const p of listAll) {
    if (p.seoSlug) continue;
    const base = String(p.lowerCaseProjectName || p.projectName || '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed-project';
    let slug = base, n = 2;
    while (usedSlugs.has(slug)) slug = base + '-' + (n++);
    usedSlugs.add(slug);
    listOnlyRecords.push({ slug, list: p, derivedFrom: 'lowerCaseProjectName' });
    bySlug.set(slug, [{ key: null, slug, version: String(p.verificationVersion ?? ''), detail: null, detailError: null, list: p, derived: true }]);
  }

  // ------------------------------------------------------------- render loop

  const pages = [];
  const index = new Map();     // seoSlug -> href of the latest version
  const listOnlyPages = [];
  let membersRendered = 0, reportsRendered = 0;

  for (const [slug, versionsRaw] of bySlug) {
    // Sort newest version first; a blank version sorts last (it is unversioned).
    const versions = versionsRaw.slice().sort((a, b) => {
      const av = a.version === '' ? -1 : Number(a.version);
      const bv = b.version === '' ? -1 : Number(b.version);
      if (Number.isNaN(av) || Number.isNaN(bv)) return String(b.version).localeCompare(String(a.version));
      return bv - av;
    });

    const siblings = versions.map((v, i) => ({
      version: v.version,
      // RELATIVE, never absolute: the archive is served both at the domain root
      // and at a subpath (the GitHub Pages preview). An absolute /projects/... breaks
      // every row link under the subpath, which reads as "the pages were never built".
      href: i === 0 ? `projects/${slug}/` : `projects/${slug}/v${v.version}/`,
      label: v.version === '' ? 'Verification record' : `Version ${v.version}`,
    }));

    versions.forEach((v, i) => {
      const rel = i === 0
        ? path.join('projects', slug, 'index.html')
        : path.join('projects', slug, 'v' + v.version, 'index.html');
      const out = renderPage({
        entry: v, slug, siblings, isLatest: i === 0,
        assetsFor, logoDataUri: opts.logoDataUri,
        depth: i === 0 ? 2 : 3,
      });
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out.html);
      pages.push({ slug, version: v.version, rel, href: siblings[i].href, listOnly: out.listOnly });
      if (i === 0) index.set(slug, siblings[0].href);
      membersRendered += out.memberCount;
      reportsRendered += out.reportCount;
      if (out.listOnly) {
        listOnlyPages.push({
          slug, version: v.version, href: siblings[i].href,
          projectName: (v.list && v.list.projectName) || slug,
          reason: v.detailError ? 'detail fetch failed: ' + v.detailError
            : (v.derived ? 'list record carried no seoSlug' : 'no detail record'),
        });
      }
    });
  }

  // Redirect map for 404.html: every URL an old link might carry -> page slug.
  const aliases = {};
  for (const [orig, page] of aliasToPage) if (index.has(page)) aliases[orig] = page;

  return {
    pages, index, listOnlyPages, aliases,
    stats: {
      slugAliases: Object.keys(aliases).length,
      pagesBuilt: pages.length,
      slugs: index.size,
      listOnlyPages: listOnlyPages.length,
      membersRendered,
      reportsRendered,
      assetsLinked: assetByAttId.size,
      assetManifestPresent: !!manifest,
      assetTotals: manifest ? manifest.totals : null,
    },
  };
}

// ------------------------------------------------------------ single page

function renderPage(ctx) {
  const { entry, slug, siblings, assetsFor, logoDataUri, depth } = ctx;
  const d = entry.detail;
  const l = entry.list || {};
  const listOnly = !d;
  // The list record is the fallback source for every field when the detail
  // payload is absent. Fields only the detail carries (members, audit reports)
  // simply have no value, and the page says so rather than inventing one.
  const p = d || l;

  const up = '../'.repeat(depth);
  // Trimmed only to keep stray leading/trailing whitespace out of the <title>
  // and alt attributes; HTML collapses it in body text either way.
  const name = String(p.projectName || l.projectName || slug).trim() || slug;
  const ticker = String(p.lowerCaseTickerName || p.tickerName || '').toUpperCase();

  const kycStatus = p.kycStatus || '';
  const auditStatus = p.auditStatus || '';
  const isProof = p.isProofProject === 'Yes';
  const approved = kycStatus === 'Approved';
  const rejected = kycStatus === 'Rejected';

  const logoAtt = arr(p.images)[0];
  const logoAsset = assetsFor(logoAtt);
  const nftAtt = arr(p.nftImage)[0];
  const nftAsset = assetsFor(nftAtt);

  const members = arr(d && d.verifiyMembersList);
  const reports = arr(d && d.auditReportList);

  const social = socialRow([
    ['Website', normalizeSocial(p.websiteLink, 'web')],
    ['X', normalizeSocial(p.twitterLink, 'twitter')],
    ['Telegram', normalizeSocial(p.telegramLink, 'telegram')],
    ['Discord', normalizeSocial(p.discordLink, 'discord')],
  ]);
  // mediumLink is not rendered by the old detail page and the corpus shows it
  // holding things that are not Medium profiles (a deck PDF, a docs site), so
  // it is carried in the record fields under its own field name rather than
  // labelled as a social account it may not be.
  const mediumLink = normalizeSocial(p.mediumLink, 'web');

  const kycDate = formatDate(p.kycDate);
  const auditDate = formatDate(p.auditDate);
  const certUrl = safeUrl(p.kycCertificate);
  const nftUrl = safeUrl(p.nftUrl);

  // ---- header badges
  const badges = [
    approved ? '<span class="stamp ok">KYC Approved</span>'
      : rejected ? '<span class="stamp warn">KYC Rejected</span>'
        : '<span class="stamp warn">No KYC</span>',
    auditStatus === 'Completed' ? '<span class="stamp ok">Audited</span>'
      : isProof ? '<span class="stamp">PROOF project</span>'
        : '<span class="stamp warn">Not audited</span>',
  ].join('');

  // ---- overview
  const overview = `<section class="card">
  <div class="ident">
    ${logoAsset
      ? `<img src="${esc(rawUrl(ASSET_REPOS.archive, logoAsset.repoPath))}" alt="${esc(name)} logo" width="56" height="56" loading="lazy">`
      : '<div class="ident-noimg" aria-hidden="true"></div>'}
    <div>
      <p class="nm">${esc(name)}</p>
      <p class="tk">${ticker ? esc(ticker) : '&mdash;'}</p>
    </div>
  </div>
  ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
  <div class="socrow">${social}</div>
</section>`;

  // ---- dates. The old site showed ONE date (audit date preferred). Both are
  // shown here, each labelled, so an audited project does not lose its KYC date.
  const dateBlocks = [
    kycDate ? `<div><p class="l">KYC date</p><p class="v">${esc(kycDate)}</p></div>` : '',
    auditDate ? `<div><p class="l">Audit date</p><p class="v">${esc(auditDate)}</p></div>` : '',
  ].filter(Boolean).join('');

  // ---- KYC section
  let kycBody;
  if (approved) {
    kycBody = `
    ${members.length
      ? members.map(memberBlock).join('') + TIER_DEFINITIONS
      : listOnly
        ? '<p class="na">Team member records are held in the detail payload, which was not available at archive time.</p>'
        : '<p class="na">No team member records are present on this verification.</p>'}
    ${certUrl || nftUrl ? `<div class="btns">
      ${certUrl ? `<a class="btn" href="${esc(certUrl)}" rel="noopener">KYC certificate</a>` : ''}
      ${nftUrl ? `<a class="btn" href="${esc(nftUrl)}" rel="noopener">Verification NFT</a>` : ''}
    </div>` : ''}
    ${nftAsset ? `<div class="nft"><img src="${esc(rawUrl(ASSET_REPOS.nft, nftAsset.repoPath))}" alt="${esc(name)} verification NFT" loading="lazy"></div>` : ''}`;
  } else if (rejected) {
    kycBody = `<div class="notice">
  <p class="t">KYC Rejected</p>
  <p>This project did <b>not pass</b> Assure DeFi&reg; KYC verification.</p>
  <p>Investors should exercise caution.</p>
</div>`;
  } else {
    kycBody = `<div class="notice">
  <p class="t">No KYC Verification</p>
  <p>This project is <b>not KYC verified by Assure DeFi&reg;</b>.</p>
  <p>They may have completed KYC with another provider, but investors should exercise caution. We cannot guarantee the quality or standards of third-party verifications.</p>
</div>`;
  }

  // ---- audit section
  let auditBody;
  if (reports.length) {
    auditBody = reports.map((r) => auditReportCard(r, assetsFor)).join('');
  } else if (isProof) {
    auditBody = `<div class="notice" style="border-color:var(--line-soft);background:rgba(255,255,255,.03)">
  <p>PROOF Projects&#39; Factory Contract is Audited by Source Hat, link to the Audit Report can be found here.</p>
  <p><a class="btn" href="https://sourcehat.com/audits/ProofStandardWhitelist/" rel="noopener">Source Hat Audit</a></p>
</div>`;
  } else if (auditStatus === 'Completed' && listOnly) {
    auditBody = `<p class="na">This record is marked audited. The audit report list is held in the detail payload, which was not available at archive time.</p>`;
  } else {
    auditBody = `<div class="notice">
  <p class="t">No Assure DeFi&reg; Code Audit Detected</p>
  <p>This project has <b>not been audited by Assure DeFi&reg;</b>. They may have completed an audit with another provider, but investors should exercise caution. We cannot guarantee the quality or standards of third-party audits.</p>
</div>`;
  }

  // ---- record fields the sections above do not carry
  const recordFacts = [
    ['Verification status', p.kycStatus],
    ['Audit status', p.auditStatus],
    ['Verification version', p.verificationVersion],
    ['Country level', p.countryLevel],
    ['Contract control', p.contractControl],
    ['Treasury control', p.treasuryControl],
    ['Liquidity control', p.liquidityControl],
    ['Contract renounced', p.renounced],
    ['PROOF project', p.isProofProject],
    // Distinct from the per-report score shown in the Audit card above: the
    // project record carries its own field, and it is often blank on a project
    // whose audit report does carry a score. Labelled so the two cannot read
    // as a contradiction.
    ['Audit score (project record)', p.auditScore],
    ['Archive slug', slug],
  ];

  const recordFactsHtml = recordFacts
    .map(([k, v]) => `<dt>${esc(k)}:</dt><dd>${textOr(v)}</dd>`)
    .concat(mediumLink
      ? [`<dt>mediumLink:</dt><dd><a href="${esc(mediumLink)}" rel="noopener nofollow">${esc(mediumLink)}</a></dd>`]
      : [])
    .concat(nftUrl ? [`<dt>NFT page:</dt><dd><a href="${esc(nftUrl)}" rel="noopener nofollow">${esc(nftUrl)}</a></dd>`] : [])
    .join('\n      ');

  const versionNav = siblings.length > 1
    ? `<div class="gap"><strong>Other verification versions of this project:</strong> ${siblings
      .map((s) => (s.href === siblings.find((x) => x.version === entry.version).href
        ? `<span>${esc(s.label)} (this page)</span>`
        : `<a href="${esc(s.href)}">${esc(s.label)}</a>`)).join(' &middot; ')}</div>`
    : '';

  const gapNote = listOnly
    ? `<div class="gap">Detail record was not available at archive time. Everything on this page comes from the project list record${entry.detailError ? ` (detail fetch returned: ${esc(entry.detailError)})` : ''}.</div>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} &mdash; Assure DeFi Verification Archive</title>
<meta name="description" content="${esc(name)} verification record from the permanent Assure DeFi archive.">
<meta name="robots" content="index,follow">
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <div class="wrap hd">
    <a class="back" href="${esc(up)}index.html">&larr; Back to the verification archive</a>
    <h1><span class="g">${esc(name)}</span></h1>
    <div>${badges}</div>
  </div>
</header>

<main class="wrap">
  ${gapNote}
  ${versionNav}
  ${overview}

  ${dateBlocks ? `<section class="card"><h2>Verification dates</h2><div class="dates">${dateBlocks}</div></section>` : ''}

  <section class="card">
    <h2>Contract</h2>
    ${contractBlock(p.tokenContractAddress1 || p.contractAddress, p.renounced, 'Contract Address')}
    ${p.tokenContractAddress2 ? contractBlock(p.tokenContractAddress2, null, 'Second Contract Address') : ''}
    <dl class="facts">
      <dt>Blockchain:</dt><dd class="chips">${chips(p.tokenBlockChain1 || p.blockchain, 'Not Available')}</dd>
      ${p.tokenBlockChain2 && arr(p.tokenBlockChain2).length
        ? `<dt>Second blockchain:</dt><dd class="chips">${chips(p.tokenBlockChain2, 'Not Available')}</dd>` : ''}
    </dl>
  </section>

  <section class="card">
    <h2>KYC Verification</h2>
    ${kycBody}
  </section>

  <section class="card">
    <h2>Audit</h2>
    ${auditBody}
  </section>

  <section class="card">
    <h2>Verification record</h2>
    <dl class="facts">
      ${recordFactsHtml}
    </dl>
  </section>
</main>

<footer class="wrap">
  <p>Assure DeFi ceased operations in September 2026. This page is a static archive and is not maintained.</p>
  <p><a href="${esc(up)}index.html">Open the full verification archive</a></p>
</footer>
<script>${PAGE_JS}</script>
</body>
</html>
`;

  return { html, listOnly, memberCount: members.length, reportCount: reports.length };
}

module.exports = { buildDetailPages, esc, safeUrl, formatDate, normalizeSocial };
