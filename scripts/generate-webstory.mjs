#!/usr/bin/env node
/**
 * AIToolsNova - Daily Web Story Auto Generator
 * ---------------------------------------------
 * - Reads the most recently added/updated blog post
 * - Generates a Google Web Story (AMP Story) with 7 slides:
 *      Cover + 5 tip slides + CTA
 * - Uses HD portrait images from Pollinations.ai (free, no key)
 * - Each image slide has a single readable caption line beneath the image
 * - Modern Google Fonts (Poppins + Playfair Display) - no emoji-only slides
 * - Adds the new story URL to sitemap.xml
 * - Rebuilds web-stories.html index page listing all stories
 * - Pings Google/Bing sitemap + IndexNow so search engines discover it fast
 *
 * Env vars (at least ONE AI key):
 *   GROQ_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY
 *   GROQ_MODEL / GEMINI_MODEL / INDEXNOW_KEY optional
 *
 * Run:  node scripts/generate-webstory.mjs
 */

import fs from 'node:fs/promises';
import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const STORIES_DIR = path.join(ROOT, 'web-stories');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');
const STORIES_INDEX = path.join(ROOT, 'web-stories.html');
const SITE = 'https://aitoolsnova.com';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.Deepseek_API_key || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.Gemini_API_key || process.env.GOOGLE_GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || (() => {
    try {
        const keyFile = readdirSync(ROOT).find(f => /^[a-f0-9]{32}\.txt$/i.test(f));
        if (keyFile) return keyFile.replace('.txt', '');
    } catch { /* silent */ }
    return '';
})();

