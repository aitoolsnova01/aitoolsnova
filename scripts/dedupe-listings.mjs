#!/usr/bin/env node
/**
 * scripts/dedupe-listings.mjs - repair the duplicate content the pipeline left
 * ---------------------------------------------------------------------------
 * One run of the old pipeline could publish the SAME article twice:
 *
 *   * blogs.html got the card twice (generate-blog.mjs called updateBlogsList()
 *     twice per post and never checked whether the slug was already listed)
 *     -> "one blog posted twice, same date" on /blogs;
 *   * a story inherited the article's URL tail and, for backfills, an unrelated
 *     date -> /blog/x + /web-stories/x, same headline, story dated BEFORE the
 *     article it summarizes;
 *   * one article could be storified twice, because "does this article already
 *     have a story?" was answered by filename, not by provenance
 *     (/web-stories/ai-upload-privacy-checks and
 *      /web-stories/ai-tool-privacy-checklist-before-upload = same post).
 *
 * This script fixes the site state (the generators are fixed separately, so it
 * only ever needs to run once, plus after any manual content surgery):
 *   1. de-duplicate cards in blogs.html and web-stories.html;
 *   2. de-duplicate <url> blocks in sitemap.xml;
 *   3. write provenance (<meta name="aitoolsnova:source-blog">) into every story
 *      so the story job can never re-story the same article;
 *   4. add the "Read the full article" link a story was missing;
 *   5. canonicalize a story to its article when it repeats the headline;
 *   6. re-date a story that claims to predate its own article (backfill runs
 *      stamped stories with an unrelated gap date, so a summary was published
 *      "before" the post it summarizes);
 *   7. delete a duplicate story page (keeping the better one) with a 301 in
 *      _redirects, and drop only genuinely orphaned images with it.
 *
 * Usage:
 *   node scripts/dedupe-listings.mjs             dry run: print the report
 *   node scripts/dedupe-listings.mjs --apply     write the repairs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    normalizeTitle, cardLinkSelector, storySourceMeta, storySourceOf,
} from './lib/publish-core.mjs';

const ROOT = path.resolve(process.env.REPO_ROOT || process.cwd());
const SITE = process.env.SITE_URL || 'https://aitoolsnova.com';
const APPLY = process.argv.includes('--apply');
const BLOG_DIR = path.join(ROOT, 'blog');
const STORY_DIR = path.join(ROOT, 'web-stories');
const STORY_IMG = path.join(STORY_DIR, 'img');
const START = '<!-- AUTO-BLOG-INSERT-START -->';
const END = '<!-- AUTO-BLOG-INSERT-END -->';

// Stories that were published with a renamed headline: the filename no longer
// says which article they came from, so the pairing is recorded here. Anything
// not listed is matched by headline, then by identical slug.
const KNOWN_SOURCES = {
    'ai-upload-privacy-checks': 'ai-tool-privacy-checklist-before-upload',
    '5-free-ai-tools-blow-your-mind-2026': 'ai-trends-2026',
    '5-free-ai-tools-2026-hd': 'ai-productivity-tools',
};

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const write = (p, data) => {
    if (APPLY) fs.writeFileSync(p, data, 'utf8');
    return APPLY;
};
const log = [];
const note = (m) => { log.push(m); console.log(m); };

function htmlTitle(html) {
    return (html.match(/<title>([^<]+)/i)?.[1] || '').trim();
}
function pubDate(html) {
    return (html.match(/"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
}

// ---------------------------------------------------------------- inputs ----
const blogs = new Map();
for (const f of fs.readdirSync(BLOG_DIR).filter(x => x.endsWith('.html'))) {
    const html = read(path.join(BLOG_DIR, f));
    const slug = f.replace(/\.html$/, '');
    blogs.set(slug, {
        slug, html, date: pubDate(html),
        title: htmlTitle(html),
        key: normalizeTitle(html.match(/<h1[^>]*>([^<]+)/i)?.[1] || htmlTitle(html)),
    });
}
const byKey = new Map();
for (const b of blogs.values()) if (b.key && !byKey.has(b.key)) byKey.set(b.key, b);

const storyFiles = fs.readdirSync(STORY_DIR).filter(x => x.endsWith('.html'));
const stories = storyFiles.map(f => {
    const html = read(path.join(STORY_DIR, f));
    const slug = f.replace(/\.html$/, '');
    const src = storySourceOf(html)
        || KNOWN_SOURCES[slug]
        || (blogs.has(slug) ? slug : '')
        || (byKey.get(normalizeTitle(html.match(/<h1[^>]*>([^<]+)/i)?.[1] || htmlTitle(html)))?.slug || '');
    return { slug, html, src, date: pubDate(html), title: htmlTitle(html), key: normalizeTitle(htmlTitle(html)) };
});

// ------------------------------------------------- 1. blogs.html card dupe --
const blogsHtml = read(path.join(ROOT, 'blogs.html'));
let fixedBlogsHtml = blogsHtml;
const seenCards = new Set();
let cardsRemoved = 0;
{
    const start = fixedBlogsHtml.indexOf(START);
    const end = fixedBlogsHtml.indexOf(END);
    if (start >= 0 && end > start) {
        const head = fixedBlogsHtml.slice(0, start + START.length);
        const block = fixedBlogsHtml.slice(start + START.length, end);
        const tail = fixedBlogsHtml.slice(end);
        const cards = block.match(/[ \t]*<article class="blog-card"[\s\S]*?<\/article>\s*/g) || [];
        const keep = [];
        for (const card of cards) {
            const m = card.match(/href="blog\/([^"]+)" class="read-more"/);
            const slug = m ? m[1] : `#${keep.length}`;
            if (seenCards.has(slug)) { cardsRemoved++; note(`♻️  blogs.html: dropped duplicate card for blog/${slug}`); continue; }
            seenCards.add(slug);
            keep.push(card);
        }
        fixedBlogsHtml = head + '\n' + keep.join('') + '                    ' + tail;
    } else {
        note('⚠️  blogs.html managed markers not found - listing left untouched');
    }
}

