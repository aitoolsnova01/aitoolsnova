#!/usr/bin/env node
/**
 * AIToolsNova - publish-core
 * --------------------------
 * Shared, dependency-free plumbing for the auto-publishing pipelines
 * (blog + web story) and for the site health checker.
 *
 * Why this file exists (the bugs it kills, all observed in Actions runs):
 *
 *  1. "GREEN BUT EMPTY" - the blog job exited 0 even though generation died in
 *     0 seconds, because the workflow step used continue-on-error + a commit
 *     step that treated "No changes." as success. -> every failure now emits a
 *     ::error:: workflow command AND a machine-readable record in
 *     scripts/publish-log.json + publish-status.json, so a dead pipeline is
 *     visible in the run, in the repo and on the live site.
 *
 *  2. POISONED GIT INDEX - the web-story job restored .github/workflows/*.yml
 *     from scripts/workflow-fixes/*.fixed, committed it, failed to push (GitHub
 *     refuses workflow writes from a job token), then `git reset --soft` left
 *     those workflow files STAGED in the index. The very next step
 *     (`git add <content> && git diff --staged --quiet`) saw those staged
 *     workflow files, committed them and died on `git push` - so the story that
 *     WAS generated could never be published. -> the index is now always reset
 *     before staging, content paths are whitelisted, and workflow files can
 *     only be pushed with an explicit WORKFLOW_PAT.
 *
 *  3. NO CATCH-UP - one skipped/delayed schedule = one permanently missing day.
 *     -> gap planner + per-date publishing, so the next run fills the hole.
 *
 *  4. FRAGILE JSON - a truncated completion (free-tier token limits) meant
 *     "no valid JSON" and the whole day died. -> lenient parser + repair.
 *
 * No third-party imports: this must run on a bare GitHub Actions runner.
 */

import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const SITE = process.env.SITE_URL || 'https://aitoolsnova.com';
export const LEDGER_REL = path.join('scripts', 'publish-log.json');
export const STATUS_REL = 'publish-status.json';

// ---------------------------------------------------------------- keys ----

/** All AI keys, with the historical name variants the owner has used. */
export function readKeys(env = process.env) {
    const groq = env.GROQ_API_KEY || env.GROQ_KEY || '';
    const gemini = env.GEMINI_API_KEY || env.Gemini_API_key
        || env.GOOGLE_GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
    const deepseek = env.DEEPSEEK_API_KEY || env.Deepseek_API_key
        || env.DEEPSEEK_API_key || env.deepseek_api_key || '';
    const present = [];
    const missing = [];
    for (const [name, val] of [['GROQ_API_KEY', groq], ['GEMINI_API_KEY', gemini], ['DEEPSEEK_API_KEY', deepseek]]) {
        (val ? present : missing).push(name);
    }
    return { groq, gemini, deepseek, present, missing, any: present.length > 0 };
}

/**
 * The exact, copy-pasteable instruction for the one failure mode that no code
 * can fix by itself: no provider key visible to the workflow.
 */
export function noKeyGuidance(missing = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY']) {
    return [
        'No AI provider key is visible to this job, so nothing can be generated.',
        `Missing: ${missing.join(', ')}.`,
        'Fix (2 min): GitHub repo -> Settings -> Secrets and variables -> Actions ->',
        'New repository secret -> name GROQ_API_KEY -> value gsk_... (free at',
        'https://console.groq.com/keys) -> Add secret, then Actions ->',
        '"Blog Auto-Publish" -> Run workflow. Secrets stored under an',
        '"Environment" (e.g. Production) are NOT visible to scheduled runs -',
        'they must be repository secrets.',
    ].join(' ');
}

// --------------------------------------------------------- annotations ----

const inActions = () => process.env.GITHUB_ACTIONS === 'true';

/** Emit a GitHub Actions workflow command (harmless no-op markup elsewhere). */
export function annotate(level, title, message) {
    const safe = String(message || '').replace(/\r?\n/g, ' ').replace(/::/g, ': :').slice(0, 800);
    if (inActions()) console[level === 'error' ? 'error' : 'warn'](
        `::${level}${title ? ` title=${title}` : ''}::${safe}`
    );
    else if (level === 'error') console.error(`[error] ${title}: ${safe}`);
    return safe;
}

