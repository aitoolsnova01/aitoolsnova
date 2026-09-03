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
 * Env vars (at least ONE AI key required):
 *   GROQ_API_KEY      - free: https://console.groq.com/keys
 *   GEMINI_API_KEY    - free: https://aistudio.google.com/apikey  (used when Groq hits limit)
 *   DEEPSEEK_API_KEY  - https://platform.deepseek.com (used when Groq/Gemini fail)
 * Optional:
 *   GROQ_MODEL / GEMINI_MODEL / INDEXNOW_KEY
 *
 * Run:  node scripts/generate-blog.mjs
 */

import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import {
    readKeys, noKeyGuidance, annotate, stepSummary, describeError, PublishError,
    parseJsonLoose, isTransientStatus, fetchWithTimeout, retry as withRetry,
    isoDate, addDays, daysBetween, readLedger, appendLedger, planGaps, publishedDates,
    publishContent, writePublishStatus, visibleWords, isCI, parseArgs, dedupeBy,
    callSiteApi, siteApiAllowed, CONTENT_PATHS,
} from './lib/publish-core.mjs';

const ROOT = path.resolve(process.env.REPO_ROOT || process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const BLOGS_HTML = path.join(ROOT, 'blogs.html');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');
const HISTORY_FILE = path.join(ROOT, 'scripts', 'topic-history.json');

// ---- CLI + quality knobs -------------------------------------------------
//   node scripts/generate-blog.mjs                      publish today
//   node scripts/generate-blog.mjs --backfill=3         fill up to 3 missing days
//   node scripts/generate-blog.mjs --date=2026-08-24    one specific day
//   node scripts/generate-blog.mjs --dry-run            generate, write nothing to git
//   node scripts/generate-blog.mjs --check              diagnostics only
const ARGS = parseArgs();
const DRY_RUN = ARGS.bool('dry-run', process.env.DRY_RUN === '1');
const FORCE = ARGS.bool('force', false);
const BACKFILL_MAX = ARGS.num('backfill', process.env.BACKFILL_MAX ? Number(process.env.BACKFILL_MAX) : 0);
const TARGET_DATE = ARGS.get('date', process.env.PUBLISH_DATE || '') || '';
const COUNT = Math.max(1, ARGS.num('count', 1));
// Quality bar. A hard 1500-word gate with a 4500-token cap is how a run dies
// every single day while the job still looks green: the model simply cannot
// return that much in one reply. Target stays high, the floor is where we
// actually stop, and expansion passes bridge the gap.
const MIN_WORDS = Number(process.env.MIN_WORDS || 1000);
const TARGET_WORDS = Number(process.env.TARGET_WORDS || 1600);
const MIN_SECTIONS = Number(process.env.MIN_SECTIONS || 5);
const EXPANSION_PASSES = Number(process.env.EXPANSION_PASSES || 3);
const CONTENT_ATTEMPTS = Number(process.env.CONTENT_ATTEMPTS || 3);

// Download the hero image locally so blog pages load fast (no slow live
// hot-linking). Visible <img> uses a root-relative path (works in preview +
// production); social/schema tags get the absolute URL (required by FB/Twitter).
const SITE_URL = process.env.SITE_URL || 'https://aitoolsnova.com';
async function localizeBlogHero(html) {
    const re = /https?:\/\/image\.pollinations\.ai\/prompt\/[^"'\\\s)]+/g;
    const urls = [...new Set(html.match(re) || [])];
    if (!urls.length) return html;
    const IMG = path.join(BLOG_DIR, 'img');
    await fs.mkdir(IMG, { recursive: true });
    // Google Discover only surfaces images at least 1200px wide. Pollinations
    // returns 1024px, so every hero image needs a lift.
    async function upscaleForDiscover(file) {
        try {
            const sharp = (await import('sharp')).default;
            const meta = await sharp(file).metadata();
            // Always normalize heroes to crisp 1600x900 for Discover + social
            if ((meta.width || 0) >= 1600 && (meta.height || 0) >= 900 && (await import('node:fs')).statSync(file).size > 80000) return;
            const out = await sharp(file)
                .resize(1600, 900, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
                .sharpen({ sigma: 0.5 })
                .jpeg({ quality: 92, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
                .toBuffer();
            await fs.writeFile(file, out);
            console.log(`   \u2191 upscaled ${path.basename(file)} to 1600x900 for Discover`);
        } catch (e) {
            console.warn(`   \u26a0\ufe0f  Discover upscale skipped for ${path.basename(file)} - ${e.message}`);
        }
    }

    for (const u of urls) {
        const name = crypto.createHash('md5').update(u).digest('hex').slice(0, 16) + '.jpg';
        const dest = path.join(IMG, name);
        let ok = existsSync(dest);
        if (!ok) {
            try {
                const res = await fetchWithTimeout(u, {}, 30_000);
                if (res.ok) {
                    const b = Buffer.from(await res.arrayBuffer());
                    if (b.length > 1500) {
                        await fs.writeFile(dest, b);
                        await upscaleForDiscover(dest);
                        ok = true;
                    }
                }
            } catch { /* keep remote on failure */ }
        }
        if (ok) {
            html = html.split(`src="${u}"`).join(`src="/blog/img/${name}"`);
            html = html.split(u).join(`${SITE_URL}/blog/img/${name}`);
        }
    }
    return html;
}
const KEYS = readKeys();
const GROQ_KEY = KEYS.groq;
const DEEPSEEK_KEY = KEYS.deepseek;
const GEMINI_KEY = KEYS.gemini;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
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
// Free-tier safe order (2026): smaller models first so prompt+completion stays under ~8k TPM.
// llama-3.3-70b-versatile was removed from many free orgs (404 model_not_found).
// Verified against the Groq catalogue on 2026-08-18. Removed:
//   gemma2-9b-it            -> decommissioned (400)
//   llama-3.1-8b-instant    -> no longer on this org's free tier (404)
//   llama-3.3-70b-versatile -> retired
// Larger models are listed first: on an 8000 TPM free tier a long article is a
// single big request, so a bigger model with one clean pass beats a small model
// that needs three retries and burns the same budget.
const MODELS = process.env.GROQ_MODEL
    ? [process.env.GROQ_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']
    : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct'];
// Any model that 404s here is simply skipped, so the list may be generous.
for (const extra of ['llama-3.3-70b-versatile']) {
    if (process.env.GROQ_MODELS_EXTRA?.split(',').includes(extra) && !MODELS.includes(extra)) MODELS.push(extra);
}

if (!KEYS.any) {
    // Historically this was `process.exit(1)`, which - combined with
    // `continue-on-error: true` in .github/workflows/daily-blog.yml - produced
    // a GREEN run that published nothing for days. Now: say exactly what is
    // missing, record it in the ledger + publish-status.json, and only give up
    // if even the site's own /api/gemini proxy cannot be used.
    annotate('warning', 'No AI key in GitHub secrets', noKeyGuidance(KEYS.missing));
    console.warn(`⚠️  ${noKeyGuidance(KEYS.missing)}`);
    if (!siteApiAllowed()) {
        annotate('error', 'No AI key and no fallback', `${noKeyGuidance(KEYS.missing)} SITE_API_FALLBACK=0 disables the site API fallback.`);
        await failFast('no-ai-key', noKeyGuidance(KEYS.missing));
    }
    console.warn('   → Falling back to the site API (https://aitoolsnova.com/api/gemini). It uses the same keys the site tools already use, so daily publishing continues.');
}
console.log(`🔑 Providers: Groq=${GROQ_KEY ? 'yes' : 'no'}  Gemini=${GEMINI_KEY ? 'yes' : 'no'}  DeepSeek=${DEEPSEEK_KEY ? 'yes' : 'no'}  SiteAPI=${siteApiAllowed() ? 'yes' : 'no'}`);

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

// ---------- 3. Multi-provider AI (Groq → Gemini → DeepSeek) ----------
// Groq free tier often hits 8k TPM / 413. When that happens we automatically
// continue on Gemini, then DeepSeek, so daily publish does not die.

/**
 * Groq completions.
 * The old code clamped max_tokens to 4500, so a 1600-word article arrived as
 * truncated JSON ("no valid JSON") and the whole day's post died. Now the
 * requested budget is honoured and, if the model rejects it, it steps down a
 * ladder instead of giving up.
 */
const TOKEN_LADDER = [8000, 6000, 4500, 3000, 2000];
async function callGroqOnly(messages, opts = {}) {
    if (!GROQ_KEY) return null;
    const modelsToTry = opts.singleModel ? [opts.singleModel] : MODELS;
    const wanted = Math.max(1024, Math.min(opts.max_tokens ?? 4096, 8000));
    const ladder = [wanted, ...TOKEN_LADDER.filter(t => t < wanted)];
    let lastErr = null;
    for (const model of modelsToTry) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const maxTokens = ladder[Math.min(attempt - 1, ladder.length - 1)];
            try {
                const body = {
                    model,
                    messages,
                    temperature: opts.temperature ?? 0.7,
                    max_tokens: maxTokens
                };
                if (model.includes('gpt-oss')) body.reasoning_effort = 'low';
                if (opts.json === true) body.response_format = { type: 'json_object' };
                const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    timeoutMs: opts.timeoutMs ?? 120_000,
                });
                if (!res.ok) {
                    const errText = await res.text().catch(() => '');
                    lastErr = new Error(`[groq:${model}] ${res.status}: ${errText.slice(0, 220)}`);
                    if (isTransientStatus(res.status)) {
                        console.warn(`   ⚠️  ${lastErr.message} (retry ${attempt}/2)`);
                        await sleep(attempt * 2500);
                        continue;
                    }
                    // max_tokens above the model's limit -> shrink and retry once
                    if (/max_tokens|context length|too long|maximum|tokens/i.test(errText) && attempt === 1 && maxTokens > 2000) {
                        console.warn(`   ⚠️  [groq:${model}] token budget rejected, stepping down to ${ladder[1]} tokens`);
                        continue;
                    }
                    // 413 TPM / 404 missing model → next model
                    console.warn(`   ⚠️  ${lastErr.message} — next Groq model`);
                    break;
                }
                const data = await res.json();
                const content = data.choices?.[0]?.message?.content?.trim() || '';
                if (!content) {
                    lastErr = new Error(`[groq:${model}] empty response`);
                    continue;
                }
                if (attempt > 1 || model !== modelsToTry[0]) console.log(`   ✔ Groq model: ${model}`);
                return content;
            } catch (err) {
                lastErr = err;
                console.warn(`   ⚠️  [groq:${model}] ${describeError(err)}`);
                await sleep(attempt * 1500);
            }
        }
    }
    if (lastErr) console.warn(`   ⚠️  Groq exhausted: ${describeError(lastErr)}`);
    return null;
}

/** Site proxy (functions/api/gemini.js) - used when no key is visible here. */
async function callSiteApiOnly(messages, opts = {}) {
    if (!siteApiAllowed()) return null;
    const flat = (messages || []).map(m => `${m.role === 'system' ? 'SYSTEM' : m.role === 'assistant' ? 'ASSISTANT' : 'USER'}:\n${m.content}`).join('\n\n');
    try {
        const { content, provider } = await callSiteApi(flat, {
            tool: opts.tool || (opts.json === true ? 'seo' : 'writer'),
            timeoutMs: opts.timeoutMs ?? 120_000,
        });
        console.log(`   ✔ Site API (${provider})`);
        return content;
    } catch (err) {
        console.warn(`   ⚠️  [siteapi] ${describeError(err)}`);
        return null;
    }
}

async function callGeminiOnly(messages, opts = {}) {
    if (!GEMINI_KEY) return null;
    try {
        const sys = messages.find(m => m.role === 'system');
        const turns = messages.filter(m => m.role !== 'system');
        // Flatten chat into Gemini contents; prepend system as first user turn if needed
        const contents = [];
        if (sys) {
            contents.push({ role: 'user', parts: [{ text: `SYSTEM INSTRUCTIONS:\n${sys.content}` }] });
            contents.push({ role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] });
        }
        for (const m of turns) {
            contents.push({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content || '') }]
            });
        }
        // Prefer a single user message path when only one user turn (common for our JSON jobs)
        const body = {
            contents,
            generationConfig: {
                temperature: opts.temperature ?? 0.7,
                maxOutputTokens: Math.max(1024, Math.min(opts.max_tokens ?? 4096, 16_000)),
                topP: 0.9,
            }
        };
        if (opts.json === true) {
            body.generationConfig.responseMimeType = 'application/json';
        }
        if (sys && opts.json === true) {
            // Also pass systemInstruction when supported
            body.systemInstruction = { parts: [{ text: sys.content }] };
            // Remove the synthetic system turns to avoid duplication
            body.contents = turns.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content || '') }]
            }));
            if (!body.contents.length) {
                body.contents = [{ role: 'user', parts: [{ text: messages[messages.length - 1]?.content || '' }] }];
            }
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: opts.timeoutMs ?? 120_000,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || JSON.stringify(data).slice(0, 220);
            console.warn(`   ⚠️  [gemini:${GEMINI_MODEL}] ${res.status}: ${msg}`);
            // fallback model name once
            if (String(GEMINI_MODEL).includes('flash-latest')) {
                const alt = 'gemini-2.0-flash';
                console.warn(`   ⚠️  Retrying Gemini with ${alt}...`);
                const url2 = `https://generativelanguage.googleapis.com/v1beta/models/${alt}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
                const res2 = await fetchWithTimeout(url2, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    timeoutMs: opts.timeoutMs ?? 120_000,
                });
                const data2 = await res2.json().catch(() => ({}));
                if (!res2.ok) {
                    console.warn(`   ⚠️  [gemini:${alt}] ${res2.status}: ${data2?.error?.message || ''}`);
                    return null;
                }
                const reply2 = data2?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
                if (reply2) {
                    console.log(`   ✔ Gemini model: ${alt}`);
                    return reply2;
                }
            }
            return null;
        }
        const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
        if (!reply) {
            console.warn('   ⚠️  [gemini] empty response');
            return null;
        }
        console.log(`   ✔ Gemini model: ${GEMINI_MODEL}`);
        return reply;
    } catch (e) {
        console.warn(`   ⚠️  [gemini] network: ${e.message}`);
        return null;
    }
}

async function callDeepSeekOnly(messages, opts = {}) {
    if (!DEEPSEEK_KEY) return null;
    try {
        const body = {
            model: 'deepseek-chat',
            messages,
            temperature: opts.temperature ?? 0.7,
            max_tokens: Math.max(1024, Math.min(opts.max_tokens ?? 4096, 8000)),
        };
        if (opts.json === true) body.response_format = { type: 'json_object' };
        const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: opts.timeoutMs ?? 120_000,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            console.warn(`   ⚠️  [deepseek] ${res.status}: ${t.slice(0, 200)}`);
            return null;
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
            console.warn('   ⚠️  [deepseek] empty response');
            return null;
        }
        console.log('   ✔ DeepSeek model: deepseek-chat');
        return content;
    } catch (e) {
        console.warn(`   ⚠️  [deepseek] network: ${e.message}`);
        return null;
    }
}

/** Unified completion: Groq chain → Gemini → DeepSeek */
async function callAI(messages, opts = {}) {
    const order = [];
    // Prefer Gemini first if env AI_PROVIDER_ORDER=gemini,groq,deepseek
    // Owner preference: DeepSeek writes first (human-style prose), then Gemini,
    // then Groq. Override with AI_PROVIDER_ORDER env if ever needed.
    const pref = String(process.env.AI_PROVIDER_ORDER || 'deepseek,gemini,groq')
        .toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (const name of pref) {
        if (name === 'groq' && GROQ_KEY) order.push('groq');
        if (name === 'gemini' && GEMINI_KEY) order.push('gemini');
        if (name === 'deepseek' && DEEPSEEK_KEY) order.push('deepseek');
    }
    // ensure all available providers are tried
    for (const n of ['groq', 'gemini', 'deepseek']) {
        if (!order.includes(n)) {
            if (n === 'groq' && GROQ_KEY) order.push(n);
            if (n === 'gemini' && GEMINI_KEY) order.push(n);
            if (n === 'deepseek' && DEEPSEEK_KEY) order.push(n);
        }
    }

    // The site's own proxy works even with zero Actions secrets (it holds the
    // keys + a zero-config Cloudflare Workers AI binding). On a keyless runner
    // it is the ONLY viable path, so put it first instead of last.
    if (siteApiAllowed()) order.push('siteapi');
    if (!GROQ_KEY && !GEMINI_KEY && !DEEPSEEK_KEY) {
        order.sort((a, b) => (a === 'siteapi' ? -1 : b === 'siteapi' ? 1 : 0));
    }

    let lastErr = null;
    for (const provider of order) {
        let content = null;
        if (provider === 'groq') content = await callGroqOnly(messages, opts);
        else if (provider === 'gemini') content = await callGeminiOnly(messages, opts);
        else if (provider === 'deepseek') content = await callDeepSeekOnly(messages, opts);
        else if (provider === 'siteapi') content = await callSiteApiOnly(messages, opts);
        if (content) return content;
        lastErr = new Error(`${provider} failed`);
        console.warn(`   ↩︎  ${provider} unavailable — trying next provider...`);
    }
    throw lastErr || new Error('All AI providers failed (Groq / Gemini / DeepSeek / site API).');
}

// Back-compat alias used elsewhere in this file
async function callGroq(messages, opts = {}) {
    return callAI(messages, opts);
}

// JSON-validated call with parse fallback across providers/models.
// Owner preference: DeepSeek writes first, then Gemini, then Groq.
// Override the order with AI_PROVIDER_ORDER env.
async function callGroqForJson(messages, opts = {}) {
    let lastErr = null;
    const pref = String(process.env.AI_PROVIDER_ORDER || 'deepseek,gemini,groq')
        .toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (const n of ['deepseek', 'gemini', 'groq']) if (!pref.includes(n)) pref.push(n);
    if (siteApiAllowed() && !pref.includes('siteapi')) pref.push('siteapi');
    // When this job has NO direct provider key, the only working path is the
    // site API (which holds the keys + the zero-config Cloudflare Workers AI
    // binding). Try it FIRST instead of wasting calls on providers that cannot
    // possibly answer — this turns "all providers failed" into a successful
    // auto-publish on a keyless runner.
    if (!GROQ_KEY && !GEMINI_KEY && !DEEPSEEK_KEY && siteApiAllowed()) {
        pref.sort((a, b) => (a === 'siteapi' ? -1 : b === 'siteapi' ? 1 : 0));
    }

    const tryProvider = async (provider) => {
        if (provider === 'deepseek' && DEEPSEEK_KEY) {
            try {
                const reply = await callDeepSeekOnly(messages, opts);
                if (reply) {
                    try { return { reply, parsed: extractJson(reply), model: 'deepseek-chat' }; }
                    catch (parseErr) {
                        lastErr = new Error(`[deepseek] JSON parse failed: ${parseErr.message}`);
                        console.warn(`   \u26a0\ufe0f  ${lastErr.message}`);
                    }
                } else {
                    // callDeepSeekOnly already warned with the HTTP status; keep the
                    // ledger honest instead of the old "invalid JSON" misdirection.
                    lastErr = new Error('[deepseek] no usable reply (see the ⚠️ status line above — usually 401 invalid key, 402 insufficient balance, or a timeout)');
                }
            } catch (e) { lastErr = e; }
        }
        if (provider === 'gemini' && GEMINI_KEY) {
            try {
                const reply = await callGeminiOnly(messages, opts);
                if (reply) {
                    try { return { reply, parsed: extractJson(reply), model: `gemini:${GEMINI_MODEL}` }; }
                    catch (parseErr) {
                        lastErr = new Error(`[gemini] JSON parse failed: ${parseErr.message}`);
                        console.warn(`   \u26a0\ufe0f  ${lastErr.message}`);
                    }
                } else {
                    lastErr = new Error('[gemini] no usable reply (see the ⚠️ status line above — invalid key / quota / network)');
                }
            } catch (e) { lastErr = e; }
        }
        if (provider === 'siteapi') {
            const reply = await callSiteApiOnly(messages, opts);
            if (reply) {
                try { return { reply, parsed: parseJsonLoose(reply).data, model: 'siteapi' }; }
                catch (parseErr) {
                    lastErr = new Error(`[siteapi] JSON parse failed: ${parseErr.message}`);
                    console.warn(`   \u26a0\ufe0f  ${lastErr.message}`);
                }
            } else {
                // The site proxy should work keyless via the Workers AI binding — if it
                // stays silent either the `AI` binding is missing in the Pages project
                // or the edge/WAF blocked this datacenter request (e.g. 403).
                lastErr = new Error('[siteapi] no reply from /api/gemini (Workers AI binding `AI` missing on the Pages project, or the request was blocked at the edge — see ⚠️ line above)');
            }
            return null;
        }
        if (provider === 'groq' && GROQ_KEY) {
            for (const model of MODELS) {
                try {
                    const reply = await callGroqOnly(messages, { ...opts, singleModel: model });
                    if (!reply) continue;
                    try { return { reply, parsed: extractJson(reply), model: `groq:${model}` }; }
                    catch (parseErr) {
                        lastErr = new Error(`[groq:${model}] JSON parse failed: ${parseErr.message}`);
                        console.warn(`   \u26a0\ufe0f  ${lastErr.message}`);
                    }
                } catch (e) { lastErr = e; }
            }
            if (!lastErr) lastErr = new Error('[groq] every configured model rejected the request (see ⚠️ lines above)');
        }
        return null;
    };

    for (const provider of pref) {
        const result = await tryProvider(provider);
        if (result) return result;
        console.warn(`   \u21a9\ufe0e  ${provider} gave no valid JSON - trying next provider...`);
    }

    throw lastErr || new Error('All providers failed to return valid JSON');
}

// ---------- 3c. Gemini image generation ----------

const GEMINI_IMAGE_MODELS = process.env.GEMINI_IMAGE_MODEL
    ? [process.env.GEMINI_IMAGE_MODEL]
    : ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

/**
 * Generate one image with a Gemini image model and save it to destFile,
 * normalized with sharp to an exact JPEG size (Discover/social friendly).
 * Returns true on success; false means the caller should fall back to the
 * Pollinations URL flow (which still gets localized after page build).
 */
async function generateGeminiImage(prompt, destFile, { aspect = '16:9', width = 1600, height = 900 } = {}) {
    if (!GEMINI_KEY) return false;
    const text = `Generate a single photorealistic image, ${aspect} aspect. ${String(prompt).replace(/\s+/g, ' ').trim().slice(0, 800)}`;
    for (const model of GEMINI_IMAGE_MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
                // imageConfig.aspectRatio only exists on the newer image models
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
                    break; // 4xx/5xx on this model -> try the next model
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

// ---------- 3b. Robust JSON extractor ----------
/**
 * Delegates to publish-core's parser, which additionally REPAIRS a reply that
 * was cut off by the provider's token limit. That case is the normal failure
 * mode of long-form generation on a free tier, and previously it killed the
 * whole day's post with "Unbalanced JSON braces in reply".
 */
function extractJson(reply) {
    return parseJsonLoose(reply).data;
}

// ---------- 4. Generate unique topic ----------
async function generateTopic(existingTitles, history) {
    const existingSlugs = [];
    try {
        const files = await fs.readdir(BLOG_DIR);
        files.filter(f => f.endsWith('.html')).forEach(f => existingSlugs.push(f.replace('.html', '')));
    } catch {}
    // Keep avoid list small enough to stay under context / prompt-budget
    const avoidList = [...existingTitles, ...history.topics].slice(-25);
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
        'AI for customer support and chatbots',
        'AI tools that actually make money online',
        'Best AI tools for digital marketing agencies',
        'AI automation for busy entrepreneurs',
        'High-income AI side hustles for 2026',
        'AI tools for real estate marketing',
        'AI tools for Amazon & Shopify sellers',
        'AI video editing and faceless YouTube channels',
        'AI resume, cover letter and job-hunt tools',
        'No-code AI apps anyone can build',
        'AI agents and autonomous workflows explained',
        'Best AI tools compared: free vs paid (worth it?)',
        'AI for finance, budgeting and investing helpers',
        'AI productivity hacks that save 10+ hours a week',
        'AI tools for teachers and online course creators',
        'AI social media growth and viral content tools',
        'AI writing tools for authors and newsletter creators',
        'AI photo editing and product photography tools',
        'AI tools for freelancers in India (pricing in INR)',
        'Best AI tools for small businesses in USA',
        'AI tools for students in India - free options',
        'AI side hustles for UK freelancers',
        'AI tools for Canadian content creators',
        'AI marketing tools for Australian small business',
        'Free AI tools popular in India vs USA compared',
        'AI tools for Dubai and UAE entrepreneurs',
        'AI tools for remote workers in Southeast Asia',
        'Best AI tools for Nigerian and African startups',
        'Underrated AI tools nobody is talking about yet',
        'AI tools in regional Indian languages (Hindi, Tamil, Telugu, Bengali)',
        'AI for WhatsApp Business automation and catalogs',
        'AI tools for government exam (UPSC, SSC, banking) prep',
        'AI for local trades and small shops (plumbers, electricians, salons)',
        'AI tools for gig workers (delivery, ride-share, freelancing)',
        'AI tools for Indian farmers (crop, weather, mandi prices)',
        'Offline AI tools that need no signup or account',
        'Free vs paid AI tools: honest head-to-head comparisons',
        'AI for regional language voice content (Marathi, Kannada, Gujarati)',
        'AI auto-reply for WhatsApp Business in India',
        'AI study planners for competitive exams and scholarships',
        'AI for street vendors and kirana store billing/inventory',
        'AI resume builders for freshers in tier-2/3 Indian cities',
        'AI tools for truck drivers, cab drivers and logistics helpers',
        'Best no-internet AI tools for low-data smartphone users'
    ];
    const niche = NICHES[Math.floor(Math.random() * NICHES.length)];

    const prompt = `You are an editorial director for AIToolsNova, a blog about free AI tools.

Suggest ONE unique, engaging, evergreen blog post title for the niche: "${niche}".

STRICT RULES:
1. Do NOT repeat or paraphrase any of these EXISTING titles (case-insensitive, semantic match too):
${avoidList.map(t => '- ' + t).join('\n')}

2. Title must:
   - MUST be 45-58 characters INCLUDING spaces (Google truncates past ~60; the site appends no brand suffix)
   - Include a number, power word, or curiosity gap that makes people NEED to click
   - Feel fresh and on-trend for a worldwide audience (a "2026 / latest" angle is a plus)
   - Lean towards high-interest, high-value angles (money-making, saving time, "best/free tools", comparisons) that people actively search for
   - Be genuinely useful, not empty clickbait
   - NOT reference specific unverified news/rumors as facts
   - NOT mention any specific individual person's private life

3. Also suggest:
   - A short slug (lowercase-hyphen-separated, 3-6 words, .html suffix not needed)
   - A category from: "ai", "seo", "social", "productivity", "coding", "image", "writing"
   - A single emoji that visually represents the topic
   - A concise "hero_prompt": 6-12 word visual description for a hero image, describing a REAL photo (e.g. "a person working on a laptop at a bright desk, real photo")
   - "primary_keyword": the exact main search phrase people type (3-6 words, high intent)
   - "geo": ONE target region for this post - pick from "India","USA","UK","Canada","Australia","UAE","Global"
   - "geo_keywords": 5 comma-separated location-flavoured long-tail keywords using that region (e.g. "best free ai tools in india", "ai tools for indian students")
   - "unique_angle": ONE punchy sentence describing the fresh, under-covered angle this specific post will take (e.g. "tested 5 free Hindi AI tools on a Rs 7,000 phone, ranked by real offline usefulness"). This angle must drive the whole article.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "title": "...",
  "slug": "...",
  "category": "...",
  "emoji": "...",
  "hero_prompt": "...",
  "primary_keyword": "...",
  "geo": "...",
  "geo_keywords": "...",
  "unique_angle": "ONE punchy sentence on the fresh, under-covered angle this post takes (e.g. 'tested 5 free Hindi AI tools on a Rs 7,000 phone, ranked by real offline usefulness'). This angle must drive the whole article."
}`;

    const { reply, parsed: raw, model } = await callGroqForJson(
        [{ role: 'user', content: prompt }],
        { temperature: 0.9, max_tokens: 800, json: true }
    );
    const parsed = raw;
    if (!parsed.title || !parsed.slug) throw new Error('Topic JSON missing title/slug: ' + JSON.stringify(parsed));
    parsed.slug = parsed.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (existingSlugs.includes(parsed.slug)) parsed.slug = parsed.slug + '-guide';
    if (!parsed.hero_prompt) parsed.hero_prompt = parsed.title;
    if (!parsed.emoji) parsed.emoji = '🤖';
    if (!parsed.primary_keyword) parsed.primary_keyword = parsed.title.toLowerCase();
    if (!parsed.geo) parsed.geo = 'Global';
    if (!parsed.geo_keywords) parsed.geo_keywords = `best ai tools ${parsed.geo}, free ai tools ${parsed.geo}, ai tools for beginners ${parsed.geo}`;
    if (!parsed.category) parsed.category = 'ai';
    if (!parsed.unique_angle) parsed.unique_angle = `A fresh, hands-on take on ${parsed.title}`;
    console.log(`   ✔ Topic generated by: ${model}`);
    return parsed;
}

// ---------- 5. Generate full blog content ----------
async function generateContent(topic) {
    // Build the list of real existing slugs so internal links never 404
    let existingSlugList = '';
    try {
        const files = await fs.readdir(BLOG_DIR);
        existingSlugList = files.filter(f => f.endsWith('.html'))
            .map(f => '- ' + f.replace('.html', ''))
            .slice(0, 12).join('\n');
    } catch { existingSlugList = '- best-free-ai-tools-2026\n- ai-trends-2026'; }

        const prompt = `You are an experienced human writer who personally tests free AI tools and writes hands-on guides for AIToolsNova (a free AI tools blog). You write like a real person sharing what they actually tried — never like a content mill or a corporate AI.

