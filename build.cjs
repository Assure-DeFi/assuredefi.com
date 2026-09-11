#!/usr/bin/env node
/**
 * build.cjs — regenerates the Assure DeFi closure archive in place.
 *
 * Run from the repository root:  node build.cjs
 *
 * The site is served from the repository root, so the output directory IS the
 * repository root. The only thing a rebuild deletes is projects/, and only
 * through tools/output-guard.cjs.
 *
 * Inputs (inputs/):
 *   projects.json                  985 public verification records
 *   KYC-Certificates.files.tsv     path<TAB>size for Assure-DeFi/KYC-Certificates
 *   Audits.files.tsv               path<TAB>size for Assure-DeFi/Audits
 *   Audit-Certificates.files.tsv   path<TAB>size for Assure-DeFi/Audit-Certificates
 *   brand/Assure-brand.webp        logo, inlined as a base64 data URI
 * Inputs (data/):
 *   api-list-all.json, api-detail-all.json   the live API sweep behind projects/
 *   assets-manifest.json                     archived attachments, by attachment id
 *
 * Outputs (repository root):
 *   index.html          one self-contained page (inline CSS + JS, no CDN, no fetch)
 *   404.html            /projects/<slug> and /project/<slug> -> /#p=<slug>
 *   projects/           one page per verification
 *   verifications.csv   slimmed columns + resolved certificate/report URLs
 *   verifications.xlsx  same columns (written by tools/make_xlsx.py via openpyxl)
 * Build scratch (.build/, gitignored): stats, suffix-match audit, xlsx hand-off.
 *
 * Link resolution never fabricates. A project with no confident file match gets
 * no link and the cell renders an em dash.
 */

const fs = require('fs');
const path = require('path');

const { assertOutputRoot } = require('./tools/output-guard.cjs');

const ROOT = __dirname;
const IN = path.join(ROOT, 'inputs');
const OUT = assertOutputRoot(ROOT);
const BUILD = path.join(ROOT, '.build');

const REPOS = {
  kyc: 'KYC-Certificates',
  audit: 'Audits',
  cert: 'Audit-Certificates',
};

// ---------------------------------------------------------------- utilities

/** Percent-encode a repo-relative path for a github.com/raw URL, keeping "/". */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
function blobUrl(repo, p) {
  return `https://github.com/Assure-DeFi/${repo}/blob/main/${encodePath(p)}`;
}

/** Case/punctuation/whitespace-insensitive key. Empty string when nothing survives. */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Tokens a filename is built from. Split on the separators the corpus actually
 * uses, so a window boundary is a real boundary and "Volt" can never match
 * inside "REVOLT".
 */
function fileTokens(basename) {
  return basename
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[_\-\s.]+/)
    .filter(Boolean);
}

// Filename tokens that describe the DOCUMENT, never the project. A candidate
// window containing any of these is rejected outright.
const NOISE = new Set(
  [
    'assuredefi', 'assure', 'defi', 'audit', 'audits', 'auditcertificate',
    'certificate', 'cert', 'report', 'token', 'tokenv2', 'tokens', 'erc',
    'erc20', '20', 'bep', 'bep20', 'adv', 'adv2', 'adv3', 'advanced', 'st',
    'st2', 'v2', 'v3', 'v4', 'v5', 'v6', 'final', 'initial', 'draft', 'kyc',
    'flash', 'mm', 'farm', 'lock', 'locker', 'orderbook', 'sol', 'bsc', 'eth',
    'base', 'arb', 'vac', 'labo', 'network', 'protocol', 'finance', 'security',
    'ai', 'the', 'of', 'and',
  ].map(norm)
);

/**
 * The leading NAME segment of a filename: skip any leading document-noise or
 * date tokens, then take tokens up to the next one. For
 * "ASSUREDEFI_CNDR_TOKEN_Audit_06_14_2023" that is ["CNDR"]; for
 * "BASED MONSTA_ADV_12_28_24" it is ["BASED","MONSTA"] — which is what stops a
 * generic-suffix rule from reading "BASED" alone and claiming "Based Finance".
 */
function nameSegment(tokens) {
  const junk = (t) => NOISE.has(norm(t)) || /^\d+$/.test(t);
  let i = 0;
  while (i < tokens.length && junk(tokens[i])) i++;
  const out = [];
  while (i < tokens.length && !junk(tokens[i])) out.push(tokens[i++]);
  return out;
}

// Generic corporate suffixes a project name carries and its audit filename
// routinely drops ("LYNX_..." for "Lynx Tech"). Applied ONLY to a filename's
// full name segment, and only when exactly one project matches.
const GENERIC_SUFFIX = [
  'ai', 'finance', 'token', 'coin', 'network', 'protocol', 'labs', 'lab',
  'io', 'app', 'inc', 'tech', 'global', 'world', 'capital',
];

/** A window is usable only if it is substantive and not pure document noise. */
function windowOk(tokens) {
  if (!tokens.length) return false;
  if (tokens.every((t) => NOISE.has(norm(t)))) return false;
  if (tokens.some((t) => /^\d+$/.test(t))) return false; // date fragments
  const key = norm(tokens.join(''));
  return key.length >= 3;
}

/**
 * The contract fields are free text in the source: some hold several addresses
 * with chain labels, five hold a block-explorer URL, and a few hold a sentence
 * ("not yet deployed"). Collapse whitespace, and where EVM addresses are present
 * take those verbatim — that is a read of what the field contains, never a guess
 * at what it meant. Anything with no address is kept as-is so the record still
 * shows what was filed.
 */
function contractValues(v) {
  if (!v) return [];
  const flat = String(v).replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const evm = flat.match(/0x[0-9a-fA-F]{40}/g);
  if (evm && evm.length) return [...new Set(evm)];
  return [flat];
}

