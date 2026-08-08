#!/usr/bin/env node
/**
 * AIToolsNova - Daily Auto Blog Generator (Session 5 - Bulletproof)
 * ------------------------------------------------------------------
 * - Generates ONE unique, professional, SEO-optimized blog post per run
 * - Multi-model fallback (openai/gpt-oss-120b → llama-3.3-70b-versatile → openai/gpt-oss-20b)
 * - Retries on transient failures (3x per model)
 * - Robust JSON extraction (balanced-brace, sanitized)
 * - Auto hero image via Pollinations (free, no key)
 * - IndexNow ping so Google/Bing pick up new URL instantly
 * - Never overwrites: uses safe marker-based insertion only
 * - Preserves all AdSense, Google Analytics, meta tags (only ADDS)
 *
 * Env vars required:
 *   GROQ_API_KEY   - free from https://console.groq.com/keys
 * Optional:
 *   GROQ_MODEL     - override primary model (else fallback list is used)
 *   INDEXNOW_KEY   - optional IndexNow key (else skipped silently)
 *
 * Run:  node scripts/generate-blog.mjs
 */

import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const BLOGS_HTML = path.join(ROOT, 'blogs.html');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');
const HISTORY_FILE = path.join(ROOT, 'scripts', 'topic-history.json');
const GROQ_KEY = process.env.GROQ_API_KEY;
// IndexNow key: use env var OR auto-detect the .txt key file at repo root
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || (() => {
    try {
        const keyFile = readdirSync(ROOT).find(f => /^[a-f0-9]{32}\.txt$/i.test(f));
        if (keyFile) return keyFile.replace('.txt', '');
    } catch { /* silent */ }
    return '';
})();
const AFFILIATE_PRODUCT_NAME = process.env.AFFILIATE_PRODUCT_NAME || '';
const AFFILIATE_PRODUCT_URL = process.env.AFFILIATE_PRODUCT_URL || '';
const AFFILIATE_DISCLOSURE = process.env.AFFILIATE_DISCLOSURE || 'This article may contain affiliate links. We may earn a small commission at no extra cost to you.';
// Amazon India + Flipkart affiliate IDs. Amazon default is set to the confirmed AIToolsNova associate tag.
const AMAZON_TAG = process.env.AMAZON_TAG || 'aitoolsnova-21';
const FLIPKART_AFFID = process.env.FLIPKART_AFFID || '';