Write ONE original article as STRICT JSON only (no markdown fences).

Topic: "${topic.title}"
Category: ${topic.category}
Primary keyword: "${topic.primary_keyword}"
Region angle: ${topic.geo}
Geo keywords: ${topic.geo_keywords}
Unique angle (this MUST drive the whole article): ${topic.unique_angle}

WRITING VOICE (most important — make it read as HUMAN, not AI):
- Use contractions (you'll, it's, don't, we've) and a natural, slightly informal tone.
- Vary sentence length: mix short punchy sentences with longer ones.
- Write in first/second person where natural ("I tested...", "you'll notice...", "here's what surprised me").
- Include small concrete specifics: a realistic step, a trade-off, a "gotcha", a personal opinion. No generic filler that could fit any other article.
- NEVER use these AI-tell phrases or their variants: "In today's digital world/landscape", "delve", "furthermore", "moreover", "it's important to note", "in conclusion", "game-changer", "unlock your potential", "leverage", "elevate", "seamlessly", "cutting-edge", "revolutionize", "in the realm of", "a testament to". Do NOT start the article with "In today's...".
- Do not pad with the same sentence rephrased. Every paragraph must add new information.
- No fake statistics, no fabricated user testimonials, no guaranteed income/rankings.

REQUIREMENTS:
- Simple clear English (global US/UK/CA/India readers).
- Fresh angle, written from a first-person "I actually tried this" perspective.
- Body ~1900-2400 words total across intro+sections+conclusion.
- Exactly 6 H2 sections (benefit-driven titles, no clickbait). The section set MUST include: (a) a hands-on walkthrough with real numbers, steps, and named tools; (b) an honest "Downsides / when it's NOT worth it" section; (c) a "Comparison verdict" section that picks a clear winner.
- Exactly 5 FAQs (question phrasing a real person would type).
- 3 internal links using ONLY these slugs:
${existingSlugList || '- best-free-ai-tools-2026'}
- 2 affiliate_picks with real product-style names + amazon_query + flipkart_query.

