#!/usr/bin/env node
/**
 * scripts/rebuild-feed.mjs - rebuild feed.xml from what is actually in blog/
 * -------------------------------------------------------------------------
 * Why this file exists. feed.xml was a hand-written file:
 *   * nothing in the pipeline regenerated it, so it stopped at 2026-08-20 while
 *     posts kept landing - subscribers and Google were fed a stale feed;
 *   * every <pubDate> was the same "06:00:00 GMT", so two posts published on one
 *     day looked like two copies of the same post published at the same second;
 *   * nothing de-duplicated <link>/<guid>, so a re-published topic stacked a
 *     second identical item.
 *
 * The generator now calls buildFeed() after every successful publish, and
 * `node scripts/rebuild-feed.mjs --check` is wired into the health check so the
 * feed can never silently rot again.
 *
 * Usage:
 *   node scripts/rebuild-feed.mjs             rewrite feed.xml
 *   node scripts/rebuild-feed.mjs --dry-run   print what would change
 *   node scripts/rebuild-feed.mjs --check     exit 1 when the feed is stale
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isoDate, normalizeTitle, parseArgs } from './lib/publish-core.mjs';

const SITE = process.env.SITE_URL || 'https://aitoolsnova.com';
const MAX_ITEMS = Number(process.env.FEED_ITEMS || 30);
// Publish window used to spread items across the day. The pipeline publishes in
// the early UTC hours, and a deterministic per-slug offset means the feed never
// shows two posts with the same timestamp (and never re-shuffles between runs).
const WINDOW_START_HOUR = 4;
const WINDOW_MINUTES = 9 * 60;

const esc = (s = '') => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // kill any control char an LLM answer can smuggle into a description
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');

function first(html, re) {
    const m = html.match(re);
    return m ? m[1].trim() : '';
}

/**
 * CI and local tests generate throwaway posts (scripts/test-e2e-mock.mjs writes
 * "Mock Test Post Please Ignore <ts>" into blog/ for a second). The feed is the
 * one public artifact that must never carry them, so anything that smells like a
 * test fixture is skipped here. The staleness gate still looks at blog/, so this
 * filter can never hide a real post that failed to reach the feed.
 * FEED_ALLOW_MOCK=1 turns the filter off (tests assert both behaviours).
 */
const MOCKISH = /(mock|please ignore|test only|for test only|placeholder post|^test[-_])/i;

function isTestPost(slug, title) {
    if (process.env.FEED_ALLOW_MOCK === '1') return false;
    return MOCKISH.test(String(slug || '')) || MOCKISH.test(String(title || ''));
}

/** One feed item per published article, newest first. */
export function collectFeedItems(root = process.cwd()) {
    const dir = path.join(root, 'blog');
    if (!existsSync(dir)) return [];
    const out = [];
    const skipped = [];
    for (const f of readdirSync(dir).filter(x => x.endsWith('.html'))) {
        let html = '';
        try { html = readFileSync(path.join(dir, f), 'utf8').slice(0, 40_000); } catch { continue; }
        const slug = f.replace(/\.html$/, '');
        const date = first(html, /"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/)
            || first(html, /article:published_time"\s+content="(\d{4}-\d{2}-\d{2})/)
            || first(html, /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
        const title = first(html, /<title>([^<|]+)/) || first(html, /<h1[^>]*>([^<]+)/) || slug;
        const description = first(html, /<meta\s+name="description"\s+content="([^"]+)"/);
        if (isTestPost(slug, title)) { skipped.push(slug); continue; }
        out.push({ slug, date, title, description, url: `${SITE}/blog/${slug}` });
    }
    // Newest first. Ties are broken by slug so the order is stable across runs
    // (an unstable sort used to rewrite the whole file for no reason).
    out.sort((a, b) => (b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)));
    const seen = new Set();
    const list = out.filter((it) => {
        const key = normalizeTitle(it.title) || it.slug;
        if (seen.has(key)) return false;      // never list one headline twice
        seen.add(key);
        return true;
    }).slice(0, MAX_ITEMS);
    // carried along so --check can explain a "stale" verdict (test fixtures are
    // deliberately filtered out, and that must never look like a missing post)
    list.skippedTestPosts = skipped;
    return list;
}

