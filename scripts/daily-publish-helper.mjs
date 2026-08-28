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
 *   node scripts/daily-publish-helper.mjs apply
 *      Copy scripts/workflow-fixes/*.fixed over .github/workflows/* locally so the
 *      repaired anti-"green-but-empty" YAML is staged in one step. This repo's
 *      GitHub App token cannot push .github/workflows/* (no `workflows` permission),
 *      so `apply` is how the fix is staged here; commit/push it from an account or
 *      Actions run that has the `workflows` scope (or set the WORKFLOW_PAT secret and
 *      let the web-story job self-heal).
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
            // The exact pattern that produced days of green-but-empty runs:
            // a generator step that may fail plus a commit step that exits 0
            // when nothing changed.
            if (/continue-on-error:\s*true/.test(src) && !/Nothing published|nothing-published|verify-publish/.test(src)) {
                errors.push(`${name}: continue-on-error on the generate step with no publish verification = silent green runs`);
            }
            if (/git diff --staged --quiet[\s\S]{0,120}exit 0/.test(src) && !/verify-publish/.test(src)) {
                errors.push(`${name}: "no changes" is treated as success - a run that published nothing must fail`);
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
    // Always start from a clean index so a stray staged file cannot ride along.
    await git(['reset', '-q']).catch(() => {});
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
        // GitHub rejects any push from a job token that touches
        // .github/workflows, so this path can never succeed. Undo COMPLETELY:
        // `git reset --soft` here used to leave the workflow files STAGED in the
        // index, the workflow's own "Commit and push" step then committed them,
        // the push was refused, and the generated story was never published.
        // --mixed clears the index too, and the worktree is restored as well.
        console.log('ℹ️  No WORKFLOW_PAT — workflow files cannot be pushed from a job token. Reverting the workflow commit; content-only commit will follow.');
        try {
            await git(['reset', '--mixed', '-q', 'HEAD~1']).catch(() => {});
        } catch { /* no commit to undo */ }
        await git(['restore', '--staged', '.github/workflows']).catch(() => {});
        await git(['restore', '--worktree', '.github/workflows']).catch(() => {});
        const stagedAfter = await git(['diff', '--cached', '--name-only'])
            .then(r => r.stdout.trim())
            .catch(() => '');
        if (/\.github\/workflows/.test(stagedAfter)) {
            // Belt and braces: refuse to continue with a poisoned index.
            throw new Error('index still contains workflow files after revert - refusing to publish (this is the bug that made every run red)');
        }
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
    } else if (cmd === 'sync') {
        // Copy the CURRENT live workflow files over scripts/workflow-fixes/*.fixed
        // so the two never drift apart (they drifted, and the "fix" sat unapplied).
        const { copyFile } = await import('node:fs/promises');
        let n = 0;
        for (const name of [BLOG_WF, WEBSTORY_WF, 'health-check.yml', 'cloudflare-pages-deploy.yml']) {
            const live = path.join(WF_DIR, name);
            if (!existsSync(live)) continue;
            await copyFile(live, path.join(FIX_DIR, `${name}.fixed`));
            n++;
        }
        console.log(`✅ Synced ${n} workflow file(s) into scripts/workflow-fixes/`);
    } else if (cmd === 'apply') {
        const changed = await selfHealWorkflows();
        if (!changed.length) {
            console.log('ℹ️  Workflows already match scripts/workflow-fixes/*.fixed — nothing to apply.');
        } else {
            console.log(`✅ Applied repaired YAML to: ${changed.join(', ')}`);
            console.log('   Next: commit + push .github/workflows from an account/Actions run with the `workflows`');
            console.log('   scope (this token cannot push workflow files), or set WORKFLOW_PAT and let CI self-heal.');
        }
    } else {
        const broken = await isBlogWorkflowBroken();
        const errors = await validateWorkflows();
        console.log(`daily-blog.yml      : ${broken ? 'BROKEN (invalid permission / missing push)' : 'healthy'}`);
        console.log(`fixed copy (blog)   : ${existsSync(path.join(FIX_DIR, `${BLOG_WF}.fixed`)) ? 'present' : 'MISSING'}`);
        console.log(`fixed copy (story)  : ${existsSync(path.join(FIX_DIR, `${WEBSTORY_WF}.fixed`)) ? 'present' : 'MISSING'}`);
        console.log(`validate            : ${errors.length ? errors.join(' | ') : 'ok'}`);
    }
}
