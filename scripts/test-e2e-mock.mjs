#!/usr/bin/env node
/**
 * End-to-end MOCK test — runs the full pipeline WITHOUT hitting Groq.
 * Monkey-patches globalThis.fetch to return canned Groq responses,
 * then executes generate-blog.mjs as a subprocess with GROQ_API_KEY=mock.
 *
 * After run: restores blogs.html + sitemap.xml + removes generated blog file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const BLOGS_HTML = path.join(ROOT, 'blogs.html');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');
const HISTORY_FILE = path.join(ROOT, 'scripts', 'topic-history.json');
const FEED_FILE = path.join(ROOT, 'feed.xml');
const feedBackup = await fs.readFile(FEED_FILE, 'utf8').catch(() => null);

// Backup
const blogsBackup = await fs.readFile(BLOGS_HTML, 'utf-8');
const sitemapBackup = await fs.readFile(SITEMAP_XML, 'utf-8');
const historyBackup = await fs.readFile(HISTORY_FILE, 'utf-8').catch(() => '{"topics":[]}');
const LEDGER_FILE = path.join(ROOT, 'scripts', 'publish-log.json');
const STATUS_FILE = path.join(ROOT, 'publish-status.json');
const readOr = async (f) => (await fs.readFile(f, 'utf-8').catch(() => null));
const ledgerBackup = await readOr(LEDGER_FILE);
const statusBackup = await readOr(STATUS_FILE);
console.log('📦 Backups taken.');

// Create a fetch-mock wrapper module
const mockLoader = path.join(ROOT, 'scripts', '_mock-loader.mjs');
await fs.writeFile(mockLoader, `
const realFetch = globalThis.fetch;
let call = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.groq.com')) {
    call++;
    if (call === 1) {
      // Topic response
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          title: 'Mock Test Post Please Ignore ' + Date.now(),
          slug: 'mock-test-post-' + Date.now(),
          category: 'ai',
          emoji: '🧪',
          hero_prompt: 'test placeholder blue geometric'
        })}}]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } else {
      // Content response
      const sections = Array.from({length: 7}, (_, i) => ({
        h2: 'Section ' + (i+1),
        body_html: '<p>Section ' + (i+1) + ' explains a realistic workflow in enough detail to exercise the production quality gate. A reader can follow each step, understand why it matters, compare the available options, and avoid common mistakes before using the tool on an important project.</p><p>The mock article also includes practical context, clear limitations, and a short example so the automated test resembles valid long-form output rather than thin placeholder text. It describes the expected input, the processing stage, and the final export in plain language that a beginner can understand without specialist knowledge.</p><p>Before choosing a service, readers should test accuracy with non-sensitive data, check whether the free plan adds limits, and confirm that the downloaded result opens correctly. This repeatable process catches quality problems early and makes comparisons fair.</p><p>A useful review should mention both strengths and trade-offs. Fast output is valuable, but privacy, reliability, accessibility, and control over the final result matter just as much for real work.</p><p>For the best outcome, save the original file, record the settings used, and compare the result at normal viewing size instead of relying only on a small preview. If something looks wrong, change one setting at a time and run the same sample again. Clear notes make it easier to reproduce a good result later, explain the workflow to a teammate, and decide whether a paid feature is genuinely necessary.</p><ul><li>Start with a small sample and verify the result.</li><li>Review privacy, pricing, and export settings before publishing.</li></ul>'
      }));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          meta_description: 'Mock meta description used only for the automated pipeline test. Does not appear in production.',
          meta_keywords: 'mock, test, aitoolsnova, pipeline, autoblog',
          read_time_min: 6,
          intro_html: '<p>This is a mock intro paragraph for testing.</p><p>Second paragraph here.</p>',
          sections,
          faqs: [
            { q: 'Is this a real post?', a: 'No, it is a mock generated during CI.' },
            { q: 'Will it appear live?', a: 'No, mock posts are cleaned up immediately.' }
          ],
          conclusion_html: '<p>Mock conclusion paragraph 1.</p><p>Mock conclusion paragraph 2.</p>',
          related_tools: ['ai-chat.html','ai-writer.html','ai-image-generator.html','youtube-kit.html'],
          related_blogs: ['best-free-ai-tools-2026.html','top-100-ai-tools-2026.html','ai-productivity-tools.html']
        })}}]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  // IndexNow / all other → pass-through (or 200 mock)
  if (u.includes('indexnow.org')) {
    return new Response('', { status: 200 });
  }
  return realFetch(url, opts);
};
await import('./generate-blog.mjs');
`);

// Run the mock loader as an ESM script
const r = spawnSync('node', ['scripts/_mock-loader.mjs'], {
    // BACKFILL_MAX=0 -> exactly one post per run, so the assertions below stay
    // deterministic. Catch-up planning itself is covered by
    // scripts/test-publish-core.mjs (planGaps) and scripts/test-site-health.mjs.
    env: { ...process.env, GROQ_API_KEY: 'mock-key-for-test', BACKFILL_MAX: '0' },
    encoding: 'utf-8',
    cwd: ROOT
});
console.log(r.stdout);
if (r.stderr) console.error(r.stderr);
const exitCode = r.status;

// Verify the generated file
const blogFiles = await fs.readdir(path.join(ROOT, 'blog'));
const mockFile = blogFiles.find(f => f.startsWith('mock-test-post-'));
let mockChecks = [];
if (mockFile) {
    const content = await fs.readFile(path.join(ROOT, 'blog', mockFile), 'utf-8');
    mockChecks = [
        ['Generated file exists: ' + mockFile, true],
        ['Contains AdSense pub-id',            content.includes('ca-pub-2278101269918728')],
        ['Contains GA id',                     content.includes('G-KJ0WTD0R0M')],
        ['Contains canonical URL',             content.includes('rel="canonical"')],
        ['Contains OG image (pollinations)',   content.includes('image.pollinations.ai')],
        ['Contains hero <img> tag',            content.includes('class="hero-image"')],
        ['Contains Article JSON-LD',           content.includes('"@type": "Article"')],
        ['Contains FAQPage JSON-LD',           content.includes('"@type": "FAQPage"')],
        ['Contains at least 5 H2 sections',   (content.match(/<h2>/g) || []).length >= 5],
        ['Contains all 7 mock sections',       content.includes('Section 7')],
        ['File size > 8KB',                    content.length > 8000]
    ];
    const newBlogsHtml = await fs.readFile(BLOGS_HTML, 'utf-8');
    mockChecks.push(['blogs.html card injected', newBlogsHtml.includes(mockFile.replace('.html',''))]);
    const newSitemap = await fs.readFile(SITEMAP_XML, 'utf-8');
    // Sitemap now uses extensionless URLs (the .html form 308-redirects).
    const mockSlug = mockFile.replace(/\.html$/, '');
    mockChecks.push(['sitemap.xml URL injected', newSitemap.includes('/blog/' + mockSlug)]);

    // --- publish bookkeeping: the run must be auditable, not silently green ---
    const ledgerRaw = await readOr(LEDGER_FILE);
    mockChecks.push(['publish-log.json written by the run', !!ledgerRaw]);
    let ledgerOk = false, ledgerDate = '';
    try {
        const entries = JSON.parse(ledgerRaw || '{}').entries || [];
        const mine = entries.find(e => e.slug === mockFile.replace(/\.html$/, '') || (e.kind === 'blog' && e.status === 'ok'));
        ledgerOk = !!mine && mine.status === 'ok';
        ledgerDate = mine?.date || '';
    } catch { /* assertion below fails */ }
    mockChecks.push(['ledger records an ok blog entry', ledgerOk]);
    mockChecks.push(['ledger entry is dated', /^\d{4}-\d{2}-\d{2}$/.test(ledgerDate)]);
    const statusRaw = await readOr(STATUS_FILE);
    mockChecks.push(['publish-status.json written', !!statusRaw]);
    mockChecks.push(['publish-status.json says ok', /"ok": true/.test(statusRaw || '')]);
    mockChecks.push(['publish-status.json leaks no API keys', !/mock-key-for-test|gsk_/.test(statusRaw || '')]);
    // The generator refreshes feed.xml after a publish: a mock post must never
    // reach a public artifact, and the run must still restore it.
    const feedAfter = await fs.readFile(FEED_FILE, 'utf8').catch(() => '');
    mockChecks.push(['feed.xml never lists the mock post', !feedAfter.includes(mockSlug)]);
} else {
    mockChecks = [['Generated blog file NOT found — pipeline broken!', false]];
}

