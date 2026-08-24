#!/usr/bin/env node
/**
 * AIToolsNova - Daily Publish Helper (resilience layer)
 * -----------------------------------------------------
 * Why this exists:
 *   1. `.github/workflows/daily-blog.yml` shipped with an invalid
 *      permission scope (`secrets: read`) which made the WHOLE workflow
 *      invalid on GitHub (red X on every push, 0s runs, no logs).
 *   2. `.github/workflows/daily-webstory.yml` was truncated - the story
 *      was generated but never committed/pushed.
 *
 * This helper, called from generate-webstory.mjs inside the (valid)
 * daily-webstory workflow, does three jobs so the daily automation
 * keeps running with zero manual steps:
 *   a) SELF-HEAL: if a workflow file differs from its fixed copy in
 *      scripts/workflow-fixes/*.fixed, restore it and push.
 *      GITHUB_TOKEN usually CANNOT update workflow files (GitHub
 *      security restriction). A repo secret named WORKFLOW_PAT
 *      (classic PAT with the `workflow` scope) makes the heal stick.
 *      This PR also ships the repaired YAML directly.
 *   b) COMBINED CONTENT: while daily-blog.yml is still broken, also
 *      generate the daily blog from here.
 *   c) AUTO-PUBLISH: commit + push all generated content to main
 *      (only when running inside GitHub Actions).
 *
 * CLI:
 *   node scripts/daily-publish-helper.mjs status
 *   node scripts/daily-publish-helper.mjs validate
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const execFileP = promisify(execFile);

const ROOT = process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd());

const WF_DIR = path.join(ROOT, '.github', 'workflows');
const FIX_DIR = path.join(ROOT, 'scripts', 'workflow-fixes');
const BLOG_WF = 'daily-blog.yml';
const WEBSTORY_WF = 'daily-webstory.yml';

// GitHub Actions job-level `permissions:` keys. Anything else (e.g.
// `secrets: read`) makes the whole workflow file invalid.
export const VALID_PERMISSION_KEYS = new Set([
    'actions', 'attestations', 'checks', 'contents', 'deployments',
    'discussions', 'id-token', 'issues', 'models', 'packages', 'pages',
    'pull-requests', 'repository-projects', 'security-events', 'statuses',
]);

export const git = (args, opts = {}) =>
    execFileP('git', args, { cwd: ROOT, ...opts, maxBuffer: 64 * 1024 * 1024 });

function permissionKeysIn(src) {
    const keys = [];
    const block = src.match(/^permissions:\s*\n((?:[ \t]+.+\n)*)/m);
    if (!block) return keys;
    for (const line of block[1].split('\n')) {
        const m = line.match(/^\s+([A-Za-z0-9_-]+)\s*:/);
        if (m) keys.push(m[1]);
    }
    return keys;
}

export function invalidPermissionKeys(src) {
    return permissionKeysIn(src).filter(k => !VALID_PERMISSION_KEYS.has(k));
}

/** True if daily-blog.yml is missing or contains an invalid permission. */
export async function isBlogWorkflowBroken() {
    const p = path.join(WF_DIR, BLOG_WF);
    if (!existsSync(p)) return true;
    const src = await fs.readFile(p, 'utf8');
    if (/^\s*secrets:\s*read\s*$/m.test(src)) return true;
    if (invalidPermissionKeys(src).length) return true;
    if (!/git commit/.test(src) || !/git push/.test(src)) return true;
    return false;
}

/**
 * Restore workflow files from scripts/workflow-fixes/*.fixed when they differ.
 * Returns the list of repaired file names (without touching git).
 */
export async function selfHealWorkflows() {
    const changed = [];
    for (const name of [BLOG_WF, WEBSTORY_WF]) {
        const fixedPath = path.join(FIX_DIR, `${name}.fixed`);
        if (!existsSync(fixedPath)) continue;
        const target = path.join(WF_DIR, name);
        const wanted = await fs.readFile(fixedPath, 'utf8');
        const current = existsSync(target) ? await fs.readFile(target, 'utf8') : '';
        if (wanted !== current) {
            await fs.mkdir(WF_DIR, { recursive: true });
            await fs.writeFile(target, wanted);
            changed.push(name);
        }
    }
    return changed;
}

/**
 * Validate every workflow YAML we own. Returns an array of error strings
 * (empty = healthy). Used by CLI + unit tests so `secrets: read` can
 * never silently ship again.
 */
export async function validateWorkflows() {
    const errors = [];
    const names = existsSync(WF_DIR)
        ? (await fs.readdir(WF_DIR)).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        : [];
    if (!names.includes(BLOG_WF)) errors.push(`missing ${BLOG_WF}`);
    if (!names.includes(WEBSTORY_WF)) errors.push(`missing ${WEBSTORY_WF}`);

    for (const name of names) {
        const src = await fs.readFile(path.join(WF_DIR, name), 'utf8');
        const bad = invalidPermissionKeys(src);
        if (bad.length) {
            errors.push(`${name}: invalid permission key(s): ${bad.join(', ')}`);
        }
        if (name === BLOG_WF || name === WEBSTORY_WF) {
            if (!/git commit/.test(src)) errors.push(`${name}: missing git commit`);
            if (!/git push/.test(src)) errors.push(`${name}: missing git push`);
            if (!/node scripts\/generate-/.test(src)) {
                errors.push(`${name}: missing node generate script step`);
            }
        }
    }
    return errors;
}

