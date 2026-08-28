#!/usr/bin/env node
/**
 * Offline unit tests for scripts/lib/publish-core.mjs.
 * No network, no AI keys: run any time with `node scripts/test-publish-core.mjs`
 * (it is also part of `npm test`).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as C from './lib/publish-core.mjs';

const execFileP = promisify(execFile);
const git = (args, cwd) => execFileP('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

let pass = 0, fail = 0;
const check = async (name, fn) => {
    try { await fn(); console.log(`✅ ${name}`); pass++; }
    catch (e) { console.error(`❌ ${name}\n   ${e.message}`); fail++; }
};

// ---------- parseJsonLoose ----------
await check('parses clean JSON', () => {
    const { data, repaired } = C.parseJsonLoose('{"a":1,"b":[1,2]}');
    assert.equal(data.b.length, 2);
    assert.equal(repaired, false);
});
await check('strips markdown fences', () => {
    const { data } = C.parseJsonLoose('```json\n{"title":"x"}\n```');
    assert.equal(data.title, 'x');
});
await check('repairs a truncated reply', () => {
    const { data, repaired } = C.parseJsonLoose('{"title":"Hello","sections":[{"h2":"One","body_html":"<p>text');
    assert.equal(data.title, 'Hello');
    assert.equal(repaired, true);
    assert.ok(Array.isArray(data.sections));
});
await check('drops a dangling half key', () => {
    const { data } = C.parseJsonLoose('{"a":1,"b":2,"ccc');
    assert.equal(data.a, 1);
    assert.equal(data.b, 2);
});
await check('tolerates curly quotes and trailing commas', () => {
    const { data } = C.parseJsonLoose('{"a":1,}');
    assert.equal(data.a, 1);
});
await check('throws a typed error on garbage', () => {
    assert.throws(() => C.parseJsonLoose('no json here'), e => e.code === 'no-json');
    assert.throws(() => C.parseJsonLoose(''), e => e.code === 'no-json');
});

// ---------- keys ----------
await check('key variants are detected', () => {
    const k = C.readKeys({ GROQ_KEY: 'gsk_x', Gemini_API_key: 'AIza_y' });
    assert.equal(k.groq, 'gsk_x');
    assert.equal(k.gemini, 'AIza_y');
    assert.equal(k.any, true);
    assert.deepEqual(k.missing, ['DEEPSEEK_API_KEY']);
});
await check('no keys => actionable guidance naming every secret', () => {
    const k = C.readKeys({});
    assert.equal(k.any, false);
    const g = C.noKeyGuidance(k.missing);
    for (const need of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'console.groq.com', 'repository secret']) {
        assert.ok(g.includes(need), `guidance must mention ${need}`);
    }
});
await check('describeError redacts secrets', () => {
    const s = C.describeError(new Error('Authorization: Bearer gsk_abc123def456 and sk-proj-abcdefghijklmnop'));
    assert.ok(!s.includes('gsk_abc123'), 'groq key leaked');
    assert.ok(!s.includes('sk-proj-abcdefghijklmnop'), 'openai key leaked');
});

// ---------- dates ----------
await check('addDays / daysBetween across month boundary', () => {
    assert.equal(C.addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(C.daysBetween('2026-08-23', '2026-08-28'), 5);
});

// ---------- ledger + gap planner ----------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pubcore-'));
await fs.mkdir(path.join(tmp, 'blog'), { recursive: true });
await fs.mkdir(path.join(tmp, 'web-stories'), { recursive: true });
await fs.mkdir(path.join(tmp, 'scripts'), { recursive: true });

const writePost = async (dir, slug, date) => {
    await fs.writeFile(path.join(tmp, dir, `${slug}.html`),
        `<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"${date}T00:00:00+00:00"}</script></head><body><h1>${slug}</h1></body></html>`);
};

await check('publishedDates reads datePublished from disk (mtime is not trusted)', async () => {
    await writePost('blog', 'post-a', '2026-08-21');
    await writePost('blog', 'post-b', '2026-08-23');
    // Same mtime for everything, exactly like a fresh CI checkout.
    const have = await C.publishedDates(tmp, 'blog');
    assert.ok(have.has('2026-08-21') && have.has('2026-08-23'));
});
await check('planGaps finds the missing days and caps per run', async () => {
    // posts exist for 2026-08-21 and 2026-08-23 only; window = 21..26
    const { gaps } = await C.planGaps(tmp, { kind: 'blog', days: 6, max: 2, today: '2026-08-26' });
    assert.deepEqual(gaps, ['2026-08-22', '2026-08-24'], 'oldest missing days first, capped at max');
});
await check('planGaps never backfills before the first post ever', async () => {
    const { gaps } = await C.planGaps(tmp, { kind: 'blog', days: 30, max: 3, today: '2026-08-26' });
    assert.ok(!gaps.includes('2026-08-21') && !gaps.includes('2026-08-23'));
    assert.ok(gaps.every(d => d >= '2026-08-21'));
});
await check('ledger + existing file marks a day as published (retry-safe)', async () => {
    await C.appendLedger(tmp, { kind: 'blog', date: '2026-08-24', slug: 'post-a', status: 'ok' });
    const { gaps } = await C.planGaps(tmp, { kind: 'blog', days: 6, max: 2, today: '2026-08-26' });
    assert.ok(!gaps.includes('2026-08-24'), '2026-08-24 should be considered published');
});
await check('a stale ok entry whose file is gone re-opens the gap', async () => {
    await C.appendLedger(tmp, { kind: 'blog', date: '2026-08-22', slug: 'deleted-post', status: 'ok' });
    const { gaps } = await C.planGaps(tmp, { kind: 'blog', days: 6, max: 3, today: '2026-08-26' });
    assert.ok(gaps.includes('2026-08-22'), 'missing file must not be hidden by the ledger');
});
await check('failed ledger entries do not count as published and store a reason', async () => {
    await C.appendLedger(tmp, { kind: 'blog', date: '2026-08-25', slug: '', status: 'fail', reason: 'All providers failed' });
    const l = await C.readLedger(tmp);
    const bad = l.entries.find(e => e.date === '2026-08-25');
    assert.equal(bad.status, 'fail');
    assert.match(bad.reason, /providers failed/);
});

// ---------- status file ----------
await check('publish-status.json summarizes freshness + key booleans', async () => {
    const s = await C.writePublishStatus(tmp, { kind: 'blog', ok: false, reason: 'no keys', slug: '', date: '2026-08-26' });
    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, C.STATUS_REL), 'utf8'));
    assert.equal(onDisk.lastRun.ok, false);
    assert.match(onDisk.lastRun.reason, /no keys/);
    assert.equal(onDisk.providers.anyConfigured, false);
    assert.ok(onDisk.automation.blog.newest >= '2026-08-21');
    assert.equal(typeof onDisk.automation.blog.daysSinceNewest, 'number');
    const raw = JSON.stringify(onDisk);
    assert.ok(!/gsk_/.test(raw), 'status file must never contain a key');
    void s;
});

// ---------- git publisher ----------
const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pubcore-git-'));
await git(['init', '-q', '-b', 'main'], repo);
await git(['config', 'user.email', 't@t.tt'], repo);
await git(['config', 'user.name', 't'], repo);
await fs.mkdir(path.join(repo, 'blog'), { recursive: true });
await fs.mkdir(path.join(repo, 'web-stories'), { recursive: true });
await fs.mkdir(path.join(repo, '.github', 'workflows'), { recursive: true });
await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
await fs.writeFile(path.join(repo, 'README.md'), 'seed\n');
await fs.writeFile(path.join(repo, 'sitemap.xml'), '<urlset/>\n');
await fs.writeFile(path.join(repo, 'blog', 'old.html'), '<html></html>\n');
await fs.writeFile(path.join(repo, '.github', 'workflows', 'daily-blog.yml'), 'name: x\n');
await git(['add', '-A'], repo);
await git(['commit', '-qm', 'seed'], repo);

// bare remote, like origin/main
const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'pubcore-remote-'));
await git(['init', '-q', '--bare', '-b', 'main', remote], repo);
await git(['push', '-q', remote, 'main'], repo);
await git(['remote', 'add', 'origin', remote], repo);

await check('publishes only whitelisted content paths', async () => {
    await fs.writeFile(path.join(repo, 'blog', 'new.html'), '<html>new</html>\n');
    await fs.writeFile(path.join(repo, 'contact.html'), '<html>x</html>\n'); // not in include list
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.blog, message: 'auto: blog' });
    assert.equal(res.committed, true);
    assert.equal(res.pushed, true);
    assert.ok(res.files.some(f => f.includes('blog/new.html')));
    assert.ok(!res.files.some(f => f === 'contact.html'), 'unrelated file must not be committed');
});
await check('returns no-changes instead of failing when nothing was generated', async () => {
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.blog, message: 'nothing' });
    assert.equal(res.committed, false);
    assert.equal(res.skipped, 'no-changes');
});
await check('NEVER stages .github/workflows from the content path (webstory list includes blog/)', async () => {
    await fs.writeFile(path.join(repo, 'web-stories', 's1.html'), '<html>s</html>\n');
    await fs.writeFile(path.join(repo, '.github', 'workflows', 'daily-blog.yml'), 'name: changed\n');
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.webstory, message: 'auto: story' });
    assert.equal(res.pushed, true);
    assert.ok(!res.files.some(f => f.startsWith('.github/workflows')), 'workflow file leaked into a content commit');
    // the workflow edit must still be uncommitted in the worktree
    const { stdout } = await git(['status', '--porcelain'], repo);
    assert.match(stdout, /\.github\/workflows\/daily-blog\.yml/);
});
await check('a POISONED index from an earlier step cannot hijack the commit', async () => {
    // Reproduce the old failure: a previous step committed workflows and did
    // `git reset --soft HEAD~1`, leaving workflow files staged.
    await git(['add', '.github/workflows/daily-blog.yml'], repo);
    await fs.writeFile(path.join(repo, 'blog', 'poison.html'), '<html>p</html>\n');
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.blog, message: 'auto: blog2' });
    assert.equal(res.pushed, true, 'publish must still succeed');
    assert.ok(!res.files.some(f => f.startsWith('.github/workflows')), 'staged workflow file must not be committed');
    const { stdout } = await git(['diff', '--cached', '--name-only'], repo);
    assert.equal(stdout.trim(), '', 'index must be clean afterwards');
});
await check('push conflict is resolved by rebase + retry', async () => {
    // Someone else advances main while we are generating.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'pubcore-other-'));
    await git(['clone', '-q', remote, other], repo);
    await fs.writeFile(path.join(other, 'someone.md'), 'hi\n');
    await git(['add', 'someone.md'], other);
    await git(['-c', 'user.email=t@t.tt', '-c', 'user.name=t', 'commit', '-qm', 'other'], other);
    await git(['push', '-q', 'origin', 'main'], other);
    await fs.writeFile(path.join(repo, 'blog', 'race.html'), '<html>r</html>\n');
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.blog, message: 'auto: race' });
    assert.equal(res.pushed, true);
    assert.ok(res.attempt >= 1);
    const { stdout } = await git(['log', '--oneline', 'origin/main'], repo);
    assert.match(stdout, /auto: race/);
});
await check('dry-run touches nothing', async () => {
    await fs.writeFile(path.join(repo, 'blog', 'dry.html'), '<html>d</html>\n');
    const before = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const res = await C.publishContent({ root: repo, include: C.CONTENT_PATHS.blog, dryRun: true });
    assert.equal(res.committed, false);
    assert.equal(res.dryRun, true);
    const after = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
    assert.equal(before, after);
    await git(['clean', '-fdq'], repo);
});

// ---------- misc ----------
await check('visibleWords ignores script/style', () => {
    const n = C.visibleWords('<script>var a="one two three four five six";</script><p>one two three</p>');
    assert.equal(n, 3);
});
await check('dedupeBy is case/whitespace insensitive', () => {
    const out = C.dedupeBy([{ h2: 'Alpha' }, { h2: ' alpha ' }, { h2: 'Beta' }], x => x.h2);
    assert.equal(out.length, 2);
});
await check('parseArgs handles --flag, --k=v and booleans', () => {
    const a = C.parseArgs(['--backfill=3', '--dry-run', '--date', 'x']);
    assert.equal(a.num('backfill'), 3);
    assert.equal(a.bool('dry-run'), true);
    assert.equal(a.get('date', 'y'), 'x');
});
await check('retry() backs off on transient errors and gives up on permanent ones', async () => {
    let calls = 0;
    await assert.rejects(() => C.retry(async () => {
        calls++;
        const e = new Error('400 bad request'); e.status = 400; throw e;
    }, { tries: 4, baseMs: 1 }), /bad request/);
    assert.equal(calls, 1, 'permanent error must not be retried');
    let ok = 0;
    await C.retry(async () => {
        ok++;
        if (ok < 2) { const e = new Error('429 slow down'); e.status = 429; throw e; }
        return 'fine';
    }, { tries: 3, baseMs: 1 });
    assert.equal(ok, 2);
});

await fs.rm(tmp, { recursive: true, force: true });
await fs.rm(repo, { recursive: true, force: true });
await fs.rm(remote, { recursive: true, force: true });

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
