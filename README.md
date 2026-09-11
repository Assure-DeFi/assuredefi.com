# assuredefi.com — closure archive

Static site served by GitHub Pages from the root of this repository. Everything
the site needs to be rebuilt is in this repository.

## Where the data comes from

| Folder | What it holds |
|---|---|
| `inputs/projects.json` | the final public verification dataset, captured 2026-09-10 (985 records) |
| `inputs/*.files.tsv` | file lists of the KYC-Certificates, Audits and Audit-Certificates repositories |
| `inputs/brand/` | the Assure DeFi logo, inlined into the pages |
| `data/api-list-all.json`, `data/api-detail-all.json` | the full project API sweep behind the per-project pages |
| `data/assets-manifest.json` | every archived logo, NFT image and audit report, with its SHA-256, by attachment id |

The archived files themselves live in two separate public repositories,
`Assure-DeFi/project-archive-assets` and `Assure-DeFi/project-nft-images`. The
pages link to them; nothing here downloads them.

## Rebuild

Needs Node 18 or later and Python 3 with `openpyxl` (3.1.5 was used).

```
node build.cjs
```

Run it from the repository root. It rewrites `index.html`, `404.html`,
`verifications.csv`, `verifications.xlsx` and the `projects/` folder. The only
thing it ever deletes is `projects/`, and only through `tools/output-guard.cjs`,
which refuses any other path. Build scratch (stats, the workbook hand-off) goes to
`.build/`, which is gitignored.

A rebuild from unchanged data reproduces the committed files byte for byte, so
`git status` afterwards should be clean. If it is not, something changed the
output and the difference should be understood before committing.

To change the closure statement, edit the EDIT-BLOCK text in `build.cjs` and
rebuild. Editing `index.html` directly works until the next rebuild overwrites it.

Old URLs that no dataset can derive are listed by hand in `MANUAL_SLUG_ALIASES`
in `build.cjs`, one line each with the date and the reason.

## Check it

```
node --test qa/guard.test.cjs
NODE_PATH=/path/to/node_modules node qa/site.cjs
```

The first proves the rebuild can only ever delete `projects/`. The second serves
the site the way GitHub Pages does (a missing path gets `404.html`, which runs the
old-link redirects) and drives it in a real browser. `NODE_PATH` must point at a
`node_modules` folder that contains the `playwright` package with its Chromium
installed. It checks the landing page, that the landing page shows no totals or
counts, a members page and an audit page against the source data, every
old-link redirect, that a real page does not redirect, no sideways scroll at
400px, zero console errors, and that no shipped file names another company. It
prints one line per check and a final `QA VERDICT` line, and exits non-zero on
any failure.

`node tools/report.cjs` writes a longer build report to `.build/BUILD-REPORT.md`.

## What gets published

This repository has a `.nojekyll` file, so GitHub Pages publishes every file in
it as is, including `build.cjs`, `tools/`, `inputs/`, `data/` and `qa/`. None of
them holds anything private: they are the generator, its public inputs and its
tests. `.build/` is gitignored, so it is never pushed or published.
