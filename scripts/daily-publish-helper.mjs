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
 *      scripts/workflow-fixes/*.fixed, restore it and push (GitHub
 *      Actions' own token CAN update workflow files because the calling
 *      workflow lives in the default branch).
 *   b) COMBINED CONTENT: while daily-blog.yml is still broken, also
 *      generate the daily blog from here.
 *   c) AUTO-PUBLISH: commit + push all generated content to main.
 *
 * CLI (for local checks):
 *   node scripts/daily-publish-helper.mjs status
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

export const git = (args, opts = {}) =>
    execFileP('git', args, { cwd: ROOT, ...opts, maxBuffer: 64 * 1024 * 1024 });

/** True if daily-blog.yml is missing or contains the invalid `secrets: read` scope. */
export async function isBlogWorkflowBroken() {
    const p = path.join(WF_DIR, BLOG_WF);
    if (!existsSync(p)) return true;
    const src = await fs.readFile(p, 'utf8');
    return /^\s*secrets:\s*read\s*$/m.test(src);
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
 * Stage + commit + push.
 *  - onlyWorkflows=true  -> stages ONLY .github/workflows (self-heal commit)
 *  - otherwise           -> stages everything EXCEPT .github/workflows
 * Returns true when a commit was created and pushed, false when nothing to push.
 */
export async function commitAndPush({
    message,
    onlyWorkflows = false,
    remote = 'origin',
    branch = 'main',
} = {}) {
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

// ---- CLI: node scripts/daily-publish-helper.mjs status ----
const isMain = process.argv[1]
    && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain && process.argv[2] === 'status') {
    const broken = await isBlogWorkflowBroken();
    console.log(`daily-blog.yml      : ${broken ? 'BROKEN (secrets: read / missing)' : 'healthy'}`);
    console.log(`fixed copy (blog)   : ${existsSync(path.join(FIX_DIR, `${BLOG_WF}.fixed`)) ? 'present' : 'MISSING'}`);
    console.log(`fixed copy (story)  : ${existsSync(path.join(FIX_DIR, `${WEBSTORY_WF}.fixed`)) ? 'present' : 'MISSING'}`);
}