/** Append markdown to the Actions run summary (no-op outside Actions). */
export async function stepSummary(lines) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!file) return false;
    try {
        await fs.appendFile(file, lines.join('\n') + '\n', 'utf8');
        return true;
    } catch {
        return false;
    }
}

// -------------------------------------------------------------- errors ----

export class PublishError extends Error {
    constructor(message, { code = 'UNKNOWN', hint = '', retryable = false } = {}) {
        super(message);
        this.name = 'PublishError';
        this.code = code;
        this.hint = hint;
        this.retryable = retryable;
    }
}

/** Flatten an error into a single safe line for annotations/ledgers. */
export function describeError(err) {
    const raw = err instanceof Error ? (err.message || String(err)) : String(err || 'unknown error');
    const redacted = raw
        .replace(/(key|token|secret|authorization|bearer)\s*[=:]\s*\S+/gi, '$1=[redacted]')
        .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_[redacted]')
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]')
        .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[redacted]')
        .replace(/\s+/g, ' ');
    return redacted.slice(0, 400);
}

// -------------------------------------------------------------- http ------

/** fetch() with a hard timeout - without it one hung socket eats the job. */
export async function fetchWithTimeout(url, { timeoutMs, ...init } = {}, timeoutMsAlt) {
    const ms = Number(timeoutMs || timeoutMsAlt || 45_000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
    try {
        return await fetch(url, { ...init, signal: ac.signal });
    } finally {
        clearTimeout(timer);
    }
}

export function isTransientStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429
        || (status >= 500 && status <= 599);
}

/** Retry with exponential backoff + jitter. fn() must throw to trigger retry. */
export async function retry(fn, { tries = 3, baseMs = 1200, maxMs = 20_000, onRetry } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            const transient = err?.status ? isTransientStatus(err.status) : true;
            if (!transient || attempt === tries) break;
            const wait = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
            if (onRetry) onRetry(err, attempt, wait);
            else console.warn(`   ↻ retry ${attempt}/${tries - 1} in ${Math.round(wait / 1000)}s: ${describeError(err)}`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr;
}

// ------------------------------------------------------- JSON recovery ----

/** Balance an unterminated JSON prefix: close the open string, then the open containers. */
function balancePrefix(prefix) {
    const stack = [];
    let inStr = false, escp = false;
    for (let i = 0; i < prefix.length; i++) {
        const c = prefix[i];
        if (inStr) {
            if (escp) escp = false;
            else if (c === '\\') escp = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') stack.pop();
    }
    let out = inStr ? prefix + '"' : prefix;
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
    return out;
}

const tryParseObject = (s) => {
    try {
        const d = JSON.parse(s);
        return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    } catch { return null; }
};

/**
 * Pull the first JSON object out of a model reply and, if the reply was cut
 * off mid-string (free-tier token limits), repair it so the usable part
 * survives instead of killing the whole run.
 * Returns { data, repaired } - throws PublishError('no-json'|'bad-json').
 */
export function parseJsonLoose(text) {
    if (!text || !String(text).trim()) throw new PublishError('Empty AI reply', { code: 'no-json' });
    let s = String(text).trim();
    // strip ```json fences
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = s.indexOf('{');
    if (start < 0) throw new PublishError(`No JSON object found in reply: ${s.slice(0, 160)}`, { code: 'no-json' });
    let body = s.slice(start);

    // Fast path: a complete, balanced object.
    let depth = 0, inStr = false, escp = false, end = -1;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) {
            if (escp) escp = false;
            else if (c === '\\') escp = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const clean = (x) => x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[“”]/g, '"');

    let repaired = false;
    const candidates = [];
    if (end >= 0) {
        candidates.push(body.slice(0, end + 1));
    } else {
        repaired = true;
        const trimmed = body.replace(/,\s*$/, '');
        candidates.push(
            balancePrefix(trimmed.replace(/,\s*"[^"]*"\s*:\s*$/, '')),   // dangling "key":
            balancePrefix(trimmed.replace(/,\s*"[^"]*$/, '')),            // dangling "partial-string
            balancePrefix(trimmed.replace(/,\s*[A-Za-z0-9._+-]+$/, '')),   // dangling true / 123
            balancePrefix(trimmed),
        );
        // Then progressively cut back to the last complete element.
        let cut = trimmed.length;
        for (let i = 0; i < 30; i++) {
            const j = Math.max(trimmed.lastIndexOf('}', cut - 1), trimmed.lastIndexOf(']', cut - 1));
            if (j <= 0 || j >= cut) break;
            cut = j + 1;
            candidates.push(balancePrefix(trimmed.slice(0, cut)));
        }
    }
    for (const c of candidates) {
        const data = tryParseObject(clean(c));
        if (!data) continue;
        // Drop empty artefacts created by the repair pass.
        for (const k of Object.keys(data)) {
            if (Array.isArray(data[k])) data[k] = data[k].filter(v => v !== null && v !== '' && !(typeof v === 'object' && Object.keys(v).length === 0));
        }
        return { data, repaired };
    }
    throw new PublishError(`JSON parse failed after ${repaired ? 'repair' : 'extraction'}: ${body.slice(0, 160)}`, { code: 'bad-json' });
}

// -------------------------------------------------------------- dates -----

export function isoDate(d = new Date()) {
    const x = d instanceof Date ? d : new Date(d);
    return x.toISOString().slice(0, 10);
}

export function addDays(iso, delta) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return isoDate(d);
}