/** Best-effort date out of a filename, for ordering multiple matches. */
function fileDate(basename) {
  const b = basename.replace(/\.[a-z0-9]+$/i, '');
  let m;
  // 20230830_... or 2024_12_04_...
  if ((m = b.match(/(^|[^0-9])(20\d{2})[_-]?(\d{2})[_-]?(\d{2})([^0-9]|$)/))) {
    return `${m[2]}-${m[3]}-${m[4]}`;
  }
  // ..._MM_DD_YY  or  ..._M_D_YYYY
  const all = [...b.matchAll(/(\d{1,2})[_-](\d{1,2})[_-](\d{2,4})(?=$|[^0-9])/g)];
  if (all.length) {
    const g = all[all.length - 1];
    const mm = g[1].padStart(2, '0');
    const dd = g[2].padStart(2, '0');
    let yy = g[3];
    if (yy.length === 2) yy = `20${yy}`;
    if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) return `${yy}-${mm}-${dd}`;
  }
  return null;
}

// ---------------------------------------------------------------- load data

function readTsv(name) {
  const raw = fs.readFileSync(path.join(IN, `${name}.files.tsv`), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length)
    .map((l) => {
      const [p, size] = l.split('\t');
      return { path: p, size: Number(size) || 0 };
    });
}

const raw = JSON.parse(fs.readFileSync(path.join(IN, 'projects.json'), 'utf8'));
const kycFiles = readTsv('KYC-Certificates');
const auditFiles = readTsv('Audits');
const certFiles = readTsv('Audit-Certificates');

// Project names in the source carry stray leading/trailing whitespace and
// embedded newlines ("Trumpius Maximus\n"). Clean for display AND for matching.
const projects = raw.map((r) => ({
  ...r,
  name: String(r.name || '').replace(/\s+/g, ' ').trim(),
  slug: String(r.slug || '').trim(),
}));

// ------------------------------------------------------- matching machinery

/**
 * normalized key -> [project index...]. Built from name, slug and ticker.
 * A key claimed by more than one project is AMBIGUOUS and is never linked,
 * because picking one would attach another project's document to this row.
 */
const keyToProjects = new Map();
projects.forEach((p, i) => {
  const keys = new Set([norm(p.name), norm(p.slug), norm(p.ticker)].filter((k) => k.length >= 3));
  for (const k of keys) {
    if (!keyToProjects.has(k)) keyToProjects.set(k, new Set());
    keyToProjects.get(k).add(i);
  }
});
const ambiguousKeys = new Set(
  [...keyToProjects.entries()].filter(([, s]) => s.size > 1).map(([k]) => k)
);

/**
 * DECLARED aliases. Each githubReportLink is a project record pointing at a
 * specific file in the Audits repo, so it states the filename convention that
 * project's documents use ("CRAFTEO_..." is Crafteo AI). Nothing is inferred:
 * an alias is registered only when it is not already a project key and no other
 * project has claimed it.
 */
const aliasToProject = new Map();
const aliasRejected = new Set();
projects.forEach((p, i) => {
  const link = p.githubReportLink ? String(p.githubReportLink).trim() : '';
  if (!/^https:\/\/(github\.com|raw\.githubusercontent\.com)\/Assure-DeFi\//.test(link)) return;
  let base;
  try { base = decodeURIComponent(link.split('/').pop()); } catch { return; }
  const key = norm(nameSegment(fileTokens(base)).join(''));
  if (key.length < 3) return;
  if (keyToProjects.has(key)) return;                       // a real project name wins
  if (aliasToProject.has(key) && aliasToProject.get(key) !== i) {
    aliasRejected.add(key);                                 // two projects claim it
    aliasToProject.delete(key);
    return;
  }
  if (aliasRejected.has(key)) return;
  aliasToProject.set(key, i);
});

/** Unique project for a normalized key, or null. Exact -> alias -> suffix. */
function resolveKey(key, allowSuffix) {
  if (ambiguousKeys.has(key)) return null;
  const exact = keyToProjects.get(key);
  if (exact && exact.size === 1) return [...exact][0];
  if (aliasToProject.has(key)) return aliasToProject.get(key);
  if (!allowSuffix) return null;
  let found = null;
  const consider = (c) => {
    if (!c || c.size !== 1) return true;
    const idx = [...c][0];
    if (found !== null && found !== idx) return false;      // two candidates, two projects
    found = idx;
    return true;
  };
  for (const suf of GENERIC_SUFFIX) {
    // project name carries the suffix, the filename drops it ("LYNX" / "Lynx Tech")
    if (!consider(keyToProjects.get(key + suf))) return null;
    // filename carries it, the project name drops it ("GeneAlphaAi" / "GeneAlpha")
    if (key.length > suf.length + 2 && key.endsWith(suf)) {
      if (!consider(keyToProjects.get(key.slice(0, -suf.length)))) return null;
    }
  }
  return found;
}

/**
 * Attach every file in a repo to the project whose name/slug/ticker equals the
 * LONGEST contiguous token window of the filename. Longest-window-wins keeps
 * "GG PROTOCOL" from being claimed by a project called "GG".
 */
const suffixMatches = [];   // audit trail for the generic-suffix pass

function matchRepo(files, repo, opts = {}) {
  const byProject = new Map(); // project index -> [{path,url,date,size}]
  const unmatched = [];

  for (const f of files) {
    const base = path.basename(f.path);
    let tokens = fileTokens(base);

    // "<Name> KYC Certificate.png" — the suffix is fixed, so strip it and use
    // the whole remaining prefix as the single candidate.
    if (opts.kycSuffix) {
      const m = base.match(/^(.*?)\s*KYC\s*Certificate\.[a-z0-9]+$/i);
      if (m) tokens = [m[1].trim()];
    }

    // Pass 1 — exact or declared-alias match on the longest contiguous window.
    let best = null; // {len, projectIdx}
    for (let i = 0; i < tokens.length; i++) {
      for (let j = tokens.length; j > i; j--) {
        const win = tokens.slice(i, j);
        if (!windowOk(win)) continue;
        const key = norm(win.join(''));
        const idx = resolveKey(key, false);
        if (idx == null) continue;
        if (!best || key.length > best.len) best = { len: key.length, projectIdx: idx };
      }
    }

    // Pass 2 — generic-suffix tolerance, restricted to the FULL name segment so
    // a sub-window can never claim a different project.
    if (!best) {
      const seg = nameSegment(tokens);
      if (windowOk(seg)) {
        const idx = resolveKey(norm(seg.join('')), true);
        if (idx != null) best = { len: 0, projectIdx: idx, viaSuffix: true };
      }
    }

    if (!best) {
      unmatched.push(f.path);
      continue;
    }
    if (best.viaSuffix) {
      suffixMatches.push({ repo, file: base, project: projects[best.projectIdx].name });
    }
    if (!byProject.has(best.projectIdx)) byProject.set(best.projectIdx, []);
    byProject.get(best.projectIdx).push({
      path: f.path,
      url: blobUrl(repo, f.path),
      date: fileDate(base),
      size: f.size,
      viaSuffix: !!best.viaSuffix,
    });
  }

  // Newest date in filename first; undated last, then by path for stability.
  for (const list of byProject.values()) {
    list.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a.path.localeCompare(b.path);
    });
  }
  return { byProject, unmatched };
}

