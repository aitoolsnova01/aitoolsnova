/**
 * Edge middleware that runs on EVERY request (Cloudflare Pages Functions).
 *
 * Jobs:
 *  1. Canonical host: redirect the shared *.pages.dev host to the real domain
 *     so it is never indexed as a duplicate; noindex per-deploy previews.
 *  2. Security headers on every response (HSTS, anti-clickjacking, MIME
 *     sniffing, referrer/permissions policy) — the "padlock / not secure" and
 *     bot-hardening baseline, enforced at the edge even before _headers.
 *  3. Light edge bot/abuse protection for the dynamic /api endpoints:
 *     block obvious scanner/attack payloads and rate-limit per IP in-memory,
 *     before a Function (and any paid AI API call behind it) ever runs.
 *
 * Static assets are served straight through with the security headers added.
 */

const PRODUCTION_HOSTS = new Set([
  'aitoolsnova.com',
  'www.aitoolsnova.com',
]);

// The stable, publicly shared Pages hostname (not a per-deploy preview).
const PUBLIC_PAGES_HOST = 'aitoolsnova.pages.dev';

const CANONICAL_ORIGIN = 'https://aitoolsnova.com';

// ---- Security headers applied to every response ---------------------------
function applySecurityHeaders(response, { api = false } = {}) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), browsing-topics=()');
  // Force HTTPS for 2 years, include subdomains. HSTS only makes sense on the
  // real HTTPS host (previews can be http), so callers gate this.
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  if (api) {
    headers.set('Cache-Control', 'no-store');
  }
  return headers;
}

// ---- Very small in-memory fixed-window rate limiter (per isolate) ---------
const buckets = new Map();
function rateLimited(key, { limit, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  // opportunistic cleanup so the map cannot grow unbounded
  if (buckets.size > 20000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  return b.n > limit;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function isObviousAttack(request) {
  const ua = (request.headers.get('User-Agent') || '').toLowerCase();
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname).toLowerCase();

  // Null bytes / path traversal attempts in the request line.
  if (path.includes('%00') || path.includes('\0') || path.includes('../') || path.includes('..\\')) {
    return true;
  }
  // Common exploit probes that have no legitimate target on this static site.
  const attackSignatures = [
    '/wp-admin', '/wp-login', '/xmlrpc.php', '/.env', '/.git/',
    'eval(', 'base64_', '<script', 'union select', 'sleep(',
    '/phpmyadmin', '/.aws/', 'passwd', 'cmd.exe',
  ];
  if (attackSignatures.some((s) => path.includes(s))) return true;

  // Empty/abusive UAs hammering the API are almost always bots. (Real browsers
  // always send a UA; curl/monitoring we allow.)
  if (!ua || /(nikto|sqlmap|nmap|masscan|acunetix|wpscan|fuzz|dirbuster|gobuster|hydra)/.test(ua)) {
    return true;
  }
  return false;
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const isApi = url.pathname.startsWith('/api/');

  // ---- Edge abuse protection for dynamic endpoints ------------------------
  if (isApi) {
    const ip = clientIp(request);

    if (isObviousAttack(request)) {
      return new Response(JSON.stringify({ ok: false, error: 'Blocked' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // AI proxy is expensive (paid APIs behind it): 30 req/min/IP.
    // Contact/subscribe forms: 8 req/min/IP.
    const limit = url.pathname.startsWith('/api/gemini') ? 30 : 8;
    if (rateLimited(`api:${ip}`, { limit, windowMs: 60_000 })) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Too many requests. Please slow down and try again shortly.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' } }
      );
    }

    const apiResponse = await next();
    return new Response(apiResponse.body, {
      status: apiResponse.status,
      statusText: apiResponse.statusText,
      headers: applySecurityHeaders(apiResponse, { api: true }),
    });
  }

  // ---- Canonical host handling (non-API) ----------------------------------
  if (!PRODUCTION_HOSTS.has(host)) {
    // The shared pages.dev hostname: 301 everything to the real domain to
    // consolidate ranking signals (a noindex header cannot do that).
    if (host === PUBLIC_PAGES_HOST) {
      return Response.redirect(CANONICAL_ORIGIN + url.pathname + url.search, 301);
    }
    // Per-deployment preview hosts: serve but keep them out of search results.
    const previewResponse = await next();
    const headers = applySecurityHeaders(previewResponse);
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return new Response(previewResponse.body, {
      status: previewResponse.status,
      statusText: previewResponse.statusText,
      headers,
    });
  }

  // ---- Production static traffic: pass through with security headers ------
  const response = await next();
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: applySecurityHeaders(response),
  });
}
