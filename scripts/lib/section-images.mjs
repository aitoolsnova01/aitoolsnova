/**
 * AIToolsNova - per-section image pipeline (shared)
 * --------------------------------------------------
 * Every blog section needs its OWN unique image. This module is the single
 * implementation used by both generate-blog.mjs (new posts) and
 * fix-broken-blog-images.mjs (repair of existing posts).
 *
 * Fallback chain for ONE section image (never wrap, never reuse):
 *   1. Gemini image model        (best quality; needs GEMINI_API_KEY)
 *   2. Pollinations, seeded per  (free, deterministic per slug+section)
 *      section
 *   3. Offline branded SVG/JPG   (always works: AIToolsNova-branded card
 *      with the section heading)
 *
 * Step 3 guarantees the chain ALWAYS produces a fresh, unique file, so no
 * caller ever needs to "borrow" another section's image again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SECTION_IMG_WIDTH = 1600;
export const SECTION_IMG_HEIGHT = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trySharp() {
    try { return (await import('sharp')).default; } catch { return null; }
}

/** Deterministic stable numeric seed from arbitrary parts (slug, index, ...). */
export function seedFor(...parts) {
    const h = crypto.createHash('md5').update(parts.join('::')).digest('hex');
    return parseInt(h.slice(0, 8), 16) % 1_000_000_000;
}

/** Build the Pollinations URL for one section (seeded, private, no logo). */
export function pollinationsUrl(prompt, seed, { width = SECTION_IMG_WIDTH, height = SECTION_IMG_HEIGHT } = {}) {
    const enc = encodeURIComponent(String(prompt).replace(/\s+/g, ' ').trim().slice(0, 700));
    return `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&seed=${seed}&model=flux&enhance=true&nologo=true&nofeed=true`;
}

/**
 * Download an image URL and save it locally, normalised to 1600x900 JPEG when
 * sharp is available. Returns true on success.
 */