// Multi-model fallback list. First one that works wins.
// Order tuned for Groq FREE tier TPM (tokens/minute) limits (2026):
//   - openai/gpt-oss-20b  : ~30000 TPM ← safest for long content, no throttle
//   - llama-3.3-70b-versatile: ~12000 TPM (retiring Aug 2026)
//   - openai/gpt-oss-120b : ~8000 TPM  ← best quality but easily hits TPM on long content
const MODELS = process.env.GROQ_MODEL
    ? [process.env.GROQ_MODEL, 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']
    : ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b'];

if (!GROQ_KEY) {
    console.error('❌ GROQ_API_KEY env var missing. Get free key at https://console.groq.com/keys');
    console.error('   → Add it to your GitHub repo: Settings → Secrets and variables → Actions → New secret');
    process.exit(1);
}

// ---------- Sleep helper ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 1. Read existing blog titles ----------
async function readExistingTitles() {
    const files = (await fs.readdir(BLOG_DIR)).filter(f => f.endsWith('.html'));
    const titles = [];
    for (const f of files) {
        try {
            const html = await fs.readFile(path.join(BLOG_DIR, f), 'utf-8');
            const m = html.match(/<title>([^<|]+)/i);
            if (m) titles.push(m[1].trim());
            const h1 = html.match(/<h1[^>]*>([^<]+)/i);
            if (h1) titles.push(h1[1].trim());
        } catch { /* ignore unreadable file */ }
    }
    return [...new Set(titles)];
}

// ---------- 2. Load / save topic history ----------
async function loadHistory() {
    try {
        const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch { return { topics: [] }; }
}
async function saveHistory(h) {
    await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await fs.writeFile(HISTORY_FILE, JSON.stringify(h, null, 2));
}

// ---------- 3. Groq call with model fallback + retry ----------
// If opts.singleModel is set, only that model is used (no outer fallback in this fn).
async function callGroq(messages, opts = {}) {
    const modelsToTry = opts.singleModel ? [opts.singleModel] : MODELS;
    let lastErr = null;
    for (const model of modelsToTry) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const body = {
                    model,
                    messages,
                    temperature: opts.temperature ?? 0.7,
                    max_tokens: opts.max_tokens ?? 4096
                };
                if (model.includes('gpt-oss')) {
                    body.reasoning_effort = 'low';
                }
                if (opts.json === true) {
                    body.response_format = { type: 'json_object' };
                }
                const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) {
                    const errText = await res.text().catch(() => '');
                    lastErr = new Error(`[${model}] Groq ${res.status}: ${errText.slice(0, 220)}`);
                    // 429 rate-limit or 5xx → retry same model with backoff
                    if (res.status === 429 || res.status >= 500) {
                        console.warn(`   ⚠️  ${lastErr.message} (attempt ${attempt}/3, retrying in ${attempt * 2}s)`);
                        await sleep(attempt * 2000);
                        continue;
                    }
                    // 413 (request too large / TPM limit) → try next model immediately
                    // 400/404 (deprecated/unknown) → next model immediately
                    console.warn(`   ⚠️  ${lastErr.message} — trying next model`);
                    break;
                }
                const data = await res.json();
                const content = data.choices?.[0]?.message?.content?.trim() || '';
                const finishReason = data.choices?.[0]?.finish_reason;
                if (!content) {
                    lastErr = new Error(`[${model}] Empty response (finish_reason=${finishReason})`);
                    console.warn(`   ⚠️  ${lastErr.message} (attempt ${attempt}/3)`);
                    await sleep(attempt * 1500);
                    continue;
                }
                if (finishReason === 'length' && content.length < 20) {
                    lastErr = new Error(`[${model}] Reply truncated by max_tokens (${content.length} chars): ${content}`);
                    console.warn(`   ⚠️  ${lastErr.message} — trying next model`);
                    break;
                }
                if (attempt > 1 || model !== modelsToTry[0]) console.log(`   ✔ Using model: ${model}`);
                return content;
            } catch (err) {
                lastErr = err;
                console.warn(`   ⚠️  [${model}] network error: ${err.message} (attempt ${attempt}/3)`);
                await sleep(attempt * 1500);
            }
        }
    }
    throw lastErr || new Error('Groq call failed on all models.');
}

// ---------- 3b. Groq call with JSON validation and cross-model fallback on parse failure ----------
async function callGroqForJson(messages, opts = {}) {
    let lastErr = null;
    for (const model of MODELS) {
        try {
            const reply = await callGroq(messages, { ...opts, singleModel: model });
            try {
                return { reply, parsed: extractJson(reply), model };
            } catch (parseErr) {
                lastErr = new Error(`[${model}] JSON parse failed: ${parseErr.message}. Reply head: ${reply.slice(0, 300)}`);
                console.warn(`   ⚠️  ${lastErr.message} — trying next model`);
            }
        } catch (callErr) {
            lastErr = callErr;
            // callGroq already logged the specific error; just note fallback here
            console.warn(`   ↩︎  Falling back to next model...`);
        }
    }
    throw lastErr || new Error('All models failed to return valid JSON');
}

// ---------- 3b. Robust JSON extractor ----------
function extractJson(reply) {
    if (!reply) throw new Error('Empty AI reply');
    // Strip markdown fences
    let txt = reply.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Find the outermost balanced { ... }
    const start = txt.indexOf('{');
    if (start < 0) throw new Error('No JSON object found in reply: ' + reply.slice(0, 200));
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < txt.length; i++) {
        const c = txt[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('Unbalanced JSON braces in reply: ' + reply.slice(0, 200));
    const candidate = txt.slice(start, end + 1);
    // Sanitize: remove trailing commas before } or ]
    const cleaned = candidate.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error('JSON parse failed: ' + e.message + '\nPayload head: ' + cleaned.slice(0, 300)); }
}

