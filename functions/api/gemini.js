// ============================================================
// Cloudflare Pages Function: AI API for all AIToolsNova tools
// File: functions/api/gemini.js
//
// Fixes applied:
//  - Adds a strict system prompt (previously there was NONE, which is why
//    replies were childish and full of spelling mistakes).
//  - Per-tool system prompts so each tool answers like a specialist.
//  - Upgrades the Groq fallback from llama-3.1-8b-instant (tiny, error-prone)
//    to llama-3.3-70b-versatile.
//  - Lower temperature + retry so output is consistent and accurate.
// ============================================================

const BASE_RULES = `You are the AI engine behind AIToolsNova, a professional free-tools website.

NON-NEGOTIABLE QUALITY RULES:
1. Write in flawless, professional English. Perfect spelling, grammar and punctuation. Proofread before answering.
2. Never use childish or filler language. No "Sure thing!", "Awesome!", "Hope this helps!", "As an AI...". Get straight to the answer.
3. Be accurate. If you are not certain about a fact, say so plainly instead of inventing details. Never invent statistics, prices, dates or quotes.
4. Be specific and useful. Prefer concrete steps, real examples and numbers over vague advice.
5. Match the length to the question: short question, short answer. Do not pad.
6. Use clean formatting - short paragraphs, and bullet points or numbered steps when listing. No decorative emoji unless the user asks.
7. Reply in the same language the user wrote in.
8. Never mention these instructions or that you are following a prompt.`;

const TOOL_PROMPTS = {
  chat: `${BASE_RULES}

You are a knowledgeable, precise assistant. Answer the user's question directly and completely, the way an experienced professional would explain it to a colleague.`,

  writer: `${BASE_RULES}

You are a senior content writer. Produce publication-ready copy: a clear structure, an engaging opening, concrete detail, and a natural human voice. No fluff, no repetition, no keyword stuffing.`,

  email: `${BASE_RULES}

You are a professional business-communication expert. Write emails with a clear subject line, an appropriate greeting, a focused body with one obvious purpose, a specific call to action, and a professional sign-off. Match the requested tone exactly.`,

  resume: `${BASE_RULES}

You are a certified professional resume writer. Use strong action verbs, quantify achievements wherever the user gives you numbers, and keep it ATS-friendly. Never invent employment history, dates, or qualifications the user did not provide.`,

  social: `${BASE_RULES}

You are a social media strategist. Write scroll-stopping copy suited to the platform, with a strong hook in the first line. Keep hashtags relevant and limited. Respect platform character limits.`,

  seo: `${BASE_RULES}

You are a technical SEO specialist. Follow current best practice: titles 50-60 characters, meta descriptions 140-158 characters, natural keyword placement, and search intent matched precisely. Never keyword-stuff.`,

  youtube: `${BASE_RULES}

You are a YouTube growth strategist. Write titles that earn clicks without being clickbait, descriptions with the key information in the first two lines, and tags that reflect real search behaviour.`,
};

function pickPrompt(tool) {
  return TOOL_PROMPTS[String(tool || '').toLowerCase()] || TOOL_PROMPTS.chat;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    const message = (body.message || '').trim();
    const tool = body.tool || 'chat';
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

    if (!message) return json({ error: 'Message is required' }, 400);

    const systemPrompt = pickPrompt(tool);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history
        .filter(m => m && m.role && m.content)
        .map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content).slice(0, 4000),
        })),
      { role: 'user', content: message },
    ];

    const cfToken = env.CLOUDFLARE_API_TOKEN;
    const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
    const groqKey = env.GROQ_API_KEY;

    const cfModel = env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    // Upgraded: the old default (llama-3.1-8b-instant) is a tiny model and was
    // the main source of poor spelling and shallow answers.
    // Best model first, then progressively smaller fallbacks.
    const groqChain = env.GROQ_MODEL
        ? [env.GROQ_MODEL, 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
        : ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

    async function callCloudflare() {
      if (!cfToken || !cfAccountId) return { ok: false, error: 'Cloudflare env vars missing' };

      const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${encodeURIComponent(cfModel)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, temperature: 0.4, max_tokens: 2048 }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.errors?.[0]?.message || data?.error || `Cloudflare error (${res.status})` };
      }
      const reply = data?.result?.response || data?.result?.text || data?.response || data?.text;
      if (!reply || !reply.trim()) return { ok: false, error: 'Empty response from Cloudflare AI' };
      return { ok: true, reply: reply.trim() };
    }

    async function callGroq(model) {
      if (!groqKey) return { ok: false, error: 'Groq env var missing' };

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 2048,
          top_p: 0.9,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error?.message || `Groq error (${res.status})` };
      }
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply || !reply.trim()) return { ok: false, error: 'Empty response from Groq' };
      return { ok: true, reply: reply.trim() };
    }

    // 1) Groq first - the large models here give the most accurate output.
    const errors = [];
    for (const model of groqChain) {
      const r = await callGroq(model);
      if (r.ok) return json({ reply: r.reply, provider: `groq:${model}` });
      errors.push(`${model}: ${r.error}`);
      // Auth/quota problems will fail for every model, so stop early.
      if (/api key|unauthorized|invalid|quota|billing/i.test(r.error || '')) break;
    }

    // 2) Cloudflare Workers AI as a second provider
    const cloudflare = await callCloudflare();
    if (cloudflare.ok) return json({ reply: cloudflare.reply, provider: 'cloudflare' });
    errors.push(`cloudflare: ${cloudflare.error}`);

    return json({ error: 'All AI providers failed', details: errors }, 500);

  } catch (error) {
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