export function daysBetween(fromISO, toISO) {
    const a = Date.parse(fromISO + 'T00:00:00Z');
    const b = Date.parse(toISO + 'T00:00:00Z');
    if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
    return Math.round((b - a) / 86_400_000);
}

/**
 * Publish ledger - the durable answer to "did we already publish that day?".
 * mtime cannot be trusted: every file in a fresh CI checkout has the same
 * checkout timestamp, which is why "latest blog" lookups went random.
 */
export async function readLedger(root = process.cwd()) {
    const file = path.join(root, LEDGER_REL);
    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Array.isArray(parsed.entries)) return parsed;
    } catch { /* first run */ }
    return { version: 1, entries: [] };
}

export async function appendLedger(root, entry, { keep = 500 } = {}) {
    const ledger = await readLedger(root);
    const at = new Date().toISOString();
    const rec = {
        at,
        date: entry.date || at.slice(0, 10),
        kind: entry.kind || 'blog',
        slug: entry.slug || '',
        status: entry.status || 'ok',
        reason: entry.reason ? describeError(entry.reason) : '',
        words: Number.isFinite(entry.words) ? entry.words : undefined,
        pushed: entry.pushed === true,
    };
    // One record per (kind, date, slug): a retry overwrites the failed record.
    const dup = ledger.entries.findIndex(e => e.kind === rec.kind && e.date === rec.date && e.slug === rec.slug);
    if (dup >= 0) ledger.entries.splice(dup, 1, rec);
    else ledger.entries.push(rec);
    if (ledger.entries.length > keep) ledger.entries = ledger.entries.slice(-keep);
    await fs.mkdir(path.dirname(path.join(root, LEDGER_REL)), { recursive: true });
    await fs.writeFile(path.join(root, LEDGER_REL), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    return rec;
}

/** Dates that already have content on disk, derived from the HTML itself. */
export function publishedDatesFromFiles(root, kind) {
    const dir = kind === 'webstory' ? 'web-stories' : 'blog';
    const full = path.join(root, dir);
    const out = new Map(); // date -> [slugs]
    if (!existsSync(full)) return out;
    for (const f of readdirSync(full).filter(x => x.endsWith('.html'))) {
        let html = '';
        try { html = readFileSync(path.join(full, f), 'utf8'); } catch { continue; }
        const m = html.match(/"(?:article:published_time|datePublished)"[^0-9]*(\d{4}-\d{2}-\d{2})/i)
            || html.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/i)
            || html.match(/(\d{4}-\d{2}-\d{2})/);
        const date = m?.[1];
        if (!date) continue;
        if (!out.has(date)) out.set(date, []);
        out.get(date).push(f.replace(/\.html$/, ''));
    }
    return out;
}

export async function publishedDates(root, kind) {
    const fromFiles = publishedDatesFromFiles(root, kind);
    const dir = kind === 'webstory' ? 'web-stories' : 'blog';
    const ledger = await readLedger(root);
    for (const e of ledger.entries) {
        if (e.kind !== kind || e.status !== 'ok') continue;
        // A ledger entry only counts as "already published" while the article
        // actually exists. That way a deleted/lost file re-opens the gap instead
        // of being covered forever by a stale log line.
        if (!e.slug) continue;
        if (!existsSync(path.join(root, dir, `${e.slug}.html`))) continue;
        if (!fromFiles.has(e.date)) fromFiles.set(e.date, []);
        if (!fromFiles.get(e.date).includes(e.slug)) fromFiles.get(e.date).push(e.slug);
    }
    return fromFiles;
}

