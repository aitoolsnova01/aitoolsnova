#!/usr/bin/env node
/**
 * Offline tests for daily-publish-helper.mjs.
 * No network, no API keys. Uses a throwaway git repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const helperSrc = path.join(HERE, 'daily-publish-helper.mjs');
const blogFixed = path.join(HERE, 'workflow-fixes', 'daily-blog.yml.fixed');
const storyFixed = path.join(HERE, 'workflow-fixes', 'daily-webstory.yml.fixed');
const healthFixed = path.join(HERE, 'workflow-fixes', 'health-check.yml.fixed');

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const sandbox = mkdtempSync(path.join(tmpdir(), 'atn-heal-'));
let bare = '';
const realCwd = process.cwd();

try {
    mkdirSync(path.join(sandbox, 'scripts', 'workflow-fixes'), { recursive: true });
    mkdirSync(path.join(sandbox, '.github', 'workflows'), { recursive: true });
    cpSync(helperSrc, path.join(sandbox, 'scripts', 'daily-publish-helper.mjs'));
    cpSync(blogFixed, path.join(sandbox, 'scripts', 'workflow-fixes', 'daily-blog.yml.fixed'));
    cpSync(storyFixed, path.join(sandbox, 'scripts', 'workflow-fixes', 'daily-webstory.yml.fixed'));
    cpSync(healthFixed, path.join(sandbox, 'scripts', 'workflow-fixes', 'health-check.yml.fixed'));

    writeFileSync(path.join(sandbox, '.github', 'workflows', 'daily-blog.yml'),
        'name: broken\non: [push]\npermissions:\n  contents: write\n  secrets: read\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    writeFileSync(path.join(sandbox, '.github', 'workflows', 'daily-webstory.yml'),
        'name: truncated\non: [push]\npermissions:\n  contents: write\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    writeFileSync(path.join(sandbox, '.github', 'workflows', 'health-check.yml'),
        'name: broken-health\non: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');

    execFileSync('git', ['init', '-b', 'main'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    execFileSync('git', ['add', '-A'], { cwd: sandbox });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: sandbox });

    process.env.REPO_ROOT = sandbox;
    const helper = await import(pathToFileURL(path.join(sandbox, 'scripts', 'daily-publish-helper.mjs')).href
        + `?t=${Date.now()}`);

    check('detects secrets: read as broken', await helper.isBlogWorkflowBroken() === true);

    const healed = await helper.selfHealWorkflows();
    check('heals both workflow files', healed.includes('daily-blog.yml') && healed.includes('daily-webstory.yml'), healed.join(','));
    check('heals health-check.yml too', healed.includes('health-check.yml'), healed.join(','));

    const blogNow = readFileSync(path.join(sandbox, '.github', 'workflows', 'daily-blog.yml'), 'utf8');
    const storyNow = readFileSync(path.join(sandbox, '.github', 'workflows', 'daily-webstory.yml'), 'utf8');
    check('healed blog has no secrets: read', !/secrets:\s*read/.test(blogNow));
    check('healed blog has git push', /git push/.test(blogNow));
    check('healed story has git commit + push', /git commit/.test(storyNow) && /git push/.test(storyNow));
    check('healed blog is no longer broken', await helper.isBlogWorkflowBroken() === false);

    const errors = await helper.validateWorkflows();
    check('validateWorkflows is clean after heal', errors.length === 0, errors.join(' | '));

    // Content commit must not stage workflow files
    writeFileSync(path.join(sandbox, 'hello.txt'), 'content');
    writeFileSync(path.join(sandbox, '.github', 'workflows', 'daily-blog.yml'), blogNow + '\n# leak-me\n');
    process.env.FORCE_PUBLISH = '1';
    process.env.GITHUB_ACTIONS = '';
    // Re-import won't pick env for commitAndPush — env is read at call time, good.
    // Don't actually push: point remote at a bare repo.
    const bare = mkdtempSync(path.join(tmpdir(), 'atn-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: sandbox });

    const pushed = await helper.commitAndPush({
        message: 'content(day): test',
        onlyWorkflows: false,
        remote: 'origin',
        branch: 'main',
    });
    check('content commit created', pushed === true);

    const show = execFileSync('git', ['show', '--name-only', '--pretty=format:'], { cwd: sandbox, encoding: 'utf8' });
    check('content commit does not include workflow files', !show.includes('.github/workflows'), show.trim());
    check('content commit includes hello.txt', show.includes('hello.txt'));

    // Self-heal (workflow-only) commit must NOT be blocked by SKIP_AUTO_PUBLISH,
    // otherwise a broken workflow YAML can never be repaired from inside a run.
    // daily-blog.yml still carries the '# leak-me' marker from above (a content
    // commit excludes workflow paths). With no WORKFLOW_PAT, a workflow-only
    // commit must still get as far as the guarded revert, which restores the
    // workflow files to HEAD and drops the marker.
    process.env.SKIP_AUTO_PUBLISH = '1';
    const wfOnly = await helper.commitAndPush({
        message: 'chore(workflows): self-heal',
        onlyWorkflows: true,
        remote: 'origin',
        branch: 'main',
    });
    const blogAfterWf = readFileSync(path.join(sandbox, '.github', 'workflows', 'daily-blog.yml'), 'utf8');
    check('workflow-only commit ignores SKIP_AUTO_PUBLISH', wfOnly === false && !blogAfterWf.includes('# leak-me'));

    // Control: a content commit must STILL be skipped under SKIP_AUTO_PUBLISH=1.
    writeFileSync(path.join(sandbox, 'hello2.txt'), 'content2');
    const contentBlocked = await helper.commitAndPush({
        message: 'content(day): should-skip',
        onlyWorkflows: false,
        remote: 'origin',
        branch: 'main',
    });
    check('content commit still skipped under SKIP_AUTO_PUBLISH', contentBlocked === false);

    // .fixed copies in THIS repo are the source of truth. Live YAML may
    // still be broken until a token with `workflows` permission can push it.
    const wantedBlog = readFileSync(blogFixed, 'utf8');
    const wantedStory = readFileSync(storyFixed, 'utf8');
    check('fixed blog has no invalid secrets key', !/^\s*secrets:\s*read\s*$/m.test(wantedBlog));
    check('fixed blog has commit+push', /git commit/.test(wantedBlog) && /git push/.test(wantedBlog));
    check('fixed story has commit+push', /git commit/.test(wantedStory) && /git push/.test(wantedStory));
    process.env.REPO_ROOT = REPO;
    const live = await import(pathToFileURL(helperSrc).href + `?live=${Date.now()}`);
    check('live helper detects current blog workflow state', typeof await live.isBlogWorkflowBroken() === 'boolean');
} catch (err) {
    check('test harness did not throw', false, err.stack || err.message);
} finally {
    process.chdir(realCwd);
    rmSync(sandbox, { recursive: true, force: true });
    if (bare) rmSync(bare, { recursive: true, force: true });
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
