// Cloudflare Pages Function - Newsletter subscribe endpoint.
// Stores subscribers in Cloudflare KV if bound as SUBSCRIBERS, else no-op success.
export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const email = String(body.email || '').trim().toLowerCase();
        const source = String(body.source || 'unknown');

        // Basic email validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return new Response(JSON.stringify({ ok: false, detail: 'Invalid email address' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Store in KV if available
        if (context.env.SUBSCRIBERS) {
            const key = `sub:${Date.now()}:${crypto.randomUUID()}`;
            await context.env.SUBSCRIBERS.put(key, JSON.stringify({
                email, source, created_at: new Date().toISOString()
            }));
        }

        // Report whether the write actually persisted so a missing binding is
        // visible instead of looking like a successful signup.
        const stored = Boolean(context.env.SUBSCRIBERS);
        if (!stored) console.warn('SUBSCRIBERS KV not bound - subscriber not persisted:', email);

        return new Response(JSON.stringify({ ok: true, stored, message: 'Subscribed successfully' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ ok: false, detail: 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
