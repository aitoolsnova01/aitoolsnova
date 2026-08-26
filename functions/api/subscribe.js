// Cloudflare Pages Function - Newsletter subscribe endpoint.
// Stores subscribers in Cloudflare KV. Never report success unless persisted.
//
// Security (Aug 2026 hardening):
//   - Per-IP rate limit (5/min) — stops KV flooding with fake signups.
//   - Origin check — blocks other websites from driving signups.
//   - `source` is sanitized to a short path-like token. Previously it was
//     stored verbatim with NO length cap, so anyone could POST arbitrary
//     multi-KB payloads and use the subscribers namespace as free storage
//     (data dumping ground that also buried real signups).
//   - Email capped + validated; error responses never leak internals.
//   - Honeypot: `website` field — a real visitor never fills it.

const MAX_EMAIL = 200;
const MAX_SOURCE = 120;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const hits = new Map();
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const row = hits.get(ip) || { n: 0, t: now };
  if (now - row.t > windowMs) {
    row.n = 0;
    row.t = now;
  }
  row.n += 1;
  hits.set(ip, row);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (now - v.t > windowMs) hits.delete(k);
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

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'aitoolsnova.com' ||
      host === 'www.aitoolsnova.com' ||
      /\.aitoolsnova\.pages\.dev$/i.test(host) ||
      host === 'aitoolsnova.pages.dev' ||
      /\.e2b\.app$/i.test(host)
    );
  } catch {
    return false;
  }
}

function sanitizeSource(raw) {
  const s = String(raw || '').trim().slice(0, MAX_SOURCE);
  // The client sends location.pathname — keep only path-shaped characters.
  if (!/^[a-z0-9\/_.\-?#=%]*$/i.test(s)) return 'unknown';
  return s || 'unknown';
}

export async function onRequestPost(context) {
  try {
    const ip = clientIp(context.request);
    if (!rateLimit(ip, 5, 60_000)) {
      return json({ ok: false, detail: 'Too many requests. Please try again later.' }, 429);
    }
    if (!originAllowed(context.request)) {
      return json({ ok: false, detail: 'Invalid request origin.' }, 403);
    }

    const body = await context.request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase().slice(0, MAX_EMAIL);

    // Honeypot: silently accept bot submissions so they look delivered.
    if (String(body.website || '').trim()) {
      return json({ ok: true, stored: true, message: 'Subscribed successfully' });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ ok: false, detail: 'Invalid email address' }, 400);
    }

    if (!context.env.SUBSCRIBERS) {
      console.error('SUBSCRIBERS KV namespace is not bound; refusing to discard signup.');
      return json({
        ok: false,
        detail: 'Newsletter signup is temporarily unavailable. Please try again later.',
      }, 503);
    }

    const key = `sub:${Date.now()}:${crypto.randomUUID()}`;
    // Data minimization: only email + where they signed up + when. No IP —
    // nothing beyond what the newsletter itself strictly needs.
    await context.env.SUBSCRIBERS.put(key, JSON.stringify({
      email,
      source: sanitizeSource(body.source),
      created_at: new Date().toISOString(),
    }));

    return json({ ok: true, stored: true, message: 'Subscribed successfully' });
  } catch (err) {
    console.error('subscribe endpoint error:', err && err.message);
    return json({ ok: false, detail: 'Server error' }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, detail: 'Method not allowed' }, 405);
}
