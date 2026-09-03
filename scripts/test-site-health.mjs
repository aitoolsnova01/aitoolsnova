#!/usr/bin/env node
/**
 * scripts/test-site-health.mjs — contract tests for scripts/site-health.mjs
 *
 * Why this exists: a health checker that always returns "OK" is worse than no
 * health checker (this repo shipped for weeks with a red-on-noise / green-on-
 * outage setup). So the classifier itself is tested: which signals must FAIL,
 * which must only WARN, and whether the freshness/gap math is right.
 *
 * Usage:  node scripts/test-site-health.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyLiveStatus, planGapDays, probe } from './site-health.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` → ${extra}`}`);
    ok ? pass++ : fail++;
};

/* ── status classification ─────────────────────────────────────────── */
check('404 fails (a real dead page)', classifyLiveStatus(404, 'https://aitoolsnova.com/blog/x.html') === 'fail');
check('410 fails', classifyLiveStatus(410, 'https://aitoolsnova.com/blog/x.html') === 'fail');
check('500 fails (origin down)', classifyLiveStatus(500, 'https://aitoolsnova.com/') === 'fail');
check('503 is noise (Cloudflare/origin unavailable)', classifyLiveStatus(503, 'https://aitoolsnova.com/') === 'warn');
check('403 is noise, not failure (Cloudflare challenge)', classifyLiveStatus(403, 'https://aitoolsnova.com/ads.txt') === 'warn');
check('429 is noise (rate limit)', classifyLiveStatus(429, 'https://aitoolsnova.com/sitemap.xml') === 'warn');
// Deliberate design choice, documented in classifyLiveStatus(): a bot
// challenge is never a page failure, not even on a content URL.
check('403 on a content page is still noise', classifyLiveStatus(403, 'https://aitoolsnova.com/blog/gone.html', true) === 'warn');
check('500 on a content page fails', classifyLiveStatus(500, 'https://aitoolsnova.com/blog/x.html', true) === 'fail');
check('timeout (status 0) is noise', classifyLiveStatus(0, 'https://aitoolsnova.com/blog/x.html') === 'warn');
check('200 passes', classifyLiveStatus(200, 'https://aitoolsnova.com/') === 'pass');
check('301 passes (redirect followed)', classifyLiveStatus(301, 'https://aitoolsnova.com/sitemap') === 'pass');

/* ── gap math ──────────────────────────────────────────────────────── */
{
    const gaps = planGapDays(['2026-08-23'], '2026-08-28', { lookback: 10, first: '2026-05-01' });
    check('gaps detected for every missing day', gaps.length === 4, `got ${gaps.length}: ${gaps.join(',')}`);
    check('gap list is oldest-first', gaps[0] === '2026-08-24', gaps.join(','));
    check('today is not treated as missing', !gaps.includes('2026-08-28'), gaps.join(','));
    const none = planGapDays(['2026-08-27', '2026-08-28'], '2026-08-28', { lookback: 10 });
    check('no gaps when the last days are covered', none.length === 0, none.join(','));
    const capped = planGapDays([], '2026-08-28', { lookback: 3 });
    check('lookback caps the backlog', capped.length === 3, capped.join(','));
}

/* ── probe() must survive network noise ────────────────────────────── */
// Regression: `last` used to be declared `const` inside probe() and rebound in
// the catch, so a single failed request threw "Assignment to constant
// variable" and main() downgraded the ENTIRE live group to a warning.
// Port 9 has nothing listening -> guaranteed ECONNREFUSED, no network needed.
{
    const r = await probe('http://127.0.0.1:9/nothing-listens-here', { tries: 1 }).catch(e => ({ threw: e }));
    check('probe() returns instead of throwing when the request fails', !r.threw, r.threw?.message);
    check('probe() reports status 0 for a failed request', r.status === 0, `status=${r.status}`);
    check('probe() keeps the error message', typeof r.err === 'string' && r.err.length > 0, String(r.err));
    check('probe() always returns a redirects array', Array.isArray(r.redirects), `redirects=${r.redirects}`);
    check('probe() flags the request as exhausted', r.exhausted === true, `exhausted=${r.exhausted}`);
}

/* ── end-to-end on a deliberately broken fixture repo ──────────────── */
{
    const root = mkdtempSync(join(tmpdir(), 'sitehealth-'));
    try {
        for (const d of ['blog', 'web-stories', 'scripts']) mkdirSync(join(root, d), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<html><head><title>x</title></head><body>ok</body></html>');
        // sitemap listing a page that does NOT exist -> must fail
        writeFileSync(join(root, 'sitemap.xml'),
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + '<url><loc>https://aitoolsnova.com/blog/exists.html</loc><lastmod>2026-08-28</lastmod></url>\n'
            + '<url><loc>https://aitoolsnova.com/blog/ghost.html</loc><lastmod>2026-08-28</lastmod></url>\n'
            + '</urlset>\n');
        writeFileSync(join(root, 'blog', 'exists.html'),
            '<html><head><title>E</title><meta name="viewport" content="width=device-width">'
            + '<link rel="canonical" href="https://aitoolsnova.com/blog/exists.html">'
            + '<script type="application/ld+json">{"@context":"https://schema.org"</script></head><body>x</body></html>');
        writeFileSync(join(root, 'ads.txt'), 'google.com, pub-NOPE, DIRECT, f08c47fec0942fa0\n');
        writeFileSync(join(root, 'robots.txt'), 'Sitemap: https://wrong.example/sitemap.xml\n');
        writeFileSync(join(root, 'scripts', 'publish-log.json'), '{"entries":[]}\n');
        writeFileSync(join(root, 'publish-status.json'), '{}\n');

        const r = spawnSync(process.execPath, [
            join(process.cwd(), 'scripts', 'site-health.mjs'), '--offline',
            '--root', root, '--json', join(root, 'report.json'),
            `--root=${root}`, '--json=report.json',
        ], { encoding: 'utf8', timeout: 180000 });
        const out = (r.stdout || '') + (r.stderr || '');
        check('broken fixture exits non-zero', r.status === 1, `exit=${r.status}`);
        check('broken fixture: stale content fails', /newest blog/.test(out) && /❌ \[freshness\]/.test(out), out.slice(0, 200));
        check('broken fixture: ghost sitemap URL fails', /ghost\.html/.test(out), '');
        check('broken fixture: wrong ads.txt pub id fails', /ads\.txt/.test(out), '');
        check('broken fixture: robots.txt sitemap host fails', /robots/.test(out), '');
        check('broken fixture: bad JSON-LD fails', /JSON-LD/.test(out), '');
        const rep = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
        check('JSON report has failed entries', Array.isArray(rep.failed) && rep.failed.length >= 4, `${rep.failed?.length}`);
        check('JSON report records warnings separately', Array.isArray(rep.warned), '');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}


console.log(`\n${fail ? '❌' : '✅'} ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