/**
 * Which recent days are missing content? Oldest first so the backlog drains
 * in order. Never proposes dates before the site's first published item (a
 * five-year-old repo must not try to backfill 900 posts) and never more than
 * `max` per run, so a broken day can't explode into a content flood.
 */
export async function planGaps(root, { kind = 'blog', days = 7, max = 3, today = isoDate() } = {}) {
    const have = await publishedDates(root, kind);
    if (!have.size) return { gaps: [], window: [], earliest: null };
    const earliest = [...have.keys()].sort()[0];
    const window = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = addDays(today, -i);
        if (d < earliest) continue;
        window.push(d);
    }
    const gaps = window.filter(d => !(have.get(d) || []).length).slice(0, max);
    return { gaps, window, earliest };
}

// ------------------------------------------------------------ git -------

export const git = (args, cwd, opts = {}) =>
    execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });

export const CONTENT_PATHS = {
    blog: ['blog/', 'blogs.html', 'sitemap.xml', 'scripts/topic-history.json', 'scripts/publish-log.json', 'publish-status.json'],
    webstory: ['web-stories/', 'web-stories.html', 'sitemap.xml', 'blog/', 'blogs.html', 'scripts/topic-history.json', 'scripts/publish-log.json', 'publish-status.json'],
};

function workflowsBlockedReason(err) {
    const t = String(err?.stderr || err?.message || '');
    return /refusing to allow .{0,60}(GitHub App|OAuth)|without `?workflows`? permission/i.test(t)
        ? 'GitHub refused the push because it contained .github/workflows files'
        : '';
}

/**
 * The ONLY commit/push path used by the publishing jobs.
 *
 * Guarantees:
 *  - the index is cleaned first (`git reset -q`) so a stale staged file from an
 *    earlier step can never ride along and get the push rejected;
 *  - only whitelisted content paths are staged - never .github/workflows;
 *  - on a rejected push (a human pushed while we were generating) it rebases
 *    onto the remote and retries, then leaves the files in the working tree if
 *    pushing is truly impossible, so a later step can finish the job;
 *  - returns a structured result instead of throwing for "nothing to do".
 */
export async function publishContent({
    root = process.cwd(),
    include = CONTENT_PATHS.blog,
    message = 'chore(auto-publish): content',
    allowWorkflows = false,
    push = true,
    dryRun = false,
    tries = 3,
    branch = process.env.PUBLISH_BRANCH || 'main',
} = {}) {
    const g = (args, opts) => git(args, root, opts);
    if (!existsSync(path.join(root, '.git'))) {
        return { committed: false, pushed: false, files: [], skipped: 'no-git-repo' };
    }
    if (dryRun || !push) {
        const status = await g(['status', '--porcelain']).catch(() => ({ stdout: '' }));
        return { committed: false, pushed: false, dryRun: true, files: status.stdout.split('\n').filter(Boolean).slice(0, 20) };
    }

    if (!allowWorkflows) include = include.filter(p => !p.startsWith('.github/workflows'));
    // `git add` aborts on an unknown pathspec, which used to silently mean
    // "nothing staged" -> "No changes." -> a green run with no content.
    const existing = include.filter(p => existsSync(path.join(root, p.replace(/\/$/, ''))));
    const absent = include.filter(p => !existing.includes(p));
    if (absent.length) console.log(`   ℹ️  not staging (missing): ${absent.join(', ')}`);

    // 1. Clean slate: never inherit a dirty index (the poisoned-index bug).
    await g(['reset', '-q']).catch(() => {});
    if (existing.length) await g(['add', '-A', '--', ...existing]);
    if (!allowWorkflows) await g(['reset', '-q', '--', '.github/workflows']).catch(() => {});

    const staged = await g(['diff', '--cached', '--name-only']).catch(() => ({ stdout: '' }));
    const files = staged.stdout.split('\n').filter(Boolean);
    if (!files.length) return { committed: false, pushed: false, files: [], skipped: 'no-changes' };

    await g(['-c', 'user.name=AIToolsNova Bot', '-c', 'user.email=bot@aitoolsnova.com', 'commit', '-m', message]);

    let lastErr = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            await g(['push', 'origin', `HEAD:refs/heads/${branch}`]);
            return { committed: true, pushed: true, files, attempt };
        } catch (err) {
            lastErr = err;
            const blocked = workflowsBlockedReason(err);
            if (blocked) {
                // Undo the commit, keep the files on disk: a content-only step
                // can still publish them, and the run says exactly why.
                await g(['reset', '--mixed', '-q', 'HEAD~1']).catch(() => {});
                throw new PublishError(`${blocked}. Only content paths should be committed; `.trim(), {
                    code: 'workflows-blocked',
                    hint: 'Apply .github/workflows changes through the GitHub web UI or a PAT with the workflows scope.',
                });
            }
            if (attempt < tries) {
                console.warn(`   ⚠️  push rejected (attempt ${attempt}/${tries}) - rebasing onto origin/${branch} and retrying...`);
                // --autostash: the worktree legitimately still holds files we
                // deliberately did not stage (e.g. .github/workflows), and a
                // plain rebase refuses to run with a dirty tree.
                const pull = await g(['pull', '--rebase', '--autostash', 'origin', branch])
                    .then(() => true).catch(() => false);
                if (!pull) await g(['rebase', '--abort']).catch(() => {});
                await new Promise(r => setTimeout(r, 1200 * attempt));
                continue;
            }
        }
    }
    // Could not push: un-commit, leave files dirty so the workflow's own commit
    // step can try again, and report precisely.
    await g(['reset', '--mixed', '-q', 'HEAD~1']).catch(() => {});
    throw new PublishError(`Committed locally but git push failed: ${describeError(lastErr)}`, {
        code: 'push-failed', retryable: true,
        hint: 'Check Repo -> Settings -> Actions -> Workflow permissions = "Read and write permissions".',
    });
}

