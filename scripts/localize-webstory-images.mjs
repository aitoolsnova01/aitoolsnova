#!/usr/bin/env node
/**
 * Localize AMP Web Story images.
 * ------------------------------------------------------------
 * Existing web stories hot-link images live from image.pollinations.ai.
 * That is slow, unreliable and bad for indexing / Core Web Vitals, and
 * often the image simply never renders ("HD images nahi aa rahi").
 *
 * This script downloads every remote story image ONCE into
 * web-stories/img/ and rewrites the HTML to point at the local file,
 * served from the site's own domain (fast, cached, indexable, HD).
 *
 * It also swaps the invalid `.ico` publisher logo for the square PNG
 * required by Google Web Stories.
 *
 * Free (uses Pollinations' free endpoint). No API keys, no AI credits.
 * Run:  node scripts/localize-webstory-images.mjs
 */
import fs from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const STORIES_DIR = path.join(ROOT, 'web-stories');
const IMG_DIR = path.join(STORIES_DIR, 'img');
const SITE = 'https://aitoolsnova.com';
const REMOTE_RE = /https?:\/\/(?:image\.pollinations\.ai\/prompt|images\.unsplash\.com)\/[^"'\\\s)]+/g;
const CONCURRENCY = 1;
const THROTTLE_MS = 4000;

const hashName = (url) => crypto.createHash('md5').update(url).digest('hex').slice(0, 16) + '.jpg';

async function download(url, dest, tries = 3) {
    for (let i = 1; i <= tries; i++) {
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 90000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(to);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 1500) throw new Error('tiny image ' + buf.length);
            await fs.writeFile(dest, buf);
            return true;
        } catch (e) {
            console.warn(`  retry ${i}/${tries} ${path.basename(dest)}: ${e.message}`);
            await new Promise(r => setTimeout(r, 6000 * i));
        }
    }
    return false;
}

async function pool(items, worker) {
    const q = [...items];
    const runners = Array.from({ length: CONCURRENCY }, async () => {
        while (q.length) await worker(q.shift());
    });
    await Promise.all(runners);
}

async function main() {
    await fs.mkdir(IMG_DIR, { recursive: true });
    const files = readdirSync(STORIES_DIR).filter(f => f.endsWith('.html'));

    // Collect unique remote URLs across all stories
    const urlMap = new Map(); // url -> localFilename
    const perFile = {};
    for (const f of files) {
        const html = await fs.readFile(path.join(STORIES_DIR, f), 'utf-8');
        const urls = [...new Set(html.match(REMOTE_RE) || [])];
        perFile[f] = urls;
        for (const u of urls) if (!urlMap.has(u)) urlMap.set(u, hashName(u));
    }
    console.log(`Found ${urlMap.size} unique remote images across ${files.length} stories`);

    // Download the ones we don't already have
    const toGet = [...urlMap.entries()].filter(([, name]) => !existsSync(path.join(IMG_DIR, name)));
    let ok = 0, fail = 0;
    await pool(toGet, async ([url, name]) => {
        const good = await download(url, path.join(IMG_DIR, name));
        if (good) { ok++; console.log(`  ✔ ${name}`); } else { fail++; }
        await new Promise(r => setTimeout(r, THROTTLE_MS));
    });
    console.log(`Downloaded ${ok}, failed ${fail}, cached ${urlMap.size - toGet.length}`);

    // Rewrite each story: remote URL -> local absolute URL (only if file exists)
    for (const f of files) {
        let html = await fs.readFile(path.join(STORIES_DIR, f), 'utf-8');
        let changed = false;
        for (const u of perFile[f]) {
            const name = urlMap.get(u);
            if (!existsSync(path.join(IMG_DIR, name))) continue; // keep remote if dl failed
            const local = `${SITE}/web-stories/img/${name}`;
            if (html.includes(u)) { html = html.split(u).join(local); changed = true; }
        }
        // Fix invalid .ico publisher logo -> square PNG required by Web Stories
        if (html.includes('/fevicon.ico')) {
            html = html.split(`${SITE}/fevicon.ico`).join(`${SITE}/images/publisher-logo.png`);
            html = html.split('/fevicon.ico').join('/images/publisher-logo.png');
            changed = true;
        }
        if (changed) {
            await fs.writeFile(path.join(STORIES_DIR, f), html);
            console.log(`📝 rewrote ${f}`);
        }
    }
    console.log('✅ Localization done');
}

main().catch(e => { console.error(e); process.exit(1); });
