/**
 * Root middleware — runs for EVERY request on Cloudflare Pages.
 *
 * Responsibilities (security hardening, Aug 2026):
 *   1. Block known scanner/bot attack probes at the edge (wp-login.php,
 *      .env, .git, phpmyadmin, vendor/phpunit, cgi-bin, etc.) with a flat
 *      403 instead of letting them touch anything. The site is pure static
 *      HTML + three JSON endpoints — none of these paths are ever legit.
 *   2. Global per-IP rate limit for /api/* so a single attacker cannot
 *      hammer the AI/contact/subscribe endpoints (each endpoint applies a
 *      stricter limit of its own on top).
 *   3. Apply security headers to Function responses. IMPORTANT: the
 *      `_headers` file only covers static assets on Cloudflare Pages —
 *      Function responses ship WITHOUT it, so the API needs its own set.
 *   4. Keep the original hostname canonicalization (pages.dev -> apex).
 *
 * Send the public Pages hostname to the real domain, and keep every other
 * non-production hostname out of search results.
 *
 * The site answers on two public hostnames: aitoolsnova.com and
 * aitoolsnova.pages.dev. Both returned 200 with identical HTML, so search
 * engines indexed the Pages host as a complete duplicate of the site (Bing
 * alone reported ~39,400 results for it). Two copies competing for the same
 * queries splits ranking signals and spends the crawl budget twice.
 *
 * Handling differs per host on purpose:
 *
 *   aitoolsnova.com / www      -> untouched.
 *   aitoolsnova.pages.dev      -> 301 to the same path on the real domain.
 *                                 A redirect consolidates link equity, which a
 *                                 noindex header cannot do, and it stops any
 *                                 human who lands there seeing a second copy.
 *   <hash>.aitoolsnova.pages.dev -> noindex only, no redirect. These are
 *                                 per-deployment previews and redirecting them
 *                                 would make it impossible to test a build
 *                                 before it goes live.
 *
 * API routes are never redirected. A 301 turns a POST into a GET and drops the
 * request body, which would silently break every AI tool called from a preview.
 */

const PRODUCTION_HOSTS = new Set([
  'aitoolsnova.com',
  'www.aitoolsnova.com',
]);

// The stable, publicly shared Pages hostname (not a per-deploy preview).
const PUBLIC_PAGES_HOST = 'aitoolsnova.pages.dev';

const CANONICAL_ORIGIN = 'https://aitoolsnova.com';

// ---------------------------------------------------------------
// 1) Attack-probe blocklist.
//
// 24h Cloudflare analytics show continuous WordPress/env-file/admin
// scanner traffic against this static site. These paths can never be
// legitimate here, so short-circuit them with a bare 403 — no redirect
// (redirecting to / gave scanners a soft landing and polluted analytics),
// no body, no-store so nothing caches the response.
// ---------------------------------------------------------------
const ATTACK_PATH_PATTERNS = [
  /^\/\.env($|[./])/i,          // /.env, /.env.local, /.env.backup …
  /^\/\.git($|[./])/i,
  /^\/\.aws($|[./])/i,
  /^\/\.ssh($|[./])/i,
  /^\/\.DS_Store$/i,
  /^\/\.svn($|[./])/i,
  /^\/\.htaccess$/i,
  /^\/wp-login\.php$/i,
  /^\/xmlrpc\.php$/i,
  /^\/wp-(admin|content|includes|json)(\/|$)/i,
  /^\/wordpress(\/|$)/i,
  /^\/wp(\/|$)/i,
  /^\/(my-)?admin(\/|$|\.)?/i,  // /admin, /administrator, /admin.php
  /^\/phpmyadmin(\/|$)/i,
  /^\/pma(\/|$)/i,
  /^\/mysql(\/|$)/i,
  /^\/vendor(\/|$)/i,
  /^\/cgi-bin(\/|$)/i,
  /^\/boaform\//i,
  /^\/actuator(\/|$)/i,
  /^\/(config|configuration)\.(php|json|yml|yaml|bak|txt|sql)$/i,
  /^\/(backup|dump|db)\.(sql|zip|tar|gz)$/i,
  /^\/(web\.config|composer\.(json|lock)|Dockerfile|package\.json)$/i,
  /^\/(shell|cmd|c99|r57)\.(php|jsp|asp)$/i,
  /\.(php|asp|aspx|jsp|cgi)(\/|$)/i, // the site has zero dynamic legacy files
  /\.(sql|bak|ini|swp|env)$/i,
  /^\/telescope/,
  /^\/\.well-known\/(?!security\.txt)/, // keep security.txt public, hide the rest from probing
  // ---- Internal repo directories & files (defense-in-depth). ----
  // .assetsignore keeps these out of the upload entirely; these rules keep
  // them blocked even for already-deployed assets and future additions:
  // backend/, scripts/, tests/, frontend source, notes, CI config.
  /^\/(backend|scripts|tests|test_reports|frontend|memory|data)(\/|$)/i,
  /^\/\.github(\/|$)/i,
  /^\/\.emergent(\/|$)/i,
  /^\/\.assetsignore$/i,
  /\.(md|sh|bak|bak\..*|py|ini|yml)$/i, // internal docs/config/scripts — site is HTML only
];

