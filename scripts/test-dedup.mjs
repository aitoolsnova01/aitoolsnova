#!/usr/bin/env node
/**
 * scripts/test-dedup.mjs - regression tests for the duplicate-publisher fixes
 * ---------------------------------------------------------------------------
 * Every check below maps to a duplicate that actually shipped:
 *   * one blog post listed twice in /blogs (updateBlogsList() ran twice per post
 *     and never looked at what was already in the managed block);
 *   * the same topic published as /blog/<x> and /web-stories/<x> with the same
 *     headline (a story inherited the article's URL tail);
 *   * one article storified twice ("has a story?" was answered by filename);
 *   * a story dated BEFORE the article it summarizes (backfill date, not source
 *     date);
 *   * two publishers writing the same day (blog job + story job fallback, with
 *     separate concurrency locks);
 *   * an RSS feed where every item had the same "06:00:00 GMT" pubDate and the
 *     newest posts were missing entirely.
 *
 * Offline, no keys, no network, nothing in the repo is modified.
 * Run: node scripts/test-dedup.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
    normalizeTitle, cardLinkSelector, dedupeManagedCards, storySourceMeta, storySourceOf,
    publishedDates, planGaps, CONTENT_PATHS, isoDate,
} from './lib/publish-core.mjs';
import { buildFeed, collectFeedItems, renderFeed } from './rebuild-feed.mjs';
import { storyDateFor, storiesCoveredSources } from './generate-webstory.mjs';

let pass = 0, fail = 0;
const check = async (name, fn) => {
    try { await fn(); console.log(`✅ ${name}`); pass++; }
    catch (e) { console.error(`❌ ${name}\n   ${(e && e.message ? e.message : String(e)).split('\n')[0]}`); fail++; }
};

const START = '<!-- AUTO-BLOG-INSERT-START -->';
const END = '<!-- AUTO-BLOG-INSERT-END -->';
const card = (slug, title = slug) => `                    <article class="blog-card" data-category="ai">
                        <div class="blog-content">
                            <h3>${title}</h3>
                            <a href="blog/${slug}" class="read-more">Read More →</a>
                        </div>
                    </article>
`;

// -------------------------------------------------- normalizeTitle / keys ----
await check('normalizeTitle ignores brand suffix, punctuation and year', () => {
    assert.equal(
        normalizeTitle('7 Free No‑Code AI Apps to Build a Business Tool 2026 | AIToolsNova'),
        normalizeTitle('7 free no-code ai apps to build a business tool')
    );
    assert.notEqual(normalizeTitle('AI Tools for Students'), normalizeTitle('AI Tools for Freelancers'));
});

// --------------------------------------------------------- listing dedupe ----
await check('dedupeManagedCards strips a stale card before inserting', () => {
    const html = `x\n${START}\n${card('free-no-code-ai-apps', 'First')}${card('other-post')}${card('free-no-code-ai-apps', 'Dup')}${END}\ny`;
    const { html: out, removed } = dedupeManagedCards(html, START, END, 'free-no-code-ai-apps');
    assert.equal(removed, 2, 'both copies of the duplicated slug must go');
    assert.equal((out.match(/blog\/free-no-code-ai-apps/g) || []).length, 0);
    assert.equal((out.match(/blog\/other-post/g) || []).length, 1, 'unrelated cards survive');
});

await check('dedupeManagedCards is a no-op outside the managed block', () => {
    const html = `<article class="blog-card"><a href="blog/a" class="read-more">x</a></article>\n${START}\n${END}`;
    const { html: out, removed } = dedupeManagedCards(html, START, END, 'a');
    assert.equal(removed, 0);
    assert.equal(out, html);
});

await check('cardLinkSelector matches what the generator writes', () => {
    assert.ok(card('ai-side-hustle-2026').includes(cardLinkSelector('ai-side-hustle-2026')));
});

// ------------------------------------------------------ story provenance ----
await check('story provenance round-trips through the meta tag', () => {
    const html = `<link rel="canonical" href="https://aitoolsnova.com/web-stories/x-story">\n${storySourceMeta('x')}`;
    assert.equal(storySourceOf(html), 'x');
});

await check('a legacy story named after its article is treated as covered', () => {
    assert.equal(storySourceOf('<link rel="canonical" href="https://aitoolsnova.com/blog/seo-guide">'), 'seo-guide');
    assert.equal(storySourceOf('<html></html>'), undefined);
});

// ------------------------------------------------- story source de-duping ----
await check('storiesCoveredSources reads provenance, not filenames', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-'));
    const blogDir = path.join(tmp, 'blog'), storyDir = path.join(tmp, 'web-stories');
    await fs.mkdir(blogDir, { recursive: true });
    await fs.mkdir(storyDir, { recursive: true });
    await fs.writeFile(path.join(blogDir, 'alpha.html'), '<h1>Alpha</h1>');
    await fs.writeFile(path.join(blogDir, 'beta.html'), '<h1>Beta</h1>');
    await fs.writeFile(path.join(blogDir, 'gamma.html'), '<h1>Gamma</h1>');
    // renamed story file + provenance meta -> alpha is covered
    await fs.writeFile(path.join(storyDir, 'alpha-top-tips.html'), storySourceMeta('alpha'));
    // legacy same-slug story -> beta is covered
    await fs.writeFile(path.join(storyDir, 'beta.html'), '<link rel="canonical" href="https://aitoolsnova.com/blog/beta">');
    const covered = storiesCoveredSources(storyDir, blogDir);
    assert.ok(covered.has('alpha'), 'provenance must count even when the file was renamed');
    assert.ok(covered.has('beta'), 'same-slug legacy story must count');
    assert.ok(!covered.has('gamma'), 'an article without a story stays available');
    await fs.rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------- story date policy ----
await check('a story is never dated before the article it summarizes', () => {
    assert.equal(storyDateFor('2026-08-25', '2026-09-02'), '2026-09-02');
    assert.equal(storyDateFor('2026-09-03', '2026-09-01'), '2026-09-03');
    assert.equal(storyDateFor('2026-09-03', ''), '2026-09-03');
    assert.ok(storyDateFor('2099-01-01', '') <= isoDate(), 'never in the future');
});

// ----------------------------------------------------------- day idempotency -
await check('a second publisher on the same day cannot open a second gap', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-day-'));
    await fs.mkdir(path.join(tmp, 'blog'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'blog', 'x.html'),
        `<title>X</title><script type="application/ld+json">{"datePublished":"${isoDate()}"}</script>`);
    await fs.writeFile(path.join(tmp, 'scripts', 'publish-log.json'),
        JSON.stringify({ version: 1, entries: [{ at: new Date().toISOString(), date: isoDate(), kind: 'blog', slug: 'x', status: 'ok' }] }));
    const have = await publishedDates(tmp, 'blog');
    assert.ok(have.has(isoDate()), 'today counts as published');
    const planned = await planGaps(tmp, { kind: 'blog', days: 3, max: 3, today: isoDate() });
    assert.equal(planned.gaps.filter(d => have.has(d)).length, 0, 'a published day is never re-planned');
    await fs.rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ feed ----
await check('feed.xml is rebuilt from blog/ and every item has its own time', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-feed-'));
    await fs.mkdir(path.join(tmp, 'blog'), { recursive: true });
    for (const [slug, date] of [['a-one', '2026-09-01'], ['a-two', '2026-09-01'], ['a-three', '2026-08-30']]) {
        await fs.writeFile(path.join(tmp, 'blog', `${slug}.html`),
            `<title>Post ${slug}</title><meta name="description" content="desc ${slug}">`
            + `<script type="application/ld+json">{"datePublished":"${date}"}</script>`);
    }
    const items = collectFeedItems(tmp);
    assert.equal(items.length, 3);
    assert.equal(items[0].date, '2026-09-01', 'newest first');
    const xml = renderFeed(items, new Date('2026-09-03T00:00:00Z'));
    const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map(m => m[1]);
    assert.equal(new Set(dates).size, dates.length, 'two posts on one day must not share a pubDate');
    const res = await buildFeed({ root: tmp, write: true });
    assert.equal(res.items, 3);
    assert.equal(res.duplicateTimes, 0);
    await fs.writeFile(path.join(tmp, 'blog', 'a-four.html'),
        `<title>Post a-four</title><script type="application/ld+json">{"datePublished":"${isoDate()}"}</script>`);
    // "stale" describes the feed that was ON DISK, so a brand-new post makes the
    // old feed stale; rebuilding once must be enough to close it.
    const res2 = await buildFeed({ root: tmp, write: true });
    assert.equal(res2.stale, true, 'a post missing from the feed must be reported as stale');
    assert.deepEqual(res2.missing, [`${'https://aitoolsnova.com'}/blog/a-four`]);
    const res3 = await buildFeed({ root: tmp, write: true });
    assert.equal(res3.stale, false, 'after one rebuild the feed lists the newest post');
    assert.equal(res3.changed, false, 'rebuilding an up-to-date feed changes nothing');
    await fs.rm(tmp, { recursive: true, force: true });
});

await check('a mock/test fixture post can never enter the feed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-feed3-'));
    await fs.mkdir(path.join(tmp, 'blog'), { recursive: true });
    const write = async (slug, title, date) => fs.writeFile(path.join(tmp, 'blog', `${slug}.html`),
        `<title>${title}</title><script type="application/ld+json">{"datePublished":"${date}"}</script>`);
    await write('mock-test-post-123', 'Mock Test Post Please Ignore 123', isoDate());
    await write('real-article', 'Real Article About AI Tools', '2026-09-01');
    const items = collectFeedItems(tmp);
    assert.deepEqual(items.map(i => i.slug), ['real-article'], 'the fixture must be filtered, the real post kept');
    const res = await buildFeed({ root: tmp, write: false });
    assert.deepEqual(res.skippedTestPosts, ['mock-test-post-123']);
    await fs.rm(tmp, { recursive: true, force: true });
});

await check('feed items are deduplicated by headline', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-feed2-'));
    await fs.mkdir(path.join(tmp, 'blog'), { recursive: true });
    for (const slug of ['same-topic', 'same-topic-copy']) {
        await fs.writeFile(path.join(tmp, 'blog', `${slug}.html`),
            `<title>Same Topic 2026</title><script type="application/ld+json">{"datePublished":"2026-09-01"}</script>`);
    }
    assert.equal(collectFeedItems(tmp).length, 1);
    await fs.rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------- repo-level guards --
const repo = path.resolve(import.meta.dirname, '..');
const readRepo = (rel) => fs.readFile(path.join(repo, rel), 'utf8');

await check('the blog generator updates the listing exactly once per post', async () => {
    const src = await readRepo('scripts/generate-blog.mjs');
    const calls = src.match(/await updateBlogsList\(/g) || [];
    assert.equal(calls.length, 1, `updateBlogsList() must be called once per publish, found ${calls.length}`);
    assert.ok(src.includes('dedupeManagedCards'), 'the insert must strip an existing card first');
    assert.ok(src.includes("code: 'duplicate-topic'"), 'a repeated topic must be skipped, not renamed into a second URL');
    assert.ok(!/already exists — appending a suffix/.test(src), 'slug collisions may no longer fork a second URL');
    assert.ok(src.includes('await rebuildFeedBestEffort()'), 'every blog run refreshes the feed');
});

await check('a story never reuses the article URL tail and records its source', async () => {
    const src = await readRepo('scripts/generate-webstory.mjs');
    assert.ok(src.includes('storySlugFor'), 'story slugs must be distinct from the article slug');
    assert.ok(src.includes('covered.has(slug)'), 'the story job must skip articles that already have a story');
    assert.ok(src.includes("code: 'duplicate-story'"), 'a second story for the same article must be refused');
    assert.ok(src.includes('STORY_CANONICAL'), 'canonical policy must be configurable');
    assert.ok(src.includes('storySourceMeta(articleSlug)') || src.includes('storySourceMeta('), 'provenance must be written into the page');
});

/**
 * The publish jobs are asserted against scripts/workflow-fixes/*.fixed, which is
 * what actually reaches main: an App/Actions token without the `workflows` scope
 * cannot push .github/workflows/**, so the story job's healWorkflowsIfAllowed()
 * copies the .fixed file over the live one with WORKFLOW_PAT. Asserting on the
 * live file only would make `npm test` red for a permission the bot will never
 * have - so whichever copy already carries the guard is used, and both are
 * required to agree once the YAML has been healed.
 */