const kycMatch = matchRepo(kycFiles, REPOS.kyc, { kycSuffix: true });
const auditMatch = matchRepo(auditFiles, REPOS.audit);
const certMatch = matchRepo(certFiles, REPOS.cert);

// ------------------------------------------------------------ assemble rows

/**
 * Slimmed column set. Fields dropped and why:
 *   description, imageUrl, nftImageUrl  — bulk / a dying Supabase host
 *   addedBy, processed, renounceCheckedAt, id, published, featured, isProofProject,
 *   nftUrl, projectUrl, hasAuditReport, kycCertificateUrl  — no display use
 *   ticker, website, twitter, telegram, discord, kycCountryTier, verifiedMembers,
 *   medium  — NULL on all 985 records in this dataset (see BUILD-REPORT.md)
 */
const rejectedDeclaredLinks = [];
const rows = projects.map((p, i) => {
  const kyc = kycMatch.byProject.get(i) || [];
  const certs = certMatch.byProject.get(i) || [];
  let audits = (auditMatch.byProject.get(i) || []).map((a) => a.url);

  // githubReportLink is already a canonical GitHub URL — use it verbatim, first.
  // Default-DENY the origin: this value is dataset-sourced and lands in an href,
  // so anything that is not an Assure-DeFi GitHub URL is dropped, not rendered.
  const raw = p.githubReportLink ? String(p.githubReportLink).trim() : null;
  const declared = raw && /^https:\/\/(github\.com|raw\.githubusercontent\.com)\/Assure-DeFi\//.test(raw)
    ? raw
    : null;
  if (raw && !declared) rejectedDeclaredLinks.push({ name: p.name, url: raw });
  if (declared) audits = [declared, ...audits.filter((u) => u !== declared)];

  const chains = [...new Set([p.chain1, p.chain2].filter(Boolean))];
  return {
    name: p.name,
    slug: p.slug,
    chains,
    contracts: [...new Set([
      ...contractValues(p.contractAddress1),
      ...contractValues(p.contractAddress2),
    ])],
    kycStatus: p.kycStatus || 'none',
    kycDate: p.kycDate || null,
    auditStatus: p.auditStatus || 'none',
    auditDate: p.auditDate || null,
    auditScore: p.auditScore == null ? null : Number(p.auditScore),
    tier: p.verificationTier || null,
    renounced: !!p.renounced,
    kycCerts: kyc.map((f) => f.url),
    auditReports: audits,
    auditCerts: certs.map((f) => f.url),
  };
});

// ------------------------------------------------------------- measurements

// Fields the source carries but never populates. Computed, not remembered: any
// field null/empty on every record has no display use and is dropped from the
// page, the CSV and the workbook rather than shipped as 985 empty cells.
const allNullFields = Object.keys(
  projects.reduce((acc, p) => { Object.keys(p).forEach((k) => { acc[k] = 1; }); return acc; }, {})
).filter((k) => projects.every((p) => p[k] === null || p[k] === undefined || p[k] === ''));

const approvedKyc = rows.filter((r) => r.kycStatus === 'approved');
const completedAudit = rows.filter((r) => r.auditStatus === 'completed');

const stats = {
  rows: rows.length,
  kycFiles: kycFiles.length,
  auditFiles: auditFiles.length,
  certFiles: certFiles.length,
  kycMatchedRows: rows.filter((r) => r.kycCerts.length).length,
  auditMatchedRows: rows.filter((r) => r.auditReports.length).length,
  certMatchedRows: rows.filter((r) => r.auditCerts.length).length,
  kycFilesMatched: kycFiles.length - kycMatch.unmatched.length,
  auditFilesMatched: auditFiles.length - auditMatch.unmatched.length,
  certFilesMatched: certFiles.length - certMatch.unmatched.length,
  kycUnmatchedFiles: kycMatch.unmatched,
  auditUnmatchedFiles: auditMatch.unmatched,
  certUnmatchedFiles: certMatch.unmatched,
  approvedKycTotal: approvedKyc.length,
  approvedKycNoCert: approvedKyc.filter((r) => !r.kycCerts.length).map((r) => r.name),
  completedAuditTotal: completedAudit.length,
  completedAuditNoReport: completedAudit.filter((r) => !r.auditReports.length).map((r) => r.name),
  ambiguousKeys: [...ambiguousKeys],
  allNullFields,
  aliases: [...aliasToProject.entries()].map(([k, i]) => `${k} -> ${projects[i].name}`),
  rejectedDeclaredLinks,
};

// ---------------------------------------------------------------- CSV / TSV

