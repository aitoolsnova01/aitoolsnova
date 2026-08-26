/**
 * Lightweight static file server for the Emergent PREVIEW only.
 * Serves the real static site that lives in the repo root (/app) on port 3000.
 * Dependency-free (Node built-ins). This file is NOT used by Cloudflare Pages
 * (Cloudflare serves the root directly) - it only powers the live preview.
 *
 * Hardened Aug 2026:
 *   - Path traversal check now requires ROOT + path.sep (a sibling directory
 *     like /app-evil previously passed a bare startsWith(ROOT) check).
 *   - Dotfiles and dot-directories are refused (except /.well-known, which is
 *     a real public standard path) so .git, .env, .github etc. never serve.
 *   - Security headers mirror production (_headers) so CSP issues surface in
 *     preview before they ship.
 *   - /api/* answers with a clean 503 JSON: the preview has no Functions.
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

// Mirrors the production `_headers` file. Keep both in sync.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://cdn.ampproject.org https://*.ampproject.net https://cdn.jsdelivr.net https://assets.emergent.sh",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.googlesyndication.com https://cdn.ampproject.org",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://image.pollinations.ai https://pollinations.ai https://cdn.jsdelivr.net",
  "frame-src 'self' https://googleads.g.doubleclick.net https://*.googlesyndication.com https://*.doubleclick.net https://cdn.ampproject.org https://*.ampproject.net",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'upgrade-insecure-requests',
].join('; ');

function send(res, status, body, type, extraHeaders) {
  const headers = {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP,
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // The preview has no Functions runtime — answer /api/* honestly.
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      return send(res, 503, JSON.stringify({ ok: false, detail: 'API not available in preview.' }), 'application/json');
    }

    // Refuse dotfiles/dot-directories except the public .well-known path.
    const segments = urlPath.split('/').filter(Boolean);
    const touchesDot = segments.some((s) => s.startsWith('.')) && segments[0] !== '.well-known';
    if (touchesDot) return send(res, 403, 'Forbidden');

    // Mirror the production middleware blocklist: internal repo content
    // (notes, scripts, backend, tests, config) is never site content.
    const INTERNAL_DIRS = /^(backend|scripts|tests|test_reports|frontend|memory|data|\.github|\.emergent)(\/|$)/i;
    const INTERNAL_EXT = /\.(md|sh|bak|py|ini|yml|sql|env)$/i;
    const INTERNAL_FILES = /^\/(package\.json|design_guidelines\.json|wrangler\.toml|gsc-priority-urls\.txt|gsc-url-list\.txt|test_result\.md)$/i;
    if (INTERNAL_DIRS.test(urlPath) || INTERNAL_EXT.test(urlPath) || INTERNAL_FILES.test(urlPath)) {
      return send(res, 403, 'Forbidden');
    }

    // resolve inside ROOT (block path traversal). ROOT + sep so a sibling
    // directory such as /app-evil can never pass the prefix check.
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      return send(res, 403, 'Forbidden');
    }

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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': CSP,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    send(res, 500, 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Preview static server serving ${ROOT} at http://${HOST}:${PORT}`);
});
