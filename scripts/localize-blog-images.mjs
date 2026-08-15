#!/usr/bin/env node
/**
 * Localize blog hero/content images that are hot-linked live from
 * image.pollinations.ai / images.unsplash.com. Live hot-linking makes blog
 * pages SLOW (big LCP) and unreliable. We download each image once into
 * blog/img/ and rewrite the HTML to a root-relative /blog/img/ path so it
 * loads fast from our own domain (and works in preview + production).
 *
 * Free (Pollinations/Unsplash are free), no API keys.
 * Run: node scripts/localize-blog-images.mjs
 */
import fs from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const IMG_DIR = path.join(BLOG_DIR, 'img');
const REMOTE_RE = /https?:\/\/(?:image\.pollinations\.ai\/prompt|images\.unsplash\.com)\/[^"'\\\s)]+/g;

const hashName = (u) => crypto.createHash('md5').update(u).digest('hex').slice(0, 16) + '.jpg';

async function download(url, dest, tries = 3) {
    for (let i = 1; i <= tries; i++) {
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 90000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(to);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 1500) throw new Error('tiny');
            await fs.writeFile(dest, buf);
            return true;
        } catch (e) {
            await new Promise(r => setTimeout(r, 5000 * i));
        }
    }
    return false;
}

async function main() {
    await fs.mkdir(IMG_DIR, { recursive: true });
    const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.html'));
    let rewritten = 0, got = 0, fail = 0;
    for (const f of files) {
        const p = path.join(BLOG_DIR, f);
        let html = await fs.readFile(p, 'utf-8');
        const urls = [...new Set(html.match(REMOTE_RE) || [])];
        if (!urls.length) continue;
        let changed = false;
        for (const u of urls) {
            const name = hashName(u);
            const dest = path.join(IMG_DIR, name);
            const ok = existsSync(dest) || await download(u, dest);
            if (ok) {
                got += existsSync(dest) ? 1 : 0;
                html = html.split(u).join(`/blog/img/${name}`);
                changed = true;
            } else {
                fail++;
                console.warn(`  ⚠️ keep remote (dl failed): ${u.slice(0, 60)}`);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
        if (changed) { await fs.writeFile(p, html); rewritten++; console.log(`📝 ${f}`); }
    }
    console.log(`✅ Blog images localized. files rewritten: ${rewritten}, downloaded: ${got}, failed: ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
