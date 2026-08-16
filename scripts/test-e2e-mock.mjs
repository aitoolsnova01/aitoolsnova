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

// Backup
const blogsBackup = await fs.readFile(BLOGS_HTML, 'utf-8');
const sitemapBackup = await fs.readFile(SITEMAP_XML, 'utf-8');
const historyBackup = await fs.readFile(HISTORY_FILE, 'utf-8').catch(() => '{"topics":[]}');
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
        body_html: '<p>Body ' + (i+1) + ' with realistic sentence length that would be produced by an LLM in a live run.</p><ul><li>Point A</li><li>Point B</li></ul>'
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
    env: { ...process.env, GROQ_API_KEY: 'mock-key-for-test' },
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
} else {
    mockChecks = [['Generated blog file NOT found — pipeline broken!', false]];
}

// Cleanup: remove mock file + restore blogs.html + sitemap + history
if (mockFile) await fs.unlink(path.join(ROOT, 'blog', mockFile)).catch(() => {});
await fs.writeFile(BLOGS_HTML, blogsBackup);
await fs.writeFile(SITEMAP_XML, sitemapBackup);
await fs.writeFile(HISTORY_FILE, historyBackup);
await fs.unlink(mockLoader).catch(() => {});
console.log('\n🧹 Cleanup done. Repo restored to pre-test state.\n');

let pass = 0, fail = 0;
for (const [name, ok] of mockChecks) {
    console.log((ok ? '✅' : '❌') + ' ' + name);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed / ${fail} failed (subprocess exit ${exitCode})`);
process.exit(fail === 0 && exitCode === 0 ? 0 : 1);
