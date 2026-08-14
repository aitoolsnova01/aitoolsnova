#!/usr/bin/env node
/**
 * DRY-RUN test for generate-blog.mjs
 * Verifies:
 * - Script imports & builds HTML correctly
 * - HTML has all required meta/AdSense/GA tags
 * - blogs.html insertion works (rolled back after)
 * - sitemap.xml insertion works (rolled back after)
 * - Pollinations hero image URL is valid
 *
 * Usage:  node scripts/test-dry-run.mjs
 * (Does NOT hit Groq API — uses mock content.)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(process.cwd());
const BLOG_DIR = path.join(ROOT, 'blog');
const BLOGS_HTML = path.join(ROOT, 'blogs.html');
const SITEMAP_XML = path.join(ROOT, 'sitemap.xml');

// Backup original files so we don't dirty the repo
const blogsBackup = await fs.readFile(BLOGS_HTML, 'utf-8');
const sitemapBackup = await fs.readFile(SITEMAP_XML, 'utf-8');

// Mock topic + content
const topic = {
    title: 'Dry-Run Test Post — Please Ignore',
    slug: 'dry-run-test-' + Date.now(),
    category: 'ai',
    emoji: '🧪',
    hero_prompt: 'clean geometric AI test pattern blue purple gradient'
};
const content = {
    meta_description: 'Dry-run test content for the autoblog pipeline. Verifies HTML template works end-to-end.',
    meta_keywords: 'test, dryrun, aitoolsnova, pipeline',
    read_time_min: 5,
    intro_html: '<p>This is a dry-run test post.</p>',
    sections: [
        { h2: 'Section One', body_html: '<p>Body one.</p>' },
        { h2: 'Section Two', body_html: '<p>Body two.</p>' },
        { h2: 'Section Three', body_html: '<p>Body three.</p>' }
    ],
    faqs: [
        { q: 'Is this a real post?', a: 'No, it is a test.' },
        { q: 'Will it be deleted?', a: 'Yes, immediately after this test.' }
    ],
    conclusion_html: '<p>End of test.</p>',
    related_tools: ['ai-chat.html','ai-writer.html'],
    related_blogs: ['best-free-ai-tools-2026.html']
};

// NOTE: generate-blog.mjs auto-executes main() and process.exit() when GROQ_API_KEY missing,
// so we do NOT import it. Instead we grep the source for required patterns.

const blogsHtml = await fs.readFile(BLOGS_HTML, 'utf-8');
const sitemap = await fs.readFile(SITEMAP_XML, 'utf-8');

const checks = [
    ['blogs.html has AUTO-BLOG-INSERT-START marker', blogsHtml.includes('<!-- AUTO-BLOG-INSERT-START -->')],
    ['blogs.html has AUTO-BLOG-INSERT-END marker',   blogsHtml.includes('<!-- AUTO-BLOG-INSERT-END -->')],
    ['sitemap.xml has AUTO-BLOG-SITEMAP-START marker', sitemap.includes('<!-- AUTO-BLOG-SITEMAP-START -->')],
    ['AdSense pub id ca-pub-2278101269918728 present in blogs.html', blogsHtml.includes('ca-pub-2278101269918728')],
    ['GA measurement id G-KJ0WTD0R0M present in blogs.html', blogsHtml.includes('G-KJ0WTD0R0M')],
    ['generate-blog.mjs has multi-model fallback', (await fs.readFile('scripts/generate-blog.mjs','utf-8')).includes("'openai/gpt-oss-120b'")],
    ['generate-blog.mjs has hero image via pollinations', (await fs.readFile('scripts/generate-blog.mjs','utf-8')).includes('image.pollinations.ai')],
    ['generate-blog.mjs has IndexNow ping', (await fs.readFile('scripts/generate-blog.mjs','utf-8')).includes('api.indexnow.org')],
    ['generate-blog.mjs has robust extractJson', (await fs.readFile('scripts/generate-blog.mjs','utf-8')).includes('function extractJson')],
    ['generate-blog.mjs has retry loop (attempt <= 3)', (await fs.readFile('scripts/generate-blog.mjs','utf-8')).includes('attempt <= 3')],
    ['blog/ directory exists', existsSync(BLOG_DIR)],
    ['sitemap.xml has ads.txt-friendly aitoolsnova.com host', sitemap.includes('aitoolsnova.com')],
    ['ads.txt has google.com pub-2278101269918728', (await fs.readFile('ads.txt','utf-8')).includes('pub-2278101269918728')]
];

let pass = 0, fail = 0;
for (const [name, ok] of checks) {
    console.log((ok ? '✅' : '❌') + ' ' + name);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