// ------------------------------------------------ 2. sitemap.xml dupes ------
let sitemap = read(path.join(ROOT, 'sitemap.xml'));
let sitemapDupes = 0;
{
    const seen = new Set();
    sitemap = sitemap.replace(/\s*<url>[\s\S]*?<\/url>/g, (m) => {
        const loc = (m.match(/<loc>([^<]+)<\/loc>/) || [])[1] || '';
        if (!loc) return m;
        if (seen.has(loc)) { sitemapDupes++; note(`♻️  sitemap.xml: dropped duplicate <url> for ${loc}`); return ''; }
        seen.add(loc);
        return m;
    });
}

// ------------------------------ 3-5. story provenance, article link, canonical
const toDelete = new Map();          // slug -> keeper slug (301 target)
const bySource = new Map();
for (const st of stories) {
    if (!st.src) continue;
    if (!bySource.has(st.src)) bySource.set(st.src, []);
    bySource.get(st.src).push(st);
}
for (const [src, list] of bySource) {
    if (list.length < 2) continue;
    // Keep the story that is NOT a verbatim copy of the headline (it adds a
    // distinct page); break ties by newest.
    const article = blogs.get(src);
    const scored = list.map(st => ({
        st,
        score: (article && st.key && st.key === article.key ? 0 : 2) + (st.date || ''),
    }));
    scored.sort((a, b) => (String(b.score) > String(a.score) ? 1 : -1));
    const keeper = scored[0].st;
    for (const { st } of scored.slice(1)) {
        toDelete.set(st.slug, keeper.slug);
        note(`♻️  ${st.slug}: duplicate story for /blog/${src} -> replaced by 301 to /web-stories/${keeper.slug}`);
    }
}

/** Same rule the generator uses: publish date, never before the article. */
function storyDateFor(publishDate, sourceDate) {
    const today = new Date().toISOString().slice(0, 10);
    let d = /^\d{4}-\d{2}-\d{2}$/.test(publishDate || '') ? publishDate : today;
    if (/^\d{4}-\d{2}-\d{2}$/.test(sourceDate || '') && d < sourceDate) d = sourceDate;
    return d > today ? today : d;
}

/**
 * Put a "Read the full article" link inside the story's CTA page, wherever that
 * page lives in this generation of files. Layout changed over time (the newest
 * pages use class="cta-cta", older ones class="cta"), so three anchors are tried
 * in order and the link is only ever inserted INSIDE a grid layer - an <a> that
 * AMP finds outside a layer invalidates the whole story.
 */
