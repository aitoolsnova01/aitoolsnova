// Netlify Function: Gemini -> Cloudflare Workers AI -> Groq fallback
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const json = (statusCode, payload) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const message = (body.message || '').trim();

    if (!message) return json(400, { error: 'Message is required' });

    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const groqKey = process.env.GROQ_API_KEY;

    const cfModel = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const groqModel = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

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

      const reply =
        data?.result?.response ||
        data?.result?.text ||
        data?.response ||
        data?.text ||
        'Sorry, no response from Cloudflare AI.';

      return { ok: true, reply };
    }

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

    const cloudflare = await callCloudflare();
    if (cloudflare.ok) return json(200, { reply: cloudflare.reply, provider: 'cloudflare' });

    const groq = await callGroq();
    if (groq.ok) return json(200, { reply: groq.reply, provider: 'groq' });

    return json(500, {
      error: 'All AI providers failed',
      cloudflareError: cloudflare.error,
      groqError: groq.error,
    });
  } catch (error) {
    return json(500, { error: error.message || 'Internal server error' });
  }
};
