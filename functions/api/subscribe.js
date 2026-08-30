// Cloudflare Pages Function - Newsletter subscribe endpoint.
// Stores subscribers in Cloudflare KV. Never report success unless persisted.
export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const email = String(body.email || '').trim().toLowerCase();
        const source = String(body.source || 'unknown');

        // Honeypot: a real subscriber never fills a field that is hidden with
        // CSS or moved off-screen. Bots auto-fill every input they see.
        if (String(body.company || body.website || body.url || '').trim()) {
            return new Response(JSON.stringify({ ok: true, stored: true, message: 'Subscribed successfully' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
            });
        }

        // Basic email validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return new Response(JSON.stringify({ ok: false, detail: 'Invalid email address' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!context.env.SUBSCRIBERS) {
            console.error('SUBSCRIBERS KV namespace is not bound; refusing to discard signup.');
            return new Response(JSON.stringify({
                ok: false,
                detail: 'Newsletter signup is temporarily unavailable. Please try again later.'
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
            });
        }

        const key = `sub:${Date.now()}:${crypto.randomUUID()}`;
        await context.env.SUBSCRIBERS.put(key, JSON.stringify({
            email, source, created_at: new Date().toISOString()
        }));

        return new Response(JSON.stringify({ ok: true, stored: true, message: 'Subscribed successfully' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ ok: false, detail: 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