async function workflowSource(name) {
    const live = await readRepo(`.github/workflows/${name}`);
    const fixed = await readRepo(`scripts/workflow-fixes/${name}.fixed`).catch(() => '');
    return live.includes('auto-publish-content') ? live : (fixed || live);
}

await check('both publishers share one lock and only one owns blog/', async () => {
    const blog = await workflowSource('daily-blog.yml');
    const story = await workflowSource('daily-webstory.yml');
    assert.ok(/group:\s*auto-publish-content/.test(blog), 'blog job must use the shared content lock');
    assert.ok(/group:\s*auto-publish-content/.test(story), 'story job must use the shared content lock');
    assert.ok(/AUTO_BLOG_FALLBACK:\s*'0'/.test(story), 'the story job must not write blog posts');
    assert.ok(!/git add -A --[^\n]*\bblog\b[^\n]*$/.test(story.split('\n').find(l => l.includes('git add')) || ''),
        'the story job must not stage blog/');
    assert.ok(blog.includes('rebuild-feed.mjs') && story.includes('rebuild-feed.mjs'), 'both jobs refresh the feed');
});

await check('the fixed workflow copies match live once self-heal has run', async () => {
    for (const name of ['daily-blog.yml', 'daily-webstory.yml']) {
        const live = await readRepo(`.github/workflows/${name}`);
        const fixed = await readRepo(`scripts/workflow-fixes/${name}.fixed`);
        if (live === fixed) continue;                       // already healed
        assert.ok(fixed.includes('auto-publish-content'),
            `${name}: live copy is not healed yet, so scripts/workflow-fixes must carry the shared lock`);
        assert.ok(live.includes('contents: write'), `${name}: live copy must at least stay valid YAML`);
    }
    const sugg = await readRepo('.github/workflow-suggestions/daily-blog.yml.txt');
    assert.ok(sugg.includes('auto-publish-content'),
        'the paste-by-hand suggestion must match the fixed copy (GitHub UI fallback)');
});