function insertArticleLink(html, url) {
    if (html.includes(url) || !html.includes('</amp-story-page>')) return html;
    const linkAt = (indent, cls) => `${indent}<a class="${cls}" style="margin-bottom:10px;background:#fff" href="${url}">Read the full article \u2192</a>`;
    // 1. current layout: sit next to the "Explore Tools" button in the CTA layer
    const lines = html.split('\n');
    const at = lines.findIndex(l => l.includes('<a class="cta-cta"') && l.includes('/tools"'));
    if (at >= 0) {
        const indent = (lines[at].match(/^[ \t]*/) || ['          '])[0];
        lines.splice(at, 0, linkAt(indent, 'cta-cta'));
        return lines.join('\n');
    }
    // 2. older layout: right after the CTA copy, still inside the same layer
    const desc = html.match(/[ \t]*<p class="cta-desc">[\s\S]*?<\/p>/);
    if (desc) {
        const indent = (desc[0].match(/^[ \t]*/) || ['          '])[0];
        return html.replace(desc[0], `${desc[0]}\n${linkAt(indent, 'cta-cta')}`);
    }
    // 3. legacy layout (class="cta"): share the line with the existing button
    const idx = html.lastIndexOf('<a ');
    if (idx > 0) {
        const lineStart = html.lastIndexOf('\n', idx) + 1;
        const indent = (html.slice(lineStart, idx).match(/^[ \t]*/) || ['          '])[0];
        return `${html.slice(0, lineStart)}${linkAt(indent, 'cta')}\n${html.slice(lineStart)}`;
    }
    return html;
}