// ---------- 4. Generate unique topic ----------
async function generateTopic(existingTitles, history) {
    const existingSlugs = [];
    try {
        const files = await fs.readdir(BLOG_DIR);
        files.filter(f => f.endsWith('.html')).forEach(f => existingSlugs.push(f.replace('.html', '')));
    } catch {}
    // Keep avoid list small enough to stay under context / prompt-budget
    const avoidList = [...existingTitles, ...history.topics].slice(-80);
    const NICHES = [
        'AI tools for productivity',
        'AI in freelancing and side hustles',
        'AI for content creators (YouTube, blogs, Instagram)',
        'AI for SEO and digital marketing',
        'AI for students and learning',
        'AI in coding and development',
        'AI image generation and design',
        'AI writing and copywriting',
        'AI for small business',
        'AI vs traditional tools comparison',
        'Best free AI alternatives',
        'AI ethics, privacy and safety',
        'AI news, trends and updates (verified only)',
        'AI voice, audio and podcast tools',
        'AI for e-commerce and dropshipping',
        'AI for graphic design and branding',
        'AI for language learning and translation',
        'AI for data analysis and spreadsheets',
        'AI for customer support and chatbots'
    ];
    const niche = NICHES[Math.floor(Math.random() * NICHES.length)];

    const prompt = `You are an editorial director for AIToolsNova, a blog about free AI tools.

Suggest ONE unique, engaging, evergreen blog post title for the niche: "${niche}".

STRICT RULES:
1. Do NOT repeat or paraphrase any of these EXISTING titles (case-insensitive, semantic match too):
${avoidList.map(t => '- ' + t).join('\n')}

2. Title must:
   - Be 55-70 chars
   - Include a number, power word, or curiosity gap
   - Be genuinely useful, not clickbait
   - NOT reference specific unverified news/rumors as facts
   - NOT mention any specific individual person's private life

3. Also suggest:
   - A short slug (lowercase-hyphen-separated, 3-6 words, .html suffix not needed)
   - A category from: "ai", "seo", "social", "productivity", "coding", "image", "writing"
   - A single emoji that visually represents the topic
   - A concise "hero_prompt": 6-12 word visual description for a hero image (e.g. "futuristic AI dashboard glowing blue neon")

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "title": "...",
  "slug": "...",
  "category": "...",
  "emoji": "...",
  "hero_prompt": "..."
}`;

    const { reply, parsed: raw, model } = await callGroqForJson(
        [{ role: 'user', content: prompt }],
        { temperature: 0.9, max_tokens: 1200, json: true }
    );
    const parsed = raw;
    if (!parsed.title || !parsed.slug) throw new Error('Topic JSON missing title/slug: ' + JSON.stringify(parsed));
    parsed.slug = parsed.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (existingSlugs.includes(parsed.slug)) parsed.slug = parsed.slug + '-guide';
    if (!parsed.hero_prompt) parsed.hero_prompt = parsed.title;
    if (!parsed.emoji) parsed.emoji = '🤖';
    if (!parsed.category) parsed.category = 'ai';
    console.log(`   ✔ Topic generated by: ${model}`);
    return parsed;
}