// -------------------------------------------------------- status file ----

/**
 * publish-status.json is committed to the repo root, so it is reachable at
 * https://aitoolsnova.com/publish-status.json. It is the single place the user
 * (and the health check) can look to see whether automation is alive.
 * Secrets are never written here - only booleans and names.
 */
export async function writePublishStatus(root, {
    kind = 'blog',
    ok = true,
    reason = '',
    slug = '',
    date = isoDate(),
    pushed = false,
    extra = {},
} = {}) {
    const file = path.join(root, STATUS_REL);
    let prev = {};
    try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first write */ }

    const blogDates = publishedDatesFromFiles(root, 'blog');
    const storyDates = publishedDatesFromFiles(root, 'webstory');
    const newest = m => (m.size ? [...m.keys()].sort().at(-1) : null);
    const today = isoDate();
    const keys = readKeys();
    const ledger = await readLedger(root);

    const status = {
        ...prev,
        site: SITE,
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        automation: {
            blog: {
                newest: newest(blogDates),
                daysSinceNewest: newest(blogDates) ? daysBetween(newest(blogDates), today) : null,
            },
            webstory: {
                newest: newest(storyDates),
                daysSinceNewest: newest(storyDates) ? daysBetween(newest(storyDates), today) : null,
            },
        },
        lastRun: {
            kind,
            ok,
            date,
            slug,
            pushed,
            reason: reason ? describeError(reason) : '',
            at: new Date().toISOString(),
        },
        providers: {
            groq: !!keys.groq, gemini: !!keys.gemini, deepseek: !!keys.deepseek,
            anyConfigured: keys.any,
        },
        ledgerTail: ledger.entries.slice(-12).reverse(),
        ...extra,
    };
    await fs.writeFile(file, JSON.stringify(status, null, 2) + '\n', 'utf8');
    return status;
}

// --------------------------------------------------- site API fallback ----
/**
 * Last-resort provider: the site's OWN /api/gemini proxy (functions/api/gemini.js)
 * already holds the Gemini/Groq/DeepSeek keys as Cloudflare Pages env secrets and
 * already implements a per-model fallback chain. Using it when no key is visible
 * to the Actions job turns "0 posts for 5 days because a secret is missing" into
 * "still publishing". ~8 requests per article, far below the endpoint's
 * 45 req/min/IP limit, and it never leaves the owner's own account.
 *
 * Disable with SITE_API_FALLBACK=0.
 */
export function siteApiAllowed(env = process.env) {
    return env.SITE_API_FALLBACK !== '0' && env.SITE_API_FALLBACK !== 'false';
}

