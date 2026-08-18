/**
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

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // Production traffic: pass straight through, no changes.
  if (PRODUCTION_HOSTS.has(host)) {
    return next();
  }

  const isApi = url.pathname.startsWith('/api/');

  // The shared pages.dev hostname: redirect everything except the API.
  if (host === PUBLIC_PAGES_HOST && !isApi) {
    const target = CANONICAL_ORIGIN + url.pathname + url.search;
    return Response.redirect(target, 301);
  }

  // Per-deployment previews, and API calls on any preview host: serve the
  // response but make sure crawlers never index it.
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
