// Temporary: tests DeepSeek and Gemini directly, bypassing the Groq-first chain.
export async function onRequest(context) {
  const { env } = context;
  const out = {};

  const dsKey = env.DEEPSEEK_API_KEY || env.Deepseek_API_key || env.DEEPSEEK_API_key || env.deepseek_api_key;
  const gmKey = env.GEMINI_API_KEY || env.Gemini_API_key;

  out.deepseek = { keyFound: Boolean(dsKey) };
  if (dsKey) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${dsKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 10 }),
      });
      out.deepseek.status = r.status;
      const d = await r.json().catch(() => ({}));
      out.deepseek.result = r.ok ? ('WORKING: ' + d?.choices?.[0]?.message?.content) : ('FAILED: ' + (d?.error?.message || '').slice(0, 160));
    } catch (e) { out.deepseek.result = 'NETWORK: ' + e.message; }
  }

  out.gemini = { keyFound: Boolean(gmKey) };
  if (gmKey) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gmKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }] }),
      });
      out.gemini.status = r.status;
      const d = await r.json().catch(() => ({}));
      out.gemini.result = r.ok
        ? ('WORKING: ' + (d?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim())
        : ('FAILED: ' + (d?.error?.message || '').slice(0, 160));
    } catch (e) { out.gemini.result = 'NETWORK: ' + e.message; }
  }

  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