// ---------- 5. Generate full blog content ----------
async function generateContent(topic) {
    const prompt = `You are a senior SEO content writer for AIToolsNova. Write a complete, professional, human-friendly blog post.

Topic: "${topic.title}"
Category: ${topic.category}

LANGUAGE & TONE (very important):
- Write in SIMPLE, EASY English suitable for a 10th-grade reader.
- Use SHORT sentences (avg 12-18 words). Use everyday words.
- No jargon. If a technical term is unavoidable, explain it in one line.
- Friendly, conversational tone. Speak to the reader as "you".
- Do NOT copy or paraphrase any existing content on the internet. Write fresh.
- Do NOT repeat sentences or phrases inside the article.

ABSOLUTE RULES:
- Only include VERIFIED, well-established facts. If mentioning a prediction, market forecast, or emerging trend, clearly label it (e.g. "According to industry analysts...", "This is speculation, not confirmed...").
- Do NOT invent statistics. Only use ballpark ranges you are highly confident about (e.g. "millions of users"), never specific fake numbers.
- Do NOT report any rumor as fact. If a rumor is relevant, prefix with "Rumored:" and explicitly note it is unverified.
- Do NOT mention pricing of paid competitors unless you're sure (skip prices if unsure).
- Do NOT promote any illegal, unethical or misleading activity.
- Never write about specific individuals in a defamatory way.
- Focus on genuinely helpful, evergreen information.

AFFILIATE RECOMMENDATIONS (required):
- Include a JSON array "affiliate_picks" with 2 relevant product/tool recommendations related to the topic.
- Each pick: { "name": "short product name", "why": "one-line reason", "amazon_query": "search terms for Amazon India", "flipkart_query": "search terms for Flipkart" }
- Pick real, well-known products (e.g. "Logitech M240 Wireless Mouse", "Wacom One Pen Tablet"). No made-up names.

STRUCTURE (return ONLY valid JSON — no markdown code fences, no explanation outside JSON):

{
  "meta_description": "150-160 char SEO meta description with primary keyword and clear benefit",
  "meta_keywords": "10 comma-separated SEO keywords",
  "read_time_min": 7,
  "intro_html": "<p>...2-3 short paragraphs...</p><p>...</p>",
  "sections": [
    {
      "h2": "First H2 heading",
      "body_html": "<p>...</p><ul><li>...</li></ul>"
    }
  ],
  "faqs": [
    {"q": "Question 1?", "a": "Clear, concise answer paragraph."}
  ],
  "conclusion_html": "<p>Closing 2 short paragraphs with a friendly CTA to explore related tools on AIToolsNova.</p>",
  "affiliate_picks": [
    {"name": "Product Name", "why": "one-line benefit", "amazon_query": "search terms", "flipkart_query": "search terms"}
  ],
  "related_tools": ["ai-chat.html","ai-writer.html","ai-image-generator.html","youtube-kit.html"],
  "related_blogs": ["best-free-ai-tools-2026.html","top-100-ai-tools-2026.html","ai-productivity-tools.html"]
}

Rules:
- 7 to 9 sections total
- 4 to 6 FAQs
- Minimum 1500 words total across intro + sections + conclusion
- Use <p>, <ul>, <ol>, <li>, <strong>, <em>
- No <script>, no <style>, no external links except aitoolsnova.com internal ones
- Use straight ASCII quotes inside HTML attributes; escape any inline double-quote inside JSON strings

Return ONLY the JSON object.`;

    const { parsed: raw, model } = await callGroqForJson(
        [{ role: 'user', content: prompt }],
        { temperature: 0.6, max_tokens: 6000, json: true }
    );
    const parsed = raw;
    console.log(`   ✔ Content generated by: ${model}`);
    // Defensive defaults
    parsed.meta_description = parsed.meta_description || `Learn about ${topic.title} with AIToolsNova — free, expert-backed guide.`;
    parsed.meta_keywords = parsed.meta_keywords || 'ai tools, free ai, ai guide, aitoolsnova';
    parsed.read_time_min = parsed.read_time_min || 7;
    parsed.intro_html = parsed.intro_html || '<p>Welcome to this guide.</p>';
    parsed.sections = Array.isArray(parsed.sections) && parsed.sections.length ? parsed.sections : [];
    parsed.faqs = Array.isArray(parsed.faqs) ? parsed.faqs : [];
    parsed.conclusion_html = parsed.conclusion_html || '<p>Thanks for reading! Explore more free AI tools on AIToolsNova.</p>';
    parsed.related_tools = parsed.related_tools || ['ai-chat.html','ai-writer.html','ai-image-generator.html','youtube-kit.html'];
    parsed.related_blogs = parsed.related_blogs || ['best-free-ai-tools-2026.html','top-100-ai-tools-2026.html','ai-productivity-tools.html'];
    parsed.affiliate_picks = Array.isArray(parsed.affiliate_picks) ? parsed.affiliate_picks.slice(0, 3) : [];
    if (parsed.sections.length < 3) throw new Error('Content too short (needs >=3 sections). Got: ' + parsed.sections.length);
    return parsed;
}

// ---------- 6a. Build affiliate section HTML ----------
function buildAffiliateSection(picks) {
    if (!Array.isArray(picks) || picks.length === 0) return '';
    const items = picks.map(p => {
        const aQ = encodeURIComponent(p.amazon_query || p.name || '');
        const fQ = encodeURIComponent(p.flipkart_query || p.name || '');
        // Amazon India affiliate link (auto-tagged when AMAZON_TAG is set)
        const amazonUrl = AMAZON_TAG
            ? `https://www.amazon.in/s?k=${aQ}&tag=${encodeURIComponent(AMAZON_TAG)}`
            : `https://www.amazon.in/s?k=${aQ}`;
        // Flipkart affiliate link (auto-tagged when FLIPKART_AFFID is set)
        const flipkartUrl = FLIPKART_AFFID
            ? `https://www.flipkart.com/search?q=${fQ}&affid=${encodeURIComponent(FLIPKART_AFFID)}`
            : `https://www.flipkart.com/search?q=${fQ}`;
        return `<div class="pick"><h4>${esc(p.name || '')}</h4><p>${esc(p.why || '')}</p><p><a href="${amazonUrl}" rel="sponsored nofollow noopener" target="_blank">🛒 Buy on Amazon</a> &nbsp;·&nbsp; <a href="${flipkartUrl}" rel="sponsored nofollow noopener" target="_blank">🛍️ Buy on Flipkart</a></p></div>`;
    }).join('');
    return `<aside class="affiliate-box">
        <strong>🎯 Recommended products</strong>
        <p style="font-size:.85rem;color:#94A3B8;">${esc(AFFILIATE_DISCLOSURE)}</p>
        ${items}
    </aside>`;
}