const MODELS = process.env.GROQ_MODEL
    ? [process.env.GROQ_MODEL, 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'gemma2-9b-it']
    : ['llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'gemma2-9b-it', 'openai/gpt-oss-120b'];

if (!GROQ_KEY && !GEMINI_KEY && !DEEPSEEK_KEY) {
    console.error('❌ Need GROQ_API_KEY and/or GEMINI_API_KEY and/or DEEPSEEK_API_KEY');
    process.exit(1);
}
console.log(`🔑 Providers: Groq=${GROQ_KEY ? 'yes' : 'no'} Gemini=${GEMINI_KEY ? 'yes' : 'no'} DeepSeek=${DEEPSEEK_KEY ? 'yes' : 'no'}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Pick source blog ----------
async function pickSourceBlog() {
    const files = readdirSync(BLOG_DIR)
        .filter(f => f.endsWith('.html'))
        .map(f => ({ f, mtime: statSync(path.join(BLOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    // Skip blogs that already have a matching web story
    for (const { f } of files) {
        const slug = f.replace(/\.html$/, '');
        const storyPath = path.join(STORIES_DIR, `${slug}.html`);
        if (!existsSync(storyPath)) {
            const html = await fs.readFile(path.join(BLOG_DIR, f), 'utf-8');
            const titleMatch = html.match(/<title>([^<|]+)/i);
            const h1Match = html.match(/<h1[^>]*>([^<]+)/i);
            const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
            const title = (h1Match?.[1] || titleMatch?.[1] || slug.replace(/-/g, ' ')).trim();
            const description = (descMatch?.[1] || '').trim();
            return { slug, title, description, sourceFile: f };
        }
    }
    // Fallback: use the most recent blog even if a story exists (regenerate with -v2 suffix)
    if (files.length === 0) throw new Error('No blog posts found in blog/');
    const { f } = files[0];
    const slug = `${f.replace(/\.html$/, '')}-v${Date.now().toString(36).slice(-4)}`;
    const html = await fs.readFile(path.join(BLOG_DIR, f), 'utf-8');
    const titleMatch = html.match(/<title>([^<|]+)/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)/i);
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    return {
        slug,
        title: (h1Match?.[1] || titleMatch?.[1] || slug).trim(),
        description: (descMatch?.[1] || '').trim(),
        sourceFile: f,
    };
}

// ---------- Multi-provider AI call (Groq → Gemini → DeepSeek) ----------
async function callGroq(messages) {
    let lastErr;
    if (GROQ_KEY) {
        for (const model of MODELS) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${GROQ_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            model,
                            messages,
                            temperature: 0.85,
                            max_tokens: 1800,
                            response_format: { type: 'json_object' },
                        }),
                    });
                    if (!res.ok) {
                        const t = await res.text();
                        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
                    }
                    const j = await res.json();
                    const content = j.choices?.[0]?.message?.content;
                    if (!content) throw new Error('Empty content');
                    console.log(`   ✔ Groq: ${model}`);
                    return { content, model: `groq:${model}` };
                } catch (e) {
                    lastErr = e;
                    console.warn(`⚠️  groq:${model} attempt ${attempt} failed: ${e.message}`);
                    await sleep(1500 * attempt);
                }
            }
        }
    }

    if (GEMINI_KEY) {
        try {
            console.warn('   ⚠️  Groq unavailable — trying Gemini');
            const sys = messages.find(m => m.role === 'system');
            const user = messages.filter(m => m.role !== 'system');
            const body = {
                systemInstruction: sys ? { parts: [{ text: sys.content }] } : undefined,
                contents: user.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                })),
                generationConfig: {
                    temperature: 0.85,
                    maxOutputTokens: 2048,
                    responseMimeType: 'application/json',
                }
            };
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                const content = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
                if (content) {
                    console.log(`   ✔ Gemini: ${GEMINI_MODEL}`);
                    return { content, model: `gemini:${GEMINI_MODEL}` };
                }
            } else {
                console.warn(`   ⚠️  Gemini ${res.status}: ${data?.error?.message || ''}`);
            }
        } catch (e) {
            console.warn(`   ⚠️  Gemini error: ${e.message}`);
            lastErr = e;
        }
    }

    if (DEEPSEEK_KEY) {
        try {
            console.warn('   ⚠️  Falling back to DeepSeek');
            const res = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages,
                    temperature: 0.85,
                    max_tokens: 1800,
                    response_format: { type: 'json_object' },
                }),
            });
            if (res.ok) {
                const data = await res.json();
                const content = data.choices?.[0]?.message?.content?.trim() || '';
                if (content) {
                    console.log('   ✔ DeepSeek: deepseek-chat');
                    return { content, model: 'deepseek-chat' };
                }
            } else {
                const t = await res.text().catch(() => '');
                console.warn(`   ⚠️  DeepSeek ${res.status}: ${t.slice(0, 200)}`);
            }
        } catch (e) {
            console.warn(`   ⚠️  DeepSeek error: ${e.message}`);
            lastErr = e;
        }
    }

    throw lastErr || new Error('All AI providers failed');
}

function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found');
    const raw = text.slice(start, end + 1);
    return JSON.parse(raw);
}

// ---------- Generate story content ----------
async function generateStoryContent({ title, description }) {
    const sys = `You are a viral Google Web Story writer for AIToolsNova.com.
Return STRICT JSON only.
Schema:
{
  "story_title": "Catchy 60-char max headline",
  "meta_description": "160-char SEO description",
  "cover_caption": "Short punchy hook, 8-14 words",
  "geo_keywords": "10 comma-separated high-intent SEO keywords mixing Global/US/UK/Canada/India e.g. best free ai tools 2026, ai tools for us freelancers, free ai tools uk, ai tools canada students, best ai apps india",
  "cover_image_prompt": "cinematic HD photorealistic image prompt for cover, portrait 9:16, no text",
  "slides": [
    {
      "heading": "Big 3-5 word slide heading",
      "caption": "Single readable line that appears under the image, 10-18 words, no hashtags, no emoji",
      "image_prompt": "cinematic HD photorealistic prompt for portrait 9:16, no text overlay"
    }
    // exactly 5 slides
  ],
  "cta_line": "Short CTA line, 8-14 words, benefit-led"
}
Rules:
- Never include quotation marks inside string values.
- Captions must be ONE clean sentence, no emojis, no hashtags, no ALL CAPS.
- Image prompts must describe HD real photos (studio lighting, cinematic, ultra-detailed), NEVER cartoons or text.`;

    const user = `Blog title: "${title}"
Blog description: "${description}"
Create a 7-slide web story (cover + 5 tips + cta) for mobile readers in the US, UK, Canada, India and worldwide. Make the cover title irresistible (curiosity + benefit + number when natural). Keywords must be search-friendly, not stuffed. Captions in clear global English.`;

    const { content } = await callGroq([
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ]);
    const data = extractJson(content);
    if (!data.slides || !Array.isArray(data.slides) || data.slides.length < 3) {
        throw new Error('Invalid slides array');
    }
    // Trim to 5 slides
    data.slides = data.slides.slice(0, 5);
    return data;
}

// ---------- Helpers ----------
const esc = s => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const imgUrl = (prompt, seed) => {
    const p = encodeURIComponent(String(prompt).slice(0, 380));
    return `https://image.pollinations.ai/prompt/${p}?width=1080&height=1920&nologo=true&enhance=true&model=flux&seed=${seed}&safe=true`;
};

// ---------- Localize images: download remote HD images into the repo ----------
// Live-hotlinked images are slow, unreliable and bad for indexing. We download
// each once into web-stories/img/ and serve it from our own domain.
const IMG_DIR = path.join(STORIES_DIR, 'img');
const REMOTE_RE = /https?:\/\/image\.pollinations\.ai\/prompt\/[^"'\\\s)]+/g;

// Google Web Stories require at least 640x853. Pollinations returns 576x1024
// no matter what we ask for, so every image needs upscaling to pass validation.
async function upscaleForWebStories(file) {
    // Always normalize to 1080x1920 HD portrait for AMP Web Stories approval + crisp phones.
    try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(file).metadata();
        const out = await sharp(file)
            .resize(1080, 1920, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
            .sharpen({ sigma: 0.6 })
            .jpeg({ quality: 92, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
            .toBuffer();
        await fs.writeFile(file, out);
        console.log(`   ↑ HD ${path.basename(file)} ${(meta.width||'?')}x${(meta.height||'?')} → 1080x1920`);
    } catch (e) {
        console.warn(`   ⚠️  UPSCALE SKIPPED for ${path.basename(file)} - ${e.message}`);
        console.warn('   ⚠️  Check that the "Install sharp" workflow step succeeded.');
    }
}

async function downloadImage(url, dest, tries = 3) {
    for (let i = 1; i <= tries; i++) {
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 90000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(to);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 1500) throw new Error('tiny image');
            await fs.writeFile(dest, buf);
            await upscaleForWebStories(dest);
            return true;
        } catch (e) {
            await sleep(6000 * i);
        }
    }
    return false;
}

async function localizeHtmlImages(html) {
    await fs.mkdir(IMG_DIR, { recursive: true });
    const urls = [...new Set(html.match(REMOTE_RE) || [])];
    for (const u of urls) {
        const name = crypto.createHash('md5').update(u).digest('hex').slice(0, 16) + '.jpg';
        const dest = path.join(IMG_DIR, name);
        const ok = existsSync(dest) || await downloadImage(u, dest);
        if (ok) {
            html = html.split(u).join(`/web-stories/img/${name}`);
            console.log(`  🖼️  localized ${name}`);
        } else {
            console.warn(`  ⚠️  keeping remote (download failed): ${u.slice(0, 60)}...`);
        }
        await sleep(1500);
    }
    return html;
}

// ---------- Build AMP Story HTML ----------
function buildStoryHtml({ slug, story }) {
    // Extensionless - the .html form 308-redirects on Cloudflare Pages.
    const canonical = `${SITE}/web-stories/${slug}`;
    const publisherLogo = `${SITE}/images/publisher-logo.png`;
    const coverImg = imgUrl(story.cover_image_prompt, 1000);
    const posterUrl = coverImg;
    const today = new Date().toISOString().split('T')[0];

    const slidesHtml = story.slides.map((s, i) => {
        const seed = 2000 + i * 137;
        const src = imgUrl(s.image_prompt, seed);
        return `
    <amp-story-page id="s-${i + 1}">
      <amp-story-grid-layer template="fill">
        <amp-img src="${src}" width="1080" height="1920" layout="responsive" alt="${esc(s.heading)}"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="fill">
        <div class="scrim"></div>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical" class="slide-layer">
        <div class="slide-body">
          <span class="pill">Tip ${i + 1} of ${story.slides.length}</span>
          <h2 class="slide-heading">${esc(s.heading)}</h2>
        </div>
        <div class="slide-caption-wrap">
          <p class="slide-caption">${esc(s.caption)}</p>
        </div>
      </amp-story-grid-layer>
    </amp-story-page>`;
    }).join('\n');

    return `<!doctype html>
<html amp lang="en">
<head>
  <meta charset="utf-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-story" src="https://cdn.ampproject.org/v0/amp-story-1.0.js"></script>
  <script async custom-element="amp-story-auto-ads" src="https://cdn.ampproject.org/v0/amp-story-auto-ads-0.1.js"></script>
  <script async custom-element="amp-analytics" src="https://cdn.ampproject.org/v0/amp-analytics-0.1.js"></script>
  <title>${esc(story.story_title)}</title>
  <meta name="description" content="${esc(story.meta_description)}">
  <meta name="keywords" content="${esc(story.geo_keywords || 'free ai tools, ai tools 2026')}">
  <meta name="viewport" content="width=device-width,minimum-scale=1,initial-scale=1">
  <link rel="canonical" href="${canonical}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Poppins:wght@400;500;700;900&display=swap" rel="stylesheet">
  <style amp-boilerplate>body{-webkit-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-moz-animation:-amp-start 8s steps(1,end) 0s 1 normal both;animation:-amp-start 8s steps(1,end) 0s 1 normal both}@-webkit-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-moz-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}</style><noscript><style amp-boilerplate>body{-webkit-animation:none;-moz-animation:none;animation:none}</style></noscript>
  <style amp-custom>
    amp-story-page { background:#0b0b12; font-family:'Poppins', Arial, sans-serif; }
    .scrim { width:100%; height:100%; background:linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.25) 35%, rgba(0,0,0,0.85) 100%); }
    .slide-layer { padding: 32px 28px; }
    .slide-body { margin-top: 24px; }
    .pill { display:inline-block; padding:6px 14px; border-radius:999px; background:rgba(255,255,255,0.16); backdrop-filter: blur(8px); color:#fff; font-size:12px; letter-spacing:1.2px; text-transform:uppercase; font-weight:700; }
    .slide-heading { font-family:'Playfair Display', serif; color:#fff; font-size:38px; line-height:1.1; margin-top:14px; font-weight:900; text-shadow:0 2px 12px rgba(0,0,0,0.55); max-width:92%; }
    .slide-caption-wrap { margin-top:auto; padding:16px 18px; background:rgba(0,0,0,0.55); border-left:4px solid #ffd166; border-radius:10px; backdrop-filter: blur(6px); }
    .slide-caption { color:#fff; font-size:18px; line-height:1.45; font-weight:500; margin:0; }
    .cover-body { text-align:center; padding:40px 26px; }
    .cover-brand { font-size:12px; letter-spacing:3px; color:#ffd166; text-transform:uppercase; font-weight:800; }
    .cover-title { font-family:'Playfair Display', serif; color:#fff; font-size:44px; line-height:1.08; font-weight:900; margin-top:14px; text-shadow:0 3px 14px rgba(0,0,0,0.6); }
    .cover-caption { color:#f2f2f2; font-size:19px; margin-top:16px; font-weight:500; }
    .swipe-hint { color:#ffd166; font-size:14px; margin-top:28px; letter-spacing:2px; font-weight:700; }
    .cta-wrap { padding:40px 28px; text-align:center; }
    .cta-title { font-family:'Playfair Display', serif; color:#fff; font-size:40px; line-height:1.1; font-weight:900; }
    .cta-desc { color:#f2f2f2; font-size:18px; margin-top:14px; font-weight:500; }
    .cta-cta { display:inline-block; margin-top:26px; padding:14px 28px; background:#ffd166; color:#1a1a2e; border-radius:999px; font-weight:800; font-size:16px; text-decoration:none; }
  </style>
  <script type="application/ld+json">
  ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": story.story_title,
        "description": story.meta_description,
        "image": [coverImg],
        "datePublished": today,
        "dateModified": today,
        "author": { "@type": "Organization", "name": "AIToolsNova" },
        "publisher": {
            "@type": "Organization",
            "name": "AIToolsNova",
            "logo": { "@type": "ImageObject", "url": publisherLogo }
        },
        "mainEntityOfPage": canonical
    })}
  </script>
</head>
<body>
  <amp-story standalone
    title="${esc(story.story_title)}"
    publisher="AIToolsNova"
    publisher-logo-src="${publisherLogo}"
    poster-portrait-src="${posterUrl}">

    <!-- Cover -->
    <amp-story-page id="cover">
      <amp-story-grid-layer template="fill">
        <amp-img src="${coverImg}" width="1080" height="1920" layout="responsive" alt="${esc(story.story_title)}"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="fill">
        <div class="scrim"></div>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical">
        <div class="cover-body">
          <span class="cover-brand">AIToolsNova</span>
          <h1 class="cover-title">${esc(story.story_title)}</h1>
          <p class="cover-caption">${esc(story.cover_caption)}</p>
          <p class="swipe-hint">Swipe up →</p>
        </div>
      </amp-story-grid-layer>
    </amp-story-page>

${slidesHtml}

    <!-- CTA -->
    <amp-story-page id="cta">
      <amp-story-grid-layer template="fill">
        <amp-img src="${imgUrl('futuristic glowing dashboard of AI tools, neon lights, cinematic', 9000)}" width="1080" height="1920" layout="responsive" alt="Explore more"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="fill">
        <div class="scrim"></div>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical">
        <div class="cta-wrap">
          <h2 class="cta-title">Try 100+ Free AI Tools</h2>
          <p class="cta-desc">${esc(story.cta_line)}</p>
          <a class="cta-cta" href="${SITE}/tools">Explore Tools →</a>
        </div>
      </amp-story-grid-layer>
      <amp-story-page-outlink layout="nodisplay">
        <a href="${SITE}/tools">Explore AI Tools</a>
      </amp-story-page-outlink>
    </amp-story-page>

  <amp-story-auto-ads><script type="application/json">{"ad-attributes":{"type":"adsense","data-ad-client":"ca-pub-2278101269918728","data-ad-slot":"1700790558"}}</script></amp-story-auto-ads>
<amp-analytics type="gtag" data-credentials="include"><script type="application/json">{"vars":{"gtag_id":"G-KJ0WTD0R0M","config":{"G-KJ0WTD0R0M":{"groups":"default"}}}}</script></amp-analytics>
</amp-story>
</body>
</html>`;
}

// ---------- Update sitemap.xml ----------
async function updateSitemap({ slug, title }) {
    let xml = await fs.readFile(SITEMAP_XML, 'utf-8');
    const url = `${SITE}/web-stories/${slug}`;
    if (xml.includes(url)) return false;

    const today = new Date().toISOString().split('T')[0];
    const block = `
    <url>
        <loc>${url}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
`;
    xml = xml.replace('</urlset>', `${block}\n</urlset>`);
    await fs.writeFile(SITEMAP_XML, xml);
    return true;
}

// ---------- Rebuild web-stories.html index ----------
async function rebuildStoriesIndex() {
    const files = readdirSync(STORIES_DIR).filter(f => f.endsWith('.html')).sort((a, b) =>
        statSync(path.join(STORIES_DIR, b)).mtimeMs - statSync(path.join(STORIES_DIR, a)).mtimeMs
    );

    const cards = await Promise.all(files.map(async f => {
        const html = await fs.readFile(path.join(STORIES_DIR, f), 'utf-8');
        const t = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || f).trim();
        const d = (html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || '').trim();
        const img = html.match(/poster-portrait-src="([^"]+)"/i)?.[1] || `${SITE}/images/publisher-logo.png`;
        const url = `/web-stories/${f.replace(/\.html$/, '')}`;
        return `
      <a class="story-card" href="${url}" data-testid="story-card-${f.replace(/\.html$/, '')}">
        <div class="story-thumb"><img src="${img}" alt="${esc(t)}" loading="lazy" width="240" height="426"></div>
        <div class="story-meta">
          <h3>${esc(t)}</h3>
          <p>${esc(d.slice(0, 110))}</p>
          <span class="story-cta">Read Story →</span>
        </div>
      </a>`;
    }));

    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI Web Stories | AIToolsNova - Daily Visual AI Tool Tips</title>
<meta name="description" content="Bite-sized visual web stories about the latest AI tools, tips, and hacks. Updated daily on AIToolsNova.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${SITE}/web-stories">
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Poppins:wght@400;500;700&display=swap" rel="stylesheet">
<meta property="og:title" content="AI Web Stories | AIToolsNova">
<meta property="og:description" content="Bite-sized visual web stories about the latest AI tools, tips, and hacks.">
<meta property="og:image" content="${SITE}/images/og-image.webp">
<meta name="google-adsense-account" content="ca-pub-2278101269918728">
<script type="application/ld+json">
${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "AI Web Stories",
        "description": "Daily visual web stories on AI tools and tips",
        "url": `${SITE}/web-stories`,
        "publisher": { "@type": "Organization", "name": "AIToolsNova" }
    })}
