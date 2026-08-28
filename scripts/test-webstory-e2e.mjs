#!/usr/bin/env node
/**
 * End-to-end MOCK test for the web story job.
 *
 * Runs scripts/generate-webstory.mjs as a subprocess with globalThis.fetch
 * mocked (no Groq, no network), then asserts the parts that silently broke in
 * production:
 *   - a story file is actually written and listed on /web-stories
 *   - sitemap.xml gets the new URL
 *   - the run is recorded in scripts/publish-log.json + publish-status.json
 *     (so "green but empty" cannot happen unnoticed)
 *   - .github/workflows is never touched by the story job (the poisoned-index
 *     bug that made every story run red)
 *   - a second run says "already up to date" and exits 0 (idempotent re-runs)
 *
 * Everything the test writes is restored afterwards.
 * Run: node scripts/test-webstory-e2e.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const STORIES_INDEX = path.join(ROOT, 'web-stories.html');
const LEDGER = path.join(ROOT, 'scripts', 'publish-log.json');
const STATUS = path.join(ROOT, 'publish-status.json');
const STORIES_DIR = path.join(ROOT, 'web-stories');
const STORY_IMG_DIR = path.join(STORIES_DIR, 'img');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const readOr = f => fs.readFile(f, 'utf8').catch(() => null);
const backups = new Map();
for (const f of [SITEMAP, STORIES_INDEX, LEDGER, STATUS]) backups.set(f, await readOr(f));
const storiesBefore = new Set(readdirSync(STORIES_DIR).filter(f => f.endsWith('.html')));
const storyImgsBefore = new Set(existsSync(STORY_IMG_DIR) ? readdirSync(STORY_IMG_DIR) : []);
const wfBefore = new Map();
for (const f of readdirSync(WF_DIR)) wfBefore.set(f, await readOr(path.join(WF_DIR, f)));

const SLUG = 'mock-e2e-story-' + Date.now().toString(36);
const mockLoader = path.join(ROOT, 'scripts', '_mock-story-loader.mjs');
await fs.writeFile(mockLoader, `
const story = {
  story_title: 'Mock Story 10 AI Hacks For Test Only',
  meta_description: 'A mock web story used only by the automated pipeline test. Nothing here is published for real.',
  cover_caption: 'Ten mock AI hacks for the test pipeline only.',
  cover_image_prompt: 'photorealistic laptop on a desk',
  slides: Array.from({ length: 10 }, (_, i) => ({
    heading: 'Mock Tip ' + (i + 1),
    caption: 'Mock caption number ' + (i + 1) + ' with enough words to look like a real slide for the pipeline test.',
    image_prompt: 'photorealistic office scene ' + (i + 1)
  })),
  cta_line: 'Try the free AI tools on AIToolsNova.'
};
const topic = { title: 'Mock Story 10 AI Hacks For Test Only', slug: '${SLUG}', category: 'ai', emoji: '🧪', hero_prompt: 'test' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.groq.com') || u.includes('/api/gemini')) {
    const body = String(opts?.body || '');
    const payload = body.includes('slides') ? story : topic;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('indexnow.org')) return new Response('', { status: 200 });
  if (u.includes('pollinations')) return new Response('not-an-image', { status: 500 });
  return realFetch(url, opts);
};
const mod = await import('./generate-webstory.mjs');
try {
  await mod.main();
} catch (e) {
  console.error('MOCK-RUN-FAILED:', e && e.message ? e.message : String(e));
  process.exit(1);
}
`);

const run = () => spawnSync('node', ['scripts/_mock-story-loader.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
        ...process.env,
        GROQ_API_KEY: 'mock-key-for-test',
        SITE_API_FALLBACK: '0',
        AUTO_BLOG_FALLBACK: '0',
        HEAL_WORKFLOWS: '0',
        // one story per run so the assertions + the "nothing to do" re-run are
        // deterministic (backfill planning is unit-tested separately)
        BACKFILL_MAX: '0',
    },
});

const r1 = run();
const out1 = (r1.stdout || '') + (r1.stderr || '');
console.log(out1.split('\n').slice(0, 60).join('\n'));

const newStories = readdirSync(STORIES_DIR).filter(f => f.endsWith('.html') && !storiesBefore.has(f));
const storyFile = newStories[0] ? path.join(STORIES_DIR, newStories[0]) : null;
let storyHtml = storyFile ? await fs.readFile(storyFile, 'utf8') : '';
const sitemapNow = await fs.readFile(SITEMAP, 'utf8');
const indexNow = await fs.readFile(STORIES_INDEX, 'utf8');
const ledger = JSON.parse((await readOr(LEDGER)) || '{"entries":[]}');
const statusRaw = (await readOr(STATUS)) || '';

const checks = [
    ['story run exited 0', r1.status === 0, `exit=${r1.status}`],
    ['a story file was written', !!storyFile, newStories.join(',')],
    ['story uses amp-story + 12 pages', /<amp-story /.test(storyHtml) && (storyHtml.match(/amp-story-page id=/g) || []).length === 12,
        `${(storyHtml.match(/amp-story-page id=/g) || []).length} pages`],
    ['story carries AdSense + GA tags', storyHtml.includes('ca-pub-2278101269918728') && storyHtml.includes('G-KJ0WTD0R0M')],
    ['story has no hot-linked images', !/image\.pollinations\.ai/.test(storyHtml.split('\n').filter(l => l.includes('src=')).join('\n'))],
    ['sitemap.xml lists the new story', !!storyFile && sitemapNow.includes(`/web-stories/${newStories[0].replace('.html', '')}`)],
    ['web-stories.html lists the new story', !!storyFile && indexNow.includes(newStories[0].replace('.html', ''))],
    ['ledger recorded an ok webstory entry', ledger.entries.some(e => e.kind === 'webstory' && e.status === 'ok')],
    ['publish-status.json updated', /"webstory"/.test(statusRaw)],
    ['.github/workflows untouched (no poisoned index)', (() => {
        const now = readdirSync(WF_DIR).filter(f => !f.startsWith('.'));
        if (now.length !== wfBefore.size) return false;
        return now.every(f => readFileSync(path.join(WF_DIR, f), 'utf8') === wfBefore.get(f));
    })()],
];

// Idempotency: a second run must not double-publish the same day.
const r2 = run();
const out2 = (r2.stdout || '') + (r2.stderr || '');
checks.push(['second run exits 0', r2.status === 0, `exit=${r2.status}`]);
checks.push(['second run reports up-to-date (no duplicate)', /already has|Nothing to do|up to date/i.test(out2)
    && readdirSync(STORIES_DIR).filter(f => f.endsWith('.html') && !storiesBefore.has(f)).length <= newStories.length, 'no extra story']);
checks.push(['second run did not push a duplicate story', readdirSync(STORIES_DIR).filter(f => f.endsWith('.html') && !storiesBefore.has(f)).length === newStories.length]);

// ---------- cleanup ----------
for (const f of newStories) await fs.unlink(path.join(STORIES_DIR, f)).catch(() => {});
if (existsSync(STORY_IMG_DIR)) {
    // Anything the run added (named after the source blog slug, not after our
    // mock slug) must go, or the asset audit flags them as orphan images.
    const imgs = readdirSync(STORY_IMG_DIR).filter(f => !storyImgsBefore.has(f));
    for (const f of imgs) await fs.unlink(path.join(STORY_IMG_DIR, f)).catch(() => {});
}
for (const [f, content] of backups) {
    if (content === null) await fs.unlink(f).catch(() => {});
    else await fs.writeFile(f, content);
}
await fs.unlink(mockLoader).catch(() => {});

if (process.env.E2E_DEBUG === '1') {
    await fs.writeFile(path.join(ROOT, 'test_reports', 'webstory-e2e.log'),
        `--- run1 (exit ${r1.status}) ---\n${out1}\n--- run2 (exit ${r2.status}) ---\n${out2}\n`);
}
let failed = 0;
for (const [name, ok, extra] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
}
console.log(`\n${checks.length - failed} passed / ${failed} failed (story pipeline)`);
process.exit(failed ? 1 : 0);
