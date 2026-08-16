// Temporary diagnostic: verifies the DEEPSEEK_API_KEY binding on Pages.
// Returns no secret material.
export async function onRequest(context) {
  const { env } = context;
  const key = env.DEEPSEEK_API_KEY;
  const out = { keyPresent: Boolean(key), keyLength: key ? key.length : 0 };

  if (!key) {
    out.verdict = 'DEEPSEEK_API_KEY still not bound to this Pages project';
    return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 10 }),
    });
    out.httpStatus = res.status;
    const d = await res.json().catch(() => ({}));
    if (res.ok) { out.verdict = 'DeepSeek WORKING'; out.sample = d?.choices?.[0]?.message?.content; }
    else { out.verdict = 'DeepSeek rejected'; out.apiError = d?.error?.message || JSON.stringify(d).slice(0,200); }
  } catch (e) { out.verdict = 'Network error'; out.apiError = e.message; }
  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
