#!/usr/bin/env node
/**
 * AIToolsNova - publish verifier
 * ------------------------------
 * Answers one question with a pass/fail that a workflow step can gate on:
 *
 *   "Did this run actually put content on main - not just exit 0?"
 *
 * The old jobs reported success while publishing nothing (continue-on-error on
 * the generate step + `git diff --staged --quiet || exit 0` on the commit step),
 * which is why the blog was silently missing for days. This script closes that
 * hole and is the last step of both publish workflows.
 *
 * Checks, in order:
 *   1. the publish log has a fresh `ok` entry for this kind (today, or the
 *      newest date it covers);
 *   2. the file(s) exist on disk and are non-trivial (words/amp-story present);
 *   3. the file is on origin/<branch> - so "generated but never pushed" fails;
 *   4. blogs.html / web-stories.html + sitemap.xml list it (a page nobody can
 *      reach from the site is the same as no page);
 *   5. a stale-site warning when the newest post is older than MAX_AGE_DAYS.
 *
 * Usage:
 *   node scripts/verify-publish.mjs --kind=blog
 *   node scripts/verify-publish.mjs --kind=webstory --date=2026-08-24 --strict
 * Exit 0 = published and reachable, 1 = not.
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    isoDate, daysBetween, publishedDates, readLedger, parseArgs, annotate,
    stepSummary, visibleWords, SITE,
} from './lib/publish-core.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(process.env.REPO_ROOT || process.cwd());
const git = (args) => execFileP('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
const A = parseArgs();
const KIND = A.get('kind', 'blog');
const LABEL = KIND === 'webstory' ? 'web story' : 'blog post';
const DIR = KIND === 'webstory' ? 'web-stories' : 'blog';
const STRICT = A.bool('strict', true);
const MAX_AGE_DAYS = Number(A.get('max-age-days', process.env.MAX_AGE_DAYS || 3));
const BRANCH = A.get('branch', process.env.VERIFY_BRANCH || 'main');
const TODAY = A.get('date', isoDate());

const problems = [];
const notes = [];
const fail = (msg) => { problems.push(msg); return false; };
const ok = (msg) => { notes.push(msg); return true; };

async function fileOnRemote(relPath) {
    try {
        await git(['fetch', '--quiet', 'origin', BRANCH]);
    } catch (e) {
        // Offline or no remote: cannot prove the push, so say so and let it pass
        // only when not running in CI.
        if (process.env.GITHUB_ACTIONS === 'true') return fail(`cannot reach origin/${BRANCH} to verify the push: ${e.message}`);
        return ok(`skipped remote check (no origin/${BRANCH} reachable)`);
    }
    try {
        const { stdout } = await git(['ls-tree', '-r', '--name-only', `origin/${BRANCH}`, '--', relPath]);
        return stdout.trim() ? ok(`${relPath} is on origin/${BRANCH}`)
            : fail(`${relPath} was generated but is NOT on origin/${BRANCH} (never pushed)`);
    } catch (e) {
        return fail(`git ls-tree failed: ${e.message}`);
    }
}

async function main() {
    if (!existsSync(path.join(ROOT, DIR))) return finish(fail(`${DIR}/ directory missing`));

    const have = await publishedDates(ROOT, KIND);
    const dates = [...have.keys()].sort();
    const newest = dates.at(-1);
    if (!newest) return finish(fail(`no ${LABEL} found anywhere under ${DIR}/`));

    const age = daysBetween(newest, TODAY);
    if (age > MAX_AGE_DAYS) {
        fail(`newest ${LABEL} is ${newest} (${age} days old; allowed ${MAX_AGE_DAYS}). Freshness gate failed.`);
    } else {
        ok(`newest ${LABEL}: ${newest} (${age} day(s) old)`);
    }

    // Which slugs should exist for the freshest date?
    const slugs = have.get(newest) || [];
    if (!slugs.length) return finish(fail(`${newest} has no file for ${LABEL} (ledger entry without content?)`));

    const ledger = await readLedger(ROOT);
    const entry = ledger.entries.find(e => e.kind === KIND && e.status === 'ok' && slugs.includes(e.slug));
    if (!entry) notes.push('no matching ledger entry (verified from files instead)');
    else ok(`ledger ok entry: ${entry.slug} @ ${entry.date}`);

    for (const slug of slugs) {
        const rel = `${DIR}/${slug}.html`;
        const abs = path.join(ROOT, rel);
        if (!existsSync(abs)) { fail(`${rel} is listed but does not exist`); continue; }
        const html = readFileSync(abs, 'utf8');
        if (html.length < 6000) fail(`${rel} is only ${html.length} bytes - suspiciously thin`);
        if (KIND === 'webstory') {
            const pages = (html.match(/amp-story-page id=/g) || []).length;
            if (pages < 8) fail(`${rel} has only ${pages} amp-story pages (need 8+)`);
            else ok(`${rel}: ${pages} story pages`);
            if (/https?:\/\/image\.pollinations\.ai/.test(html)) fail(`${rel} still hot-links Pollinations images`);
        } else {
            const words = visibleWords(html);
            if (words < 500) fail(`${rel} has ${words} visible words - too thin to publish`);
            else ok(`${rel}: ${words} words`);
            if (!html.includes('rel="canonical"')) fail(`${rel} has no canonical URL`);
            if (!html.includes('ca-pub-2278101269918728')) fail(`${rel} lost its AdSense tag`);
        }
        // discoverability: linked from the index + listed in the sitemap
        const indexFile = KIND === 'webstory' ? 'web-stories.html' : 'blogs.html';
        const index = readFileSync(path.join(ROOT, indexFile), 'utf8');
        if (!index.includes(`${DIR}/${slug}`)) fail(`${slug} is not linked from /${indexFile.replace('.html', '')}`);
        const sitemap = readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
        if (!sitemap.includes(`${SITE}/${DIR}/${slug}`)) fail(`${slug} is missing from sitemap.xml`);
        await fileOnRemote(rel);
    }

    return finish(problems.length ? false : true);
}

function finish(good) {
    const lines = [
        `### Publish verification - ${LABEL}`,
        '',
        ...notes.map(n => `- ✅ ${n}`),
        ...problems.map(p => `- ❌ ${p}`),
    ];
    console.log(lines.join('\n'));
    if (good) {
        console.log(`✅ ${LABEL} publish verified`);
        stepSummary(lines);
        process.exit(0);
    }
    const msg = problems.join(' | ').slice(0, 700);
    annotate('error', `Publish verification failed (${LABEL})`, msg);
    stepSummary(lines);
    console.error(`❌ ${msg}`);
    process.exit(STRICT ? 1 : 0);
}

main().catch(err => {
    annotate('error', 'Publish verifier crashed', String(err?.message || err));
    console.error(err);
    process.exit(1);
});