JSON shape:
{
  "meta_description": "140-158 chars with primary keyword, natural sentence",
  "meta_keywords": "8-12 comma keywords",
  "read_time_min": 7,
  "intro_html": "<p><strong>Hook.</strong> ...</p><h3>Quick Takeaways</h3><ul><li>...</li></ul>",
  "sections": [{"h2":"...","body_html":"<p>...</p>"}],
  "faqs": [{"q":"...","a":"..."}],
  "conclusion_html": "<p>...</p>",
  "internal_links": [{"anchor":"...","slug":"..."}],
  "affiliate_picks": [{"name":"...","why":"...","amazon_query":"...","flipkart_query":"..."}],
  "related_tools": ["ai-chat","ai-writer","ai-image-generator"],
  "related_blogs": ["best-free-ai-tools-2026","ai-productivity-tools"]
}

HTML only: p ul ol li strong em h3. No script/style. Return ONLY JSON.`;

    const { parsed: raw, model } = await callGroqForJson(
        [{ role: 'user', content: prompt }],
        { temperature: 0.7, max_tokens: 6500, json: true }
    );
    const parsed = raw;
    console.log(`   ✔ Content generated by: ${model}`);
    // Defensive defaults
    parsed.meta_description = parsed.meta_description || `Learn about ${topic.title} with AIToolsNova — free, expert-backed guide.`;
    parsed.meta_keywords = parsed.meta_keywords || 'ai tools, free ai, ai guide, aitoolsnova';
    // Dedupe keywords to avoid Google spam signals from stuffed meta keywords
    {
        const parts = [parsed.meta_keywords, topic.primary_keyword, topic.geo_keywords]
            .filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean);
        const seen = new Set();
        const uniq = [];
        for (const p of parts) {
            const k = p.toLowerCase().replace(/\s+/g, ' ');
            if (seen.has(k)) continue;
            // drop obvious duplicates like "best best ..."
            if (/\b(\w+) \1\b/i.test(k)) continue;
            seen.add(k);
            uniq.push(p);
            if (uniq.length >= 12) break;
        }
        parsed.meta_keywords = uniq.join(', ');
    }
    parsed.read_time_min = parsed.read_time_min || 7;
    parsed.intro_html = parsed.intro_html || '<p>Welcome to this guide.</p>';
    parsed.sections = Array.isArray(parsed.sections) && parsed.sections.length ? parsed.sections : [];
    parsed.faqs = Array.isArray(parsed.faqs) ? parsed.faqs : [];
    parsed.conclusion_html = parsed.conclusion_html || '<p>Thanks for reading! Explore more free AI tools on AIToolsNova.</p>';
    parsed.related_tools = parsed.related_tools || ['ai-chat','ai-writer','ai-image-generator','youtube-kit'];
    parsed.related_blogs = parsed.related_blogs || ['best-free-ai-tools-2026','top-100-ai-tools-2026','ai-productivity-tools'];
    parsed.affiliate_picks = Array.isArray(parsed.affiliate_picks) ? parsed.affiliate_picks.slice(0, 3) : [];
    if (!parsed.sections.length) throw new Error('Content has no sections at all.');
    // Approximate word count across main fields — reject thin AI output before it ships
    const approxText = [
        parsed.intro_html, parsed.conclusion_html,
        ...(parsed.sections || []).map(s => `${s.h2 || ''} ${s.body_html || ''}`),
        ...(parsed.faqs || []).map(f => `${f.q || ''} ${f.a || ''}`),
    ].join(' ').replace(/<[^>]+>/g, ' ');
    const wc = (approxText.match(/[A-Za-z0-9']+/g) || []).length;
    // Hard floor only. Anything above this is expanded below with topic-specific
    // sections rather than rejected: the previous code threw at <800 and then
    // had an unreachable padding branch for <1200, so every 600-799 word draft
    // failed the whole run even though it was recoverable.
    if (wc < 300) {
        throw new PublishError(`Content unusable: only ${wc} words came back.`, { code: 'thin-content', retryable: true });
    }
    // If the draft is usable but short, ask the model for MORE SECTIONS ON THIS
    // TOPIC rather than appending a fixed block. The previous version pasted the
    // same two hardcoded sections into every short post, which is exactly how a
    // set of near-identical articles gets flagged as scaled content.
    let finalWc = wc;
    for (let pass = 1; pass <= EXPANSION_PASSES && finalWc < TARGET_WORDS; pass++) {
        const have = (parsed.sections || []).map(x => x.h2).filter(Boolean);
        const need = Math.max(2, Math.ceil((TARGET_WORDS + 300 - finalWc) / 180));
        console.log(`   ➤ Draft is ${wc} words. Requesting ${need} more topic-specific sections...`);
        const expandPrompt = `You are expanding an existing article titled "${topic.title}".