const CSV_COLUMNS = [
  'name', 'slug', 'chains', 'contract_addresses', 'kyc_status', 'kyc_date',
  'audit_status', 'audit_date', 'audit_score', 'verification_tier', 'renounced',
  'kyc_certificate_urls', 'audit_report_urls', 'audit_certificate_urls',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowValues(r) {
  return [
    r.name, r.slug, r.chains.join(' | '), r.contracts.join(' | '),
    r.kycStatus, r.kycDate, r.auditStatus, r.auditDate,
    r.auditScore == null ? '' : r.auditScore, r.tier, r.renounced ? 'yes' : 'no',
    r.kycCerts.join(' '), r.auditReports.join(' '), r.auditCerts.join(' '),
  ];
}

// --------------------------------------------------------------- HTML build

const logoB64 = fs.readFileSync(path.join(IN, 'brand', 'Assure-brand.webp')).toString('base64');
const LOGO_URI = `data:image/webp;base64,${logoB64}`;

// ------------------------------------------------- per-project detail pages
//
// One static page per verification under projects/. Built before the
// landing page, because the landing table links a project row to its page only
// where a page actually exists — never to a guessed path.
const { buildDetailPages } = require('./tools/detail-pages.cjs');
const detailBuild = buildDetailPages({ outDir: OUT, logoDataUri: LOGO_URI });

// Compact payload: a header list plus array rows, so 985 objects do not repeat
// 15 key names each. Link lists are arrays of URLs (usually empty).
const PAYLOAD_COLS = [
  'n', 's', 'ch', 'ca', 'ks', 'kd', 'as', 'ad', 'sc', 'tr', 'rn', 'kc', 'ar', 'ac', 'pg',
];
const payload = {
  cols: PAYLOAD_COLS,
  rows: rows.map((r) => [
    r.name, r.slug, r.chains, r.contracts, r.kycStatus, r.kycDate,
    r.auditStatus, r.auditDate, r.auditScore, r.tier, r.renounced ? 1 : 0,
    r.kycCerts, r.auditReports, r.auditCerts,
    pageHref(r.slug),
  ]),
};

/** The landing dataset's slug, resolved through the archive's alias map. */
function pageHref(slug) {
  if (detailBuild.index.has(slug)) return detailBuild.index.get(slug);
  const aliased = detailBuild.aliases[slug];
  return aliased ? detailBuild.index.get(aliased) : '';
}

// Rows whose slug has no archive page. Reported, never papered over: the two
// datasets behind this build (the landing dataset and the live API sweep) do
// not carry an identical slug set.
const rowsWithoutPage = rows.filter((r) => !pageHref(r.slug)).map((r) => r.slug);

const chainList = [...new Set(rows.flatMap((r) => r.chains))].sort();

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CLOSURE_MONTH = 'September 2026';
const CLOSURE_STATEMENT =
  'Assure DeFi ceased operations in ' + CLOSURE_MONTH + '. ' +
  'Every KYC verification and smart-contract audit we issued remains publicly available below, permanently.';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assure DeFi &mdash; Verification Archive</title>
<meta name="description" content="Assure DeFi has closed its doors. The permanent public archive of every KYC verification and smart-contract audit we issued.">
<style>
:root{
  --navy:#0A0724; --bg1:#090822; --bg2:#04030e; --bg3:#050411;
  --card:#12122b; --gold:#E2D243; --gold-bright:#ffe627; --gold-dark:#968929;
  --gold-mid:#d1b933; --light:#F2F2F2; --line:rgba(226,210,67,.16);
  --line-soft:rgba(255,255,255,.08); --muted:rgba(242,242,242,.62);
  --muted-2:rgba(242,242,242,.42);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg2); color:var(--light);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px; line-height:1.55; overflow-x:hidden;
}
.wrap{max-width:1240px; margin:0 auto; padding-inline:20px}
a{color:var(--gold-mid); text-decoration:none}
a:hover{color:var(--gold-bright); text-decoration:underline}