// Cleanup: remove mock file + its generated images + restore blogs.html + sitemap + history
// generate-blog.mjs writes blog/img/<slug>-hero.jpg and <slug>-section-N.jpg next to
// the post. Removing only the HTML left those JPEGs behind as untracked files, which
// the auto-publish job then committed to main on every CI run.
if (mockFile) await fs.unlink(path.join(ROOT, 'blog', mockFile)).catch(() => {});
{
    const imgDir = path.join(ROOT, 'blog', 'img');
    const leftovers = (await fs.readdir(imgDir).catch(() => []))
        .filter(f => f.startsWith('mock-test-post-'));
    for (const f of leftovers) await fs.unlink(path.join(imgDir, f)).catch(() => {});
    if (leftovers.length) console.log(`🧹 Removed ${leftovers.length} mock image(s) from blog/img/`);
}
await fs.writeFile(BLOGS_HTML, blogsBackup);
await fs.writeFile(SITEMAP_XML, sitemapBackup);
await fs.writeFile(HISTORY_FILE, historyBackup);
if (feedBackup === null) await fs.unlink(FEED_FILE).catch(() => {});
else await fs.writeFile(FEED_FILE, feedBackup);
// ledger/status are real repo files - restore them exactly as they were
for (const [file, backup] of [[LEDGER_FILE, ledgerBackup], [STATUS_FILE, statusBackup]]) {
    if (backup === null) await fs.unlink(file).catch(() => {});
    else await fs.writeFile(file, backup);
}
await fs.unlink(mockLoader).catch(() => {});
console.log('\n🧹 Cleanup done. Repo restored to pre-test state.\n');

let pass = 0, fail = 0;
for (const [name, ok] of mockChecks) {
    console.log((ok ? '✅' : '❌') + ' ' + name);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed / ${fail} failed (subprocess exit ${exitCode})`);
process.exit(fail === 0 && exitCode === 0 ? 0 : 1);
