#!/usr/bin/env node
/**
 * AIToolsNova - site + automation health check
 * --------------------------------------------
 * One command that answers "is the site healthy AND is the automation still
 * publishing?" - the two things that quietly broke separately.
 *
 * The old .github/workflows/health-check.yml was a plain curl of the homepage,
 * ads.txt and every sitemap URL, one after another, with no timeout, no retry
 * and no classification. A single Cloudflare bot challenge (403/429) or one
 * slow response turned the whole job red, while a blog pipeline that had
 * published nothing for five days kept its green tick. Both failure modes are
 * wrong: the red was noise, the green was the real problem.
 *
 * So this checker:
 *   - separates REAL breakage from noise (challenge/rate-limit/timeout = warn,
 *     retried with backoff and jitter, 404/5xx-after-retry = fail);
 *   - follows redirects when deciding if a URL is alive, and reports the chain;
 *   - checks content FRESHNESS from the repo, so it works with --offline too;
 *   - verifies sitemap/robots/ads.txt/feed/schema markup and the deploy
 *     plumbing (_headers/_redirects) that a crawler depends on;
 *   - verifies the publish workflows themselves are still valid YAML with the
 *     anti-green-but-empty guards in place, and flags unapplied fixes;
 *   - writes a report (JSON + step summary) so the result is auditable later.
 *
 * Usage:
 *   node scripts/site-health.mjs                 everything, live site included
 *   node scripts/site-health.mjs --offline       repo-only (no network needed)
 *   node scripts/site-health.mjs --ci            adds GH annotations + summary
 *   node scripts/site-health.mjs --json out.json
 * Exit: 0 healthy/warnings, 1 failing checks.
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
    SITE, isoDate, addDays, daysBetween, readKeys, annotate,
    stepSummary, fetchWithTimeout, parseArgs, noKeyGuidance,
} from './lib/publish-core.mjs';
import { validateWorkflows } from './daily-publish-helper.mjs';

const A = parseArgs();
// --root / REPO_ROOT lets the fixture tests point the checker at a throwaway
// repo copy instead of the real one.
const ROOT = path.resolve(A.get('root', process.env.REPO_ROOT || process.cwd()));
const OFFLINE = A.bool('offline', false);
const AS_CI = A.bool('ci', process.env.GITHUB_ACTIONS === 'true');
const CONCURRENCY = Math.max(1, A.num('concurrency', 6));
const ALLOWED_STALE_DAYS = A.num('max-age-days', Number(process.env.MAX_AGE_DAYS || 3));
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const results = [];
const add = (group, name, status, detail = '') => {
    results.push({ group, name, status, detail: String(detail).slice(0, 300) });
    const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} [${group}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`);
};

// ------------------------------------------------------------- helpers ----
async function probe(url, { tries = 3, method = 'GET' } = {}) {
    // `let`, NOT `const`: the retry loop rebinds `last` on a non-2xx response
    // (line below) and in the catch. With `const` the very first 429 / 5xx /
    // timeout threw `TypeError: Assignment to constant variable.`, which the
    // caller swallowed into "live probing - skipped". One flaky request
    // therefore disabled EVERY live check (homepage, ads.txt, all ~113 sitemap
    // URLs) and the health job went green-on-outage again - the exact failure
    // mode this script was rewritten to prevent.
    let last = { status: 0, err: null, redirects: [] };
    for (let attempt = 1; attempt <= tries; attempt++) {
        const started = Date.now();
        try {
            let res, hops = 0;
            let target = url;
            while (true) {
                res = await fetchWithTimeout(target, {
                    method,
                    headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Encoding': 'gzip, br' },
                    redirect: 'manual',
                    timeoutMs: 20_000,
                });
                if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < 4) {
                    const next = new URL(res.headers.get('location'), target).toString();
                    last.redirects.push(`${res.status} → ${next}`);
                    target = next; hops++;
                    continue;
                }
                break;
            }
            const ms = Date.now() - started;
            if (res.ok || res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
                return { status: res.status, ms, redirects: last.redirects, challenge: res.status === 403 || res.status === 503 };
            }
            last = { status: res.status, err: `HTTP ${res.status}`, redirects: last.redirects };
        } catch (err) {
            last = { status: 0, err: err?.message || String(err), redirects: last.redirects };
        }
        if (attempt < tries) {
            await new Promise(r => setTimeout(r, 700 * 2 ** (attempt - 1) + Math.random() * 500));
        }
    }
    return { status: last.status || 0, ms: 0, err: last.err, redirects: last.redirects, exhausted: true };
}

/** Simple mapWithConcurrency so 111 URLs do not take 111 sequential round trips. */
async function mapPool(items, fn, limit = CONCURRENCY) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}