/* ---- header ---- */
header{
  background:linear-gradient(to bottom,var(--bg1),var(--bg2));
  border-bottom:1px solid var(--line);
}
.hd{padding-block:44px 52px}
.logo{height:64px; width:auto; display:block; margin-bottom:30px}
h1{
  margin:0 0 16px; font-size:clamp(28px,5.4vw,50px); line-height:1.12;
  font-weight:800; letter-spacing:-.02em;
}
h1 .g{
  background:linear-gradient(to right,var(--gold-dark),var(--gold-bright));
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.sub{margin:0; max-width:62ch; font-size:clamp(15px,2.3vw,18px); color:var(--muted)}
.stamp{
  margin-top:26px; display:inline-flex; align-items:center; gap:9px;
  border:1px solid var(--line); border-radius:999px; padding:7px 15px;
  font-size:12.5px; letter-spacing:.09em; text-transform:uppercase;
  color:var(--gold); background:rgba(226,210,67,.05);
}
.dot{width:7px; height:7px; border-radius:50%; background:var(--gold-dark)}

/* ---- archive cards ---- */
section{padding-block:44px}
h2{
  margin:0 0 6px; font-size:20px; font-weight:700; letter-spacing:-.01em;
}
.lede{margin:0 0 22px; color:var(--muted); font-size:14.5px; max-width:70ch}
.cards{display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.card{
  display:block; background:linear-gradient(140deg,#0a0923,#161544);
  border:1px solid var(--line-soft); border-radius:14px; padding:22px 22px 20px;
  color:inherit; transition:border-color .18s ease, transform .18s ease;
}
.card:hover{border-color:var(--line); text-decoration:none; transform:translateY(-2px)}
.card .num{
  font-size:38px; font-weight:800; line-height:1; letter-spacing:-.02em;
  color:var(--gold);
}
.card .lbl{margin-top:10px; font-weight:600; font-size:15px}
.card .meta{margin-top:5px; font-size:12.5px; color:var(--muted-2)}

/* ---- controls ---- */
.controls{
  display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px;
}
input[type=search],select{
  background:var(--card); color:var(--light); border:1px solid var(--line-soft);
  border-radius:9px; padding:10px 12px; font:inherit; font-size:14px; min-width:0;
}
input[type=search]{flex:1 1 260px}
input[type=search]:focus,select:focus{outline:2px solid var(--gold-dark); outline-offset:1px}
select{flex:0 1 auto}
.count{font-size:13px; color:var(--muted-2); margin-left:auto; white-space:nowrap}
.btn{
  background:transparent; border:1px solid var(--line); color:var(--gold);
  border-radius:9px; padding:10px 14px; font:inherit; font-size:13.5px; cursor:pointer;
}
.btn:hover{background:rgba(226,210,67,.07)}

/* ---- table ---- */
.tablebox{
  border:1px solid var(--line-soft); border-radius:12px; overflow:auto;
  background:var(--bg3); max-height:78vh;
}
table{border-collapse:collapse; width:100%; min-width:1080px; font-size:13.5px}
thead th{
  position:sticky; top:0; z-index:2; background:#0d0c26; text-align:left;
  padding:11px 12px; font-size:11.5px; letter-spacing:.07em; text-transform:uppercase;
  color:var(--muted); border-bottom:1px solid var(--line); white-space:nowrap;
}
thead th.sortable{cursor:pointer; user-select:none}
thead th.sortable:hover{color:var(--gold)}
th .arw{color:var(--gold); font-size:10px}
tbody td{padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.045); vertical-align:top}
tbody tr:hover{background:rgba(226,210,67,.035)}
tbody tr.hl{background:rgba(226,210,67,.13); outline:1px solid var(--line)}
.nm{font-weight:600; color:var(--light)}
a.nm{color:var(--light); text-decoration:underline; text-decoration-color:var(--line);
  text-underline-offset:3px}
a.nm:hover{color:var(--gold-bright); text-decoration-color:currentColor}
.sl{display:block; font-size:11.5px; color:var(--muted-2); font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--muted); white-space:nowrap}
tbody td:nth-child(5){white-space:nowrap}
/* the link columns hold up to ten reports for one project: let them wrap
   rather than stretch the table for every other row */
tbody td:nth-child(8),tbody td:nth-child(9){max-width:240px}
.lk{display:inline-block; margin:0 8px 3px 0}
.dt{color:var(--muted); font-size:12px; display:block; margin-top:2px}
.pill{
  display:inline-block; padding:2px 9px; border-radius:999px; font-size:11.5px;
  font-weight:600; white-space:nowrap; border:1px solid transparent;
}
.p-ok{background:rgba(226,210,67,.13); color:var(--gold); border-color:var(--line)}
.p-no{background:rgba(255,255,255,.05); color:var(--muted-2); border-color:var(--line-soft)}
.p-rej{background:rgba(255,120,120,.1); color:#ff9b9b; border-color:rgba(255,120,120,.22)}
.dash{color:var(--muted-2)}
.empty{padding:40px 20px; text-align:center; color:var(--muted-2)}

/* ---- downloads + footer ---- */
.dl{
  margin-top:18px; display:flex; flex-wrap:wrap; gap:12px; align-items:center;
  border:1px solid var(--line-soft); border-radius:12px; padding:16px 18px;
  background:var(--card);
}
.dl .t{font-weight:600; margin-right:4px}
.dl .n{font-size:13px; color:var(--muted-2); flex-basis:100%}
footer{
  border-top:1px solid var(--line-soft); margin-top:40px;
  padding-block:30px 44px; color:var(--muted-2); font-size:13px;
}
@media (max-width:640px){
  .wrap{padding-inline:16px}
  .hd{padding-block:32px 38px}
  .count{margin-left:0; flex-basis:100%}
  .tablebox{max-height:70vh}
}
</style>
</head>
<body>

<header>
  <div class="wrap hd">
    <img class="logo" src="${LOGO_URI}" alt="Assure DeFi">
    <!-- EDIT-BLOCK: closure statement -->
    <h1>Assure DeFi has <span class="g">closed its doors</span>.</h1>
    <p class="sub">${esc(CLOSURE_STATEMENT)}</p>
    <!-- /EDIT-BLOCK: closure statement -->
    <span class="stamp"><span class="dot"></span>Archive &middot; not maintained</span>
  </div>
</header>

<main class="wrap">

<section>
  <h2>The permanent record</h2>
  <p class="lede">Every document we issued is hosted in public GitHub repositories and stays reachable whether or not this page does. Open a repository to browse or download the files.</p>
  <div class="cards">
    <a class="card" href="https://github.com/Assure-DeFi/KYC-Certificates">
            <div class="lbl">KYC Certificates</div>
      <div class="meta">Assure-DeFi/KYC-Certificates</div>
    </a>
    <a class="card" href="https://github.com/Assure-DeFi/Audits">
            <div class="lbl">Audit Reports</div>
      <div class="meta">Assure-DeFi/Audits</div>
    </a>
    <a class="card" href="https://github.com/Assure-DeFi/Audit-Certificates">
            <div class="lbl">Audit Certificates</div>
      <div class="meta">Assure-DeFi/Audit-Certificates</div>
    </a>
  </div>
</section>

<section>
  <h2>KYC verifications</h2>
  <p class="lede">Search by project name, slug or contract address. Open a project name for its full verification record &mdash; the team members who were verified, what each had control over, their country tier and verified contacts, the contract, and every audit report. A dash means no document of that kind was matched to that project. Nothing here is inferred: a link appears only where a file in the public repositories is confidently the one for that record.</p>
  <p class="lede">The source dataset carried no ticker, website or social fields for any record, so those columns are not shown.</p>

  <div class="controls">
    <input type="search" id="q" placeholder="Search projects, slugs, contract addresses&hellip;" aria-label="Search verifications">
    <select id="fk" aria-label="Filter by KYC status">
      <option value="">KYC: any</option>
      <option value="approved">KYC: approved</option>
      <option value="rejected">KYC: rejected</option>
      <option value="none">KYC: none</option>
    </select>
    <select id="fa" aria-label="Filter by audit status">
      <option value="">Audit: any</option>
      <option value="completed">Audit: completed</option>
      <option value="none">Audit: none</option>
    </select>
    <select id="fc" aria-label="Filter by chain">
      <option value="">Chain: any</option>
${chainList.map((c) => `      <option value="${esc(c)}">${esc(c)}</option>`).join('\n')}
    </select>
    <button class="btn" id="reset" type="button">Reset</button>
    <span class="count" id="count"></span>
  </div>

  <div class="tablebox" id="tbox">
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">Project <span class="arw" data-arw="name"></span></th>
          <th>Chain(s)</th>
          <th class="sortable" data-sort="kyc">KYC <span class="arw" data-arw="kyc"></span></th>
          <th class="sortable" data-sort="audit">Audit <span class="arw" data-arw="audit"></span></th>
          <th>Tier</th>
          <th>Contract</th>
          <th>Certificate</th>
          <th>Audit report</th>
          <th>Audit cert.</th>
        </tr>
      </thead>
      <tbody id="tb"></tbody>
    </table>
    <div class="empty" id="empty" hidden>No verifications match those filters.</div>
  </div>

  <div class="dl">
    <span class="t">Download the full dataset:</span>
    <a href="verifications.csv" download>verifications.csv</a>
    <a href="verifications.xlsx" download>verifications.xlsx</a>
    <span class="n">Same table, same columns, with the resolved certificate and report URLs.</span>
  </div>
</section>

</main>

<footer class="wrap">
  <p>This page is a static archive and is not maintained.</p>
  <p>Assure DeFi &middot; verification records ${(() => {
    const ds = rows.map((r) => r.kycDate).filter(Boolean).sort();
    return ds.length ? `${ds[0].slice(0, 4)}&ndash;${ds[ds.length - 1].slice(0, 4)}` : '';
  })()}</p>
</footer>

<script>
(function(){
"use strict";
var DATA = ${JSON.stringify(payload)};
var C = {}; DATA.cols.forEach(function(k,i){ C[k]=i; });
var ROWS = DATA.rows;

// Precompute a lowercase haystack per row so filtering 985 rows is trivial.
var HAY = ROWS.map(function(r){
  return (r[C.n]+" "+r[C.s]+" "+r[C.ch].join(" ")+" "+r[C.ca].join(" ")).toLowerCase();
});
var SLUG = {}; ROWS.forEach(function(r,i){ SLUG[r[C.s]] = i; });

var view = ROWS.map(function(_,i){ return i; });
var sortKey = "kyc", sortDir = -1;   // default: newest KYC date first
var RENDER_STEP = 120, rendered = 0;

var q=document.getElementById("q"), fk=document.getElementById("fk"),
    fa=document.getElementById("fa"), fc=document.getElementById("fc"),
    tb=document.getElementById("tb"), tbox=document.getElementById("tbox"),
    countEl=document.getElementById("count"), emptyEl=document.getElementById("empty");

function esc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function pill(v){
  var cls = v==="approved"||v==="completed" ? "p-ok" : (v==="rejected" ? "p-rej" : "p-no");
  return '<span class="pill '+cls+'">'+esc(v)+"</span>";
}
function links(list, label){
  if(!list || !list.length) return '<span class="dash">&mdash;</span>';
  return list.map(function(u,i){
    return '<a class="lk" href="'+esc(u)+'" rel="noopener">'+label+(list.length>1?" "+(i+1):"")+"</a>";
  }).join("");
}
// An address is truncated in the middle, where the informative ends survive.
// A free-text value (a few records hold "not deployed yet" prose) is truncated
// from the front, because its middle-ellipsis form is unreadable.
function shorten(a){
  if(a.length<=18) return a;
  return /\\s/.test(a) ? a.slice(0,20)+"\\u2026" : a.slice(0,8)+"\\u2026"+a.slice(-6);
}

function rowHtml(i){
  var r = ROWS[i];
  var chains = r[C.ch].length ? esc(r[C.ch].join(", ")) : '<span class="dash">&mdash;</span>';
  var contracts = r[C.ca].length
    ? r[C.ca].map(function(a){ return '<span class="mono" title="'+esc(a)+'">'+esc(shorten(a))+"</span>"; }).join("<br>")
    : '<span class="dash">&mdash;</span>';
  var score = r[C.sc]==null ? "" : '<span class="dt">score '+r[C.sc]+"</span>";
  // The project cell links to its archive page. A row with no page (the two
  // source datasets do not carry identical slug sets) renders plain text.
  var nm = r[C.pg]
    ? '<a class="nm" href="'+esc(r[C.pg])+'">'+esc(r[C.n])+"</a>"
    : '<span class="nm">'+esc(r[C.n])+"</span>";
  return '<tr id="r-'+esc(r[C.s])+'">'
    + "<td>"+nm+'<span class="sl">'+esc(r[C.s])+"</span></td>"
    + "<td>"+chains+"</td>"
    + "<td>"+pill(r[C.ks])+(r[C.kd]?'<span class="dt">'+esc(r[C.kd])+"</span>":"")+"</td>"
    + "<td>"+pill(r[C.as])+(r[C.ad]?'<span class="dt">'+esc(r[C.ad])+"</span>":"")+score+"</td>"
    + '<td><span class="mono">'+esc(r[C.tr]||"\\u2014")+"</span></td>"
    + "<td>"+contracts+"</td>"
    + "<td>"+links(r[C.kc],"PNG")+"</td>"
    + "<td>"+links(r[C.ar],"PDF")+"</td>"
    + "<td>"+links(r[C.ac],"Cert")+"</td>"
    + "</tr>";
}

function cmp(a,b){
  var ra=ROWS[a], rb=ROWS[b], x, y;
  if(sortKey==="name"){ x=ra[C.n].toLowerCase(); y=rb[C.n].toLowerCase(); }
  else if(sortKey==="kyc"){ x=ra[C.kd]||""; y=rb[C.kd]||""; }
  else { x=ra[C.ad]||""; y=rb[C.ad]||""; }
  if(x===y) return ra[C.n].localeCompare(rb[C.n]);
  // Rows with no date always sink, whichever direction is active.
  if(sortKey!=="name"){
    if(!x) return 1;
    if(!y) return -1;
  }
  return (x<y?-1:1)*sortDir;
}

function apply(){
  var s = q.value.trim().toLowerCase(), k=fk.value, a=fa.value, c=fc.value;
  view = [];
  for(var i=0;i<ROWS.length;i++){
    var r = ROWS[i];
    if(s && HAY[i].indexOf(s)===-1) continue;
    if(k && r[C.ks]!==k) continue;
    if(a && r[C.as]!==a) continue;
    if(c && r[C.ch].indexOf(c)===-1) continue;
    view.push(i);
  }
  view.sort(cmp);
  rendered = 0; tb.innerHTML = "";
  emptyEl.hidden = view.length>0;
  countEl.textContent = "";
  grow();
  document.querySelectorAll("[data-arw]").forEach(function(el){
    el.textContent = el.getAttribute("data-arw")===sortKey ? (sortDir===1?"\\u25B2":"\\u25BC") : "";
  });
}

// Render on demand: 120 rows at a time as the container scrolls.
function grow(){
  if(rendered>=view.length) return;
  var end = Math.min(rendered+RENDER_STEP, view.length), html="";
  for(var i=rendered;i<end;i++) html += rowHtml(view[i]);
  tb.insertAdjacentHTML("beforeend", html);
  rendered = end;
}
tbox.addEventListener("scroll", function(){
  if(tbox.scrollTop + tbox.clientHeight >= tbox.scrollHeight - 400) grow();
});

q.addEventListener("input", apply);
fk.addEventListener("change", apply);
fa.addEventListener("change", apply);
fc.addEventListener("change", apply);
document.getElementById("reset").addEventListener("click", function(){
  q.value=""; fk.value=""; fa.value=""; fc.value=""; apply();
});
document.querySelectorAll("th.sortable").forEach(function(th){
  th.addEventListener("click", function(){
    var k = th.getAttribute("data-sort");
    if(sortKey===k) sortDir = -sortDir;
    else { sortKey=k; sortDir = (k==="name") ? 1 : -1; }
    apply();
  });
});

// #p=<slug> deep link: render through to that row, scroll it in, highlight it.
function jump(){
  var m = /(?:^|[#&])p=([^&]+)/.exec(location.hash);
  if(!m) return;
  var slug = decodeURIComponent(m[1]);
  if(!(slug in SLUG)) return;
  var idx = SLUG[slug];
  q.value=""; fk.value=""; fa.value=""; fc.value=""; apply();
  var pos = view.indexOf(idx);
  if(pos<0) return;
  while(rendered <= pos) grow();
  var el = document.getElementById("r-"+slug);
  if(!el) return;
  document.querySelectorAll("tr.hl").forEach(function(t){ t.classList.remove("hl"); });
  el.classList.add("hl");
  tbox.scrollTop = el.offsetTop - tbox.clientHeight/3;
  tbox.scrollIntoView({block:"center"});
}
window.addEventListener("hashchange", jump);

apply();
jump();
})();
</script>
</body>
</html>
`;

// --------------------------------------------------- nft.assuredefi.com map
// The detail pages carry outbound links to `nft.assuredefi.com/?token=<n>`, the
// old verification-NFT viewer. That host is dead (measured 2026-09-10: HTTP 404
// for the exact token URLs these pages link), so the links are broken inside the
// archive we just published. A Cloudflare rule sends that host to /nft/ here,
// preserving the query, and this table resolves the token to the project page.
//
// DERIVED FROM THE SHIPPED BYTES, never from a hand list: each built page is read
// back and its token links extracted, so a page that stops linking a token drops
// out of the table by itself and a token can never point at a page that is gone.
// A token appearing on TWO different projects is AMBIGUOUS and is deliberately
// left out — it lands on the landing page, because guessing which project a
// certificate belongs to is exactly the wrong redirect to invent.
const nftTokenSlugs = new Map();
for (const pg of detailBuild.pages) {
  const html = fs.readFileSync(path.join(OUT, pg.rel), 'utf8');
  const re = /nft\.assuredefi\.com\/\?token=(\d+)/g;
  let mt;
  while ((mt = re.exec(html))) {
    if (!nftTokenSlugs.has(mt[1])) nftTokenSlugs.set(mt[1], new Set());
    nftTokenSlugs.get(mt[1]).add(pg.slug);
  }
}
const nftTokens = {};
const nftTokensAmbiguous = {};
for (const [tok, slugs] of nftTokenSlugs) {
  const only = [...slugs];
  if (only.length === 1 && detailBuild.index.has(only[0])) nftTokens[tok] = only[0];
  else nftTokensAmbiguous[tok] = only;
}

// ------------------------------------------------ DECLARED manual slug aliases
// Old URLs no dataset can derive, each added by a human with the date and the
// reason. Used ONLY by the 404.html redirect map, never by the landing table.
// The build refuses an entry whose target has no page, or whose old slug is
// itself a live page (it would be unreachable, and silently so).
const MANUAL_SLUG_ALIASES = Object.freeze({
  // 2026-09-11: an old Webflow page served /projects/plutochain; the archive
  // page is /projects/pluto-chain/.
  plutochain: 'pluto-chain',
});
for (const [from, to] of Object.entries(MANUAL_SLUG_ALIASES)) {
  if (!detailBuild.index.has(to)) throw new Error(`manual alias ${from} -> ${to}: no archive page for ${to}`);
  if (detailBuild.index.has(from)) throw new Error(`manual alias ${from}: ${from} is already a live page`);
  if (detailBuild.aliases[from] && detailBuild.aliases[from] !== to) {
    throw new Error(`manual alias ${from} -> ${to} contradicts derived alias -> ${detailBuild.aliases[from]}`);
  }
}
const redirectAliases = { ...detailBuild.aliases, ...MANUAL_SLUG_ALIASES };

const notFound = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assure DeFi &mdash; Verification Archive</title>
<style>
body{margin:0;background:#04030e;color:#F2F2F2;font-family:Inter,-apple-system,
BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;
min-height:100vh;align-items:center;justify-content:center;padding:20px;text-align:center}
a{color:#d1b933}
p{max-width:46ch;color:rgba(242,242,242,.62)}
</style>
<script>
(function(){
  // Old projects-site paths: /project/<slug> and /projects/<slug>. Both go to
  // the archive page for that slug when one exists, and otherwise to the
  // slug's row on the landing table. The slug list is generated, so a path
  // that never had a page can never be redirected to a 404.
  var PAGES = ${JSON.stringify([...detailBuild.index.keys()])};
  // A few old seoSlug values are not usable as a path segment (a trailing
  // space, an uppercase form, an ampersand), so their page lives at a
  // sanitised slug and the original maps to it here, followed by the declared
  // manual aliases (MANUAL_SLUG_ALIASES in build.cjs).
  var ALIAS = ${JSON.stringify(redirectAliases)};
  var HAS = {}; for (var i = 0; i < PAGES.length; i++) HAS[PAGES[i]] = 1;
  // Old verification-NFT viewer. Cloudflare sends nft.assuredefi.com/* here with
  // the query preserved; this table is generated from the archive's own pages.
  var TOKENS = ${JSON.stringify(nftTokens)};
  // Trailing segments are tolerated: an old /project/<slug>/anything still knows
  // which project it meant, and a version directory that no longer exists lands
  // on the project page, which lists the versions that do.
  var m = /\\/projects?\\/([^\\/?#]+)(?:\\/|$)/.exec(location.pathname);
  // BASE is everything before /project(s)/..., so the redirect is correct both at
  // the domain root and under a subpath (the GitHub Pages preview URL).
  // At the domain the site root is "/"; on the GitHub Pages preview it is
  // "/<repo>/". DECLARED, never derived from an arbitrary path: deriving it from
  // an unmatched path (e.g. /nonsense/page) sends the redirect back to itself and
  // the browser sits on a page that never loads.
  var PREVIEW_ROOTS = ["/assuredefi.com/"];
  var BASE = "/";
  for (var b = 0; b < PREVIEW_ROOTS.length; b++) {
    if (location.pathname.indexOf(PREVIEW_ROOTS[b]) === 0) { BASE = PREVIEW_ROOTS[b]; break; }
  }
  if (m && location.pathname.slice(0, m.index).indexOf(BASE) !== 0) BASE = "/";
  var to = BASE;
  var nft = /\\/nft(?:\\/|$)/.exec(location.pathname.slice(BASE.length - 1));
  if (nft) {
    // An unknown or ambiguous token goes to the landing page. It is NOT guessed:
    // a certificate sent to the wrong project is worse than no certificate.
    var t = /[?&]token=(\\d+)/.exec(location.search);
    var ts = t && TOKENS[t[1]];
    to = ts ? BASE + "projects/" + encodeURIComponent(ts) + "/" : BASE;
  } else if (m) {
    var seg = m[1];
    // Four lookups, widest last. decodeURIComponent is tried BOTH ways because a
    // few old seoSlug values carry percent-escapes as LITERAL TEXT ("defi%c2%b2"),
    // so the browser decodes a path the alias table stores undecoded.
    var raw;
    try { raw = decodeURIComponent(seg.replace(/\\+/g, " ")); } catch (e) { raw = seg; }
    var slug =
      (HAS[raw] && raw) ||
      ALIAS[raw] ||
      ALIAS[seg] ||
      // Every built slug matches /^[a-z0-9._-]+\$/, so lowercasing and trimming can
      // only ever reach the intended page or nothing at all.
      (HAS[raw.trim().toLowerCase()] && raw.trim().toLowerCase()) ||
      null;
    to = slug ? BASE + "projects/" + encodeURIComponent(slug) + "/" : BASE + "#p=" + seg;
  }
  location.replace(to);
})();
</script>
</head>
<body>
<div>
  <p>Assure DeFi has closed its doors. Redirecting to the verification archive&hellip;</p>
  <p><a href="./">Open the archive</a></p>
</div>
</body>
</html>
`;

// ------------------------------------------------------------------- write

fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '404.html'), notFound);
fs.writeFileSync(
  path.join(OUT, 'verifications.csv'),
  [CSV_COLUMNS.join(','), ...rows.map((r) => rowValues(r).map(csvCell).join(','))].join('\n') + '\n'
);
// Handed to tools/make_xlsx.py, which is the only step that needs Python.
const XLSX_INPUT = path.join(BUILD, 'xlsx-input.json');
fs.writeFileSync(XLSX_INPUT, JSON.stringify({ columns: CSV_COLUMNS, rows: rows.map(rowValues) }));
// The raw API payloads in data/ are inputs here and ship as they are, so a field
// a template misses is still recoverable from the archive itself.

stats.nftTokens = {
  distinct: nftTokenSlugs.size,
  resolved: Object.keys(nftTokens).length,
  ambiguous: nftTokensAmbiguous,
};
stats.detailPages = detailBuild.stats;
stats.detailListOnlyPages = detailBuild.listOnlyPages;
stats.landingRowsWithoutArchivePage = rowsWithoutPage;
stats.manualSlugAliases = MANUAL_SLUG_ALIASES;
fs.writeFileSync(path.join(BUILD, 'stats.json'), JSON.stringify(stats, null, 2));
fs.writeFileSync(path.join(BUILD, 'suffix-matches.json'), JSON.stringify(suffixMatches, null, 2));

// verifications.xlsx — written by openpyxl (3.1.5), so the build needs no npm
// dependency at all. A missing openpyxl is reported, never silently skipped.
let xlsxNote = '';
try {
  const { execFileSync } = require('child_process');
  xlsxNote = execFileSync('python3', [
    path.join(ROOT, 'tools', 'make_xlsx.py'), XLSX_INPUT, path.join(OUT, 'verifications.xlsx'),
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (e) {
  xlsxNote = `XLSX STEP FAILED (CSV still written): ${String(e.message).split('\n')[0]}`;
  process.exitCode = 1;
}

const bytes = fs.statSync(path.join(OUT, 'index.html')).size;
console.log(`rows                 ${stats.rows}`);
console.log(`kyc  files ${stats.kycFilesMatched}/${stats.kycFiles} matched -> ${stats.kycMatchedRows} rows`);
console.log(`audit files ${stats.auditFilesMatched}/${stats.auditFiles} matched -> ${stats.auditMatchedRows} rows`);
console.log(`cert files ${stats.certFilesMatched}/${stats.certFiles} matched -> ${stats.certMatchedRows} rows`);
console.log(`approved KYC with no certificate   ${stats.approvedKycNoCert.length}/${stats.approvedKycTotal}`);
console.log(`completed audit with no report     ${stats.completedAuditNoReport.length}/${stats.completedAuditTotal}`);
console.log(`index.html           ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
console.log(`detail pages         ${detailBuild.stats.pagesBuilt} (${detailBuild.stats.slugs} slugs, ${detailBuild.stats.listOnlyPages} from list data only)`);
console.log(`members rendered     ${detailBuild.stats.membersRendered}`);
console.log(`audit reports        ${detailBuild.stats.reportsRendered}`);
console.log(`landing rows w/o page ${rowsWithoutPage.length}`);
console.log(`nft tokens           ${Object.keys(nftTokens).length}/${nftTokenSlugs.size} resolved (${Object.keys(nftTokensAmbiguous).length} ambiguous, sent to the landing page)`);
console.log(xlsxNote);