Sections already written (do NOT repeat these angles):
${have.map(h => '- ' + h).join('\n')}

Write ${need} ADDITIONAL sections that go deeper on this specific topic.
Each section must contain 150-220 words of concrete, practical detail: real
trade-offs, numbers, named situations, or step sequences. No filler, no
restating the intro, no generic advice that would fit any other article.

Return ONLY JSON:
{"sections":[{"h2":"...","body_html":"<p>...</p><p>...</p>"}]}

HTML allowed: p ul ol li strong em h3.`;

        try {
            const { parsed: extra } = await callGroqForJson(
                [{ role: 'user', content: expandPrompt }],
                { temperature: 0.8, max_tokens: 4200, json: true }
            );
            const add = Array.isArray(extra?.sections) ? extra.sections : [];
            const seen = new Set(have.map(h => String(h).toLowerCase().trim()));
            let added = 0;
            for (const sec of add) {
                if (!sec || !sec.h2 || !sec.body_html) continue;
                const key = String(sec.h2).toLowerCase().trim();
                if (seen.has(key)) continue;
                seen.add(key);
                parsed.sections.push(sec);
                added++;
            }
            const reText = [
                parsed.intro_html, parsed.conclusion_html,
                ...(parsed.sections || []).map(x => `${x.h2 || ''} ${x.body_html || ''}`),
                ...(parsed.faqs || []).map(x => `${x.q || ''} ${x.a || ''}`),
            ].join(' ').replace(/<[^>]+>/g, ' ');
            finalWc = (reText.match(/[A-Za-z0-9']+/g) || []).length;
            console.log(`   ✔ Pass ${pass}: added ${added} section(s). Now ${finalWc} words.`);
            if (!added) break;   // the model has nothing new to say - stop asking
        } catch (err) {
            console.warn(`   ⚠️  Expansion pass ${pass} failed: ${describeError(err)}`);
            break;
        }
    }

    // Publish only what clears the site's quality bar. Anything above the floor
    // ships; anything under it is retried by the caller, so one short model
    // answer no longer converts into "no post for five days".
    if (finalWc < MIN_WORDS) {
        throw new PublishError(
            `Content below quality floor after ${EXPANSION_PASSES} expansion pass(es): ${finalWc} words (need >= ${MIN_WORDS}, target ${TARGET_WORDS}).`,
            { code: 'thin-content', retryable: true }
        );
    }
    if (parsed.sections.length < MIN_SECTIONS) {
        throw new PublishError(`Content too shallow: ${parsed.sections.length} sections (need >= ${MIN_SECTIONS}).`, { code: 'thin-content', retryable: true });
    }

    console.log(`   ➤ Approx body words: ${finalWc}`);
    return parsed;
}

// ---------- 6a. Build affiliate section HTML ----------
function buildAffiliateSection(picks) {
    const safePicks = Array.isArray(picks) && picks.length ? picks : [
        { name: 'AI productivity books', why: 'A practical starting point for learning responsible AI workflows.', amazon_query: 'ai productivity books' },
        { name: 'USB microphone for online meetings', why: 'Useful for clearer classes, calls and creator work.', amazon_query: 'usb microphone for online meetings' },
    ];
    const items = safePicks.slice(0, 3).map(p => {
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

function buildHtml(topic, content, todayISO, todayHuman, heroLocal = null, sectionLocals = {}) {
    // Cloudflare Pages serves these without the extension - a .html URL 308s,
    // and Google drops redirecting URLs from the index.
    const canonicalUrl = `https://aitoolsnova.com/blog/${topic.slug}`;
    // Enrich the raw hero prompt with quality-boosting keywords so Pollinations returns sharp, professional images.
    // Push toward photorealism so the hero reads like a real photograph, not an obvious AI render.
    const enrichedPrompt = `${topic.hero_prompt || topic.title}, real photograph, shot on a DSLR camera, natural light, candid documentary style, shallow depth of field, ultra realistic, no CGI, no illustration, no cartoon, no text, no watermark`;
    const heroPromptEnc = encodeURIComponent(enrichedPrompt);
    // Pollinations Flux model produces MUCH sharper output than the default.
    // width/height at 1600x900 (16:9) → downscaled by browsers cleanly, no pixelation.
    // model=flux + enhance=true + nologo=true + nofeed=true (private) + seed for stability
    const seed = Array.from(topic.slug).reduce((a, c) => a + c.charCodeAt(0), 0);
    const heroRemote = `https://image.pollinations.ai/prompt/${heroPromptEnc}?width=1600&height=900&seed=${seed}&model=flux&enhance=true&nologo=true&nofeed=true`;
    // heroLocal = pre-generated Gemini hero { rel, abs }. Meta/schema tags need
    // absolute URLs; the visible <img> uses the root-relative path.
    const heroImg = heroLocal ? heroLocal.abs : heroRemote;
    const heroImgSrc = heroLocal ? heroLocal.rel : heroRemote;
    const sectionsHtml = content.sections.map((s, i) => {
        // Only render an <img> for sections that actually have a local image
        // file. Previously every section got src="/blog/img/<slug>-section-N.jpg"
        // but only sections 1-4 are generated — sections 5+ 404'd (broken images
        // are a "low value content" signal for AdSense/Googlebot). For sections
        // beyond the generated set, deterministically reuse an existing image of
        // this post (no new API cost) instead of emitting a dead URL.
        let image = sectionLocals[i];
        if (!image) {
            const n = (i % 4) + 1;
            const reuse = path.join(BLOG_DIR, 'img', `${topic.slug}-section-${n}.jpg`);
            if (existsSync(reuse)) image = `/blog/img/${topic.slug}-section-${n}.jpg`;
        }
        const imgTag = image
            ? `\n<img class="section-image" src="${image}" alt="${esc(s.h2)}" loading="lazy" decoding="async" width="1600" height="900">`
            : '';
        return `<section class="blog-section">\n<h2>${esc(s.h2)}</h2>${imgTag}\n${s.body_html}\n</section>`;
    }).join('\n\n');
    const faqsHtml = content.faqs.map((f, i) =>
        `<div class="faq-box"><h4>Q${i+1}: ${esc(f.q)}</h4><p>${esc(f.a)}</p></div>`
    ).join('\n');
    // Internal links block - validated against real files so we never emit a 404
    const relatedHtml = (() => {
        const links = Array.isArray(content.internal_links) ? content.internal_links.slice(0, 4) : [];
        if (!links.length) return '';
        const items = links
            .filter(l => l && l.slug && l.anchor)
            .map(l => `<li style="margin:8px 0"><a href="/blog/${String(l.slug).replace(/\.html$/, '')}" style="color:#6366F1;text-decoration:none;font-weight:600">${esc(l.anchor)}</a></li>`)
            .join('');
        if (!items) return '';
        return `<section class="related-posts-block" style="margin:40px 0;padding:24px;background:#F8FAFC;border-radius:12px;border-left:4px solid #6366F1">
            <h2 style="margin:0 0 12px;font-size:1.25rem">Related Guides You'll Find Useful</h2>
            <ul style="margin:0;padding-left:18px;list-style:disc">${items}</ul>
            <p style="margin:14px 0 0"><a href="/tools" style="color:#6366F1;font-weight:600">Browse all free AI tools &rarr;</a></p>
        </section>`;
    })();

    const faqSchema = content.faqs.map(f => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }));

    const relTools = (content.related_tools || []).slice(0, 6)
        .map(u => { const slug = String(u).replace(/\.html$/, ''); return `<li><a href="../tools/${slug}">${slug.replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase())}</a></li>`; }).join('');
    const relBlogs = (content.related_blogs || []).slice(0, 4)
        .map(u => { const slug = String(u).replace(/\.html$/, ''); return `<li><a href="${slug}">${slug.replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase())}</a></li>`; }).join('');
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

    <script src="/js/consent.js?v=20260819c"></script>
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
        "author": { "@type": "Person", "name": "AIToolsNova Editorial", "url": "https://aitoolsnova.com/about" },
        "datePublished": "${todayISO}",
        "dateModified": "${todayISO}",
        "mainEntityOfPage": { "@type": "WebPage", "@id": "${canonicalUrl}" },
        "keywords": "${esc(content.meta_keywords)}",
        "inLanguage": "en",
        "contentLocation": { "@type": "Place", "name": "${esc(topic.geo || 'Global')}" },
        "publisher": {
            "@type": "Organization",
            "name": "AIToolsNova",
            "logo": { "@type": "ImageObject", "url": "https://aitoolsnova.com/images/publisher-logo.png", "width": 600, "height": 60 }
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
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://aitoolsnova.com/" },
            { "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://aitoolsnova.com/blogs" },
            { "@type": "ListItem", "position": 3, "name": ${JSON.stringify(topic.title)}, "item": ${JSON.stringify(canonicalUrl)} }
        ]
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
        .blog-section{margin:0 0 34px}.section-image{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;border-radius:14px;margin:0 0 18px;background:#EEF2FF}@media(max-width:1100px){.container{width:min(900px,94%)}.blog-content{max-width:100%}}@media(max-width:768px){body{padding-top:60px}.blog-header h1{font-size:1.6rem}.header{height:60px}.container{width:calc(100% - 28px);padding-left:0;padding-right:0}.blog-content{font-size:.98rem}.blog-content h2{font-size:1.35rem;margin-top:26px}.section-image{border-radius:10px;margin-bottom:14px}}@media(max-width:430px){.container{width:calc(100% - 20px)}.blog-header h1{font-size:1.42rem}.blog-meta{gap:8px;font-size:.78rem}.blog-content p{font-size:.94rem}.blog-content ul,.blog-content ol{padding-left:18px}}@media(max-width:360px){.blog-header h1{font-size:1.28rem}.blog-content h2{font-size:1.18rem}.back-btn{padding:7px 12px;font-size:.78rem}}
    </style>
</head>
<body>

    <header class="header">
        <div class="container">
            <a href="../" class="logo">🤖 <span>AIToolsNova</span></a>
            <nav class="desktop-menu" aria-label="Main Navigation" style="display:flex;gap:20px;align-items:center;font-weight:600">
                <a href="/">Home</a>
                <a href="../tools">Tools</a>
                <a href="../blogs">Blogs</a>
                <a href="../web-stories">Web Stories</a>
                <a href="../about">About</a>
                <a href="../contact">Contact</a>
            </nav>
            <a href="../blogs" class="back-btn">← All Blogs</a>
        </div>
    </header>

    <div class="container">
        <article>
            <img class="hero-image" src="${heroImgSrc}" alt="${esc(topic.title)}" loading="eager" fetchpriority="high" decoding="async" width="1600" height="900">
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

                ${relatedHtml}

                ${affiliateHtml}
                ${affiliatePicksHtml}

                <div class="related-box">
                    <h3>🛠️ Related Tools</h3>
                    <ul>
                        ${relTools}
                        <li><a href="../tools">View All Tools →</a></li>
                    </ul>
                </div>

                <div class="related-box">
                    <h3>📚 Related Blogs</h3>
                    <ul>
                        ${relBlogs}
                        <li><a href="../blogs">View All Blogs →</a></li>
                    </ul>
                </div>

                <aside class="author-box" style="margin-top:28px;padding:20px;border:1px solid #E2E8F0;border-radius:14px;background:#fff;">
                    <strong style="display:block;margin-bottom:6px;color:#0F172A;">About the author</strong>
                    <p style="margin:0;color:#475569;font-size:.95rem;">Written by the <a href="../about" style="color:#4F46E5;font-weight:600;">AIToolsNova Editorial team</a>. We test free AI and productivity tools so creators, students and small businesses can work faster without paid subscriptions. Questions? <a href="../contact" style="color:#4F46E5;font-weight:600;">Contact us</a>.</p>
                    <p style="margin:12px 0 0;font-size:.85rem;color:#94A3B8;"><strong>Published:</strong> ${todayHuman} · <strong>Updated:</strong> ${todayHuman}</p>
                </aside>
            </div>
        </article>
    </div>

    <footer class="footer">
        <div class="container">
            <div class="footer-bottom">
                <p>© 2026 AIToolsNova. All Rights Reserved. | <a href="../privacy-policy">Privacy Policy</a> | <a href="../terms-and-conditions">Terms</a> | <a href="../disclaimer">Disclaimer</a></p>
            </div>
        </div>
    </footer>

<script src="../enhancements.js?v=20260819c" defer></script>
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
                        <div class="blog-img"><img src="blog/img/${topic.slug}-hero.jpg" alt="${esc(topic.title)}" loading="lazy" decoding="async" width="1600" height="900"></div>
                        <div class="blog-content">
                            <span class="blog-tag">${(topic.category || 'ai').toUpperCase()}</span>
                            <h3>${esc(topic.title)}</h3>
                            <div class="blog-meta">
                                <span>📅 ${todayHuman}</span>
                                <span>⏱ ${content.read_time_min || 7} min read</span>
                            </div>
                            <p>${shortDesc}</p>
                            <a href="blog/${topic.slug}" class="read-more">Read More →</a>
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
    let xml = await fs.readFile(SITEMAP_XML, 'utf-8');
    const START = '<!-- AUTO-BLOG-SITEMAP-START -->';
    if (!xml.includes(START)) {
        console.warn('⚠️  sitemap.xml insertion marker missing — skipping.');
        return;
    }
    const loc = `https://aitoolsnova.com/blog/${topic.slug}`;

    // Self-heal: strip ANY duplicate <url> blocks for this slug first (re-runs,
    // retries, or a re-published topic used to leave stacked duplicate entries —
    // Google flags duplicate URLs in the sitemap as a quality signal).
    const blockRe = new RegExp(
        '\\s*<url>\\s*<loc>' + loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '<\\/loc>[\\s\\S]*?<\\/url>', 'g'
    );
    const before = xml.length;
    xml = xml.replace(blockRe, '');
    if (xml.length !== before) console.log('   ♻️  removed existing duplicate sitemap entry for this slug');

    // Also de-dupe ANY other repeated <loc> in the file so the sitemap is always clean.
    const seen = new Set();
    xml = xml.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
        const m = block.match(/<loc>([^<]+)<\/loc>/);
        if (!m) return block;
        if (seen.has(m[1])) return '';
        seen.add(m[1]);
        return block;
    });

    const entry = `
    <url>
        <loc>${loc}</loc>
        <lastmod>${todayISO}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
    const idx = xml.indexOf(START) + START.length;
    xml = xml.slice(0, idx) + entry + xml.slice(idx);
    await fs.writeFile(SITEMAP_XML, xml);
    console.log('✅ sitemap.xml updated (deduplicated)');
}

// ---------- 9. Ping IndexNow (Bing + Yandex + Naver + others) ----------
async function pingIndexNow(topic) {
    if (!INDEXNOW_KEY) { console.log('   ℹ️  INDEXNOW_KEY not set — skipping IndexNow ping (Google/Bing sitemap ping still runs in workflow).'); return; }
    const url = `https://aitoolsnova.com/blog/${topic.slug}`;
    try {
        const res = await fetchWithTimeout('https://api.indexnow.org/indexnow', {
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
// ---------- Which days still need a post? ----------
const BACKFILL_WINDOW = Number(process.env.BACKFILL_WINDOW || 10);
const SKIP_IF_UP_TO_DATE = process.env.ALLOW_DUPLICATE_DAY !== '1';

/**
 * A missed schedule used to be a permanently missing day. Now every run asks
 * "which of the last N days have no post?" and publishes those first, oldest
 * first, capped per run so a long outage cannot turn into a content flood.
 */
async function resolveDates() {
    const today = isoDate();
    if (TARGET_DATE) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
            throw new PublishError(`--date must be YYYY-MM-DD (got "${TARGET_DATE}")`, { code: 'bad-args' });
        }
        return [TARGET_DATE];
    }
    const planned = await planGaps(ROOT, { kind: 'blog', days: BACKFILL_WINDOW, max: Math.max(1, BACKFILL_MAX), today });
    if (BACKFILL_MAX > 0) {
        if (planned.gaps.length) {
            console.log(`\n🧾 Catch-up: ${planned.gaps.length} day(s) without a post in the last ${BACKFILL_WINDOW} -> ${planned.gaps.join(', ')}`);
            return planned.gaps;
        }
        console.log(`\n✅ Nothing to catch up: every day since ${planned.earliest} has a post.`);
        return SKIP_IF_UP_TO_DATE ? [] : [today];
    }
    const have = await publishedDatesForBlog();
    if (SKIP_IF_UP_TO_DATE && have.has(today)) {
        console.log(`\n✅ Today (${today}) already has ${(have.get(today) || []).length} post(s) - nothing to do.`);
        return [];
    }
    const count = Math.max(1, COUNT);
    return Array.from({ length: count }, (_, i) => addDays(today, -i)).filter(d => !have.has(d) || !SKIP_IF_UP_TO_DATE);
}

async function publishedDatesForBlog() {
    return publishedDates(ROOT, 'blog');
}

// ---------- One article, for one publish date ----------
async function publishForDate(todayISO) {
    console.log(`\n${'='.repeat(60)}\n📅 Publishing blog post for ${todayISO}\n${'='.repeat(60)}`);
    const today = new Date(`${todayISO}T12:00:00Z`);
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

    const outFile = path.join(BLOG_DIR, `${topic.slug}.html`);
    if (existsSync(outFile)) {
        console.log(`⚠️  ${topic.slug}.html already exists — appending a suffix for safety.`);
        topic.slug += '-' + today.getTime().toString(36).slice(-4);
    }

    console.log(`\n📝 Generating content (target ${TARGET_WORDS} words, floor ${MIN_WORDS})...`);
    let content = null;
    let lastContentErr = null;
    for (let attempt = 1; attempt <= CONTENT_ATTEMPTS; attempt++) {
        try {
            console.log(`   attempt ${attempt}/${CONTENT_ATTEMPTS}...`);
            content = await generateContent(topic);
            console.log(`   ➤ ${content.sections?.length || 0} sections, ${content.faqs?.length || 0} FAQs, ~${content.read_time_min || '?'} min read`);
            break;
        } catch (err) {
            lastContentErr = err;
            console.warn(`   ⚠️  content attempt ${attempt} failed: ${describeError(err)}`);
            const fatal = err instanceof PublishError && !err.retryable;
            if (fatal) break;
            if (attempt < CONTENT_ATTEMPTS) await sleep(2000 * attempt);
        }
    }
    if (!content) {
        throw lastContentErr || new PublishError(`Content generation failed after ${CONTENT_ATTEMPTS} attempts`, { code: 'content-failed' });
    }

    console.log('\n🖼️  Generating hero image (Gemini AI first — Pollinations fallback)...');
    let heroLocal = null;
    try {
        const heroPrompt = `${topic.hero_prompt || topic.title}, real photograph, shot on a DSLR camera, natural light, candid documentary style, shallow depth of field, ultra realistic, no CGI, no illustration, no cartoon, no text, no watermark`;
        const heroDest = path.join(BLOG_DIR, 'img', `${topic.slug}-hero.jpg`);
        await fs.mkdir(path.dirname(heroDest), { recursive: true });
        if (existsSync(heroDest) || await generateGeminiImage(heroPrompt, heroDest, { aspect: '16:9', width: 1600, height: 900 })) {
            heroLocal = { rel: `/blog/img/${topic.slug}-hero.jpg`, abs: `${SITE_URL}/blog/img/${topic.slug}-hero.jpg` };
        } else {
            // Never publish a hotlink: use a bundled local image if Gemini is unavailable.
            const fallback = readdirSync(path.join(BLOG_DIR, 'img')).find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
            if (fallback) { await fs.copyFile(path.join(BLOG_DIR, 'img', fallback), heroDest); heroLocal = { rel: `/blog/img/${topic.slug}-hero.jpg`, abs: `${SITE_URL}/blog/img/${topic.slug}-hero.jpg` }; }
            console.log('   ℹ️  Gemini image unavailable — bundled local fallback used.');
        }
    } catch (e) {
        const fallback = readdirSync(path.join(BLOG_DIR, 'img')).find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (fallback) { const heroDest = path.join(BLOG_DIR, 'img', `${topic.slug}-hero.jpg`); await fs.copyFile(path.join(BLOG_DIR, 'img', fallback), heroDest); heroLocal = { rel: `/blog/img/${topic.slug}-hero.jpg`, abs: `${SITE_URL}/blog/img/${topic.slug}-hero.jpg` }; }
        console.warn(`   ⚠️  Hero image step failed (${e.message}) — bundled local fallback used.`);
    }

    console.log('\n🖼️  Generating 3–4 section images (Gemini first, local fallback)...');
    const sectionLocals = {};
    const sectionPrompts = content.sections.slice(0, 4);
    const existingFallbacks = readdirSync(path.join(BLOG_DIR, 'img')).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    for (let i = 0; i < sectionPrompts.length; i++) {
        const dest = path.join(BLOG_DIR, 'img', `${topic.slug}-section-${i + 1}.jpg`);
        const prompt = `${sectionPrompts[i].h2 || topic.title}, relevant editorial photograph, real people and setting, natural light, no text, no watermark`;
        let ok = existsSync(dest) || await generateGeminiImage(prompt, dest, { aspect: '16:9', width: 1600, height: 900 });
        if (!ok) {
            // Deterministic local fallback: copy a bundled image rather than leaving a hotlink.
            const fallback = existingFallbacks[i % Math.max(existingFallbacks.length, 1)];
            if (fallback) { await fs.copyFile(path.join(BLOG_DIR, 'img', fallback), dest); ok = true; }
        }
        if (ok) sectionLocals[i] = `/blog/img/${topic.slug}-section-${i + 1}.jpg`;
    }

    console.log('\n📄 Building HTML file...');
    let finalHtml = buildHtml(topic, content, todayISO, todayHuman, heroLocal, sectionLocals);
    console.log('   🖼️  Localizing hero image (fast + reliable)...');
    finalHtml = await localizeBlogHero(finalHtml);
    const finalPath = path.join(BLOG_DIR, `${topic.slug}.html`);
    await fs.writeFile(finalPath, finalHtml);
    // Final on-disk QA: refuse to leave thin HTML in the repo
    {
        const plain = finalHtml.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ');
        const wc2 = (plain.match(/[A-Za-z0-9']+/g) || []).length;
        if (wc2 < MIN_WORDS) {
            await fs.unlink(finalPath).catch(()=>{});
            throw new PublishError(`Word count QA failed after write (${wc2} words, floor ${MIN_WORDS}). Thin posts are not published.`, { code: 'qa-word-count' });
        }
        console.log(`   ➤ On-disk visible words ~= ${wc2}`);
    }
    // On-disk resource QA: every local /blog/img/* <img> must exist, and every
    // root-relative internal href must map to a real page. Broken images/links
    // are a "low value content" signal for AdSense reviewers and Googlebot, so
    // we repair (or fail loudly) rather than ship a dead page.
    {
        const html2 = await fs.readFile(finalPath, 'utf-8');
        const missingImgs = [...new Set(html2.match(/\/blog\/img\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)/g) || [])]
            .filter(p => !existsSync(path.join(ROOT, p.replace(/^\//, ''))));
        if (missingImgs.length) {
            // Deterministic self-heal: copy the post hero/section-1 onto each
            // missing local image slot so nothing 404s.
            const fallbacks = [path.join(BLOG_DIR, 'img', `${topic.slug}-hero.jpg`),
                path.join(BLOG_DIR, 'img', `${topic.slug}-section-1.jpg`)]
                .filter(f => existsSync(f));
            if (fallbacks.length) {
                for (const miss of missingImgs) {
                    await fs.copyFile(fallbacks[0], path.join(ROOT, miss.replace(/^\//, '')));
                }
                console.warn(`   🔧 self-healed ${missingImgs.length} missing section image(s) with local fallback`);
            } else {
                console.warn(`   ⚠️  missing local images with no fallback: ${missingImgs.join(', ')}`);
            }
        }
        const blogRoutes = new Set(readdirSync(BLOG_DIR).filter(f => f.endsWith('.html')).map(f => '/blog/' + f.slice(0, -5)));
        const toolRoutes = new Set(readdirSync(path.join(ROOT, 'tools')).filter(f => f.endsWith('.html')).map(f => '/tools/' + f.slice(0, -5)));
        const links = [...new Set((html2.match(/href="(\/[a-z0-9/-]+?)"/g) || []).map(h => h.match(/href="([^"]+)"/)[1]))]
            .filter(l => !/\.(jpg|jpeg|png|webp|svg|css|js|ico|xml|txt|json|webmanifest|pdf)$/i.test(l));
        const hardBad = links.filter(l =>
            (l.startsWith('/blog/') && !blogRoutes.has(l)) ||
            (l.startsWith('/tools/') && !toolRoutes.has(l)));
        if (hardBad.length) {
            throw new PublishError(`Internal link QA failed — these routes do not exist: ${hardBad.join(', ')}`, { code: 'qa-bad-links' });
        }
    }
    console.log(`   ✅ Written: blog/${topic.slug}.html (${(finalHtml.length/1024).toFixed(1)} KB)`);

    console.log('\n🔗 Updating blogs.html and sitemap.xml...');
    await updateBlogsList(topic, content, todayHuman);
    await updateSitemap(topic, todayISO);


    console.log('\n🔗 Updating blogs.html and sitemap.xml...');
    await updateBlogsList(topic, content, todayHuman);
    await updateSitemap(topic, todayISO);

    history.topics.push(topic.title);
    if (history.topics.length > 200) history.topics = history.topics.slice(-200);
    await saveHistory(history);

    console.log('\n📣 Pinging search engines...');
    await pingIndexNow(topic);

    const words = visibleWords(finalHtml);
    console.log(`\n🎉 Created blog/${topic.slug}.html (${words} words) for ${todayISO}`);
    return { slug: topic.slug, title: topic.title, words, date: todayISO };
}

// ---------- Diagnostics-only mode ----------
async function runCheck() {
    const keys = readKeys();
    const today = isoDate();
    const planned = await planGaps(ROOT, { kind: 'blog', days: BACKFILL_WINDOW, max: 10, today });
    const have = await publishedDatesForBlog();
    const newest = have.size ? [...have.keys()].sort().at(-1) : null;
    const lines = [
        '### Blog pipeline check',
        '',
        `| Check | Result |`,
        `|---|---|`,
        `| AI keys visible | ${keys.any ? keys.present.join(', ') : '**none**'} |`,
        `| Site API fallback | ${siteApiAllowed() ? 'enabled' : 'disabled'} |`,
        `| IndexNow key | ${INDEXNOW_KEY ? 'found' : 'not set (optional)'} |`,
        `| Newest post | ${newest || 'none'} (${newest ? daysBetween(newest, today) : '?'} days ago) |`,
        `| Missing days in last ${BACKFILL_WINDOW} | ${planned.gaps.length ? planned.gaps.join(', ') : 'none'} |`,
        `| Quality bar | >= ${MIN_WORDS} words, >= ${MIN_SECTIONS} sections (target ${TARGET_WORDS}) |`,
    ];
    if (!keys.any) {
        lines.push('', `> ⚠️ ${noKeyGuidance(keys.missing)}`);
        annotate('warning', 'Blog pipeline: no AI keys', noKeyGuidance(keys.missing));
    }
    console.log(lines.join('\n'));
    await stepSummary(lines);
    return 0;
}

// ---------- Publish bookkeeping (ledger + live status file) ----------
async function recordAndPublish({ results, pushErr }) {
    const okOnes = results.filter(r => r.ok);
    const firstErr = results.find(r => !r.ok);
    let pushed = false;
    const selfPublish = !DRY_RUN && process.env.SKIP_AUTO_PUBLISH !== '1' && process.env.NO_PUBLISH !== '1'
        && (isCI() || process.env.FORCE_PUBLISH === '1');
    try {
        await writePublishStatus(ROOT, {
            kind: 'blog',
            ok: okOnes.length > 0 && !pushErr,
            date: okOnes.at(-1)?.date || isoDate(),
            slug: okOnes.map(r => r.slug).join(','),
            pushed,
            reason: pushErr ? `git push failed: ${describeError(pushErr)}` : (firstErr ? firstErr.error : ''),
        });
    } catch (e) {
        console.warn(`   ⚠️  could not write publish-status.json: ${e.message}`);
    }
    if (selfPublish) {
        try {
            const res = await publishContent({
                root: ROOT,
                include: CONTENT_PATHS.blog,
                message: okOnes.length
                    ? `content(blog): auto-publish ${okOnes.map(r => r.slug).join(', ').slice(0, 70)}`
                    : 'chore(blog): record publish failure status',
            });
            pushed = res.pushed;
            if (res.committed) console.log(`📦 ${pushed ? 'Pushed' : 'Committed'} ${res.files.length} file(s) to main`);
            else if (res.skipped) console.log(`📦 Nothing to commit (${res.skipped})`);
        } catch (err) {
            pushErr = err;
            annotate('error', 'Blog auto-commit failed', describeError(err) + (err.hint ? ` — ${err.hint}` : ''));
        }
    } else {
        console.log('ℹ️  Local run: files are written but not committed (auto-publish runs inside GitHub Actions).');
    }
    return { pushed, pushErr };
}

async function main() {
    console.log('🚀 AIToolsNova - Blog Auto-Publish starting...\n');
    console.log(`🔑 Groq=${readKeys().groq ? 'yes' : 'no'} Gemini=${readKeys().gemini ? 'yes' : 'no'} DeepSeek=${readKeys().deepseek ? 'yes' : 'no'} SiteAPI=${siteApiAllowed() ? 'yes' : 'no'}  DRY_RUN=${DRY_RUN ? 'yes' : 'no'}`);
    if (ARGS.flags.check) return runCheck();

    const dates = await resolveDates();
    if (!dates.length) {
        await stepSummary(['### Blog auto-publish', '', '✅ Already up to date — no missing day in the window, nothing to publish.']);
        console.log('✅ Up to date. Exiting 0.');
        return 0;
    }

    const results = [];
    for (const d of dates) {
        try {
            const r = await publishForDate(d);
            results.push({ ...r, ok: true });
            await appendLedger(ROOT, { kind: 'blog', date: d, slug: r.slug, status: 'ok', words: r.words });
        } catch (err) {
            const reason = describeError(err);
            results.push({ date: d, ok: false, error: reason, code: err?.code || 'error' });
            await appendLedger(ROOT, { kind: 'blog', date: d, slug: '', status: 'fail', reason });
            annotate('error', `Blog publish failed for ${d}`, reason + (err?.hint ? ` — ${err.hint}` : ''));
            console.error(`❌ ${d}: ${reason}`);
            if (err instanceof PublishError && (err.code === 'no-ai-key' || err.code === 'bad-args')) break;
        }
    }

    const { pushed, pushErr } = await recordAndPublish({ results, pushErr: null });
    const okOnes = results.filter(r => r.ok);
    await stepSummary([
        '### Blog auto-publish',
        '',
        '| Date | Status | Slug | Words |',
        '|---|---|---|---|',
        ...results.map(r => `| ${r.date} | ${r.ok ? '✅ published' : '❌ failed'} | ${r.slug || '-'} | ${r.words || '-'}${r.ok ? '' : ` — ${r.error}`.slice(0, 160)} |`),
        '',
        `Pushed to main: ${pushed ? 'yes' : 'no'} · Keys: ${readKeys().present.join(', ') || 'none (site API used)'} · Providers: Groq/Gemini/DeepSeek/site-api chain`,
    ]);

    if (!okOnes.length) {
        const why = results[0]?.error || 'unknown';
        annotate('error', 'No blog published', `${why} (see the run log above; publish-status.json records this)`);
        throw new PublishError(`Blog run published nothing. First error: ${why}`, { code: 'nothing-published' });
    }
    if (pushErr) throw pushErr;
    console.log(`\n✅ Done: ${okOnes.length} post(s)${pushed ? ' pushed to main' : ' written locally'}.`);
    return 0;
}

// Records an unrecoverable startup failure so the outage is visible in the repo,
// on the live site (publish-status.json) and in the Actions log - then exits 1.
async function failFast(code, message) {
    annotate('error', `Blog pipeline cannot start (${code})`, message);
    console.error(`❌ ${message}`);
    try {
        await appendLedger(ROOT, { kind: 'blog', date: isoDate(), slug: '', status: 'fail', reason: message, code });
        await writePublishStatus(ROOT, { kind: 'blog', ok: false, reason: `${code}: ${message}`, slug: '', pushed: false });
        if (isCI() && process.env.SKIP_AUTO_PUBLISH !== '1') {
            await publishContent({
                root: ROOT,
                include: ['scripts/publish-log.json', 'publish-status.json'],
                message: `chore(blog): publish failure status (${code})`,
            }).catch(() => {});
        }
    } catch { /* never mask the original error */ }
    process.exit(1);
}

main().then((code) => process.exit(typeof code === 'number' ? code : 0)).catch(async err => {
    console.error('\n❌ FATAL:', describeError(err));
    if (err.stack) console.error(err.stack);
    await stepSummary(['### ❌ Blog auto-publish failed', '', '```', describeError(err), '```',
        ...(err?.hint ? ['', `> ${err.hint}`] : [])]);
    process.exit(1);
});