function isAttackProbe(pathname) {
  return ATTACK_PATH_PATTERNS.some((re) => re.test(pathname));
}

// ---------------------------------------------------------------
// 2) Best-effort in-memory rate limit (per isolate). The per-endpoint
// limits in functions/api/*.js are stricter; this is the outer safety
// net that also covers any future endpoint added without one.
// ---------------------------------------------------------------
const apiHits = new Map();
function apiRateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const row = apiHits.get(ip) || { n: 0, t: now };
  if (now - row.t > windowMs) {
    row.n = 0;
    row.t = now;
  }
  row.n += 1;
  apiHits.set(ip, row);
  if (apiHits.size > 10000) {
    for (const [k, v] of apiHits) {
      if (now - v.t > windowMs) apiHits.delete(k);
    }
  }
  return row.n <= limit;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

// ---------------------------------------------------------------
// 3) Security headers for Function (API) responses. Static assets get
// the same suite (plus CSP) from the `_headers` file; Function responses
// bypass `_headers`, so fill anything missing here. Never duplicate a
// header that `_headers` already set on a static response.
// ---------------------------------------------------------------
function hardenApiResponse(request, response) {
  const headers = new Headers(response.headers);
  const set = (k, v) => {
    if (!headers.has(k)) headers.set(k, v);
  };
  set('X-Content-Type-Options', 'nosniff');
  set('X-Frame-Options', 'DENY');
  set('Referrer-Policy', 'no-referrer');
  set('X-Permitted-Cross-Domain-Policies', 'none');
  set('X-Robots-Tag', 'noindex, nofollow');
  set('Cache-Control', 'no-store');
  set(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; sandbox"
  );

  // CORS: echo Origin only for our own production host and preview hosts,
  // so another website's JS cannot read API responses from a victim browser.
  const origin = request.headers.get('Origin') || '';
  if (origin) {
    let allow = false;
    try {
      const host = new URL(origin).hostname;
      allow =
        host === 'aitoolsnova.com' ||
        host === 'www.aitoolsnova.com' ||
        /\.aitoolsnova\.pages\.dev$/i.test(host) ||
        host === 'aitoolsnova.pages.dev' ||
        /\.e2b\.app$/i.test(host);
    } catch {
      allow = false;
    }
    if (allow) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Factory (a fresh Response per request — never reuse one instance).
const blocked = () =>
  new Response(null, {
    status: 403,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const isApi = url.pathname.startsWith('/api/');

  // --- 1) Kill scanner probes before they touch anything. ---
  if (isAttackProbe(url.pathname)) {
    return blocked();
  }

  // --- 2) Outer API rate limit (120 req/min/IP). Endpoint-level limits
  // (AI 30/min, contact & subscribe 5-10/min) sit underneath this. ---
  if (isApi && request.method !== 'OPTIONS') {
    if (!apiRateLimit(clientIp(request), 120, 60_000)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Too many requests.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Retry-After': '60',
          },
        }
      );
    }
  }

  // Production traffic: serve, then harden API responses on the way out.
  if (PRODUCTION_HOSTS.has(host)) {
    const response = await next();
    return isApi ? hardenApiResponse(request, response) : response;
  }

  // The shared pages.dev hostname: redirect everything except the API.
  if (host === PUBLIC_PAGES_HOST && !isApi) {
    const target = CANONICAL_ORIGIN + url.pathname + url.search;
    return Response.redirect(target, 301);
  }

  // Per-deployment previews, and API calls on any preview host: serve the
  // response but make sure crawlers never index it.
  const response = await next();
  if (isApi) {
    return hardenApiResponse(request, response);
  }
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