export async function downloadToLocalImage(url, dest, { tries = 2, timeoutMs = 45_000, minBytes = 3000 } = {}) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < minBytes) throw new Error('tiny payload (' + buf.length + 'b)');
            const sharp = await trySharp();
            if (sharp) {
                const out = await sharp(buf)
                    .resize(SECTION_IMG_WIDTH, SECTION_IMG_HEIGHT, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
                    .sharpen({ sigma: 0.4 })
                    .jpeg({ quality: 88, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
                    .toBuffer();
                await fs.writeFile(dest, out);
            } else {
                await fs.writeFile(dest, buf);
            }
            if ((await fs.stat(dest)).size >= minBytes) return true;
        } catch (e) {
            console.warn(`   ⚠️  image download try ${attempt}/${tries} failed: ${e.message}`);
            await sleep(1500 * attempt);
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Offline branded fallback (step 3) - pure string SVG, works with zero network
// ---------------------------------------------------------------------------

function escXml(s = '') {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Word-wrap for the SVG heading: maxChars per line, maxLines lines, ellipsis. */
function wrapHeading(text, maxChars = 26, maxLines = 3) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
        const candidate = line ? line + ' ' + w : w;
        if (candidate.length > maxChars && line) {
            lines.push(line);
            line = w;
            if (lines.length === maxLines) break;
        } else {
            line = candidate;
        }
    }
    if (line && lines.length < maxLines) lines.push(line);
    const consumed = lines.join(' ').length;
    const truncated = words.join(' ').length > consumed;
    if (truncated && lines.length) {
        let last = lines[lines.length - 1];
        if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
        lines[lines.length - 1] = last.replace(/[\s,.:;!?-]*$/, '') + '…';
    }
    return lines.length ? lines : ['AIToolsNova Guide'];
}

/**
 * A branded AIToolsNova SVG card carrying the section heading. Deterministic:
 * the palette is derived from slug + section index, so every section of every
 * post gets a visibly different image without any network call.
 */
export function brandedSectionSvg({ heading, slug, index }) {
    const hue = seedFor(String(slug), 'hue', String(index)) % 360;
    const hue2 = (hue + 45) % 360;
    const lines = wrapHeading(heading || String(slug || '').replace(/-/g, ' '));
    const fontSize = lines.some((l) => l.length > 22) ? 64 : 76;
    const lineHeight = Math.round(fontSize * 1.22);
    const blockHeight = lines.length * lineHeight;
    const startY = Math.round((SECTION_IMG_HEIGHT - blockHeight) / 2 + fontSize * 0.8);
    const headingTexts = lines
        .map((l, i) => `<text x="140" y="${startY + i * lineHeight}" font-family="Inter, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#F8FAFC">${escXml(l)}</text>`)
        .join('\n  ');
    const part = index ? `PART ${index}` : 'GUIDE';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SECTION_IMG_WIDTH}" height="${SECTION_IMG_HEIGHT}" viewBox="0 0 ${SECTION_IMG_WIDTH} ${SECTION_IMG_HEIGHT}" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 62%, 14%)"/>
      <stop offset="0.55" stop-color="hsl(${hue}, 58%, 22%)"/>
      <stop offset="1" stop-color="hsl(${hue2}, 60%, 32%)"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="hsl(${hue2}, 90%, 66%)"/>
      <stop offset="1" stop-color="hsl(${hue}, 90%, 72%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.8" cy="0.15" r="0.9">
      <stop offset="0" stop-color="hsl(${hue2}, 80%, 60%)" stop-opacity="0.28"/>
      <stop offset="1" stop-color="hsl(${hue2}, 80%, 60%)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${SECTION_IMG_WIDTH}" height="${SECTION_IMG_HEIGHT}" fill="url(#bg)"/>
  <rect width="${SECTION_IMG_WIDTH}" height="${SECTION_IMG_HEIGHT}" fill="url(#glow)"/>
  <circle cx="1430" cy="120" r="170" fill="none" stroke="hsl(${hue2}, 70%, 70%)" stroke-opacity="0.18" stroke-width="2"/>
  <circle cx="1430" cy="120" r="260" fill="none" stroke="hsl(${hue2}, 70%, 70%)" stroke-opacity="0.10" stroke-width="2"/>
  <circle cx="180" cy="820" r="130" fill="none" stroke="hsl(${hue}, 70%, 72%)" stroke-opacity="0.12" stroke-width="2"/>
  <rect x="140" y="120" width="64" height="8" rx="4" fill="url(#accent)"/>
  <text x="140" y="86" font-family="Inter, Arial, Helvetica, sans-serif" font-size="34" font-weight="800" letter-spacing="1" fill="#E2E8F0">AIToolsNova</text>
  <text x="140" y="${startY - fontSize - 34}" font-family="Inter, Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="6" fill="hsl(${hue2}, 90%, 72%)">${escXml(part)}</text>
  ${headingTexts}
  <text x="1460" y="856" text-anchor="end" font-family="Inter, Arial, Helvetica, sans-serif" font-size="26" fill="#94A3B8">aitoolsnova.com</text>
</svg>
`;
}

/**
 * Write the branded offline fallback for one section. Rasterised to JPG via
 * sharp when possible (keeps the .jpg convention used everywhere on the site);
 * saved as SVG otherwise. Returns the final file basename.
 */
export async function writeBrandedSectionImage({ imgDir, baseName, heading, slug, index }) {
    await fs.mkdir(imgDir, { recursive: true });
    const svg = brandedSectionSvg({ heading, slug, index });
    const sharp = await trySharp();
    if (sharp) {
        try {
            const out = await sharp(Buffer.from(svg))
                .resize(SECTION_IMG_WIDTH, SECTION_IMG_HEIGHT)
                .jpeg({ quality: 88, progressive: true, mozjpeg: true })
                .toBuffer();
            const name = `${baseName}.jpg`;
            await fs.writeFile(path.join(imgDir, name), out);
            return name;
        } catch (e) {
            console.warn(`   ⚠️  SVG→JPG rasterise failed (${e.message}) — keeping SVG`);
        }
    }
    const name = `${baseName}.svg`;
    await fs.writeFile(path.join(imgDir, name), svg);
    return name;
}

// ---------------------------------------------------------------------------
// Gemini image generation (step 1)
// ---------------------------------------------------------------------------

const GEMINI_IMAGE_MODELS = process.env.GEMINI_IMAGE_MODEL
    ? [process.env.GEMINI_IMAGE_MODEL]
    : ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

function geminiKeyFromEnv() {
    return process.env.GEMINI_API_KEY || process.env.Gemini_API_key
        || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

/**
 * Generate one image with a Gemini image model and save it to destFile,
 * normalised with sharp to an exact JPEG size (Discover/social friendly).
 * Returns true on success; false means the caller should fall through to the
 * next step of the chain.
 */
export async function generateGeminiImage(prompt, destFile, { aspect = '16:9', width = SECTION_IMG_WIDTH, height = SECTION_IMG_HEIGHT, key = geminiKeyFromEnv(), model = process.env.GEMINI_MODEL || '' } = {}) {
    if (!key) return false;
    const text = `Generate a single photorealistic image, ${aspect} aspect. ${String(prompt).replace(/\s+/g, ' ').trim().slice(0, 800)}`;
    for (const m of GEMINI_IMAGE_MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
                if (/^gemini-2\.5|^gemini-3/i.test(m)) generationConfig.imageConfig = { aspectRatio: aspect };
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const msg = data?.error?.message || `HTTP ${res.status}`;
                    console.warn(`   ⚠️  [img:${m}] ${String(msg).slice(0, 180)}`);
                    break; // 4xx/5xx on this model -> try the next model
                }
                const parts = data?.candidates?.[0]?.content?.parts || [];
                const imgPart = parts.find((pt) => pt.inlineData && pt.inlineData.data);
                if (!imgPart) {
                    console.warn(`   ⚠️  [img:${m}] no image part (attempt ${attempt}/2)`);
                    await sleep(1200 * attempt);
                    continue;
                }
                const raw = Buffer.from(imgPart.inlineData.data, 'base64');
                if (raw.length < 8000) {
                    console.warn(`   ⚠️  [img:${m}] tiny image ${raw.length}b (attempt ${attempt}/2)`);
                    await sleep(1200 * attempt);
                    continue;
                }
                const sharp = await trySharp();
                const out = sharp
                    ? await sharp(raw)
                        .resize(width, height, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
                        .jpeg({ quality: 90, progressive: true, mozjpeg: true })
                        .toBuffer()
                    : raw;
                await fs.writeFile(destFile, out);
                console.log(`   ✔ Gemini image (${m}) -> ${path.basename(destFile)} (${(out.length / 1024).toFixed(0)} KB)`);
                return true;
            } catch (e) {
                console.warn(`   ⚠️  [img:${m}] ${e.message}`);
                await sleep(1200 * attempt);
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// The chain: one call = one brand-new unique image
// ---------------------------------------------------------------------------

/**
 * Generate ONE unique image for ONE section. Gemini → Pollinations (seeded
 * per section) → offline branded card with the section heading. Always
 * succeeds, always writes a fresh file - callers must never reuse another
 * section's image to fill a gap.
 *
 * @returns {Promise<string>} the file basename written into imgDir
 */
export async function generateUniqueSectionImage({ imgDir, slug, index, heading, label = '' }) {
    await fs.mkdir(imgDir, { recursive: true });
    const baseName = `${slug}-section-${index}`;
    const tag = label || baseName;
    const cleanHeading = String(heading || slug || '').replace(/<[^>]+>/g, ' ').trim();
    const prompt = `${cleanHeading || slug}, relevant editorial photograph, real people and setting, natural light, modern technology context, no text, no watermark`;

    // Step 1: Gemini (only attempted when a key is present)
    const jpgDest = path.join(imgDir, `${baseName}.jpg`);
    try {
        if (await generateGeminiImage(prompt, jpgDest, { aspect: '16:9' })) return `${baseName}.jpg`;
    } catch (e) {
        console.warn(`   ⚠️  [${tag}] Gemini step failed: ${e.message}`);
    }

    // Step 2: Pollinations, seeded per slug+section (stable + unique)
    try {
        const url = pollinationsUrl(prompt, seedFor(slug, 'section', String(index), cleanHeading));
        if (await downloadToLocalImage(url, jpgDest)) {
            console.log(`   ✔ Pollinations image -> ${baseName}.jpg`);
            return `${baseName}.jpg`;
        }
    } catch (e) {
        console.warn(`   ⚠️  [${tag}] Pollinations step failed: ${e.message}`);
    }

    // Step 3: offline branded fallback with the section heading (always works)
    const name = await writeBrandedSectionImage({ imgDir, baseName, heading: cleanHeading, slug, index });
    console.log(`   ✔ Branded offline fallback -> ${name}`);
    return name;
}

/**
 * Section-image QA used by verify-publish.mjs and the repair script: returns
 * the list of <img class="section-image"> srcs of one document, in order.
 */
export function listSectionImageSrcs(html) {
    const out = [];
    const re = /<img\b[^>]*class=["'][^"']*section-image[^"']*["'][^>]*>/gi;
    for (const m of html.matchAll(re)) {
        const src = m[0].match(/src=["']([^"']+)["']/i);
        out.push(src ? src[1] : '');
    }
    return out;
}

/** Duplicate section srcs within one document (empty array = all unique). */
export function duplicateSectionSrc(html) {
    const seen = new Set();
    const dupes = new Set();
    for (const src of listSectionImageSrcs(html)) {
        if (!src) continue;
        if (seen.has(src)) dupes.add(src);
        seen.add(src);
    }
    return [...dupes];
}
