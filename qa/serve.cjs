'use strict';
/**
 * serve.cjs — a static host that behaves like GitHub Pages for this site:
 *   - a file is served as is;
 *   - a directory with a trailing slash serves its index.html;
 *   - a directory without one answers 301 to the slash form;
 *   - anything missing answers 404 with the body of /404.html, which is what
 *     makes the old-link redirects run.
 *
 * Standalone:  node qa/serve.cjs [port]      (default: an OS-assigned port)
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.cjs': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function notFound(res) {
  res.writeHead(404, { 'content-type': TYPES['.html'] });
  res.end(fs.readFileSync(path.join(ROOT, '404.html')));
}

function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return notFound(res); }
  const file = path.join(ROOT, rel);
  // Never outside the repository, and never the git directory (Pages does not
  // serve it either).
  if (rel.includes('\0') || !(file + path.sep).startsWith(ROOT + path.sep) ||
      rel.split('/').includes('.git')) return notFound(res);

  let st;
  try { st = fs.statSync(file); } catch { return notFound(res); }
  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { location: url.pathname + '/' + url.search });
      return res.end();
    }
    const idx = path.join(file, 'index.html');
    if (!fs.existsSync(idx)) return notFound(res);
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    return res.end(fs.readFileSync(idx));
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

/** Resolves to {server, origin} once the port is bound. */
function startServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer(Number(process.argv[2]) || 0).then(({ origin }) => console.log(`serving ${ROOT} at ${origin}`));
}
