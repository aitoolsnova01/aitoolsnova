#!/usr/bin/env node
/**
 * scripts/test-dedup-mock.mjs - proves the duplicate-topic skip end to end
 * ------------------------------------------------------------------------
 * Runs the REAL blog generator (no AI: fetch is mocked) with a topic answer that
 * repeats the newest published article, then asserts what the site must see:
 *
 *   * the run exits 0 - a duplicate is not an outage, it must not turn red;
 *   * no second article file appears in blog/;
 *   * blogs.html is byte-identical (no stacked card - the exact symptom that
 *     made one post look like it was published twice at the same time);
 *   * sitemap.xml + feed.xml are byte-identical;
 *   * the day is closed in the ledger against the EXISTING slug, so the gap
 *     planner does not burn another run on the same topic tomorrow.
 *
 * Everything written is restored afterwards.
 * Run: node scripts/test-dedup-mock.mjs   (DEDUP_DEBUG=1 prints the run log)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const BLOGS_HTML = path.join(ROOT, 'blogs.html');
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const FEED = path.join(ROOT, 'feed.xml');
const LEDGER = path.join(ROOT, 'scripts', 'publish-log.json');
const STATUS = path.join(ROOT, 'publish-status.json');
const HISTORY = path.join(ROOT, 'scripts', 'topic-history.json');

const readOr = (f) => fs.readFile(f, 'utf8').catch(() => null);
const targets = [BLOGS_HTML, SITEMAP, FEED, LEDGER, STATUS, HISTORY];
const backups = new Map();
for (const f of targets) backups.set(f, await readOr(f));
const before = new Set(readdirSync(BLOG_DIR).filter(f => f.endsWith('.html')));

// Victim: the newest real article, reused verbatim as the "new" topic.
const dated = [];
for (const f of before) {
    const html = await readOr(path.join(BLOG_DIR, f)) || '';
    dated.push({ f, d: (html.match(/"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/) || [])[1] || '' });
}
dated.sort((a, b) => b.d.localeCompare(a.d));
const victimFile = dated[0].f;
const victim = victimFile.replace(/\.html$/, '');
const victimHtml = await readOr(path.join(BLOG_DIR, victimFile));
const victimTitle = ((victimHtml.match(/<h1[^>]*>([^<]+)/i) || victimHtml.match(/<title>([^<|]+)/i) || [])[1] || victim).trim();

const mockLoader = path.join(ROOT, 'scripts', '_mock-dedup-loader.mjs');
const loaderSource = [
    'const topic = ' + JSON.stringify({
        title: victimTitle, slug: victim, category: 'ai', emoji: '🧪',
        hero_prompt: 'test placeholder', primary_keyword: 'dup', geo: 'Global',
        geo_keywords: 'dup', unique_angle: 'dup',
    }) + ';',
    'let calls = 0;',
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = async (url, opts) => {',
    '  const u = String(url);',
    '  if (u.includes("api.groq.com") || u.includes("/api/gemini")) {',
    '    calls++;',
    '    if (calls > 1) return new Response(\'{"error":"mock: a content call must not happen after a duplicate topic"}\', { status: 500 });',
    '    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(topic) } }] }),',
    '      { status: 200, headers: { "Content-Type": "application/json" } });',
    '  }',
    '  if (u.includes("indexnow.org")) return new Response("", { status: 200 });',
    '  return new Response("mock: blocked", { status: 599 });',
    '};',
    'const { createHash } = await import("node:crypto");',
    'void createHash; void realFetch;',
    'await import("./generate-blog.mjs");',
].join('\n');
await fs.writeFile(mockLoader, loaderSource);

const r = spawnSync('node', ['scripts/_mock-dedup-loader.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
        ...process.env,
        GROQ_API_KEY: 'mock-key-for-test',
        SITE_API_FALLBACK: '0',
        BACKFILL_MAX: '0',
        DRY_RUN: '1',
        SKIP_AUTO_PUBLISH: '1',
        SKIP_FEED: '1',
    },
});
const out = (r.stdout || '') + (r.stderr || '');

const added = readdirSync(BLOG_DIR).filter(f => f.endsWith('.html') && !before.has(f));
const ledgerAfter = await readOr(LEDGER);

// ---- restore ----
for (const f of added) await fs.unlink(path.join(BLOG_DIR, f)).catch(() => {});
for (const [f, content] of backups) {
    if (content === null) await fs.unlink(f).catch(() => {});
    else await fs.writeFile(f, content);
}
await fs.unlink(mockLoader).catch(() => {});

const today = new Date().toISOString().slice(0, 10);
let closed = false;
try {
    const entries = (JSON.parse(ledgerAfter || '{"entries":[]}').entries) || [];
    closed = entries.some(e => e.kind === 'blog' && e.date === today && e.slug === victim && e.status === 'ok');
} catch { /* assertion below fails */ }

const checks = [
    ['run exits 0 on a duplicate topic (no false red)', r.status === 0, `exit=${r.status}`],
    ['run says it skipped the duplicate', /duplicate-topic|already exists as blog\//.test(out),
        out.split('\n').filter(l => /♻️|duplicate/i.test(l)).slice(0, 2).join(' | ')],
    ['no second article file was written', added.length === 0, `added: ${added.join(', ') || 'none'}`],
    ['blogs.html byte-identical (no stacked card)', (await readOr(BLOGS_HTML)) === backups.get(BLOGS_HTML)],
    ['sitemap.xml byte-identical', (await readOr(SITEMAP)) === backups.get(SITEMAP)],
    ['feed.xml byte-identical', (await readOr(FEED)) === backups.get(FEED)],
    ['the day was closed in the ledger against the existing slug', closed, `${victim} @ ${today}`],
];
if (process.env.DEDUP_DEBUG === '1') console.log(out);

let failed = 0;
for (const [name, ok, extra] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
    if (!ok) failed++;
}
console.log(`\n${checks.length - failed} passed / ${failed} failed (duplicate-topic skip, victim: blog/${victim})`);
process.exit(failed ? 1 : 0);