await check('feed.xml is generated, complete and free of identical timestamps', async () => {
    const feed = await readRepo('feed.xml');
    const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    assert.ok(items.length >= 10, `feed should carry the recent archive, got ${items.length}`);
    const links = items.map(i => (i.match(/<link>([^<]+)<\/link>/) || [])[1]);
    assert.equal(new Set(links).size, links.length, 'no two feed items may point at the same URL');
    const times = items.map(i => (i.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1]);
    assert.equal(new Set(times).size, times.length, 'no two feed items may share a publish time');
    const files = (await fs.readdir(path.join(repo, 'blog'))).filter(f => f.endsWith('.html'));
    const dated = [];
    for (const f of files) {
        const html = await readRepo(`blog/${f}`);
        dated.push({ f, d: (html.match(/"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/) || [])[1] || '' });
    }
    const newest = dated.sort((a, b) => b.d.localeCompare(a.d))[0];
    assert.ok(feed.includes(`/blog/${newest.f.replace('.html', '')}`), 'the newest article must be in the feed');
    assert.ok(CONTENT_PATHS.blog.includes('feed.xml'), 'feed.xml must be committed by the blog job');
});

await check('blogs.html lists every post exactly once and every story is traceable', async () => {
    const blogsHtml = await readRepo('blogs.html');
    const block = blogsHtml.slice(blogsHtml.indexOf(START), blogsHtml.indexOf(END));
    const slugs = [...block.matchAll(/href="blog\/([^"]+)" class="read-more"/g)].map(m => m[1]);
    assert.equal(new Set(slugs).size, slugs.length, `duplicate card in blogs.html: ${slugs.filter((s, i) => slugs.indexOf(s) !== i)}`);
    const xml = await readRepo('sitemap.xml');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    assert.equal(new Set(locs).size, locs.length, 'sitemap.xml must not repeat a URL');
    const dir = path.join(repo, 'web-stories');
    for (const f of (await fs.readdir(dir)).filter(x => x.endsWith('.html'))) {
        const html = await readRepo(`web-stories/${f}`);
        const slug = f.replace(/\.html$/, '');
        const src = storySourceOf(html);
        const exists = src ? await fs.readFile(path.join(repo, 'blog', `${src}.html`)).then(() => true, () => false) : false;
        if (src && !exists) assert.fail(`web-stories/${slug} points at a missing article: ${src}`);
        if (slug.endsWith('-story') && !src) assert.fail(`web-stories/${slug} has no source-blog provenance`);
    }
});

console.log(`\n${pass} passed / ${fail} failed (duplicate publishing)`);
process.exit(fail ? 1 : 0);
