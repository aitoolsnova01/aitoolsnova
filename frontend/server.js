/**
 * Lightweight static file server for the Emergent PREVIEW only.
 * Serves the real static site that lives in the repo root (/app) on port 3000.
 * Dependency-free (Node built-ins). This file is NOT used by Cloudflare Pages
 * (Cloudflare serves the root directly) - it only powers the live preview.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');   // /app
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // resolve inside ROOT (block path traversal)
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // try adding .html, else 404 page
      if (fs.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      } else {
        const notFound = path.join(ROOT, '404.html');
        if (fs.existsSync(notFound)) {
          return send(res, 404, fs.readFileSync(notFound), MIME['.html']);
        }
        return send(res, 404, 'Not Found');
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    send(res, 500, 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Preview static server serving ${ROOT} at http://${HOST}:${PORT}`);
});