const siteApiBucket = { stamps: [] };
async function respectSiteApiLimit(perMinute = 25) {
    const now = Date.now();
    siteApiBucket.stamps = siteApiBucket.stamps.filter(t => now - t < 60_000);
    if (siteApiBucket.stamps.length >= perMinute) {
        const wait = 60_000 - (now - siteApiBucket.stamps[0]) + 500;
        console.warn(`   ⏳ site API rate budget reached - waiting ${Math.ceil(wait / 1000)}s`);
        await new Promise(r => setTimeout(r, Math.min(wait, 65_000)));
        siteApiBucket.stamps = siteApiBucket.stamps.filter(t => Date.now() - t < 60_000);
    }
    siteApiBucket.stamps.push(Date.now());
}

export async function callSiteApi(promptText, { tool = 'writer', timeoutMs = 60_000, endpoint } = {}) {
    if (!siteApiAllowed()) {
        throw new PublishError('Site API fallback disabled (SITE_API_FALLBACK=0)', { code: 'site-api-off' });
    }
    const url = endpoint || `${SITE}/api/gemini`;
    if (!String(promptText || '').trim()) throw new PublishError('Empty prompt for site API', { code: 'bad-prompt' });
    await respectSiteApiLimit();
    // The endpoint accepts at most 12,000 chars. If a prompt is longer, keep the
    // opening brief AND the closing output contract (that is where the JSON
    // schema lives) instead of blindly cutting the tail and getting prose back.
    let message = String(promptText || '');
    if (message.length > 11_500) {
        message = message.slice(0, 7000) + '\n[...middle trimmed...]\n' + message.slice(-4200);
    }
    let res;
    try {
        res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // The function allows same-site origins only; this is a same-site
                // job, so declaring the site origin is correct, not a bypass.
                'Origin': SITE,
                'User-Agent': 'AIToolsNova-AutoPublish/1.0 (+https://aitoolsnova.com)',
            },
            body: JSON.stringify({ message, tool }),
            timeoutMs,
        });
    } catch (err) {
        throw new PublishError(`site API unreachable: ${describeError(err)}`, { code: 'site-api-network', retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = String(data?.error || `HTTP ${res.status}`).slice(0, 200);
        throw new PublishError(`site API ${res.status}: ${detail}`, {
            code: res.status === 429 ? 'site-api-429' : 'site-api-error',
            retryable: isTransientStatus(res.status),
        });
    }
    const reply = String(data?.reply || '').trim();
    if (!reply) throw new PublishError('site API returned an empty reply', { code: 'site-api-empty', retryable: true });
    return { content: reply, provider: `siteapi:${data?.provider || 'unknown'}` };
}

// ------------------------------------------------------------- misc ------

export function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

export function dedupeBy(list, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const k = String(keyFn(item) ?? '').toLowerCase().trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(item);
    }
    return out;
}

/** Count visible words in an HTML fragment (same rule as the blog QA gate). */
export function visibleWords(html) {
    const plain = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
    return (plain.match(/[A-Za-z0-9']+/g) || []).length;
}

/** True when the process is running inside GitHub Actions. */
export function isCI() {
    return process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
}

/** Minimal argv parser shared by the generators and the health checker. */
export function parseArgs(argv = process.argv.slice(2)) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { positional.push(a); continue; }
        const raw = a.slice(2);
        const eq = raw.indexOf('=');
        if (eq >= 0) { flags[raw.slice(0, eq)] = raw.slice(eq + 1); continue; }
        const next = argv[i + 1];
        // `--date 2026-08-24` -> value; bare `--dry-run` -> true
        if (next !== undefined && !next.startsWith('--')) { flags[raw] = next; i++; }
        else flags[raw] = true;
    }
    const num = (k, d) => (flags[k] === undefined ? d : flags[k] === true ? 1 : Number(flags[k]));
    const bool = (k, d = false) => (flags[k] === undefined ? d : flags[k] !== '0' && flags[k] !== 'false');
    return { flags, positional, num, bool, get: (k, d) => (flags[k] === undefined ? d : flags[k]) };
}

export default {
    SITE, readKeys, noKeyGuidance, annotate, stepSummary, PublishError, describeError,
    fetchWithTimeout, isTransientStatus, retry, parseJsonLoose, isoDate, addDays, daysBetween,
    readLedger, appendLedger, publishedDates, publishedDatesFromFiles, planGaps,
    publishContent, CONTENT_PATHS, writePublishStatus, visibleWords, isCI, parseArgs,
    chunk, dedupeBy,
};
