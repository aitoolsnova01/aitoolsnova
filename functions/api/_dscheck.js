// Temporary diagnostic: lists which env var NAMES are bound (no values).
// Helps spot a typo or a Preview-vs-Production mistake.
export async function onRequest(context) {
  const { env } = context;
  const names = Object.keys(env || {}).filter(k => typeof env[k] === 'string').sort();
  const expected = ['GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
  return new Response(JSON.stringify({
    boundVariableNames: names,
    lengths: Object.fromEntries(names.map(n => [n, String(env[n]).length])),
    expected: Object.fromEntries(expected.map(e => [e, names.includes(e)])),
    lookalikes: names.filter(n => /deep|seek/i.test(n)),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
