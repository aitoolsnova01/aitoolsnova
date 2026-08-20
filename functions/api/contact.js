/**
 * Contact form endpoint.
 *
 * The page previously built a mailto: link and set window.location. That fails
 * for anyone without a configured desktop mail client, which is most mobile
 * users and everyone on webmail - the browser either does nothing or offers to
 * pick an app the visitor does not have. Messages were being silently lost.
 *
 * Submissions are stored in the CONTACT KV namespace when it is bound. If it is
 * not bound yet the request still succeeds so the visitor is not shown an error
 * for a configuration gap on our side, but it is logged loudly so the missing
 * binding is visible in the deployment logs.
 */

const MAX = { name: 120, email: 200, subject: 200, message: 5000 };

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  try {
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
      ip: context.request.headers.get('CF-Connecting-IP') || '',
      country: context.request.headers.get('CF-IPCountry') || '',
      created_at: new Date().toISOString(),
    };

    if (context.env.CONTACT) {
      const key = `msg:${Date.now()}:${crypto.randomUUID()}`;
      await context.env.CONTACT.put(key, JSON.stringify(record));
    } else {
      console.warn('CONTACT KV namespace not bound - message not persisted:', JSON.stringify(record));
    }

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
