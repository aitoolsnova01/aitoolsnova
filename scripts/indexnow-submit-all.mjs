#!/usr/bin/env node
/**
 * IndexNow bulk submit — pushes EVERY URL in sitemap.xml to IndexNow
 * (Bing, Yandex, Naver, Seznam) in one shot so the whole site gets picked
 * up fast, not just newly published pages.
 *
 * Uses the IndexNow key file already present at repo root. No login needed.
 * Run:  node scripts/indexnow-submit-all.mjs
 */
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SITE = 'https://aitoolsnova.com';
const HOST = 'aitoolsnova.com';

const KEY = process.env.INDEXNOW_KEY || (() => {
    const f = readdirSync(ROOT).find(x => /^[a-f0-9]{32}\.txt$/i.test(x));
    return f ? f.replace('.txt', '') : '';
})();

async function main() {
    if (!KEY) { console.error('No IndexNow key found at repo root'); process.exit(1); }
    const xml = await fs.readFile(path.join(ROOT, 'sitemap.xml'), 'utf-8');
    const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
    if (!urls.length) { console.error('No <loc> URLs in sitemap'); process.exit(1); }

    // IndexNow allows up to 10,000 URLs per request; chunk to be safe.
    const chunkSize = 5000;
    for (let i = 0; i < urls.length; i += chunkSize) {
        const urlList = urls.slice(i, i + chunkSize);
        const res = await fetch('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                host: HOST,
                key: KEY,
                keyLocation: `${SITE}/${KEY}.txt`,
                urlList,
            }),
        });
        console.log(`IndexNow submitted ${urlList.length} URLs -> HTTP ${res.status}`);
    }
    // Also nudge Bing's sitemap endpoint.
    await fetch(`https://www.bing.com/ping?sitemap=${SITE}/sitemap.xml`).catch(() => {});
    console.log(`✅ Done. Total URLs: ${urls.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
