export async function onRequest(context) {
  const { env } = context;
  const gm = env.GEMINI_API_KEY || env.Gemini_API_key || env.GEMINI_API_key;
  const ds = env.DEEPSEEK_API_KEY || env.Deepseek_API_key || env.DEEPSEEK_API_key;
  const out = { gemini: { found: Boolean(gm) }, deepseek: { found: Boolean(ds) } };
  if (gm) {
    for (const model of ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest']) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gm}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }] }),
        });
        const d = await r.json().catch(() => ({}));
        out.gemini[model] = r.ok ? 'WORKING' : ('FAIL ' + r.status + ': ' + (d?.error?.message || '').slice(0, 90));
        if (r.ok) break;
      } catch (e) { out.gemini[model] = 'NET: ' + e.message; }
    }
  }
  if (ds) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${ds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ok' }], max_tokens: 5 }),
      });
      const d = await r.json().catch(() => ({}));
      out.deepseek.result = r.ok ? 'WORKING' : ('FAIL ' + r.status + ': ' + (d?.error?.message || '').slice(0, 80));
    } catch (e) { out.deepseek.result = 'NET'; }
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
