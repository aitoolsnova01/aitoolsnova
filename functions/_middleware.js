/**
 * Keep preview hostnames out of search results.
 *
 * The site is served from two places: the real domain (aitoolsnova.com) and the
 * Cloudflare Pages hostname (aitoolsnova.pages.dev, plus per-deploy subdomains
 * like abc123.aitoolsnova.pages.dev). Both return 200 and serve identical HTML,
 * so search engines treated the preview host as a full duplicate of the site.
 *
 * A canonical tag alone was not enough - it is a hint, and crawlers still have
 * to fetch every page to read it. X-Robots-Tag is a directive, so it removes
 * the preview host from the index and stops the crawl budget being spent twice.
 *
 * Only the preview hosts are affected. Requests to the production domain pass
 * through completely untouched.
 */

const PRODUCTION_HOSTS = new Set([
  'aitoolsnova.com',
  'www.aitoolsnova.com',
]);

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  const response = await next();

  // Production traffic: no change at all.
  if (PRODUCTION_HOSTS.has(host)) {
    return response;
  }

  // Anything else reaching this Pages project is a preview/deployment host
  // (*.pages.dev). Serve it, but tell crawlers not to index or follow it.
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
