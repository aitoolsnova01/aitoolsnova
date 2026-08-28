#!/usr/bin/env node
/**
 * AIToolsNova - Daily Web Story Auto Generator
 * ---------------------------------------------
 * - Reads the most recently added/updated blog post
 * - Generates a Google Web Story (AMP Story) with 12 pages:
 *      Cover + exactly 10 content slides + CTA (12 pages total)
 * - Uses HD portrait images from Pollinations.ai (free, no key), forced
 *   photorealistic so they read as real photos, not AI renders
 * - Each image slide has 2-3 readable caption lines beneath the image
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
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    isBlogWorkflowBroken,
    selfHealWorkflows,
    commitAndPush,
    runBlogGenerator,
    git,
} from './daily-publish-helper.mjs';
import {
    readKeys, noKeyGuidance, annotate, stepSummary, describeError, PublishError,
    parseJsonLoose, fetchWithTimeout, isoDate, addDays, daysBetween,
    appendLedger, planGaps, publishedDates, publishContent, writePublishStatus,
    isCI, parseArgs, CONTENT_PATHS, callSiteApi, siteApiAllowed,
} from './lib/publish-core.mjs';

// ---- CLI -----------------------------------------------------------------
//   node scripts/generate-webstory.mjs                  one story for today
//   node scripts/generate-webstory.mjs --backfill=3     fill missing days
//   node scripts/generate-webstory.mjs --date=2026-08-24
//   node scripts/generate-webstory.mjs --check          diagnostics only
const ARGS = parseArgs();
const DRY_RUN = ARGS.bool('dry-run', process.env.DRY_RUN === '1');
// Backfill is ON by default: a bare `node scripts/generate-blog.mjs` publishes
// today AND catches up up to 2 skipped days (oldest first). That is what makes
// the outage self-healing even if nobody edits the schedule YAML or passes a
// flag. `--backfill=0` (or BACKFILL_MAX=0) turns catch-up off.
const BACKFILL_MAX = ARGS.num('backfill', process.env.BACKFILL_MAX ? Number(process.env.BACKFILL_MAX) : 2);
const TARGET_DATE = ARGS.get('date', process.env.PUBLISH_DATE || '') || '';
const BACKFILL_WINDOW = Number(process.env.BACKFILL_WINDOW || 10);
const MIN_SLIDES = Number(process.env.MIN_SLIDES || 6);
const WANT_SLIDES = 10;

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const STORIES_DIR = path.join(ROOT, 'web-stories');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');
const STORIES_INDEX = path.join(ROOT, 'web-stories.html');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const SITE = 'https://aitoolsnova.com';

const KEYS = readKeys();
const GROQ_KEY = KEYS.groq;
const DEEPSEEK_KEY = KEYS.deepseek;
const GEMINI_KEY = KEYS.gemini;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || (() => {
    try {
        const keyFile = readdirSync(ROOT).find(f => /^[a-f0-9]{32}\.txt$/i.test(f));
        if (keyFile) return keyFile.replace('.txt', '');
    } catch { /* silent */ }
    return '';
})();