// ---------- 6. Build HTML from template ----------
function esc(s = '') { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function buildHtml(topic, content, todayISO, todayHuman) {
    const canonicalUrl = `https://aitoolsnova.com/blog/${topic.slug}.html`;
    // Enrich the raw hero prompt with quality-boosting keywords so Pollinations returns sharp, professional images.
    const enrichedPrompt = `${topic.hero_prompt || topic.title}, high quality, sharp focus, 8k, professional photography, cinematic lighting, ultra detailed, modern tech aesthetic, vibrant colors`;
    const heroPromptEnc = encodeURIComponent(enrichedPrompt);
    // Pollinations Flux model produces MUCH sharper output than the default.
    // width/height at 1600x900 (16:9) → downscaled by browsers cleanly, no pixelation.
    // model=flux + enhance=true + nologo=true + nofeed=true (private) + seed for stability
    const seed = Array.from(topic.slug).reduce((a, c) => a + c.charCodeAt(0), 0);
    const heroImg = `https://image.pollinations.ai/prompt/${heroPromptEnc}?width=1600&height=900&seed=${seed}&model=flux&enhance=true&nologo=true&nofeed=true`;
    const sectionsHtml = content.sections.map(s =>
        `<h2>${esc(s.h2)}</h2>\n${s.body_html}`
    ).join('\n\n');
    const faqsHtml = content.faqs.map((f, i) =>
        `<div class="faq-box"><h4>Q${i+1}: ${esc(f.q)}</h4><p>${esc(f.a)}</p></div>`
    ).join('\n');
    const faqSchema = content.faqs.map(f => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }));

    const relTools = (content.related_tools || []).slice(0, 6)
        .map(u => `<li><a href="../tools/${u}">${u.replace(/-/g,' ').replace('.html','').replace(/\b\w/g, c=>c.toUpperCase())}</a></li>`).join('');
    const relBlogs = (content.related_blogs || []).slice(0, 4)
        .map(u => `<li><a href="${u}">${u.replace(/-/g,' ').replace('.html','').replace(/\b\w/g, c=>c.toUpperCase())}</a></li>`).join('');
    const affiliateHtml = AFFILIATE_PRODUCT_NAME && /^https?:\/\//i.test(AFFILIATE_PRODUCT_URL)
        ? `<aside class="affiliate-box"><strong>Recommended resource: ${esc(AFFILIATE_PRODUCT_NAME)}</strong><p>${esc(AFFILIATE_DISCLOSURE)}</p><a href="${esc(AFFILIATE_PRODUCT_URL)}" rel="sponsored nofollow noopener" target="_blank">View product</a></aside>`
        : '';
    const affiliatePicksHtml = buildAffiliateSection(content.affiliate_picks);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(topic.title)} | AIToolsNova</title>
    <meta name="description" content="${esc(content.meta_description)}">
    <meta name="keywords" content="${esc(content.meta_keywords)}">
    <meta name="robots" content="index, follow, max-image-preview:large">
    <link rel="canonical" href="${canonicalUrl}">

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(topic.title)} | AIToolsNova">
    <meta property="og:description" content="${esc(content.meta_description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="article">
    <meta property="og:image" content="${heroImg}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(topic.title)} | AIToolsNova">
    <meta name="twitter:description" content="${esc(content.meta_description)}">
    <meta name="twitter:image" content="${heroImg}">

    <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
    <link rel="dns-prefetch" href="https://www.googletagmanager.com">
    <link rel="dns-prefetch" href="https://www.google-analytics.com">
    <link rel="dns-prefetch" href="https://image.pollinations.ai">
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2278101269918728" crossorigin="anonymous"></script>
    <script>
      (adsbygoogle = window.adsbygoogle || []).push({
        google_ad_client: "ca-pub-2278101269918728",
        enable_page_level_ads: true
      });
    </script>

    <script async src="https://www.googletagmanager.com/gtag/js?id=G-KJ0WTD0R0M"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){ dataLayer.push(arguments); }
        gtag('js', new Date());
        gtag('config', 'G-KJ0WTD0R0M', { page_path: window.location.pathname, anonymize_ip: true });
    </script>

    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": ${JSON.stringify(topic.title)},
        "description": ${JSON.stringify(content.meta_description)},
        "image": ${JSON.stringify(heroImg)},
        "author": { "@type": "Person", "name": "AIToolsNova Team" },
        "datePublished": "${todayISO}",
        "dateModified": "${todayISO}",
        "mainEntityOfPage": { "@type": "WebPage", "@id": "${canonicalUrl}" },
        "publisher": {
            "@type": "Organization",
            "name": "AIToolsNova",
            "logo": { "@type": "ImageObject", "url": "https://aitoolsnova.com/images/logo.webp" }
        }
    }
    </script>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": ${JSON.stringify(faqSchema)}
    }
    </script>

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:"Inter",sans-serif;background:#F8FAFC;color:#0F172A;line-height:1.8;padding-top:75px}
        .container{max-width:850px;margin:0 auto;padding:0 20px 60px}
        .header{position:fixed;top:0;left:0;width:100%;height:68px;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border-bottom:1px solid #E2E8F0;z-index:999;display:flex;align-items:center}
        .header .container{max-width:1320px;width:92%;padding:0;display:flex;align-items:center;justify-content:space-between}
        .logo{display:flex;align-items:center;gap:10px;font-size:1.3rem;font-weight:800;color:#0F172A;text-decoration:none}
        .back-btn{padding:8px 20px;border-radius:50px;background:#4F46E5;color:#fff;text-decoration:none;font-weight:600;font-size:.9rem;transition:.3s}
        .back-btn:hover{background:#6366F1;transform:translateY(-2px)}
        .hero-image{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:16px;margin:16px 0 8px;background:#EEF2FF;box-shadow:0 10px 30px rgba(15,23,42,.08);image-rendering:auto;image-rendering:high-quality;image-rendering:-webkit-optimize-contrast}
        .blog-header{margin:8px 0 24px}
        .blog-header h1{font-size:clamp(1.8rem,4vw,2.8rem);font-weight:800;line-height:1.2;margin-bottom:12px}
        .blog-meta{color:#94A3B8;font-size:.9rem;display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #E2E8F0}
        .blog-meta span{display:flex;align-items:center;gap:6px}
        .blog-content h2{font-size:1.6rem;font-weight:700;margin:35px 0 12px;color:#0F172A}
        .blog-content h3{font-size:1.2rem;font-weight:700;margin:24px 0 10px;color:#0F172A}
        .blog-content p{color:#475569;margin-bottom:16px;font-size:1rem}
        .blog-content ul,.blog-content ol{padding-left:24px;margin-bottom:16px;color:#475569}
        .blog-content ul li,.blog-content ol li{margin-bottom:8px}
        .blog-content strong{color:#0F172A}
        .blog-content a{color:#4F46E5;font-weight:600;text-decoration:none}
        .blog-content a:hover{text-decoration:underline}
        .highlight-box{background:#EEF2FF;padding:20px 24px;border-radius:12px;border-left:4px solid #4F46E5;margin:20px 0}
        .highlight-box p{margin-bottom:0;color:#0F172A}
        .affiliate-box{background:#FFF7E1;border:1px solid #E9C46A;border-radius:12px;padding:18px 20px;margin:28px 0}
        .affiliate-box strong{display:block;margin-bottom:6px;color:#0F172A}
        .affiliate-box p{margin-bottom:10px;font-size:.9rem}
        .affiliate-box a{color:#4F46E5;font-weight:700}
        .affiliate-box .pick{background:#fff;border:1px solid #E9C46A;border-radius:10px;padding:14px;margin-top:12px}
        .affiliate-box .pick h4{color:#0F172A;font-size:1.05rem;margin:0 0 6px}
        .affiliate-box .pick p{margin-bottom:6px;color:#475569}
        .faq-box{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px 20px;margin:12px 0}
        .faq-box h4{margin-bottom:6px;font-size:1rem;color:#0F172A}
        .faq-box p{color:#475569;margin-bottom:0}
        .related-box{background:#F1F5F9;border-radius:12px;padding:20px;margin:24px 0}
        .related-box h3{margin-top:0}
        .related-box ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px}
        .related-box ul li{display:inline-block;background:#fff;padding:6px 14px;border-radius:50px;border:1px solid #E2E8F0;font-size:.85rem}
        .related-box ul li a{color:#4F46E5;text-decoration:none}
        .related-box ul li a:hover{text-decoration:underline}
        .footer{background:#020617;padding:40px 0 16px;color:#CBD5E1;margin-top:20px}
        .footer .container{max-width:1320px;padding:0 20px}
        .footer a{color:#94A3B8;text-decoration:none}
        .footer a:hover{color:#fff}
        .footer-bottom{border-top:1px solid rgba(255,255,255,.06);padding-top:16px;text-align:center;font-size:.85rem;color:#94A3B8}
        @media(max-width:768px){body{padding-top:60px}.blog-header h1{font-size:1.6rem}.header{height:60px}}
    </style>
</head>
<body>

    <header class="header">
        <div class="container">
            <a href="../index.html" class="logo">🤖 <span>AIToolsNova</span></a>
            <a href="../blogs.html" class="back-btn">← All Blogs</a>
        </div>
    </header>

    <div class="container">
        <article>
            <img class="hero-image" src="${heroImg}" alt="${esc(topic.title)}" loading="eager" fetchpriority="high" decoding="async" width="1600" height="900">
            <div class="blog-header">
                <h1>${esc(topic.title)}</h1>
                <div class="blog-meta">
                    <span>📅 ${todayHuman}</span>
                    <span>⏱ ${content.read_time_min || 7} min read</span>
                    <span>👤 AIToolsNova Team</span>
                    <span>🏷️ ${esc((topic.category || 'ai').toUpperCase())}</span>
                </div>
            </div>

            <div class="blog-content">
                ${content.intro_html}

                ${sectionsHtml}

                <h2>Frequently Asked Questions</h2>
                ${faqsHtml}

                <h2>Conclusion</h2>
                ${content.conclusion_html}

                ${affiliateHtml}
                ${affiliatePicksHtml}

                <div class="related-box">
                    <h3>🛠️ Related Tools</h3>
                    <ul>
                        ${relTools}
                        <li><a href="../tools.html">View All Tools →</a></li>
                    </ul>
                </div>

                <div class="related-box">
                    <h3>📚 Related Blogs</h3>
                    <ul>
                        ${relBlogs}
                        <li><a href="../blogs.html">View All Blogs →</a></li>
                    </ul>
                </div>

                <p style="margin-top:24px;padding-top:16px;border-top:1px solid #E2E8F0;font-size:.85rem;color:#94A3B8;">
                    <strong>Published:</strong> ${todayHuman}
                </p>
            </div>
        </article>
    </div>

    <footer class="footer">
        <div class="container">
            <div class="footer-bottom">
                <p>© 2026 AIToolsNova. All Rights Reserved. | <a href="../privacy-policy.html">Privacy Policy</a> | <a href="../terms-and-conditions.html">Terms</a> | <a href="../disclaimer.html">Disclaimer</a></p>
            </div>
        </div>
    </footer>

<script src="../enhancements.js" defer></script>
</body>
</html>
`;
}

// ---------- 7. Update blogs.html ----------
async function updateBlogsList(topic, content, todayHuman) {
    const html = await fs.readFile(BLOGS_HTML, 'utf-8');
    const START = '<!-- AUTO-BLOG-INSERT-START -->';
    const END   = '<!-- AUTO-BLOG-INSERT-END -->';
    if (!html.includes(START) || !html.includes(END)) {
        console.warn('⚠️  blogs.html insertion markers missing — skipping blog list update.');
        return;
    }
    const cardCategory = ['ai','seo','social','productivity','coding','image','writing'].includes(topic.category) ? topic.category : 'ai';
    const shortDesc = (content.meta_description || '').replace(/"/g, '&quot;');
    const card = `                    <article class="blog-card" data-category="${cardCategory}">
                        <div class="blog-img">${topic.emoji || '🤖'}</div>
                        <div class="blog-content">
                            <span class="blog-tag">${(topic.category || 'ai').toUpperCase()}</span>
                            <h3>${esc(topic.title)}</h3>
                            <div class="blog-meta">
                                <span>📅 ${todayHuman}</span>
                                <span>⏱ ${content.read_time_min || 7} min read</span>
                            </div>
                            <p>${shortDesc}</p>
                            <a href="blog/${topic.slug}.html" class="read-more">Read More →</a>
                        </div>
                    </article>
`;
    const idx = html.indexOf(START) + START.length;
    const newHtml = html.slice(0, idx) + '\n' + card + '                    ' + html.slice(idx);
    await fs.writeFile(BLOGS_HTML, newHtml);
    console.log('✅ blogs.html updated');
}

// ---------- 8. Update sitemap.xml ----------
async function updateSitemap(topic, todayISO) {
    const xml = await fs.readFile(SITEMAP_XML, 'utf-8');
    const START = '<!-- AUTO-BLOG-SITEMAP-START -->';
    if (!xml.includes(START)) {
        console.warn('⚠️  sitemap.xml insertion marker missing — skipping.');
        return;
    }
    const entry = `
    <url>
        <loc>https://aitoolsnova.com/blog/${topic.slug}.html</loc>
        <lastmod>${todayISO}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
    const idx = xml.indexOf(START) + START.length;
    const newXml = xml.slice(0, idx) + entry + xml.slice(idx);
    await fs.writeFile(SITEMAP_XML, newXml);
    console.log('✅ sitemap.xml updated');
}

// ---------- 9. Ping IndexNow (Bing + Yandex + Naver + others) ----------
async function pingIndexNow(topic) {
    if (!INDEXNOW_KEY) { console.log('   ℹ️  INDEXNOW_KEY not set — skipping IndexNow ping (Google/Bing sitemap ping still runs in workflow).'); return; }
    const url = `https://aitoolsnova.com/blog/${topic.slug}.html`;
    try {
        const res = await fetch('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                host: 'aitoolsnova.com',
                key: INDEXNOW_KEY,
                keyLocation: `https://aitoolsnova.com/${INDEXNOW_KEY}.txt`,
                urlList: [url]
            })
        });
        console.log(`   IndexNow → HTTP ${res.status}`);
    } catch (e) {
        console.warn('   IndexNow ping failed (non-blocking):', e.message);
    }
}

// ---------- MAIN ----------
async function main() {
    console.log('🚀 AIToolsNova - Daily Blog Generator (v2 bulletproof) starting...\n');
    const today = new Date();
    const todayISO = today.toISOString().slice(0, 10);
    const todayHuman = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    console.log('📚 Reading existing blog titles...');
    const existingTitles = await readExistingTitles();
    console.log(`   Found ${existingTitles.length} existing titles.`);

    const history = await loadHistory();

    console.log('\n🎯 Generating unique topic...');
    const topic = await generateTopic(existingTitles, history);
    console.log(`   ➤ Title: ${topic.title}`);
    console.log(`   ➤ Slug:  ${topic.slug}`);
    console.log(`   ➤ Category: ${topic.category}`);
    console.log(`   ➤ Hero prompt: ${topic.hero_prompt}`);

    const outFile = path.join(BLOG_DIR, `${topic.slug}.html`);
    if (existsSync(outFile)) {
        console.log(`⚠️  ${topic.slug}.html already exists — appending timestamp for safety.`);
        topic.slug += '-' + today.getTime().toString(36).slice(-4);
    }

    console.log('\n📝 Generating full blog content (may take 20-40s)...');
    const content = await generateContent(topic);
    console.log(`   ➤ ${content.sections?.length || 0} sections, ${content.faqs?.length || 0} FAQs, ~${content.read_time_min || '?'} min read`);

    console.log('\n📄 Building HTML file...');
    const finalHtml = buildHtml(topic, content, todayISO, todayHuman);
    const finalPath = path.join(BLOG_DIR, `${topic.slug}.html`);
    await fs.writeFile(finalPath, finalHtml);
    console.log(`   ✅ Written: blog/${topic.slug}.html (${(finalHtml.length/1024).toFixed(1)} KB)`);

    console.log('\n🔗 Updating blogs.html and sitemap.xml...');
    await updateBlogsList(topic, content, todayHuman);
    await updateSitemap(topic, todayISO);

    history.topics.push(topic.title);
    if (history.topics.length > 200) history.topics = history.topics.slice(-200);
    await saveHistory(history);

    console.log('\n📣 Pinging search engines...');
    await pingIndexNow(topic);

    console.log('\n🎉 Done! Blog post created successfully.');
    console.log(`   Preview URL: https://aitoolsnova.com/blog/${topic.slug}.html\n`);
}

main().catch(err => {
    console.error('\n❌ FATAL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