/** Deterministic "HH:MM:SS" inside the publish window, derived from the slug. */
function stampFor(dateISO, slug) {
    const h = crypto.createHash('md5').update(`${dateISO}:${slug}`).digest();
    const minuteOffset = h.readUInt16BE(0) % WINDOW_MINUTES;
    const mins = WINDOW_START_HOUR * 60 + minuteOffset;
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const ss = String(h[4] % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

export function renderFeed(items, builtAt = new Date()) {
    const rfc = (d) => new Date(d).toUTCString().replace('GMT', 'GMT');
    const body = items.map((it) => {
        const stamp = stampFor(it.date, it.slug);
        return `  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(it.url)}</link>
    <guid isPermaLink="true">${esc(it.url)}</guid>
    <pubDate>${esc(rfc(`${it.date}T${stamp}Z`))}</pubDate>
    <description>${esc(it.description || it.title)}</description>
  </item>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>AIToolsNova Blog</title>
  <link>${SITE}/blogs</link>
  <description>Practical, honest guides on free AI tools - written for real students, freelancers and small businesses. No hype, limits included.</description>
  <language>en</language>
  <lastBuildDate>${esc(rfc(builtAt.toISOString()))}</lastBuildDate>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
${body}
</channel>
</rss>
`;
}

/**
 * @returns {{items:number, written:boolean, changed:boolean, stale:boolean,
 *            staleDays:number, missing:string[], duplicateTimes:number}}
 */
export async function buildFeed({ root = process.cwd(), write = true, now = new Date() } = {}) {
    const feedPath = path.join(root, 'feed.xml');
    const items = collectFeedItems(root);
    const text = renderFeed(items, now);
    const before = existsSync(feedPath) ? readFileSync(feedPath, 'utf8') : '';
    const missing = items.slice(0, 5).map(i => i.url).filter(u => !before.includes(u));
    const times = (before.match(/<pubDate>([^<]+)<\/pubDate>/g) || []);
    const duplicateTimes = times.length - new Set(times).size;
    const newestDate = items[0]?.date || '';
    const inFeed = /<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(before)?.[1] || '';
    const builtDay = inFeed ? new Date(inFeed).toISOString().slice(0, 10) : '';
    const staleDays = builtDay && newestDate ? Math.max(
        0, Math.round((Date.parse(`${isoDate()}T00:00:00Z`) - Date.parse(`${builtDay}T00:00:00Z`)) / 86400000)
    ) : 999;
    const stale = missing.length > 0 || !before.trim();
    if (write && text !== before) {
        await fs.writeFile(feedPath, text, 'utf8');
    }
    return {
        items: items.length,
        written: write && text !== before,
        changed: text !== before,
        stale,
        staleDays,
        missing,
        duplicateTimes,
        newestDate,
        skippedTestPosts: items.skippedTestPosts || [],
        text,
    };
}

const ARGS = parseArgs();
const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
    const root = path.resolve(process.env.REPO_ROOT || process.cwd());
    if (ARGS.flags.check) {
        const res = await buildFeed({ root, write: false });
        const lines = [
            `feed.xml: ${res.items} item(s), newest article ${res.newestDate || 'none'}`,
            res.stale ? `STALE - not listed in the feed: ${res.missing.join(', ')}` : 'up to date',
            res.skippedTestPosts.length ? `filtered test fixtures: ${res.skippedTestPosts.join(', ')}` : '',
            res.duplicateTimes ? `WARN - ${res.duplicateTimes} item(s) share a pubDate with another item` : 'every item has a distinct timestamp',
        ];
        console.log(lines.join('\n'));
        if (res.stale) process.exit(1);
        process.exit(0);
    }
    const dryRun = ARGS.bool('dry-run', false);
    const res = await buildFeed({ root, write: !dryRun });
    console.log(`${dryRun ? 'DRY RUN - ' : ''}feed.xml: ${res.items} item(s), ${res.changed ? 'changed' : 'unchanged'}${res.missing.length ? `, added: ${res.missing.join(', ')}` : ''}`);
}