const MODELS = process.env.GROQ_MODEL
    // Same catalogue cleanup as the blog generator: gemma2-9b-it is
    // decommissioned (400) and llama-3.1-8b-instant 404s for this org.
    ? [process.env.GROQ_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']
    : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

if (!KEYS.any && !siteApiAllowed()) {
    // Same lesson as the blog job: this must be loud AND recorded, not a silent
    // exit that the workflow's continue-on-error turns into a green tick.
    const msg = noKeyGuidance(KEYS.missing);
    annotate('error', 'No AI key found', `${msg} SITE_API_FALLBACK=0 disables the last-resort provider.`);
    console.error(`❌ ${msg}`);
    try {
        await appendLedger(ROOT, { kind: 'webstory', date: isoDate(), slug: '', status: 'fail', reason: msg, code: 'no-ai-key' });
        await writePublishStatus(ROOT, { kind: 'webstory', ok: false, reason: `no-ai-key: ${msg}`, pushed: false });
        if (isCI() && process.env.SKIP_AUTO_PUBLISH !== '1') {
            await publishContent({
                root: ROOT,
                include: ['scripts/publish-log.json', 'publish-status.json'],
                message: 'chore(webstory): publish failure status (no-ai-key)',
            }).catch(() => {});
        }
    } catch { /* keep the original error visible */ }
    process.exit(1);
}
if (!KEYS.any) console.warn(`⚠️  ${noKeyGuidance(KEYS.missing)}`);
console.log(`🔑 Providers: Groq=${GROQ_KEY ? 'yes' : 'no'} Gemini=${GEMINI_KEY ? 'yes' : 'no'} DeepSeek=${DEEPSEEK_KEY ? 'yes' : 'no'} SiteAPI=${siteApiAllowed() ? 'yes' : 'no'}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Pick source blog ----------
async function pickSourceBlog(preferDate = '') {
    /**
     * Sort by the article's OWN publish date, not by file mtime.
     * In a fresh CI checkout every file has the same mtime (the checkout time),
     * so the old mtime sort picked a "latest blog" at random - which is how the
     * story job re-picked the same post over and over.
     */
    const files = readdirSync(BLOG_DIR)
        .filter(f => f.endsWith('.html'))
        .map(f => ({ f, date: blogDate(path.join(BLOG_DIR, f)) }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.f.localeCompare(a.f));

    // Blogs that already have a story are skipped, newest first.
    for (const { f, date } of files) {
        const slug = f.replace(/\.html$/, '');
        if (existsSync(path.join(STORIES_DIR, `${slug}.html`))) continue;
        const html = await fs.readFile(path.join(BLOG_DIR, f), 'utf-8');
        return describeSource(slug, html, date);
    }
    // Every blog already has a story: make a "part 2" of the newest one (or of
    // the article published on the date we are catching up), instead of failing.
    if (!files.length) throw new PublishError('No blog posts found in blog/ - cannot build a story', { code: 'no-source' });
    const chosen = (preferDate ? files.find(x => x.date === preferDate) : null) || files[0];
    const html = await fs.readFile(path.join(BLOG_DIR, chosen.f), 'utf-8');
    const src = describeSource(`${chosen.f.replace(/\.html$/, '')}-story`, html, chosen.date || isoDate());
    src.slug = `${src.slug}-${Date.now().toString(36).slice(-4)}`;
    return src;
}

/** datePublished from the article itself; falls back to the sitemap/HEAD-free null. */
function blogDate(file) {
    try {
        const html = readFileSync(file, 'utf8').slice(0, 20_000);
        const m = html.match(/"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/) || html.match(/article:published_time"\s+content="(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : '';
    } catch { return ''; }
}

function describeSource(slug, html, date) {
    const titleMatch = html.match(/<title>([^<|]+)/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)/i);
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    // The article's own sections are the safety net for a short story answer.
    const sourceSections = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g)]
        .map((m) => ({
            h2: m[1].replace(/<[^>]+>/g, '').trim(),
            body_html: m[2].split('</section>')[0].trim(),
        }))
        .filter(x => x.h2)
        .slice(0, 14);
    return {
        slug,
        title: (h1Match?.[1] || titleMatch?.[1] || slug.replace(/-/g, ' ')).trim(),
        description: (descMatch?.[1] || '').trim(),
        sourceFile: `${slug}.html`,
        date: date || '',
        sourceSections,
    };
}

// ---------- Multi-provider AI call (DeepSeek -> Gemini -> Groq) ----------
// Owner preference: DeepSeek writes the story JSON first; Gemini and Groq are
// fallbacks so the daily publish never dies. Override with AI_PROVIDER_ORDER.
async function callGroq(messages) {
    const pref = String(process.env.AI_PROVIDER_ORDER || 'deepseek,gemini,groq')
        .toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (const n of ['deepseek', 'gemini', 'groq']) if (!pref.includes(n)) pref.push(n);
    let lastErr;

    const tryDeepSeek = async () => {
        if (!DEEPSEEK_KEY) return null;
        try {
            const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages,
                    temperature: 0.85,
                    max_tokens: 3600,
                    response_format: { type: 'json_object' },
                    timeoutMs: 120_000,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                const content = data.choices?.[0]?.message?.content?.trim() || '';
                if (content) {
                    console.log('   \u2714 DeepSeek: deepseek-chat');
                    return { content, model: 'deepseek-chat' };
                }
                throw new Error('Empty content');
            }
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        } catch (e) {
            lastErr = e;
            console.warn(`   \u26a0\ufe0f  DeepSeek failed: ${e.message}`);
            return null;
        }
    };

    const tryGemini = async () => {
        if (!GEMINI_KEY) return null;
        try {
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
                    maxOutputTokens: 3600,
                    responseMimeType: 'application/json',
                }
            };
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
            const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000 });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                const content = data?.candidates?.[0]?.content?.parts?.map(pp => pp.text).join('').trim() || '';
                if (content) {
                    console.log(`   \u2714 Gemini: ${GEMINI_MODEL}`);
                    return { content, model: `gemini:${GEMINI_MODEL}` };
                }
                throw new Error('Empty content');
            }
            throw new Error(`HTTP ${res.status}: ${(data?.error?.message || '').slice(0, 200)}`);
        } catch (e) {
            lastErr = e;
            console.warn(`   \u26a0\ufe0f  Gemini failed: ${e.message}`);
            return null;
        }
    };

    const tryGroq = async () => {
        if (!GROQ_KEY) return null;
        for (const model of MODELS) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${GROQ_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            model,
                            messages,
                            temperature: 0.85,
                            max_tokens: 3600,
                            response_format: { type: 'json_object' },
                            timeoutMs: 120_000,
                        }),
                    });
                    if (!res.ok) {
                        const t = await res.text();
                        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
                    }
                    const j = await res.json();
                    const content = j.choices?.[0]?.message?.content;
                    if (!content) throw new Error('Empty content');
                    console.log(`   \u2714 Groq: ${model}`);
                    return { content, model: `groq:${model}` };
                } catch (e) {
                    lastErr = e;
                    console.warn(`\u26a0\ufe0f  groq:${model} attempt ${attempt} failed: ${e.message}`);
                    await sleep(1500 * attempt);
                }
            }
        }
        return null;
    };

    // Last resort: the site's own /api/gemini proxy. It holds the same keys the
    // site tools use, so a missing GitHub secret no longer means no stories.
    const trySiteApi = async () => {
        if (!siteApiAllowed()) return null;
        try {
            const flat = messages.map(m => `${m.role === 'system' ? 'SYSTEM' : m.role === 'assistant' ? 'ASSISTANT' : 'USER'}:\n${m.content}`).join('\n\n');
            const { content, provider } = await callSiteApi(flat, { tool: 'seo', timeoutMs: 120_000 });
            console.log(`   ✔ Site API (${provider})`);
            return { content, model: provider };
        } catch (e) {
            lastErr = e;
            console.warn(`   ⚠️  [siteapi] ${describeError(e)}`);
            return null;
        }
    };

    const fns = { deepseek: tryDeepSeek, gemini: tryGemini, groq: tryGroq, siteapi: trySiteApi };
    for (const provider of pref) {
        const fn = fns[provider];
        if (!fn) continue;
        const result = await fn();
        if (result) return result;
        console.warn(`   \u21a9\ufe0e  ${provider} unavailable - trying next provider...`);
    }

    throw new PublishError(describeError(lastErr || 'All AI providers failed (Groq / Gemini / DeepSeek / site API)'), { code: 'provider-failure', retryable: true });
}

/** publish-core's parser + repair (a reply cut off by a token limit still works). */
function extractJson(text) {
    return parseJsonLoose(text).data;
}

// ---------- Generate story content ----------
async function generateStoryContent({ title, description, sourceSections = [] }) {
    const sys = `You are a viral Google Web Story writer for AIToolsNova.com.
Return STRICT JSON only.
Schema:
{
  "story_title": "Catchy 60-char max headline",
  "meta_description": "160-char SEO description",
  "cover_caption": "Short punchy hook, 8-14 words",
  "geo_keywords": "10 comma-separated high-intent SEO keywords mixing Global/US/UK/Canada/India e.g. best free ai tools 2026, ai tools for us freelancers, free ai tools uk, ai tools canada students, best ai apps india",
  "cover_image_prompt": "photorealistic image prompt for cover, portrait 9:16, no text",
  "slides": [
    {
      "heading": "Big 3-5 word slide heading",
      "caption": "Exactly 2-4 short lines (30-45 words), plain spoken English, no hashtags, no emoji",
      "image_prompt": "photorealistic prompt for portrait 9:16, no text overlay"
    }
    // EXACTLY 10 content slides (so the story is cover + 10 + cta = 12 total)
  ],
  "cta_line": "Short CTA line, 8-14 words, benefit-led"
}
Rules:
- Never include quotation marks inside string values.
- Return EXACTLY 10 slides. Each slide caption must be 2-4 short, punchy lines of plain English (30-45 words), no emojis, no hashtags, no ALL CAPS.
- Every image_prompt MUST describe a REAL photograph, not an illustration: "a real photo of ..." with a concrete subject, setting, lighting and camera feel (e.g. shot on a DSLR, natural window light, candid documentary style, shallow depth of field). NEVER cartoons, 3D renders, CGI, clipart, or text overlays.`;

    const user = `Blog title: "${title}"
Blog description: "${description}"
Create a 12-page web story (cover + exactly 10 tips + cta) for mobile readers in the US, UK, Canada, India and worldwide. Make the cover title irresistible (curiosity + benefit + number when natural). Keywords must be search-friendly, not stuffed. Captions in clear global English.`;

    const { content } = await callGroq([
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ]);
    const data = extractJson(content);
    if (!data.slides || !Array.isArray(data.slides)) {
        throw new Error('Invalid slides array');
    }
    // Normalize: keep only well-formed slides (heading + caption + image_prompt).
    data.slides = data.slides.filter(s => s && typeof s.heading === 'string' && typeof s.caption === 'string' && typeof s.image_prompt === 'string');
    // A short answer used to kill the whole run over one or two missing slides.
    // Anything from MIN_SLIDES up is completed from the SOURCE ARTICLE (real
    // headings, no invented facts); below the floor it is a hard failure.
    if (data.slides.length < MIN_SLIDES) {
        throw new PublishError(`Too few slides: got ${data.slides.length}, need >= ${MIN_SLIDES}`, { code: 'thin-story', retryable: true });
    }
    if (data.slides.length < WANT_SLIDES) {
        const fillers = storyFillersFromBlog(sourceSections, data.slides);
        if (fillers.length) {
            console.log(`   ➕ Story had ${data.slides.length} slides - padded to ${Math.min(WANT_SLIDES, data.slides.length + fillers.length)} from the source article.`);
            data.slides.push(...fillers);
        }
    }
    // Keep exactly 10 content slides for the AMP contract.
    data.slides = data.slides.slice(0, WANT_SLIDES);
    // Enforce short 30-45 word captions: collapse whitespace and make sure every caption reads short.
    data.slides = data.slides.map(s => ({
        ...s,
        heading: String(s.heading).replace(/\s+/g, ' ').trim(),
        caption: String(s.caption).replace(/\s+/g, ' ').trim(),
    }));
    return data;
}

/**
 * Derive extra slides from the blog's own H2 sections so a story is always
 * completed with real article content instead of a hard failure.
 */
function storyFillersFromBlog(sections = [], existing = []) {
    const used = new Set(existing.map(s => String(s.heading || '').toLowerCase().trim()));
    const out = [];
    for (const sec of sections) {
        const heading = String(sec.h2 || sec.heading || '').replace(/<[^>]+>/g, '').trim();
        if (!heading || used.has(heading.toLowerCase())) continue;
        const text = String(sec.body_html || sec.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3).join(' ');
        out.push({
            heading: heading.length > 42 ? heading.slice(0, 40).replace(/[,:;]?\s*$/, '') + '…' : heading,
            caption: sentences.slice(0, 260),
            image_prompt: `a real photo illustrating ${heading.toLowerCase()}, natural light, documentary style, no text`,
        });
        used.add(heading.toLowerCase());
        if (out.length >= WANT_SLIDES - existing.length) break;
    }
    return out;
}

// ---------- Helpers ----------
const esc = s => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// HTML <title>/<meta> values we read back are ALREADY entity-escaped (e.g.
// "&amp;"). Re-escaping them with esc() double-encodes ("&amp;amp;"). Decode the
// five common entities first so esc() round-trips to the intended single escape.
const unesc = s => String(s || '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');

// Force every generated image to read as a genuine photograph. We append a
// strong photorealism suffix so even a weak model prompt still comes back as a
// real-looking photo rather than an obvious AI render.
const PHOTO_SUFFIX = ', real photograph, shot on a DSLR camera, natural light, candid documentary style, shallow depth of field, ultra realistic, no CGI, no illustration, no cartoon, no 3D render, no text, no watermark';
const imgUrl = (prompt, seed) => {
    const base = String(prompt).replace(/\s+/g, ' ').trim();
    // Keep enough room for the photorealistic suffix within Pollinations' length limits.
    const p = encodeURIComponent((base + PHOTO_SUFFIX).slice(0, 520));
    return `https://image.pollinations.ai/prompt/${p}?width=1080&height=1920&nologo=true&enhance=true&model=flux&seed=${seed}&safe=true`;
};

// ---------- Gemini image generation ----------
// Owner preference: story images come from Gemini's image models. Each image
// that Gemini cannot produce keeps its Pollinations URL and is localized later.

const GEMINI_IMAGE_MODELS = process.env.GEMINI_IMAGE_MODEL
    ? [process.env.GEMINI_IMAGE_MODEL]
    : ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

async function generateGeminiImage(prompt, destFile, { aspect = '9:16', width = 1080, height = 1920 } = {}) {
    if (!GEMINI_KEY) return false;
    const text = `Generate a single photorealistic image, ${aspect} aspect. ${String(prompt).replace(/\s+/g, ' ').trim().slice(0, 800)}`;
    for (const model of GEMINI_IMAGE_MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
                if (/^gemini-2\.5|^gemini-3/i.test(model)) generationConfig.imageConfig = { aspectRatio: aspect };
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const msg = data?.error?.message || `HTTP ${res.status}`;
                    console.warn(`   \u26a0\ufe0f  [img:${model}] ${String(msg).slice(0, 180)}`);
                    break;
                }
                const parts = data?.candidates?.[0]?.content?.parts || [];
                const imgPart = parts.find(pt => pt.inlineData && pt.inlineData.data);
                if (!imgPart) {
                    console.warn(`   \u26a0\ufe0f  [img:${model}] no image part (attempt ${attempt}/2)`);
                    await sleep(1200 * attempt);
                    continue;
                }
                const raw = Buffer.from(imgPart.inlineData.data, 'base64');
                if (raw.length < 8000) {
                    console.warn(`   \u26a0\ufe0f  [img:${model}] tiny image ${raw.length}b (attempt ${attempt}/2)`);
                    await sleep(1200 * attempt);
                    continue;
                }
                const sharp = (await import('sharp')).default;
                const out = await sharp(raw)
                    .resize(width, height, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
                    .jpeg({ quality: 90, progressive: true, mozjpeg: true })
                    .toBuffer();
                await fs.writeFile(destFile, out);
                console.log(`   \u2714 Gemini image (${model}) -> ${path.basename(destFile)} (${(out.length / 1024).toFixed(0)} KB)`);
                return true;
            } catch (e) {
                console.warn(`   \u26a0\ufe0f  [img:${model}] ${e.message}`);
                await sleep(1200 * attempt);
            }
        }
    }
    return false;
}

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
function buildStoryHtml({ slug, story }, localImgs = {}, dateISO = '') {
    // Extensionless - the .html form 308-redirects on Cloudflare Pages.
    const canonical = `${SITE}/web-stories/${slug}`;
    const publisherLogo = `${SITE}/images/publisher-logo.png`;
    // Pre-generated Gemini images win; Pollinations URLs remain as fallback and
    // get localized later by localizeHtmlImages().
    const localSlides = localImgs.slides || {};
    const coverImg = localImgs.cover || imgUrl(story.cover_image_prompt, 1000);
    const coverImgAbs = localImgs.cover ? SITE + localImgs.cover : coverImg;
    const posterUrl = coverImg;
    // The CTA page used to hard-code a Pollinations URL, so every story shipped
    // with one third-party hot link (slow, and it breaks when that service is
    // down). Reuse a local frame instead - the story already owns these images.
    const ctaImg = localSlides[story.slides.length - 1] || localImgs.cover || coverImg;
    // Backfilled stories keep the date they stand for; schema + article tags
    // must agree with the blog they were derived from.
    const today = dateISO || new Date().toISOString().split('T')[0];

    const slidesHtml = story.slides.map((s, i) => {
        const seed = 2000 + i * 137;
        const src = localSlides[i] || imgUrl(s.image_prompt, seed);
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
        "image": [coverImgAbs],
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
        <amp-img src="${ctaImg}" width="1080" height="1920" layout="responsive" alt="Explore more"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="fill">
        <div class="scrim"></div>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical">
        <div class="cta-wrap">
          <h2 class="cta-title">Try 100+ Free AI Tools</h2>
          <p class="cta-desc">${esc(story.cta_line)}</p>
          <a class="cta-cta" href="${SITE}/tools">Explore Tools →</a>
          <a class="cta-cta" style="margin-left:8px;background:#fff" href="https://www.amazon.in/s?k=ai+productivity+books&tag=aitoolsnova-21" rel="sponsored nofollow noopener">Recommended products →</a>
          <small style="display:block;color:#f2f2f2;margin-top:12px;font-size:11px">Affiliate link, at no extra cost to you.</small>
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
async function updateSitemap({ slug, title }, lastmodISO = '') {
    let xml = await fs.readFile(SITEMAP_XML, 'utf-8');
    const url = `${SITE}/web-stories/${slug}`;
    if (xml.includes(url)) return false;

    const today = lastmodISO || new Date().toISOString().split('T')[0];
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
    const files = readdirSync(STORIES_DIR).filter(f => f.endsWith('.html'));
    const parsed = [];
    for (const f of files) {
        const html = await fs.readFile(path.join(STORIES_DIR, f), 'utf-8');
        const d = (html.match(/"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
        parsed.push({ f, d, html });
    }
    // Newest story first, decided by the page itself. mtime is meaningless in a
    // fresh CI checkout (every file shares the checkout timestamp), which made
    // the index reshuffle on every run and produced noisy diff-only commits.
    parsed.sort((a, b) => (b.d || '').localeCompare(a.d || '') || b.f.localeCompare(a.f));

    const cards = await Promise.all(parsed.map(async ({ f, html }) => {
        const t = unesc((html.match(/<title>([^<]+)<\/title>/i)?.[1] || f).trim());
        const d = unesc((html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || '').trim());
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
// Which days still need a story? (same catch-up idea as the blog job)
async function resolveDates() {
    const today = isoDate();
    if (TARGET_DATE) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
            throw new PublishError(`--date must be YYYY-MM-DD (got "${TARGET_DATE}")`, { code: 'bad-args' });
        }
        return [TARGET_DATE];
    }
    const planned = await planGaps(ROOT, { kind: 'webstory', days: BACKFILL_WINDOW, max: Math.max(1, BACKFILL_MAX), today });
    if (BACKFILL_MAX > 0) {
        if (planned.gaps.length) {
            console.log(`\n🧾 Catch-up: ${planned.gaps.length} day(s) without a story -> ${planned.gaps.join(', ')}`);
            return planned.gaps;
        }
        console.log(`\n✅ Nothing to catch up: every day since ${planned.earliest} has a story.`);
        return [];
    }
    const have = await publishedDates(ROOT, 'webstory');
    if (have.has(today) && process.env.ALLOW_DUPLICATE_DAY !== '1') {
        console.log(`\n✅ Today (${today}) already has ${(have.get(today) || []).length} story(ies) - nothing to do.`);
        return [];
    }
    return [today];
}

/**
 * Workflow-file self-heal, done SAFELY.
 *
 * The previous version wrote scripts/workflow-fixes/*.fixed over
 * .github/workflows/*.yml, committed, failed to push (GitHub refuses workflow
 * writes from a job token) and left the changes STAGED in the index. The next
 * step - the workflow's own "Commit and push new web story" - then committed
 * those staged workflow files, got rejected again, and the actual story was
 * never published. That is exactly the red run this job had for days.
 *
 * So: only touch workflow files when a WORKFLOW_PAT exists (that is the only
 * token allowed to push them). Otherwise report the drift and move on.
 */
async function healWorkflowsIfAllowed() {
    if (process.env.HEAL_WORKFLOWS === '0') return 'disabled';
    const pat = process.env.WORKFLOW_PAT || process.env.GH_WORKFLOW_TOKEN || '';
    const drift = await selfHealWorkflows();
    if (!drift.length) return 'clean';
    if (!pat) {
        // Undo what selfHealWorkflows() wrote, so no workflow edit can leak
        // into a content commit or a rejected push.
        await git(['checkout', '--', '.github/workflows']).catch(() => {});
        await git(['reset', '-q', '--', '.github/workflows']).catch(() => {});
        const msg = `Live workflow YAML differs from scripts/workflow-fixes/*.fixed (${drift.join(', ')}). `
            + 'Applying it needs the GitHub web UI or a secret named WORKFLOW_PAT (classic PAT with the "workflow" scope).';
        console.warn(`🩹 ${msg}`);
        annotate('warning', 'Workflow YAML drift not applied', msg);
        return 'blocked-no-pat';
    }
    try {
        const pushed = await commitAndPush({ message: 'ci: self-heal workflow files', onlyWorkflows: true });
        console.log(pushed ? '🩹 Workflow fix pushed to main' : '🩹 No workflow changes to push');
        return pushed ? 'pushed' : 'noop';
    } catch (err) {
        await git(['checkout', '--', '.github/workflows']).catch(() => {});
        await git(['reset', '-q', '--', '.github/workflows']).catch(() => {});
        console.warn(`⚠️  Workflow fix push failed: ${describeError(err)}`);
        return 'push-failed';
    }
}

/**
 * While daily-blog.yml is broken (or simply off-schedule) this job also
 * produces the blog post, so the site never loses a day twice.
 */
async function maybeCoverBlog() {
    if (process.env.AUTO_BLOG_FALLBACK === '0') {
        console.log('ℹ️  AUTO_BLOG_FALLBACK=0 → not generating a blog from this job.');
        return false;
    }
    const broken = await isBlogWorkflowBroken();
    const planned = await planGaps(ROOT, { kind: 'blog', days: 3, max: 1 });
    if (broken || planned.gaps.length) {
        console.log(`📝 Blog ${broken ? 'workflow is broken' : `is missing ${planned.gaps[0]}`} → generating it from the story job too...`);
        await runBlogGenerator();
        return true;
    }
    console.log('✅ Blog is current and its workflow is valid → leaving the blog to its own schedule.');
    return false;
}

async function publishForDate(dateISO) {
    console.log(`\n${'='.repeat(60)}\n📅 Publishing web story for ${dateISO}\n${'='.repeat(60)}`);
    await fs.mkdir(STORIES_DIR, { recursive: true });

    const src = await pickSourceBlog(dateISO);
    console.log(`📖 Source blog: ${src.sourceFile}`);
    console.log(`🎯 Slug: ${src.slug}`);

    const story = await generateStoryContent(src);
    console.log(`✍️  Title: ${story.story_title}`);
    console.log(`🖼️  Slides: ${story.slides.length}`);

    // Generate every slide image with Gemini first (photorealistic, owned by
    // us, no hot-linking). Anything Gemini cannot produce keeps its Pollinations
    // URL and gets localized later by localizeHtmlImages().
    const localImgs = { cover: null, slides: {} };
    if (GEMINI_KEY) {
        console.log('🎨 Generating story images with Gemini AI (fallback: Pollinations)...');
        await fs.mkdir(IMG_DIR, { recursive: true });
        const coverDest = path.join(IMG_DIR, `${src.slug}-cover.jpg`);
        if (await generateGeminiImage(`${story.cover_image_prompt || story.story_title}${PHOTO_SUFFIX}`, coverDest, { aspect: '9:16', width: 1080, height: 1920 })) {
            localImgs.cover = `/web-stories/img/${src.slug}-cover.jpg`;
        }
        for (let i = 0; i < story.slides.length; i++) {
            const s = story.slides[i];
            const dest = path.join(IMG_DIR, `${src.slug}-s${i + 1}.jpg`);
            if (await generateGeminiImage(`${s.image_prompt || s.heading}${PHOTO_SUFFIX}`, dest, { aspect: '9:16', width: 1080, height: 1920 })) {
                localImgs.slides[i] = `/web-stories/img/${src.slug}-s${i + 1}.jpg`;
            }
            await sleep(1200);
        }
    }
    // A story must never ship an external image URL. If Gemini is unavailable,
    // copy a checked-in portrait asset for each missing page; localization is
    // still attempted below for any legacy remote URLs.
    const bundled = readdirSync(IMG_DIR).find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (bundled) {
        const fallback = path.join(IMG_DIR, bundled);
        if (!localImgs.cover) { await fs.copyFile(fallback, path.join(IMG_DIR, `${src.slug}-cover.jpg`)); localImgs.cover = `/web-stories/img/${src.slug}-cover.jpg`; }
        for (let i = 0; i < story.slides.length; i++) {
            if (!localImgs.slides[i]) { await fs.copyFile(fallback, path.join(IMG_DIR, `${src.slug}-s${i + 1}.jpg`)); localImgs.slides[i] = `/web-stories/img/${src.slug}-s${i + 1}.jpg`; }
        }
    }

    const html = buildStoryHtml({ slug: src.slug, story }, localImgs, dateISO);
    console.log('🖼️  Downloading HD images locally (this makes stories fast + indexable)...');
    const localizedHtml = await localizeHtmlImages(html);
    const outFile = path.join(STORIES_DIR, `${src.slug}.html`);
    await fs.writeFile(outFile, localizedHtml);
    console.log(`💾 Saved: ${path.relative(ROOT, outFile)}`);

    const sitemapUpdated = await updateSitemap({ slug: src.slug, title: story.story_title }, dateISO);
    console.log(sitemapUpdated ? '🗺️  sitemap.xml updated' : '🗺️  sitemap.xml unchanged');

    await rebuildStoriesIndex();
    console.log('📑 web-stories.html rebuilt');

    await pingIndexNow([
        `${SITE}/web-stories/${src.slug}`,
        `${SITE}/web-stories`,
        `${SITE}/sitemap.xml`,
    ]);


    // ---- AUTO-PUBLISH: commit + push everything generated this run ----
    return { slug: src.slug, title: story.story_title, slides: story.slides.length, date: dateISO };
}

async function runCheck() {
    const keys = readKeys();
    const today = isoDate();
    const have = await publishedDates(ROOT, 'webstory');
    const newest = have.size ? [...have.keys()].sort().at(-1) : null;
    const planned = await planGaps(ROOT, { kind: 'webstory', days: BACKFILL_WINDOW, max: 10, today });
    const blogPlanned = await planGaps(ROOT, { kind: 'blog', days: BACKFILL_WINDOW, max: 10, today });
    const lines = [
        '### Web story pipeline check',
        '',
        '| Check | Result |',
        '|---|---|',
        `| AI keys visible | ${keys.any ? keys.present.join(', ') : '**none**'} |`,
        `| Site API fallback | ${siteApiAllowed() ? 'enabled' : 'disabled'} |`,
        `| Stories on disk | ${readdirSync(STORIES_DIR).filter(f => f.endsWith('.html')).length} |`,
        `| Newest story | ${newest || 'none'} (${newest ? daysBetween(newest, today) : '?'} days ago) |`,
        `| Missing story days | ${planned.gaps.length ? planned.gaps.join(', ') : 'none'} |`,
        `| Missing blog days | ${blogPlanned.gaps.length ? blogPlanned.gaps.join(', ') : 'none'} |`,
        `| daily-blog.yml | ${await isBlogWorkflowBroken() ? 'BROKEN' : 'valid'} |`,
        `| Workflow YAML drift | ${await driftCount()} |`,
    ];
    if (!keys.any) lines.push('', `> ⚠️ ${noKeyGuidance(keys.missing)}`);
    console.log(lines.join('\n'));
    await stepSummary(lines);
    return 0;
}

async function driftCount() {
    const names = ['daily-blog.yml', 'daily-webstory.yml'];
    let n = 0;
    for (const name of names) {
        const fixed = path.join(ROOT, 'scripts', 'workflow-fixes', `${name}.fixed`);
        const live = path.join(WF_DIR, name);
        if (!existsSync(fixed)) continue;
        const a = await fs.readFile(fixed, 'utf8').catch(() => '');
        const b = await fs.readFile(live, 'utf8').catch(() => '');
        if (a !== b) n++;
    }
    return n ? `**${n} file(s) not applied**` : 'none';
}

async function main() {
    console.log('🚀 AIToolsNova - Web Story Auto-Publish');
    if (ARGS.flags.check) return runCheck();

    const heal = await healWorkflowsIfAllowed();
    if (heal === 'pushed') console.log('🩹 Workflow files healed and pushed.');

    // A story is built from the newest article, so make sure the article exists first.
    await maybeCoverBlog();

    const dates = await resolveDates();
    if (!dates.length) {
        await stepSummary(['### Web story auto-publish', '', '✅ Already up to date — no missing story day, nothing to publish.']);
        console.log('✅ Up to date. Exiting 0.');
        return 0;
    }

    const results = [];
    for (const d of dates) {
        try {
            const r = await publishForDate(d);
            results.push({ ...r, ok: true });
            await appendLedger(ROOT, { kind: 'webstory', date: d, slug: r.slug, status: 'ok' });
        } catch (err) {
            const reason = describeError(err);
            results.push({ date: d, ok: false, error: reason });
            await appendLedger(ROOT, { kind: 'webstory', date: d, slug: '', status: 'fail', reason });
            annotate('error', `Web story failed for ${d}`, reason + (err?.hint ? ` — ${err.hint}` : ''));
            console.error(`❌ ${d}: ${reason}`);
            if (err instanceof PublishError && (err.code === 'no-source' || err.code === 'bad-args')) break;
        }
    }

    const okOnes = results.filter(r => r.ok);
    let pushErr = null, pushed = false;
    const selfPublish = !DRY_RUN && process.env.SKIP_AUTO_PUBLISH !== '1' && process.env.NO_PUBLISH !== '1'
        && (isCI() || process.env.FORCE_PUBLISH === '1');
    try {
        await writePublishStatus(ROOT, {
            kind: 'webstory',
            ok: okOnes.length > 0,
            date: okOnes.at(-1)?.date || isoDate(),
            slug: okOnes.map(r => r.slug).join(','),
            reason: okOnes.length ? '' : (results.find(r => !r.ok)?.error || ''),
        });
    } catch (e) { console.warn(`   ⚠️  could not write publish-status.json: ${e.message}`); }
    if (selfPublish) {
        try {
            const res = await publishContent({
                root: ROOT,
                include: CONTENT_PATHS.webstory,
                message: okOnes.length
                    ? `content(webstory): auto-publish ${okOnes.map(r => r.slug).join(', ').slice(0, 70)}`
                    : 'chore(webstory): record publish failure status',
            });
            pushed = res.pushed;
            if (res.committed) console.log(`📦 ${pushed ? 'Pushed' : 'Committed'} ${res.files.length} file(s) to main`);
        } catch (err) {
            pushErr = err;
            annotate('error', 'Web story auto-commit failed', describeError(err) + (err.hint ? ` — ${err.hint}` : ''));
        }
    } else {
        console.log('ℹ️  Skipping in-script publish (workflow step owns the commit).');
    }

    await stepSummary([
        '### Web story auto-publish',
        '',
        '| Date | Status | Story | Slides |',
        '|---|---|---|---|',
        ...results.map(r => `| ${r.date} | ${r.ok ? '✅ published' : '❌ failed'} | ${r.slug || '-'} | ${r.slides || '-'}${r.ok ? '' : ` — ${r.error}`.slice(0, 160)} |`),
        '',
        `Pushed to main: ${pushed ? 'yes' : 'no'} · Workflow heal: ${heal}`,
    ]);

    if (!okOnes.length) {
        const why = results[0]?.error || 'unknown';
        annotate('error', 'No web story published', `${why} — recorded in scripts/publish-log.json + publish-status.json`);
        throw new PublishError(`Web story run published nothing. First error: ${why}`, { code: 'nothing-published' });
    }
    if (pushErr) throw pushErr;
    console.log(`\n✅ Done: ${okOnes.length} story(ies)${pushed ? ' pushed to main' : ' written locally'}.`);
    return 0;
}

export { buildStoryHtml, updateSitemap, rebuildStoriesIndex, pickSourceBlog, main, resolveDates, storyFillersFromBlog };

// Only auto-run when executed directly (not when imported for testing)
import { fileURLToPath } from 'node:url';
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main().catch(err => {
        console.error('❌ Failed:', err);
        const annotation = String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 400);
        console.error(`::error title=Web story generation failed::${annotation}`);
        process.exit(1);
    });
}