function inActions() {
    return process.env.GITHUB_ACTIONS === 'true' || process.env.FORCE_PUBLISH === '1';
}

/**
 * Stage + commit + push.
 *  - onlyWorkflows=true  -> stages ONLY .github/workflows (self-heal commit)
 *  - otherwise           -> stages everything EXCEPT .github/workflows
 * Auto commit/push is skipped outside GitHub Actions unless FORCE_PUBLISH=1.
 * Returns true when a commit was created and pushed, false when nothing to push.
 */
export async function commitAndPush({
    message,
    onlyWorkflows = false,
    remote = 'origin',
    branch = 'main',
} = {}) {
    // The daily-webstory workflow sets SKIP_AUTO_PUBLISH=1 so the commit/push
    // is owned by the workflow's guarded "Commit and push" step (which fails
    // RED when nothing was published). Keeps one auditable publish path.
    if (process.env.SKIP_AUTO_PUBLISH === '1') {
        console.log('ℹ️  SKIP_AUTO_PUBLISH=1 — leaving commit/push to the workflow step.');
        return false;
    }
    if (!inActions()) {
        console.log('ℹ️  Not in GitHub Actions — skip auto commit/push (set FORCE_PUBLISH=1 to override).');
        return false;
    }
    if (onlyWorkflows) {
        await git(['add', '-A', '--', '.github/workflows']);
    } else {
        await git(['add', '-A', '--', '.', ':(exclude).github/workflows']);
    }
    let hasChanges = false;
    try {
        await git(['diff', '--cached', '--quiet']);
    } catch (e) {
        if (e && e.code === 1) hasChanges = true;
        else throw e;
    }
    if (!hasChanges) {
        console.log('ℹ️  Nothing staged — skipping commit.');
        return false;
    }
    await git([
        '-c', 'user.name=AIToolsNova Bot',
        '-c', 'user.email=bot@aitoolsnova.com',
        'commit', '-m', message,
    ]);

    const workflowToken = process.env.WORKFLOW_PAT || process.env.GH_WORKFLOW_TOKEN || '';
    if (onlyWorkflows && !workflowToken) {
        console.log('ℹ️  No WORKFLOW_PAT — cannot push workflow files. Reverting workflow changes; content-only commit will follow.');
        await git(['restore', '--staged', '.github/workflows']).catch(() => {});
        await git(['restore', '--worktree', '.github/workflows']).catch(() => {});
        // The commit already includes workflow files — undo it entirely
        try {
            await git(['reset', '--soft', 'HEAD~1']).catch(() => {});
        } catch { /* no commit to undo */ }
        return false;
    }
    if (onlyWorkflows && workflowToken) {
        const repo = process.env.GITHUB_REPOSITORY || 'aitoolsnova01/aitoolsnova';
        const url = `https://x-access-token:${workflowToken}@github.com/${repo}.git`;
        try {
            await git(['push', url, `HEAD:refs/heads/${branch}`], {
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            });
        } catch (err) {
            const safe = String(err && err.message ? err.message : err).replace(workflowToken, '***');
            throw new Error(safe);
        }
        return true;
    }

    await git(['push', remote, `HEAD:refs/heads/${branch}`]);
    return true;
}

/**
 * Best-effort run of scripts/generate-blog.mjs as a subprocess with a time
 * guard. NEVER rejects - a blog failure must not kill the web story run.
 */
export function runBlogGenerator(timeoutMs = 9 * 60 * 1000) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [path.join(ROOT, 'scripts', 'generate-blog.mjs')],
            { cwd: ROOT, stdio: 'inherit', env: process.env }
        );
        const killer = setTimeout(() => {
            console.warn(`⏱️  Blog generator exceeded ${Math.round(timeoutMs / 60000)} min — killing it (web story continues).`);
            child.kill('SIGTERM');
        }, timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(killer);
            console.log(code === 0
                ? '✅ Blog generator finished OK'
                : `⚠️  Blog generator exited with code ${code} — continuing with web story anyway.`);
            resolve();
        });
        child.on('error', (err) => {
            clearTimeout(killer);
            console.warn(`⚠️  Blog generator failed to start: ${err.message} — continuing.`);
            resolve();
        });
    });
}

// ---- CLI ----
const isMain = process.argv[1]
    && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
    const cmd = process.argv[2] || 'status';
    if (cmd === 'validate') {
        const errors = await validateWorkflows();
        if (errors.length) {
            console.error('❌ Workflow validation failed:');
            for (const e of errors) console.error('  -', e);
            process.exit(1);
        }
        console.log('✅ All workflow files look valid');
    } else {
        const broken = await isBlogWorkflowBroken();
        const errors = await validateWorkflows();
        console.log(`daily-blog.yml      : ${broken ? 'BROKEN (invalid permission / missing push)' : 'healthy'}`);
        console.log(`fixed copy (blog)   : ${existsSync(path.join(FIX_DIR, `${BLOG_WF}.fixed`)) ? 'present' : 'MISSING'}`);
        console.log(`fixed copy (story)  : ${existsSync(path.join(FIX_DIR, `${WEBSTORY_WF}.fixed`)) ? 'present' : 'MISSING'}`);
        console.log(`validate            : ${errors.length ? errors.join(' | ') : 'ok'}`);
    }
}
