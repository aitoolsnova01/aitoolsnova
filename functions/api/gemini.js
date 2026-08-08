// ============================================================
// Cloudflare Pages Function: AI Chat API
// File: functions/api/gemini.js
// ============================================================

export async function onRequest(context) {
    const { request, env } = context;

    // Only POST requests allowed
    if (request.method !== 'POST') {
        return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        const body = await request.json();
        const message = (body.message || '').trim();

        if (!message) {
            return new Response(
                JSON.stringify({ error: 'Message is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // ============================================================
        // ENVIRONMENT VARIABLES (Set in Cloudflare Pages Dashboard)
        // ============================================================
        const cfToken = env.CLOUDFLARE_API_TOKEN;
        const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
        const groqKey = env.GROQ_API_KEY;

        const cfModel = env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        const groqModel = env.GROQ_MODEL || 'llama-3.1-8b-instant';

        // ============================================================
        // 1. TRY CLOUDFLARE WORKERS AI
        // ============================================================
        async function callCloudflare() {
            if (!cfToken || !cfAccountId) {
                return { ok: false, error: 'Cloudflare env vars missing' };
            }

            const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${encodeURIComponent(cfModel)}`;

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${cfToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: message }],
                }),
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                return { ok: false, error: data?.errors?.[0]?.message || data?.error || `Cloudflare error (${res.status})` };
            }

            const reply = data?.result?.response || data?.result?.text || data?.response || data?.text || 'Sorry, no response from Cloudflare AI.';
            return { ok: true, reply };
        }

        // ============================================================
        // 2. FALLBACK: GROQ API
        // ============================================================
        async function callGroq() {
            if (!groqKey) {
                return { ok: false, error: 'Groq env var missing' };
            }

            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${groqKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: groqModel,
                    messages: [{ role: 'user', content: message }],
                    temperature: 0.7,
                }),
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                return { ok: false, error: data?.error?.message || `Groq error (${res.status})` };
            }

            const reply = data?.choices?.[0]?.message?.content || 'Sorry, no response from Groq.';
            return { ok: true, reply };
        }

        // ============================================================
        // 3. EXECUTE: Cloudflare first, Groq fallback
        // ============================================================
        const cloudflare = await callCloudflare();
        if (cloudflare.ok) {
            return new Response(
                JSON.stringify({ reply: cloudflare.reply, provider: 'cloudflare' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const groq = await callGroq();
        if (groq.ok) {
            return new Response(
                JSON.stringify({ reply: groq.reply, provider: 'groq' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // ============================================================
        // 4. BOTH FAILED
        // ============================================================
        return new Response(
            JSON.stringify({
                error: 'All AI providers failed',
                cloudflareError: cloudflare.error,
                groqError: groq.error,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message || 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
