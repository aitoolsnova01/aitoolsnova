#!/usr/bin/env node
/**
 * Repair script for blog section images.
 *
 * Bug class 1 (missing): generate-blog.mjs historically only GENERATED images
 * for the first 4 sections but emitted an <img> for EVERY section, so sections
 * 5+ pointed at files that 404 — a "low value content" signal for AdSense
 * reviewers and Googlebot.
 *
 * Bug class 2 (duplicates): to avoid those 404s the generator then started
 * WRAPPING section-1..4 across all remaining sections, shipping 11 posts
 * where 11-15 sections shared only 4 images.
 *
 * This script fixes BOTH, permanently:
 *   Pass 1 — missing files: for every referenced /blog/img/* file that does
 *            not exist, generate a fresh on-topic image.
 *   Pass 2 — duplicates: for every post, walk the section images in document
 *            order; the second (and later) use of the same src gets a BRAND
 *            NEW unique image and the HTML is rewritten to point at it.
 *
 * Both passes use the shared chain from lib/section-images.mjs:
 *   Gemini (if GEMINI_API_KEY set) → Pollinations seeded per section
 *   → offline branded SVG/JPG card carrying the section heading.
 * The chain ALWAYS produces a fresh file, so nothing is ever copied/wrapped.
 *
 * Safe to re-run: existing unique files are never overwritten.
 *
 * Usage:
 *   node scripts/fix-broken-blog-images.mjs             repair missing + dupes
 *   node scripts/fix-broken-blog-images.mjs --check     report only, exit 1 if any
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
    downloadToLocalImage, pollinationsUrl, seedFor,
    generateUniqueSectionImage, writeBrandedSectionImage,
    listSectionImageSrcs, duplicateSectionSrc,
} from './lib/section-images.mjs';

const ROOT = process.cwd();
const BLOG_DIR = path.join(ROOT, 'blog');
const IMG_DIR = path.join(BLOG_DIR, 'img');
const CHECK_ONLY = process.argv.includes('--check');

/** Extract the alt text for a given image ref (best effort). */
function altFor(html, ref) {
    const escRe = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = html.match(new RegExp(`<img[^>]*src="${escRe}"[^>]*alt="([^"]*)"`, 'i'))
        || html.match(new RegExp(`<img[^>]*alt="([^"]*)"[^>]*src="${escRe}"`, 'i'));
    return m ? m[1].replace(/&[a-z]+;/gi, ' ').trim() : '';
}

