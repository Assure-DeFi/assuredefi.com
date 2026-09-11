'use strict';
/**
 * site.cjs — browser QA for the archive, served the way GitHub Pages serves it
 * (qa/serve.cjs: files as is, a missing path answers 404 with /404.html).
 * Every check runs and is reported; the exit code is non-zero if any failed.
 *
 * Run from the repository root, after `node build.cjs`:
 *   NODE_PATH=/path/to/node_modules node qa/site.cjs
 * NODE_PATH must name a node_modules folder that holds the `playwright` package
 * (1.59 was used) with its Chromium browser installed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { startServer } = require('./serve.cjs');
const { normalizeSocial } = require('../tools/detail-pages.cjs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('qa/site.cjs needs the playwright package: set NODE_PATH to a node_modules folder that has it.');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Old URLs and where each must land. Checked one per line, so a broken entry
// turns exactly its own check red.
const REDIRECTS = [
  ['/project/volt', '/projects/volt/'],
  ['/projects/volt', '/projects/volt/'],
  ['/nft/?token=9', '/projects/0-knowledge-network/'],
  ['/projects/plutochain', '/projects/pluto-chain/'],
  ['/nonsense/page', '/'],
];
// Jeff ruled no totals or counts on the landing page. Outside the data rows the
// only digits allowed are the years the closure statement and footer name.
const ALLOWED_YEARS = ['2021', '2026'];
const MEMBERS_SLUG = 'lynx-tech';   // the most members of any record (six)
const AUDIT_SLUG = 'coincreate';    // the most audit reports of any record (four)
const ARCHIVE_REPOS = ['project-archive-assets', 'project-nft-images'];

const detailAll = JSON.parse(fs.readFileSync(path.join(DATA, 'api-detail-all.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'assets-manifest.json'), 'utf8'));
const archived = new Map();
for (const f of manifest.files || []) if (f.status === 'ok') archived.set(`${f.repo}/${f.repoPath}`, f);

function recordFor(slug) {
  const keys = Object.keys(detailAll).filter((k) => k.slice(0, k.lastIndexOf('|')) === slug);
  if (keys.length !== 1) throw new Error(`expected one detail record for ${slug}, found ${keys.length}`);
  return detailAll[keys[0]];
}

/** repo/path in the manifest that a published github.com link points at, or null. */
function archivedFileFor(href) {
  const m = /^https:\/\/github\.com\/Assure-DeFi\/([^/]+)\/blob\/main\/(.+)$/.exec(href);
  if (!m || !ARCHIVE_REPOS.includes(m[1])) return null;
  const repoPath = m[2].split('/').map(decodeURIComponent).join('/');
  return archived.get(`${m[1]}/${repoPath}`) || null;
}

const results = [];
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: (await fn()) || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e && e.message || e) });
  }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