</script>
<style>
  :root { --bg:#0b0b12; --panel:#141425; --line:#22223a; --text:#f5f5fa; --muted:#a9a9c0; --accent:#ffd166; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:'Poppins',system-ui,Arial,sans-serif; }
  header { padding:60px 24px 32px; text-align:center; background:radial-gradient(1000px 400px at 50% -20%, #2b1e5a 0%, transparent 65%); border-bottom:1px solid var(--line); }
  header .brand { color:var(--accent); font-size:12px; letter-spacing:4px; font-weight:800; text-transform:uppercase; }
  header h1 { font-family:'Playfair Display',serif; font-size:48px; margin:10px 0 8px; font-weight:900; line-height:1.05; }
  header p { color:var(--muted); font-size:17px; max-width:640px; margin:0 auto; }
  nav.top { display:flex; gap:16px; justify-content:center; margin-top:22px; flex-wrap:wrap; }
  nav.top a { color:var(--text); text-decoration:none; padding:9px 16px; border:1px solid var(--line); border-radius:999px; font-size:14px; font-weight:600; }
  nav.top a:hover { border-color:var(--accent); color:var(--accent); }
  .grid { max-width:1200px; margin:36px auto; padding:0 20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:22px; }
  .story-card { background:var(--panel); border:1px solid var(--line); border-radius:16px; overflow:hidden; text-decoration:none; color:var(--text); display:flex; flex-direction:column; transition:transform .2s ease, border-color .2s ease; }
  .story-card:hover { transform:translateY(-4px); border-color:var(--accent); }
  .story-thumb { aspect-ratio:9/16; overflow:hidden; background:#000; }
  .story-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .story-meta { padding:14px 16px 18px; }
  .story-meta h3 { font-family:'Playfair Display',serif; font-size:18px; margin:0 0 8px; line-height:1.2; }
  .story-meta p { color:var(--muted); font-size:13px; margin:0 0 10px; line-height:1.4; }
  .story-cta { color:var(--accent); font-weight:700; font-size:13px; letter-spacing:.5px; }
  footer { text-align:center; padding:32px 16px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); margin-top:40px; }
  footer a { color:var(--accent); text-decoration:none; }
  @media (max-width:520px) {
    header h1 { font-size:34px; }
    .grid { grid-template-columns:repeat(2, 1fr); gap:14px; }
    .story-meta h3 { font-size:16px; }
  }
</style>
</head>
<body>
<header>
  <span class="brand">AIToolsNova</span>
  <h1>AI Web Stories</h1>
  <p>Bite-sized, visual stories on the newest AI tools, hacks and how-to tips. New story every day.</p>
  <nav class="top" aria-label="Site">
    <a href="/" data-testid="nav-home">Home</a>
    <a href="/tools" data-testid="nav-tools">Tools</a>
    <a href="/blogs" data-testid="nav-blogs">Blogs</a>
    <a href="/web-stories" data-testid="nav-stories">Stories</a>
    <a href="/about" data-testid="nav-about">About</a>
  </nav>
</header>
<main class="grid" data-testid="web-stories-grid">
${cards.join('\n')}
</main>
<footer>
  © ${new Date().getFullYear()} AIToolsNova · <a href="/">aitoolsnova.com</a>
</footer>
</body>
</html>`;

    await fs.writeFile(STORIES_INDEX, page);
}

// ---------- IndexNow ping ----------
async function pingIndexNow(urls) {
    if (!INDEXNOW_KEY) { console.log('ℹ️  IndexNow key not set, skipping'); return; }
    try {
        const body = {
            host: 'aitoolsnova.com',
            key: INDEXNOW_KEY,
            keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
            urlList: urls,
        };
        const res = await fetch('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        console.log(`✅ IndexNow: ${res.status}`);
    } catch (e) {
        console.warn(`⚠️  IndexNow ping failed: ${e.message}`);
    }
}

// ---------- Main ----------
async function main() {
    console.log('🚀 AIToolsNova - Web Story Generator');
    await fs.mkdir(STORIES_DIR, { recursive: true });

    const src = await pickSourceBlog();
    console.log(`📖 Source blog: ${src.sourceFile}`);
    console.log(`🎯 Slug: ${src.slug}`);

    const story = await generateStoryContent(src);
    console.log(`✍️  Title: ${story.story_title}`);
    console.log(`🖼️  Slides: ${story.slides.length}`);

    const html = buildStoryHtml({ slug: src.slug, story });
    console.log('🖼️  Downloading HD images locally (this makes stories fast + indexable)...');
    const localizedHtml = await localizeHtmlImages(html);
    const outFile = path.join(STORIES_DIR, `${src.slug}.html`);
    await fs.writeFile(outFile, localizedHtml);
    console.log(`💾 Saved: ${path.relative(ROOT, outFile)}`);

    const sitemapUpdated = await updateSitemap({ slug: src.slug, title: story.story_title });
    console.log(sitemapUpdated ? '🗺️  sitemap.xml updated' : '🗺️  sitemap.xml unchanged');

    await rebuildStoriesIndex();
    console.log('📑 web-stories.html rebuilt');

    await pingIndexNow([
        `${SITE}/web-stories/${src.slug}`,
        `${SITE}/web-stories`,
        `${SITE}/sitemap.xml`,
    ]);

    console.log('✅ Done');
}

export { buildStoryHtml, updateSitemap, rebuildStoriesIndex, pickSourceBlog };

// Only auto-run when executed directly (not when imported for testing)
import { fileURLToPath } from 'node:url';
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main().catch(err => {
        console.error('❌ Failed:', err);
        process.exit(1);
    });
}
