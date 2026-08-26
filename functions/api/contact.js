/**
 * Contact form endpoint.
 *
 * The page previously built a mailto: link and set window.location. That fails
 * for anyone without a configured desktop mail client, which is most mobile
 * users and everyone on webmail - the browser either does nothing or offers to
 * pick an app the visitor does not have. Messages were being silently lost.
 *
 * Submissions are stored in the CONTACT KV namespace. If the binding is
 * missing, return an honest error with the support email instead of claiming a
 * message was received and silently discarding it.
 *
 * Security (Aug 2026 hardening):
 *   - Per-IP rate limit: 5 submissions / 10 minutes. Without it a bot could
 *     flood the KV namespace, burying real messages and burning storage quota.
 *   - Origin check: only same-site / preview origins may post cross-site, so
 *     another website's JavaScript cannot drive submissions from a visitor's
 *     browser.
 *   - Request body size cap before parsing.
 *   - Strict field caps + email format check + honeypot (already in place).
 */

const MAX = { name: 120, email: 200, subject: 200, message: 5000 };
const MAX_BODY_BYTES = 64 * 1024; // generous ceiling for the longest legit form

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Best-effort in-memory rate limit (per isolate), same approach as gemini.js.
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

// A browser form always sends Origin on a cross-origin/fetch POST. Accept our
// production host, our Pages previews, and sandbox previews. An absent Origin
// (curl, server-to-server health checks) is allowed — CORS does not apply to
// non-browsers anyway.
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

export async function onRequestPost(context) {
  try {
    const ip = clientIp(context.request);

    if (!rateLimit(ip, 5, 10 * 60_000)) {
      return json(
        { ok: false, detail: 'Too many messages from your network. Please try again later.' },
        429
      );
    }

    if (!originAllowed(context.request)) {
      return json({ ok: false, detail: 'Invalid request origin.' }, 403);
    }

    const len = Number(context.request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) {
      return json({ ok: false, detail: 'Request too large.' }, 413);
    }

    const body = await context.request.json().catch(() => ({}));

    const name = String(body.name || '').trim().slice(0, MAX.name);
    const email = String(body.email || '').trim().toLowerCase().slice(0, MAX.email);
    const subject = String(body.subject || '').trim().slice(0, MAX.subject);
    const message = String(body.message || '').trim().slice(0, MAX.message);

    if (!name || !email || !subject || !message) {
      return json({ ok: false, detail: 'Please fill in every field.' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ ok: false, detail: 'Please enter a valid email address.' }, 400);
    }
    // Very short messages are almost always bot noise.
    if (message.length < 10) {
      return json({ ok: false, detail: 'Please add a little more detail to your message.' }, 400);
    }
    // Honeypot: a real person never fills a field they cannot see.
    if (String(body.website || '').trim()) {
      return json({ ok: true, message: 'Thanks — your message has been received.' }, 200);
    }

    const record = {
      name,
      email,
      subject,
      message,
      ip,
      country: context.request.headers.get('CF-IPCountry') || '',
      created_at: new Date().toISOString(),
    };

    if (!context.env.CONTACT) {
      console.error('CONTACT KV namespace is not bound; refusing to discard contact submission.');
      return json({
        ok: false,
        detail: 'The contact form is temporarily unavailable. Please email aitoolsnova01@gmail.com directly.',
      }, 503);
    }

    const key = `msg:${Date.now()}:${crypto.randomUUID()}`;
    await context.env.CONTACT.put(key, JSON.stringify(record));

    return json({ ok: true, message: 'Thanks — your message has been received. We reply within 24-48 hours.' }, 200);
  } catch (err) {
    console.error('contact endpoint error:', err && err.message);
    return json({ ok: false, detail: 'Server error. Please email aitoolsnova01@gmail.com directly.' }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, detail: 'Method not allowed' }, 405);
}
