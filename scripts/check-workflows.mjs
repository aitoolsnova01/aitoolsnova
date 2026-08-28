#!/usr/bin/env node
/**
 * scripts/check-workflows.mjs — structural lint for .github/workflows/*.yml
 *
 * Catches the two classes of failure that cost this repo weeks of "green but
 * empty" Actions:
 *   1. YAML that GitHub refuses to load (bad indentation, tabs,
 *      `permissions.secrets`, which is not a valid scope);
 *   2. YAML that loads fine but is built to hide failure (no schedule, a job
 *      whose steps are all `continue-on-error`, a content job with no
 *      verification step, a commit step that can commit .github/workflows).
 *
 * Prefer js-yaml when it is installed; otherwise fall back to a line-based
 * structural check so this script never needs a dependency to run in CI.
 *
 * Usage:  node scripts/check-workflows.mjs [--json out.json]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WF = process.env.WF_DIR || resolve(import.meta.dirname, '..', '.github', 'workflows');
const args = process.argv.slice(2);
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

async function loadYaml() {
  for (const p of ['js-yaml', join(process.cwd(), 'node_modules/js-yaml/dist/js-yaml.mjs')]) {
    try { return await import(p); } catch { /* try next */ }
  }
  return null;
}

const CONTENT = /(generate|publish|story|blog|content)/i;
const issues = [];

function add(file, level, msg) { issues.push({ file, level, msg }); }

const files = existsSync(WF) ? readdirSync(WF).filter((f) => /\.(ya?ml)$/.test(f)).sort() : [];
if (!files.length) {
  console.error(`❌ no workflow files found in ${WF}`);
  process.exit(1);
}

const yaml = await loadYaml();
const report = [];

for (const f of files) {
  const raw = readFileSync(join(WF, f), 'utf8');
  const path = `.github/workflows/${f}`;
  const before = issues.length;

  // Always-valid checks (no parser needed)
  if (/\t/.test(raw)) add(path, 'error', 'file contains a TAB character (YAML forbids tabs for indentation)');
  if (/^\s*secrets:\s*$/m.test(raw) && /permissions:/m.test(raw)) add(path, 'error', 'possible permissions.secrets — invalid scope, GitHub rejects the whole workflow');
  const needsPat = /WORKFLOW_PAT|\.github\/workflows/.test(raw);
  if (needsPat) add(path, 'info', 'touches .github/workflows — verify it resets the index before committing content (see scripts/lib/publish-core.mjs)');

  if (yaml?.load) {
    let doc;
    try {
      doc = yaml.load(raw);
    } catch (e) {
      add(path, 'error', `YAML parse error: ${String(e.message).split('\n')[0]}`);
      report.push({ file: path, parsed: false });
      continue;
    }
    const on = doc.on ?? doc[true];
    const jobs = Object.entries(doc.jobs || {});
    if (!on) add(path, 'error', 'no `on:` block — this workflow can never run');
    if (!jobs.length) add(path, 'error', 'no jobs');
    if (doc.permissions && typeof doc.permissions === 'object' && 'secrets' in doc.permissions) {
      add(path, 'error', '`permissions: secrets:` is invalid — remove it');
    }
    for (const [jn, j] of jobs) {
      const steps = j.steps || [];
      const names = steps.map((s, i) => s.name || s.uses || `step${i}`);
      const contentJob = CONTENT.test(path) || CONTENT.test(jn);
      const coes = steps.filter((s) => s.continue_on_error === true);
      if (contentJob && steps.length && coes.length === steps.filter((s) => s.run || s.uses).length) {
        add(path, 'error', `${jn}: every step tolerates failure — the run can never go red`);
      }
      if (contentJob && !names.some((n) => /verify/i.test(n))) {
        add(path, 'warning', `${jn}: no verify-publish step — a run that published nothing would look green`);
      }
      if (/commit/i.test(path) || names.some((n) => /commit/i.test(n))) {
        const blob = steps.filter((s) => /commit/i.test(s.name || '')).map((s) => s.run || '').join('\n');
        if (blob && !/git reset/.test(blob)) add(path, 'warning', 'commit step does not reset the index first — a stale staged file can break the push');
        if (blob && /git add -A(?!\s+--)/.test(blob)) add(path, 'warning', 'bare `git add -A` can stage .github/workflows and get the push refused');
      }
      report.push({ file: path, job: jn, steps: names, timeout: j['timeout-minutes'] ?? null });
    }
    if (on?.schedule) report.push({ file: path, cron: (on.schedule || []).map((s) => s.cron).join(', ') });
    if (on?.workflow_dispatch && !on.workflow_dispatch?.inputs) add(path, 'info', 'workflow_dispatch has no inputs');
  } else {
    // Parser-free fallback: still catch the loud stuff.
    if (!/^on:/m.test(raw) && !/^true:/m.test(raw)) add(path, 'error', 'no `on:` block found (structural check)');
    report.push({ file: path, parsed: false, note: 'js-yaml not installed — line-based checks only' });
  }

  void before;
}

const errs = issues.filter((i) => i.level === 'error');
const warns = issues.filter((i) => i.level === 'warning');

console.log(`\n🔎 ${files.length} workflow file(s) in .github/workflows${yaml?.load ? '' : ' (no js-yaml — structural checks only)'}\n`);
for (const r of report) {
  const bits = [r.cron && `cron=${r.cron}`, r.job && `job=${r.job}(${r.steps.length})`].filter(Boolean);
  console.log(`   ${r.file}${bits.length ? ' · ' + bits.join(' · ') : ''}`);
}
for (const i of issues) {
  const icon = i.level === 'error' ? '❌' : i.level === 'warning' ? '⚠️ ' : 'ℹ️ ';
  console.log(`${icon} ${i.file}: ${i.msg}`);
}
console.log(`\n${errs.length ? '❌' : warns.length ? '⚠️ ' : '✅'} ${errs.length} error(s), ${warns.length} warning(s)\n`);

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ checked: files.length, issues, report }, null, 2) + '\n');
  console.log(`📄 ${jsonPath}`);
}
process.exit(errs.length ? 1 : 0);