/** The <h2> immediately preceding an <img> tag (best effort, for prompts). */
function headingBefore(html, imgIndex) {
    const before = html.slice(0, imgIndex);
    const h2s = [...before.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
    const last = h2s.at(-1);
    return last ? last[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 120) : '';
}

/** Replace exactly ONE occurrence of `src` inside one specific <img> tag. */
function replaceTagSrc(html, tagText, oldSrc, newSrc) {
    const newTag = tagText.replace(`src="${oldSrc}"`, `src="${newSrc}"`);
    const idx = html.indexOf(tagText);
    if (idx === -1) return html;
    return html.slice(0, idx) + newTag + html.slice(idx + tagText.length);
}

async function main() {
    await fs.mkdir(IMG_DIR, { recursive: true });
    const posts = readdirSync(BLOG_DIR).filter(f => f.endsWith('.html'));
    const stats = { missingFixed: 0, dupesFixed: 0, downloaded: 0, branded: 0, stillBroken: 0, postsRepaired: 0 };
    const perPost = [];

    for (const post of posts) {
        const slug = post.replace(/\.html$/, '');
        let html = await fs.readFile(path.join(BLOG_DIR, post), 'utf-8');
        let touched = false;

        // ---------------- Pass 1: missing referenced files ----------------
        const refs = [...new Set((html.match(/\/blog\/img\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp|svg)/g) || []))];
        for (const ref of refs) {
            const dest = path.join(ROOT, ref.replace(/^\//, ''));
            if (existsSync(dest) && statSync(dest).size > 1000) continue;
            if (CHECK_ONLY) { stats.stillBroken++; console.log(`   ✗ [check] missing: ${ref}`); continue; }

            const secMatch = ref.match(/-section-(\d+)\.(?:jpg|jpeg|png|webp|svg)$/i);
            const alt = altFor(html, ref) || slug.replace(/-/g, ' ');
            let writtenName = null;
            if (secMatch) {
                // Full chain (Gemini → Pollinations → branded) for section slots.
                const base = path.basename(ref).replace(/\.(jpg|jpeg|png|webp|svg)$/i, '');
                const tmpDir = IMG_DIR;
                writtenName = await generateUniqueSectionImage({
                    imgDir: tmpDir, slug, index: Number(secMatch[1]), heading: alt, label: path.basename(ref),
                });
                if (writtenName !== path.basename(ref) && existsSync(path.join(IMG_DIR, writtenName))) {
                    // extension changed (e.g. .jpg ref, .svg written) — repoint
                    html = html.split(ref).join(`/blog/img/${writtenName}`);
                    touched = true;
                }
            } else {
                // Hero/other slot: Pollinations seeded on the ref, then branded.
                const url = pollinationsUrl(`${alt}, editorial photograph, natural light, realistic, no text, no watermark`, seedFor(slug, 'repair', ref));
                const ok = await downloadToLocalImage(url, dest);
                if (ok) { writtenName = path.basename(ref); stats.downloaded++; }
                else {
                    writtenName = await writeBrandedSectionImage({ imgDir: IMG_DIR, baseName: path.basename(ref).replace(/\.(jpg|jpeg|png|webp|svg)$/i, ''), heading: alt, slug, index: 0 });
                    if (writtenName !== path.basename(ref)) {
                        html = html.split(ref).join(`/blog/img/${writtenName}`);
                        touched = true;
                    }
                }
            }
            if (writtenName) {
                stats.missingFixed++;
                if (/\.svg$/.test(writtenName) || writtenName !== path.basename(ref)) stats.branded++;
                console.log(`   ↳ ${post}: missing ${path.basename(ref)} → ${writtenName}`);
            } else {
                stats.stillBroken++;
                console.error(`   ✗ STILL BROKEN: ${ref}`);
            }
        }

        // ---------------- Pass 2: duplicate section images ----------------
        // The hero counts as "seen": a section may not reuse the hero either.
        const seen = new Set();
        const heroSrc = (html.match(/<img[^>]*class="[^"]*hero-image[^"]*"[^>]*src="([^"]+)"/i)
            || html.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*hero-image[^"]*"/i) || [])[1];
        if (heroSrc) seen.add(heroSrc);

        const tagRe = /<img\b[^>]*class="[^"]*section-image[^"]*"[^>]*>/gi;
        let ordinal = 0;
        let postDupes = 0;
        for (const m of html.matchAll(tagRe)) {
            ordinal++;
            const tag = m[0];
            const src = (tag.match(/src="([^"]+)"/) || [])[1] || '';
            if (!src) continue;
            if (!seen.has(src)) { seen.add(src); continue; }
            if (CHECK_ONLY) { stats.stillBroken++; console.log(`   ✗ [check] duplicate in ${post}: ${src} (section #${ordinal})`); continue; }

            // This section is re-using an earlier image — give it its own.
            const promptHeading = (tag.match(/alt="([^"]*)"/) || [])[1] || headingBefore(html, m.index) || slug.replace(/-/g, ' ');

            // Canonical unique slot for the Nth section image of this post.
            let index = ordinal;
            let base = `${slug}-section-${index}`;
            const referenced = new Set(listSectionImageSrcs(html));
            const existingFiles = new Set(readdirSync(IMG_DIR));
            const collides = (b) => ['jpg', 'jpeg', 'png', 'webp', 'svg'].some(ext => existingFiles.has(`${b}.${ext}`))
                || ['jpg', 'jpeg', 'png', 'webp', 'svg'].some(ext => referenced.has(`/blog/img/${b}.${ext}`));
            while (collides(base)) {
                index++;
                base = `${slug}-section-${index}`;
            }

            const name = await generateUniqueSectionImage({
                imgDir: IMG_DIR, slug, index, heading: promptHeading, label: `${post} #${ordinal}`,
            });
            const newSrc = `/blog/img/${name}`;
            html = replaceTagSrc(html, tag, src, newSrc);
            seen.add(newSrc);
            touched = true;
            postDupes++;
            stats.dupesFixed++;
            if (/\.svg$/.test(name)) stats.branded++;
            console.log(`   ↳ ${post}: section #${ordinal} ${path.basename(src)} → ${name} (unique)`);
        }

        // ---------------- Verify + persist ----------------
        const remaining = duplicateSectionSrc(html);
        if (remaining.length) {
            stats.stillBroken += remaining.length;
            console.error(`   ✗ ${post}: still has duplicate section image(s) after repair: ${remaining.join(', ')}`);
        }
        if (touched && !CHECK_ONLY) {
            await fs.writeFile(path.join(BLOG_DIR, post), html);
            stats.postsRepaired++;
        }
        if (postDupes || remaining.length) perPost.push({ post, dupesFixed: postDupes, remaining: remaining.length });
    }

    console.log(`\n${CHECK_ONLY ? '🔎 Check' : '✅ Repair'} done. missingFixed=${stats.missingFixed} dupesFixed=${stats.dupesFixed} postsRepaired=${stats.postsRepaired} brandedFallbacks=${stats.branded} stillBroken=${stats.stillBroken}`);
    if (perPost.length) {
        console.log('Per-post duplicate repairs:');
        for (const p of perPost) console.log(`   - ${p.post}: ${p.dupesFixed} new unique image(s)${p.remaining ? `, ${p.remaining} STILL DUPLICATED` : ''}`);
    }
    if (stats.stillBroken) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