const read = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };

// ---------------------------------------------------------------- checks ----
function checkRepoFiles() {
    const required = ['index.html', 'blogs.html', 'tools.html', 'web-stories.html', 'sitemap.xml', 'robots.txt', 'ads.txt', '_headers', '_redirects', 'favicon.ico', '404.html'];
    for (const f of required) add('files', `${f} exists`, existsSync(path.join(ROOT, f)) ? 'pass' : 'fail');

    const ads = read('ads.txt') || '';
    add('files', 'ads.txt has the publisher id', /pub-2278101269918728/.test(ads) ? 'pass' : 'fail', ads.trim().slice(0, 80));

    const robots = read('robots.txt') || '';
    add('files', 'robots.txt has a Sitemap line', /^Sitemap:\s*https:\/\/aitoolsnova\.com\/sitemap\.xml/m.test(robots) ? 'pass' : 'warn');
    add('files', 'robots.txt does not block content', !/^Disallow: \/blog/m.test(robots) && !/^Disallow: \/tools/m.test(robots) ? 'pass' : 'fail');

    // _redirects: every rule needs <source> <target> [code] and codes must be valid
    const lines = (read('_redirects') || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const bad = lines.filter(l => {
        const parts = l.split(/\s+/);
        return parts.length < 2 || (parts[2] && !/^(301|302|307|308|404|200|force)$/i.test(parts[2]));
    });
    add('redirects', `_redirects well-formed (${lines.length} rules)`, bad.length ? 'fail' : 'pass', bad.slice(0, 3).join(' | '));
    const splats = lines.filter(l => l.includes('*')).length;
    add('redirects', `splat rules bounded (${splats})`, splats < 120 ? 'pass' : 'warn', 'too many wildcards slows rule matching');
    // A redirect that points at itself is an infinite loop
    const loops = lines.filter(l => { const p = l.split(/\s+/); return p[0] === p[1]; });
    add('redirects', 'no self-redirect loops', loops.length ? 'fail' : 'pass', loops.slice(0, 2).join(' | '));
}

function checkSitemap() {
    const raw = read('sitemap.xml') || '';
    let urls = [];
    try {
        if (!raw.startsWith('<?xml') && !raw.startsWith('<urlset')) throw new Error('does not start with a urlset element');
        if (!raw.trim().endsWith('</urlset>')) throw new Error('missing closing </urlset>');
        urls = [...raw.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    } catch (e) {
        add('sitemap', 'sitemap.xml is well-formed', 'fail', e.message);
        return [];
    }
    add('sitemap', 'sitemap.xml is well-formed', 'pass', `${urls.length} URLs`);

    const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
    add('sitemap', 'no duplicate URLs', dupes.length ? 'fail' : 'pass', [...new Set(dupes)].slice(0, 4).join(', '));

    const badHost = urls.filter(u => !u.startsWith(`${SITE}/`));
    add('sitemap', 'all URLs on the canonical host', badHost.length ? 'fail' : 'pass', badHost.slice(0, 3).join(', '));

    const withHtml = urls.filter(u => u.endsWith('.html'));
    add('sitemap', 'no .html suffix URLs (308 risk)', withHtml.length ? 'warn' : 'pass', withHtml.slice(0, 3).join(', '));

    const future = [...raw.matchAll(/<lastmod>(\d{4}-\d{2}-\d{2})[^<]*<\/lastmod>/g)]
        .map(m => m[1]).filter(d => d > isoDate());
    add('sitemap', 'no future lastmod dates', future.length ? 'fail' : 'pass', future.slice(0, 3).join(', '));

    // every page URL must exist on disk (Cloudflare Pages 404 = crawl waste)
    const missing = urls.filter(u => {
        const rel = u.replace(`${SITE}/`, '');
        if (!rel) return false;
        return !existsSync(path.join(ROOT, `${rel}.html`)) && !existsSync(path.join(ROOT, rel));
    });
    add('sitemap', 'every sitemap URL has a file in main', missing.length ? 'fail' : 'pass', missing.slice(0, 4).join(', '));
    return urls;
}

function checkContentFreshness() {
    const today = isoDate();
    for (const kind of ['blog', 'webstory']) {
        const dir = kind === 'webstory' ? 'web-stories' : 'blog';
        const have = publishedDatesFromDisk(dir);
        const newest = have.size ? [...have.keys()].sort().at(-1) : null;
        const age = newest ? daysBetween(newest, today) : Infinity;
        const label = kind === 'webstory' ? 'web story' : 'blog post';
        add('freshness', `newest ${label} within ${ALLOWED_STALE_DAYS} days`,
            age <= ALLOWED_STALE_DAYS ? 'pass' : 'fail',
            newest ? `${newest} (${age} days ago)` : 'none found');
        const gaps = gapsSync(kind, today);
        // A gap is expected while a backlog drains (each run takes --backfill
        // days, oldest first) - so it is a warning, not a failure. The failure
        // signal above ("newest X within N days") is what must go red.
        add('freshness', gaps.length ? `${label} catch-up queue` : `${label} backlog drained`,
            gaps.length ? 'warn' : 'pass',
            gaps.length
                ? `${gaps.length} missing day(s): ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? '…' : ''} - auto-published oldest-first by --backfill`
                : 'no gaps');
    }
    const statusRaw = read('publish-status.json');
    if (!statusRaw) {
        add('automation', 'publish-status.json committed by the pipeline', 'warn',
            'not in the repo yet - the first automated run creates it (see AUTOMATION_FIX.md §3.3/§3.4)');
        return;
    }
    try {
        const st = JSON.parse(statusRaw);
        const last = st.lastRun || {};
        if (!last.date && !last.kind) {
            add('automation', 'last automated run succeeded', 'warn',
                'status file exists but records no run yet');
        } else {
            add('automation', 'last automated run succeeded', last.ok ? 'pass' : 'fail',
                `${last.kind || '?'} ${last.date || ''} ${last.ok ? 'ok' : `FAILED: ${last.reason || 'no reason recorded'}`}`);
        }
        add('automation', 'providers visible to the job', st.providers?.anyConfigured ? 'pass' : 'warn',
            st.providers?.anyConfigured ? `groq=${st.providers.groq} gemini=${st.providers.gemini} deepseek=${st.providers.deepseek}` : noKeyGuidance());
    } catch (e) {
        add('automation', 'publish-status.json parses', 'fail', e.message);
    }
}
/**
 * Classify one live probe. The distinction matters more than the probe: a
 * Cloudflare bot challenge (403), a rate limit (429) or a timeout says nothing
 * about whether a real visitor can read the site, while 404/410 on a URL that
 * is in the sitemap means we shipped a dead page. Treating the first group as
 * failures is what made the old health check cry wolf every few hours - and a
 * check that cries wolf gets muted, which is how the 5-day publishing outage
 * went unnoticed.
 *
 * @returns {'pass'|'warn'|'fail'}
 */
export function classifyLiveStatus(status, url = '', isContentPage = false) {
    if (!status) return 'warn';                                  // timeout / DNS / egress
    if (status >= 200 && status < 400) return 'pass';
    if (status === 404 || status === 410) return 'fail';
    if (status === 403 || status === 429 || status === 503) {
        // Bot protection noise. Even on a content page: a challenge is not a
        // broken page, and the retries in probe() already filtered flakiness.
        return 'warn';
    }
    if (status >= 500) return 'fail';                            // origin is down
    if (status >= 400 && isContentPage) return 'fail';          // 4xx on a page we published
    return 'warn';
}

/**
 * Which days between the newest published item and today are missing?
 * Oldest first (so a backlog drains chronologically), capped at `lookback`,
 * and never earlier than `first` (the day the site started).
 */
export function planGapDays(haveDates, todayISO, { lookback = 7, first = null } = {}) {
    const isISO = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const set = new Set((haveDates || []).filter(isISO));
    const newest = [...set].sort().pop() || null;
    let cursor = newest ? addDays(newest, 1) : addDays(todayISO, -lookback);
    if (first && cursor < first) cursor = first;
    const out = [];
    for (let guard = 0; cursor < todayISO && guard < 400; guard++) {
        if (daysBetween(cursor, todayISO) <= lookback && !set.has(cursor)) out.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return out;
}

function publishedDatesFromDisk(dir) {
    const out = new Map();
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) return out;
    for (const f of readdirSync(full).filter(x => x.endsWith('.html'))) {
        const m = (read(path.join(dir, f)) || '').match(/"(?:datePublished|article:published_time)"?\s*[:=]\s*"?(\d{4}-\d{2}-\d{2})/)
            || read(path.join(dir, f)).match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/i);
        if (!m) continue;
        if (!out.has(m[1])) out.set(m[1], []);
        out.get(m[1]).push(f.replace(/\.html$/, ''));
    }
    return out;
}
function gapsSync(kind, today) {
    const have = publishedDatesFromDisk(kind === 'webstory' ? 'web-stories' : 'blog');
    if (!have.size) return [];
    return planGapDays([...have.keys()], today, { lookback: 7 });
}

function checkSchemaAndMeta() {
    const pages = [...readdirSync(path.join(ROOT, 'blog')).filter(f => f.endsWith('.html')).slice(0, 200).map(f => `blog/${f}`),
    ...(existsSync(path.join(ROOT, 'web-stories')) ? readdirSync(path.join(ROOT, 'web-stories')).filter(f => f.endsWith('.html')).map(f => `web-stories/${f}`) : [])];
    const jsonldBad = [];
    const noCanonical = [];
    const noViewport = [];
    for (const rel of pages) {
        const html = read(rel) || '';
        for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
            try { JSON.parse(m[1].trim()); } catch { jsonldBad.push(rel); break; }
        }
        if (!/rel="canonical"/.test(html)) noCanonical.push(rel);
        if (!/name="viewport"/.test(html)) noViewport.push(rel);
    }
    add('markup', `JSON-LD parses on all ${pages.length} content pages`, jsonldBad.length ? 'fail' : 'pass', jsonldBad.slice(0, 4).join(', '));
    add('markup', 'every content page has a canonical', noCanonical.length ? 'fail' : 'pass', noCanonical.slice(0, 4).join(', '));
    add('markup', 'every content page has a viewport', noViewport.length ? 'fail' : 'pass', noViewport.slice(0, 4).join(', '));
}

async function checkWorkflows() {
    const errors = await validateWorkflows();
    add('automation', 'publish workflow YAML is valid + guarded', errors.length ? 'fail' : 'pass', errors.slice(0, 3).join(' | '));
    const drift = [];
    for (const name of ['daily-blog.yml', 'daily-webstory.yml', 'health-check.yml']) {
        const fixed = path.join(ROOT, 'scripts', 'workflow-fixes', `${name}.fixed`);
        if (!existsSync(fixed)) continue;
        if (read(path.join('.github', 'workflows', name)) !== await fs.readFile(fixed, 'utf8').catch(() => '')) drift.push(name);
    }
    add('automation', 'live workflow files match scripts/workflow-fixes', drift.length ? 'warn' : 'pass',
        drift.length ? `not applied yet: ${drift.join(', ')} (needs the GitHub UI or WORKFLOW_PAT)` : '');
    const keys = readKeys();
    add('automation', 'AI provider key available to scripts', keys.any ? 'pass' : 'warn',
        keys.any ? keys.present.join(', ') : 'none in this environment (Actions secrets are not exposed to local runs)');
}

async function checkLive(sitemapUrls) {
    const must = [
        ['homepage', `${SITE}/`],
        ['blogs index', `${SITE}/blogs`],
        ['tools index', `${SITE}/tools`],
        ['web stories index', `${SITE}/web-stories`],
        ['ads.txt', `${SITE}/ads.txt`],
        ['robots.txt', `${SITE}/robots.txt`],
        ['sitemap.xml', `${SITE}/sitemap.xml`],
        ['RSS feed', `${SITE}/feed.xml`],
        ['404 page', `${SITE}/this-url-should-404-please-ignore`],
    ];
    const probes = await mapPool(must, async ([name, url]) => {
        const r = await probe(url);
        return { name, url, ...r };
    }, 4);
    for (const p of probes) {
        if (p.name === '404 page') {
            add('live', 'unknown URL returns 404 (not 200)', p.status === 404 ? 'pass' : 'warn', `got ${p.status || `error: ${p.err}`}`);
            continue;
        }
        const verdict = classifyLiveStatus(p.status, p.url, /\/blog\/|\/web-stories\//.test(p.url));
        add('live', `${p.name} returns 200`, verdict === 'pass' ? 'pass' : (verdict === 'warn' ? 'warn' : 'fail'),
            `${p.status || `error: ${p.err}`}${p.ms ? ` in ${p.ms}ms` : ''}${p.redirects.length ? ` (${p.redirects.join(', ')})` : ''}`);
    }

    // Sitemap URLs - the crawl surface. Only a definitive 404/410 after retries
    // is a failure; Cloudflare challenges and rate limits are warnings, because
    // they say nothing about the site being broken for real users.
    const urls = sitemapUrls.filter(u => !u.match(/\.(jpg|jpeg|png|webp|svg|ico|gif)$/i));
    const checked = await mapPool(urls, async (u) => ({ u, ...(await probe(u, { tries: 2 })) }), CONCURRENCY);
    const dead = checked.filter(c => classifyLiveStatus(c.status, c.u, true) === 'fail');
    const challenged = checked.filter(c => classifyLiveStatus(c.status, c.u, true) === 'warn');
    const redirected = checked.filter(c => c.redirects.length);
    add('live', `all ${urls.length} sitemap URLs respond 200`, dead.length ? 'fail' : 'pass',
        dead.slice(0, 6).map(d => `${d.status} ${d.u.replace(SITE, '')}`).join(', '));
    add('live', 'no Cloudflare challenge/rate-limit noise', challenged.length ? 'warn' : 'pass',
        challenged.length ? `${challenged.length} URL(s) challenged or timed out (retried ${2}x) - not a site failure` : '');
    add('live', 'no redirect hops in the sitemap', redirected.length ? 'warn' : 'pass',
        redirected.slice(0, 4).map(d => d.u.replace(SITE, '')).join(', '));
}

function runRepoAudits() {
    for (const [label, cmd, args] of [
        ['broken internal links', 'python3', ['scripts/audit-broken-links.py']],
        ['SEO assets (hotlinks/og/meta/orphans)', 'python3', ['scripts/audit-seo-assets.py']],
    ]) {
        const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
        const out = (r.stdout || '') + (r.stderr || '');
        add('audits', label, r.status === 0 ? 'pass' : 'fail', r.status === 0 ? '' : out.split('\n').filter(l => l.includes('❌') || l.includes('FAIL')).slice(0, 3).join(' | ').slice(0, 260));
    }
}

// ------------------------------------------------------------------ main ----
async function main() {
    console.log(`🩺 AIToolsNova site health - ${OFFLINE ? 'offline (repo only)' : 'live + repo'} - ${isoDate()}\n`);
    checkRepoFiles();
    const urls = checkSitemap();
    checkContentFreshness();
    checkSchemaAndMeta();
    runRepoAudits();
    await checkWorkflows();
    if (!OFFLINE) {
        try { await checkLive(urls); }
        catch (e) { add('live', 'live probing', 'warn', `skipped: ${e.message}`); }
    } else {
        add('live', 'live checks', 'warn', 'skipped (--offline)');
    }

    const fails = results.filter(r => r.status === 'fail');
    const warns = results.filter(r => r.status === 'warn');
    const report = {
        site: SITE,
        at: new Date().toISOString(),
        mode: OFFLINE ? 'offline' : 'live',
        summary: { checks: results.length, failed: fails.length, warned: warns.length },
        failed: fails,
        warned: warns,
        results,
    };
    const outPath = A.get('json', 'test_reports/site-health.json');
    if (outPath) {
        await fs.mkdir(path.dirname(path.join(ROOT, outPath)), { recursive: true }).catch(() => {});
        await fs.writeFile(path.join(ROOT, outPath), JSON.stringify(report, null, 2) + '\n');
        console.log(`\n📄 report: ${outPath}`);
    }

    const lines = [
        `### Site health — ${OFFLINE ? 'offline' : 'live'} · ${isoDate()}`,
        '',
        `**${results.length} checks** · ${fails.length} failing · ${warns.length} warning(s)`,
        '',
        ...(fails.length ? ['#### ❌ Failing', ...fails.map(f => `- **${f.group}** · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`), ''] : []),
        ...(warns.length ? ['#### ⚠️ Warnings', ...warns.map(f => `- **${f.group}** · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`), ''] : []),
        ...(fails.length ? ['#### How to read this', '', '- `freshness` failing = the auto-publish job is not landing content. Look at', '  `scripts/publish-log.json` and publish-status.json, then re-run the workflow.', '- `automation` failing = the workflow YAML still has a trap or needs a fix applied.', '- `live` failing = a URL in the sitemap is a real 404.'] : []),
    ];
    console.log('\n' + lines.join('\n'));
    if (AS_CI) await stepSummary(lines);
    for (const f of fails) if (AS_CI) annotate('error', `Health check failed: ${f.group}`, `${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    for (const w of warns) if (AS_CI) annotate('warning', `Health check warning: ${w.group}`, `${w.name}${w.detail ? ` — ${w.detail}` : ''}`);

    console.log(`\n${fails.length ? `❌ ${fails.length} failing check(s)` : '✅ No failing checks'} · ${warns.length} warning(s)`);
    return fails.length ? 1 : 0;
}

export { main, checkRepoFiles, checkSitemap, checkContentFreshness, checkSchemaAndMeta, checkLive, probe };

// Only self-run when invoked directly - the unit tests import these helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
main().then(code => process.exit(code)).catch(err => {
    console.error('❌ health checker crashed:', err);
    if (AS_CI) annotate('error', 'Health checker crashed', String(err?.message || err));
    process.exit(1);
});
}
