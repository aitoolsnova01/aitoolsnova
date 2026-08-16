// Temporary diagnostic endpoint - verifies the DEEPSEEK_API_KEY binding.
// Returns no secret material, only whether the call succeeds.
export async function onRequest(context) {
  const { env } = context;
  const key = env.DEEPSEEK_API_KEY;

  const out = {
    keyPresent: Boolean(key),
    keyLength: key ? key.length : 0,
    keyPrefix: key ? key.slice(0, 3) + '...' : null,
  };

  if (!key) {
    out.verdict = 'DEEPSEEK_API_KEY is not bound to this Pages project';
    return new Response(JSON.stringify(out, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 10,
      }),
    });
    out.httpStatus = res.status;
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      out.verdict = 'DeepSeek is working';
      out.sample = data?.choices?.[0]?.message?.content;
    } else {
      out.verdict = 'DeepSeek rejected the request';
      out.apiError = data?.error?.message || JSON.stringify(data).slice(0, 300);
    }
  } catch (e) {
    out.verdict = 'Network error reaching DeepSeek';
    out.apiError = e.message;
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