const patchedStories = new Map();
const reDated = [];
const skippedNoAnchor = [];
for (const st of stories) {
    if (toDelete.has(st.slug)) continue;
    let html = st.html;
    let changed = false;
    const article = st.src ? blogs.get(st.src) : null;
    if (article) {
        const articleUrl = `${SITE}/blog/${article.slug}`;
        // 3. provenance, so the generator never re-storifies this article
        if (!html.includes('aitoolsnova:source-blog')) {
            const next = html.replace(/(<link rel="canonical"[^>]*>)/, `$1\n  ${storySourceMeta(article.slug)}`);
            if (next !== html) {
                html = next;
                changed = true;
                note(`➕ ${st.slug}: source-blog provenance -> ${article.slug}`);
            }
        }
        // 4. a story without a path back to the article is a dead end for
        //    readers and for crawlers trying to find the preferred version
        const withLink = insertArticleLink(html, articleUrl);
        if (withLink !== html) {
            html = withLink;
            changed = true;
            note(`➕ ${st.slug}: "Read the full article" link -> /blog/${article.slug}`);
        } else if (!html.includes(articleUrl)) {
            skippedNoAnchor.push(st.slug);
        }
        // 6. a summary may not be older than the thing it summarizes
        const fixedDate = storyDateFor(st.date, article.date);
        if (st.date && fixedDate !== st.date) {
            const before = html;
            html = html
                .replace(/("datePublished"\s*:\s*")\d{4}-\d{2}-\d{2}/, `$1${fixedDate}`)
                .replace(/("dateModified"\s*:\s*")\d{4}-\d{2}-\d{2}/, `$1${fixedDate}`);
            if (html !== before) {
                changed = true;
                reDated.push(`${st.slug}: ${st.date} -> ${fixedDate}`);
                note(`📅 ${st.slug}: re-dated ${st.date} -> ${fixedDate} (it claimed to predate /blog/${article.slug})`);
                sitemap = sitemap.replace(
                    new RegExp(`(<loc>${SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/web-stories/${st.slug}</loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}`),
                    `$1${fixedDate}`
                );
            }
        }
        // 5. same headline as the article = duplicate content: hand the canonical
        //    over to the article, keep the story page live for swipe readers
        const sameHeadline = article.key && article.key === st.key;
        if (sameHeadline && !html.includes(`rel="canonical" href="${articleUrl}"`)) {
            const next = html.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${articleUrl}">`);
            if (next !== html) {
                html = next;
                changed = true;
                note(`🔗 ${st.slug}: canonical -> ${articleUrl} (headline is the article's own)`);
            }
        }
    }
    if (changed && html !== st.html) patchedStories.set(st.slug, html);
}

// ---------------------------------------------------------- apply edits -----
const removedSlugs = [...toDelete.keys()];
if (removedSlugs.length) {
    // drop the dead URL from sitemap + index BEFORE writing, so nothing points
    // at a file that will not exist
    sitemap = sitemap.replace(/\s*<url>[\s\S]*?<\/url>/g, (m) => (
        removedSlugs.some(s => m.includes(`/web-stories/${s}<`)) ? '' : m
    ));
}

let storiesIndex = read(path.join(ROOT, 'web-stories.html'));
if (removedSlugs.length) {
    // Walk the cards one by one. A single cross-card regex would happily swallow
    // every card between the first match and the one being deleted.
    const count = (h) => (h.match(/<a class="story-card"/g) || []).length;
    const before = count(storiesIndex);
    storiesIndex = storiesIndex.replace(/[ \t]*<a class="story-card"[\s\S]*?<\/a>\s*/g, (m) => {
        const slug = (m.match(/story-card-([a-z0-9-]+)"/i) || [])[1];
        if (slug && removedSlugs.includes(slug)) {
            note(`♻️  web-stories.html: removed card for ${slug}`);
            return '';
        }
        return m;
    });
    const lost = before - count(storiesIndex);
    if (lost !== removedSlugs.length) {
        note(`⚠️  web-stories.html: expected to drop ${removedSlugs.length} card(s), dropped ${lost} - index left untouched`);
        storiesIndex = read(path.join(ROOT, 'web-stories.html'));
    }
}

// redirects for the pages that are going away
const redirectLines = removedSlugs.map(slug =>
    `/web-stories/${slug}${' '.repeat(Math.max(1, 46 - slug.length))}/web-stories/${toDelete.get(slug)}${' '.repeat(Math.max(1, 41 - String(toDelete.get(slug)).length))}301`);
let redirects = read(path.join(ROOT, '_redirects'));
const MARK = '# >>> auto-dedupe redirects (scripts/dedupe-listings.mjs)';
const MARK_END = '# <<< auto-dedupe redirects';
if (redirectLines.length) {
    const body = `${MARK}\n${redirectLines.join('\n')}\n${MARK_END}`;
    if (redirects.includes(MARK)) {
        redirects = redirects.replace(new RegExp(`${MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), body);
    } else {
        redirects = `${redirects.replace(/\s+$/, '')}\n\n# Auto-generated 301s for de-duplicated web stories.\n${body}\n`;
    }
    note(`➕ _redirects: ${redirectLines.length} 301 rule(s)`);
}

let wrote = 0;
for (const [slug, html] of patchedStories) { if (write(path.join(STORY_DIR, `${slug}.html`), html)) wrote++; }
if (cardsRemoved || removedSlugs.length) {
    // blogs.html is only rewritten when something actually changed
    if (fixedBlogsHtml !== blogsHtml) { write(path.join(ROOT, 'blogs.html'), fixedBlogsHtml); wrote++; }
}
if (sitemap !== read(path.join(ROOT, 'sitemap.xml'))) { write(path.join(ROOT, 'sitemap.xml'), sitemap); wrote++; }
if (storiesIndex !== read(path.join(ROOT, 'web-stories.html'))) { write(path.join(ROOT, 'web-stories.html'), storiesIndex); wrote++; }
if (redirectLines.length) { write(path.join(ROOT, '_redirects'), redirects); wrote++; }

for (const slug of removedSlugs) {
    if (!APPLY) { note(`🗑  would delete web-stories/${slug}.html`); continue; }
    fs.unlinkSync(path.join(STORY_DIR, `${slug}.html`));
    note(`🗑  deleted web-stories/${slug}.html`);
    // images that no remaining page references
    if (fs.existsSync(STORY_IMG)) {
        const corpus = fs.readdirSync(STORY_DIR).filter(f => f.endsWith('.html'))
            .map(f => read(path.join(STORY_DIR, f))).join('\n')
            + fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => read(path.join(ROOT, f))).join('\n');
        for (const img of fs.readdirSync(STORY_IMG)) {
            if (!img.startsWith(`${slug}-`) && !img.startsWith(`${slug}_`)) continue;
            if (corpus.includes(img)) continue;
            fs.unlinkSync(path.join(STORY_IMG, img));
            note(`🗑  deleted orphan web-stories/img/${img}`);
        }
    }
}

const summary = {
    apply: APPLY,
    blogCardsRemoved: cardsRemoved,
    sitemapDupesRemoved: sitemapDupes,
    storiesPatched: patchedStories.size,
    storiesRedated: reDated,
    storiesMissingCtaAnchor: skippedNoAnchor,
    storiesDeleted: removedSlugs,
    redirectsAdded: redirectLines.length,
    filesWritten: wrote,
    storiesWithoutProvenance: stories.filter(s => !s.src && !toDelete.has(s.slug)).map(s => s.slug),
};
note(`\n${APPLY ? '✅ applied' : '🔎 dry run (add --apply)'}: ${JSON.stringify(summary, null, 2)}`);
process.exit(0);