// An old URL is SUPPOSED to answer 404: that response is what runs 404.html and
// its redirect, on GitHub Pages as here, and Chrome logs it as a console error.
// Exactly that one message is set aside, and only when the failing resource is
// one of the declared old URLs themselves. Any other error counts.
const OLD_URL_PATHS = new Set(REDIRECTS.map(([from]) => from));
const consoleErrors = [];
const expected404s = [];
function watch(page) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    let res = null;
    try { const u = new URL(m.location().url); res = u.pathname + u.search; } catch { /* no resource url */ }
    if (res && OLD_URL_PATHS.has(res) && /status of 404/.test(m.text())) expected404s.push(res);
    else consoleErrors.push(`${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  page.setDefaultTimeout(15000);
  return page;
}

async function main() {
  const { server, origin } = await startServer(0);
  const browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 400, height: 800 } });
  try {
    const landing = watch(await desk.newPage());

    await check('landing page renders', async () => {
      const res = await landing.goto(origin + '/');
      must(res.status() === 200, `status ${res.status()}`);
      await landing.waitForSelector('#tb tr');
      must(/closed its doors/.test(await landing.textContent('h1')), 'headline missing');
      must(await landing.$eval('header img.logo', (i) => i.complete && i.naturalWidth > 0), 'logo did not render');
      const rows = await landing.$$eval('#tb tr', (r) => r.length);
      const links = await landing.$$eval('#tb a[href*="projects/"]', (a) => a.length);
      must(rows > 0 && links > 0, `rows ${rows}, project links ${links}`);
      return `${rows} rows in the first chunk, ${links} link to project pages`;
    });

    await check('landing page shows no totals or counts', async () => {
      const measure = () => landing.evaluate(() => {
        const tb = document.getElementById('tb');
        const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
        const text = [];
        (function walk(n) {
          if (n.nodeType === 3) { text.push(n.nodeValue); return; }
          if (n.nodeType !== 1 || skip.has(n.tagName) || n === tb) return;
          for (const c of n.childNodes) walk(c);
        })(document.body);
        const attrs = [...document.querySelectorAll('[placeholder],[aria-label],[title],[alt]')]
          .filter((e) => !tb.contains(e))
          .map((e) => [e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt')].join(' '));
        return {
          text: [document.title, document.querySelector('meta[name=description]').content, ...text, ...attrs].join(' '),
          count: document.getElementById('count').textContent,
          cardNums: document.querySelectorAll('.card .num').length,
          // A data row has nine cells; a "showing N of M" row would not.
          oddRows: [...tb.rows].filter((r) => r.cells.length !== 9).map((r) => r.textContent.trim().slice(0, 80)),
        };
      });
      const problems = [];
      const judge = (m, when) => {
        // A separator counts only between digits, so "1,003" is one number and
        // the full stop after "2026." is punctuation.
        const digits = (m.text.match(/\d+(?:[.,]\d+)*/g) || []).filter((d) => !ALLOWED_YEARS.includes(d));
        if (digits.length) problems.push(`${when}: digits ${JSON.stringify([...new Set(digits)])}`);
        if (m.count.trim()) problems.push(`${when}: count element says "${m.count.trim()}"`);
        if (m.cardNums) problems.push(`${when}: ${m.cardNums} card number element(s)`);
        if (m.oddRows.length) problems.push(`${when}: non-data table rows ${JSON.stringify(m.oddRows)}`);
      };
      judge(await measure(), 'on load');
      await landing.fill('#q', 'volt');
      await landing.selectOption('#fk', 'approved');
      await landing.waitForTimeout(400);
      judge(await measure(), 'after search + filter');
      await landing.fill('#q', 'zzzz-no-such-project');
      await landing.waitForTimeout(400);
      judge(await measure(), 'with no matches');
      await landing.click('#reset');
      must(!problems.length, problems.join('; '));
      return 'checked on load, filtered, and with no matches';
    });

    await check(`members page shows every member field (/projects/${MEMBERS_SLUG}/)`, async () => {
      const members = recordFor(MEMBERS_SLUG).verifiyMembersList || [];
      const page = watch(await desk.newPage());
      await page.goto(`${origin}/projects/${MEMBERS_SLUG}/`);
      const blocks = await page.$$eval('.member', (els) => els.map((e) => ({
        text: e.textContent.replace(/\s+/g, ' '),
        hrefs: [...e.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      })));
      must(members.length >= 5, `record has only ${members.length} members`);
      must(blocks.length === members.length, `${blocks.length} member blocks for ${members.length} members`);
      const missing = [];
      let fields = 0;
      members.forEach((m, i) => {
        const b = blocks[i];
        const want = [String(m.name || 'N/A').trim(), String(m.role || 'N/A').trim()];
        const control = (Array.isArray(m.controlOver) ? m.controlOver : [m.controlOver]).map((v) => String(v || '').trim()).filter(Boolean);
        want.push(...(control.length ? control : ['No Access']));
        const tier = String(m.countryTier == null ? '' : m.countryTier).trim();
        want.push(tier ? `Tier ${tier}` : 'N/A');
        for (const [label, h] of [['Telegram', m.telegramHandle], ['X', m.twitterHandle], ['Discord', m.discordHandle]]) {
          if (h && String(h).trim()) want.push(`${label} ${String(h).trim()}`);
        }
        for (const w of want) { fields++; if (!b.text.includes(w)) missing.push(`member ${i + 1}: "${w}"`); }
        for (const [raw, kind] of [[m.telegram || m.telegramHandle, 'telegram'], [m.twitter || m.twitterHandle, 'twitter'], [m.discord || m.discordHandle, 'discord']]) {
          const href = normalizeSocial(raw, kind);
          if (!href) continue;
          fields++;
          if (!b.hrefs.includes(href)) missing.push(`member ${i + 1}: link ${href}`);
        }
      });
      const tiers = await page.$eval('details.tiers', (d) => d.textContent);
      for (const t of ['Tier 1:', 'Tier 2:', 'Tier 3:']) { fields++; if (!tiers.includes(t)) missing.push(`definition "${t}"`); }
      must(!missing.length, `missing ${missing.join('; ')}`);
      await page.close();
      return `${members.length} members, ${fields} fields from the source record`;
    });

    await check(`audit report links resolve to archived files (/projects/${AUDIT_SLUG}/)`, async () => {
      const reports = recordFor(AUDIT_SLUG).auditReportList || [];
      const attachments = reports.reduce((n, r) => n + [].concat(r.initialAuditReport || [], r.finalAuditReport || []).length, 0);
      const page = watch(await desk.newPage());
      await page.goto(`${origin}/projects/${AUDIT_SLUG}/`);
      const hrefs = await page.$$eval('.report a', (a) => a.map((x) => x.getAttribute('href')));
      const dead = await page.$$eval('.report .dead', (d) => d.length);
      const bad = [];
      let resolved = 0;
      for (const h of hrefs) {
        if (ARCHIVE_REPOS.some((r) => h.startsWith(`https://github.com/Assure-DeFi/${r}/`))) {
          const f = archivedFileFor(h);
          if (f && f.sha256) resolved++; else bad.push(`not in data/assets-manifest.json: ${h}`);
        } else if (!h.startsWith('https://github.com/Assure-DeFi/')) {
          bad.push(`link outside the Assure-DeFi repositories: ${h}`);
        }
      }
      // Falsifiable: an invented file under an archive repo must not resolve.
      must(!archivedFileFor(`https://github.com/Assure-DeFi/project-archive-assets/blob/main/${AUDIT_SLUG}/audit-final/NO-SUCH-FILE.pdf`),
        'an invented path resolved, so the lookup proves nothing');
      must(reports.length > 0 && attachments > 0, `record has ${reports.length} reports, ${attachments} attachments`);
      must(!bad.length, bad.join('; '));
      must(dead === 0, `${dead} report(s) shown as unavailable`);
      must(resolved === attachments, `${resolved} archived links for ${attachments} report attachments`);
      await page.close();
      return `${reports.length} reports, ${resolved} archived report links, all in the manifest`;
    });

    for (const [from, to] of REDIRECTS) {
      await check(`redirect ${from} -> ${to}`, async () => {
        const page = watch(await desk.newPage());
        await page.goto(origin + from);
        const here = () => { const u = new URL(page.url()); return u.pathname + u.search + u.hash; };
        try {
          await page.waitForURL((u) => u.pathname + u.search + u.hash === to, { timeout: 8000 });
        } catch {
          throw new Error(`landed on ${here()}`);
        }
        await page.waitForLoadState('load');
        const body = await page.textContent('body');
        must(!/Redirecting to the verification archive/.test(body), 'stuck on the redirect page');
        await page.close();
        return `landed on ${here()}`;
      });
    }

    await check('a real page does not redirect (/projects/volt/)', async () => {
      const page = watch(await desk.newPage());
      const res = await page.goto(`${origin}/projects/volt/`);
      must(res.status() === 200, `status ${res.status()}`);
      await page.waitForTimeout(1500);
      must(new URL(page.url()).pathname === '/projects/volt/', `moved to ${page.url()}`);
      must(/Volt/.test(await page.textContent('h1')), 'not the Volt page');
      await page.close();
      return 'status 200, stayed put for 1.5 s';
    });

    await check('no sideways scroll at 400px', async () => {
      const bad = [];
      for (const p of ['/', `/projects/${MEMBERS_SLUG}/`, `/projects/${AUDIT_SLUG}/`, '/projects/volt/']) {
        const page = watch(await phone.newPage());
        await page.goto(origin + p);
        if (p === '/') await page.waitForSelector('#tb tr');
        const m = await page.evaluate(() => {
          window.scrollTo(9999, 0);
          const d = document.documentElement;
          return { sw: d.scrollWidth, cw: d.clientWidth, x: window.scrollX };
        });
        if (m.sw > m.cw || m.x !== 0) bad.push(`${p}: scrollWidth ${m.sw} > ${m.cw}, scrollX ${m.x}`);
        await page.close();
      }
      must(!bad.length, bad.join('; '));
      return 'landing and three project pages';
    });

    await check('shipped files carry no other brand name', async () => {
      // The name is assembled at run time so this file does not match itself.
      const needle = ['brain', 'verse'].join('');
      const hit = (buf) => buf.toString('latin1').toLowerCase().includes(needle);
      must(hit(Buffer.from('x' + needle.toUpperCase() + 'x')), 'positive control not detected');
      // Shipped = everything a push publishes: tracked files plus untracked ones
      // that are not ignored. .git and the gitignored .build/ are not published.
      const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: ROOT })
        .toString('utf8').split('\0').filter(Boolean);
      must(files.length > 1000, `only ${files.length} files listed`);
      const hits = files.filter((f) => hit(fs.readFileSync(path.join(ROOT, f))));
      must(!hits.length, `found in ${hits.join(', ')}`);
      return `${files.length} files scanned`;
    });

    await check('zero console errors on every page visited', async () => {
      must(!consoleErrors.length, `${consoleErrors.length}: ${consoleErrors.slice(0, 8).join(' | ')}`);
      return `none (plus ${expected404s.length} expected 404s on the old URLs themselves: ${[...new Set(expected404s)].join(', ')})`;
    });
  } finally {
    await browser.close();
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
  console.log(`\nQA VERDICT: ${passed === results.length ? 'PASS' : 'FAIL'}  ${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
