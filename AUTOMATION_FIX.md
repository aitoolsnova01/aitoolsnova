# 🩺 Publishing automation: root cause + permanent fix (2026-08-28)

Status of the outage the user reported:

> "Website par pichle 5 din se blog automatically upload nahi ho raha, aur na hi
> webstories, aur site health bhi nahi chal rahi hai."

| Symptom | Real cause | Fixed in code? | Left for the owner |
|---|---|---|---|
| No blog post since **2026-08-23** | No AI key reached the job → generator exited in ~0 s, and the job still printed **green** (`continue-on-error: true` + a commit step ending in `exit 0`) | ✅ | add 1 Actions **repository** secret |
| Web Story job **red** every day | The self-heal step staged `.github/workflows/*.yml` into the index; GitHub refuses workflow writes from a job token → the *content* push was refused too | ✅ | nothing |
| Site Health Check red every 6 h | 3 bare `curl`s with no retry/classification: a Cloudflare challenge or rate limit = red, while "nothing published for 5 days" = invisible | ✅ | nothing |
| 4 lost days (08-24 … 08-27) never re-published | No backfill: every run only tried "today" and a skipped day was lost forever | ✅ (catch-up is now the default) | optionally trigger one run with `backfill=5` |

Everything in the right-hand column is a **one-time** action; see [Owner actions](#owner-actions-one-time).

---

## 1. Root causes (evidence-linked)

### 1.1 The green-tick lie (blog)

`gh api .../actions/runs` for `Blog Auto-Publish (Mon Wed Fri)`:

```
2026-08-24T19:41Z  success
2026-08-25T14:19Z  success      <- zero commits on those days
2026-08-26T07:37Z  success
```

The run log for those jobs shows the generator step finishing in **0 s** with
`❌ Need GROQ_API_KEY and/or GEMINI_API_KEY and/or DEEPSEEK_API_KEY`. Because
that step was `continue-on-error: true`, the next step ("Commit and push")
staged nothing, printed `No changes.` and `exit 0` → **success**. Three days of
"green" with no content, and no way to notice except by reading the site.

Why the key never arrived: keys were configured as **Environment** secrets (or
not at all). Scheduled workflows do not carry an `environment:`, so Environment
secrets are simply not visible to them.

### 1.2 The poisoned git index (web story)

`Commit and push new web story` was the only failing step
(`.../actions/runs/32989334584/jobs`), every single day:

```
remote: error: refusing to update ref with non-fast-forward ...
Error: Process completed with exit code 1.
```

`scripts/daily-publish-helper.mjs` copied hardened YAML into
`.github/workflows/`, committed it with `git reset --soft HEAD~1`, and left the
workflow files **staged**. The workflow's own commit step then swept them into
its content commit; GitHub rejects any push from `GITHUB_TOKEN` that touches
`.github/workflows/**` — so the *story* push died with the workflow files.

### 1.3 Health check: wrong signal in both directions

`health-check.yml` ran three `curl`s of the live site. No timeout, no retry, no
status classification. A 403 from Cloudflare's bot check = red run. It also
verified nothing about publishing, so during the entire outage it was red about
the *wrong thing* while the red nobody watched was "no new content".

### 1.4 No catch-up, no proof, no state

* a skipped/failed day was never retried (no backfill, no idempotency ledger);
* nothing proved a pushed commit actually reached `main` (the job could generate
  files and lose them);
* nothing recorded *why* a run stopped, so every outage started from zero.

---

## 2. What changed (all in `scripts/`, so the fix survives YAML churn)

### New: `scripts/lib/publish-core.mjs` (shared spine)

Key detection (`readKeys`) · `PublishError` + secret-redacting `describeError` ·
`fetchWithTimeout` (every provider call now has a deadline) · `isTransientStatus`
+ `retry` (429/5xx/timeouts retried with backoff, 401/404 never retried) ·
`parseJsonLoose` (salvages fenced/truncated/unbalanced model JSON) ·
`visibleWords` (real content-length gate) · `planGaps` + `publishedDates`
(backfill + idempotency, driven by `scripts/publish-log.json`) ·
`callSiteApi` (the site's own `/api/gemini` proxy as a last-resort provider) ·
`publishContent()` (index-safe stage → commit → push with 3 rebase retries →
**un-commit** on total failure) · `writePublishStatus()`.

`publishContent` only ever stages whitelisted content paths and always ends with
`git reset -- .github/workflows`, so a content commit can never carry a workflow
file again.

### Rewritten: `scripts/generate-blog.mjs`

* **Never exits 0 without either publishing or a documented skip.** A missing key
  is a *loud* `::error::` + step summary + non-zero exit — and after that, the
  site-API fallback provider still publishes the post instead of stopping.
* Multi-provider ladder `groq → gemini → deepseek → siteapi`, token ladder
  `[8000,6000,4500,3000,2000]` (a 400 "max_tokens too large" shrinks and retries),
  120 s timeouts, `CONTENT_ATTEMPTS=3` with a **thin-content gate**
  (`MIN_WORDS=1000`, `MIN_SECTIONS=5`) that rejects and retries garbage instead
  of publishing it.
* `--backfill` is **on by default (2 days/run, oldest first)** → the 4-day gap
  drains itself in ~2 scheduled runs; `planGaps` never writes a date earlier than
  the first post, and a day that already has a post is skipped (idempotent).
* Records everything: `scripts/publish-log.json` (last 200 entries) +
  `publish-status.json` (deployed to the site, booleans/counts only — never keys).

### Rewritten: `scripts/generate-webstory.mjs`

Same spine, plus: story derived from the **newest** article by `datePublished`
(not mtime), `MIN_SLIDES=6`/`WANT_SLIDES=10` with padding pulled from the source
article, `healWorkflowsIfAllowed()` that **refuses** to touch `.github/workflows`
without a `WORKFLOW_PAT`, `maybeCoverBlog()` (only when `AUTO_BLOG_FALLBACK=1`),
and no `image.pollinations.ai` hot-link in any frame — the CTA slide now reuses a
local image, so a Pollinations outage cannot make a story half-broken or trip
`audit-seo-assets.py`.

### Fixed: `scripts/daily-publish-helper.mjs`

`git reset --mixed` + index re-check when reverting workflow files (throws if
they are still staged), `git reset -q` before staging content, new
`validateWorkflows()` rules (`continue-on-error` without verification, a commit
step that treats "no changes" as success), and `sync` to refresh the mirrors in
`scripts/workflow-fixes/`.

### New: `scripts/verify-publish.mjs` — the gate that must pass at the end of every run

For the newest post/story it checks: file exists on disk · ≥500 visible words
(story: ≥8 `amp-story-page`) · canonical + AdSense id present · no hot-linked
story image · linked from `blogs.html` / `web-stories.html` · present in
`sitemap.xml` · ledger has an `ok` entry for that date · **and `git ls-tree
origin/main` proves the commit is actually pushed.** `--strict` also fails on a
`publish-status.json` that says `ok:false`. Freshness limit: `MAX_AGE_DAYS=3`.

### New: `scripts/site-health.mjs` — replaces the 3 curls

Groups: `files` (required pages, ads.txt publisher id, robots, `_redirects`
sanity) · `sitemap` (well-formed, no dupes, canonical host, no `.html`
suffix, no future `lastmod`, every `<loc>` exists in `main`) · `freshness`
(blog + story age and missing-day list, last publish run + providers) ·
`markup` (JSON-LD parses, canonical, viewport on all 68 content pages) ·
`audits` (runs the Python link/asset auditors) · `automation` (workflow YAML
validity, `.fixed` drift, key visibility) · `live` (retried probes at
concurrency 6, redirects followed).

Signal policy: **404/410/5xx = fail; 403/429/503/timeout = warn** (bot
challenge ≠ broken site). `--offline` skips the network group, `--ci` adds
step summaries + `::error::` annotations, `--json test_reports/site-health.json`.

### New: `scripts/check-workflows.mjs`

Parses every workflow and fails on YAML GitHub rejects (tabs,
`permissions.secrets`) and on patterns that hide failure (a content job whose
steps all tolerate errors, a commit step with no index reset, no verify step).
Part of `npm test`.

### Rewritten schedules

| Workflow | Was | Now |
|---|---|---|
| `daily-blog.yml` | `0 14 * * 1,3,5` Mon/Wed/Fri | **`20 5,14 * * *`** daily ×2, `--backfill=2`, no `continue-on-error`, verify step gates the job |
| `daily-webstory.yml` | `30 15 * * 1,3,5` | **`45 6,16 * * *`** daily ×2, index-safe commit, verify step |
| `health-check.yml` | `0 */6 * * *` + 3 curls | **`7 1,7,13,19 * * *`** + `site-health.mjs`, artifact report, **auto-opens/updates one GitHub issue** when checks fail and closes it when green |
| `indexnow-all.yml` | `0 6 * * 1` | `5 6 * * 1` (off the `:00` queue) |

Off-`:00` minutes matter: GitHub's scheduler can delay `:00` cron jobs by hours
under load, which is how "daily at 14:00" silently became "no run on Friday".

### Tests added (all wired into `npm test`)

`test-publish-core.mjs` (27 checks, incl. real temp bare-remote git repos:
poisoned index, pathspec whitelist, concurrent-push rebase) ·
`test-webstory-e2e.mjs` (13: full mocked story pipeline, asserts workflows stay
byte-identical and a re-run is a no-op) · `test-site-health.mjs` (24: the
pass/warn/fail classifier, gap math, and a broken fixture repo that *must* go
red) · `test-publish-helper.mjs` (14) · `test-e2e-mock.mjs` (19) ·
`test-dry-run.mjs` (19 contract checks) · `test-webstory-smoke.mjs` (10).

`npm test` = audits + all of the above. Current: **all green**.

### `_headers`

`publish-status.json` is served with `Cache-Control: no-store` so the operator
dashboard can never show a stale "last run ok".

---

## 3. Owner actions (one-time)

### 3.1 Add the AI key as a **repository** secret (this is what unblocks content)

GitHub → `aitoolsnova01/aitoolsnova` → **Settings** → **Secrets and variables** →
**Actions** → **New repository secret**:

```
GROQ_API_KEY = gsk_...            # free: console.groq.com/keys
```

Optional extras: `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` (fallbacks),
`INDEXNOW_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`.

⚠️ **Do not** put them under Environments — a scheduled run has no environment
and cannot see them. That is exactly what broke the last 5 days.

### 3.2 Workflow permissions

Settings → Actions → General → **Workflow permissions** → **Read and write
permissions**. (Without it, every push from the job token fails.)

### 3.3 Apply the new workflow YAML

The files in `.github/workflows/` are already rewritten in this branch. A GitHub
App/token without the `workflows` scope **cannot** push workflow files, so if
this PR merges without them, paste them manually:

1. github.com/aitoolsnova01/aitoolsnova → `.github/workflows/daily-blog.yml` →
   ✏️ → replace the whole file with `scripts/workflow-fixes/daily-blog.yml.fixed`
   → **Commit directly to main**.
2. Repeat for `daily-webstory.yml` and `health-check.yml`
   (same `.fixed` mirrors; `sync` keeps them identical: `node
   scripts/daily-publish-helper.mjs sync`).

Permanent alternative (then I *can* ship workflow changes myself): create a
fine-grained PAT (this repo only, **Actions: read & write**) and add it as the
repository secret `WORKFLOW_PAT`. With that secret present,
`generate-webstory.mjs`'s `healWorkflowsIfAllowed()` will push a hardened YAML
and re-run `validateWorkflows` — verified by `test-publish-helper.mjs`.

### 3.4 Drain the 4 missing days

After merge, either:

* do nothing — each scheduled run publishes today + up to 2 skipped days
  (oldest first), so the backlog is gone within ~2 runs; **or**
* Actions → **Blog Auto-Publish (daily)** → **Run workflow** → `backfill = 5`.

### 3.5 Confirm

```bash
gh run list --workflow=daily-blog.yml --limit 3      # must be success
node scripts/verify-publish.mjs --kind=blog          # also checks origin/main
node scripts/site-health.mjs --offline                # repo-side checks
curl -s https://aitoolsnova.com/publish-status.json   # live proof of last run
```

---

## 4. Why this is permanent (not a one-off rerun)

1. **Nothing can go green while publishing nothing.** The generator exits
   non-zero unless it published or a day genuinely already has content; the
   commit step never ends in `exit 0`; `verify-publish.mjs` is the last step and
   fails if `origin/main` doesn't have the file. No path back to a false
   success (and `npm test` fails if someone re-adds one to the YAML).
2. **A skipped day is not lost.** Backfill is the default, oldest-first, capped,
   idempotent (`publishedDates` counts a day only while the file still exists, so
   a deleted post re-opens the gap instead of being silently "already done").
3. **Transient failures self-recover.** Every provider fetch has a timeout +
   bounded retry with backoff; permanent 4xx are never retried; truncated model
   JSON is salvaged; thin content is retried up to 3× across 4 providers;
   `max_tokens` is auto-clamped per model.
4. **No silent network dependency.** Stories use local images; Pollinations
   (AI images) is non-fatal — a bad image never blocks a publish.
5. **State is visible.** `scripts/publish-log.json` (in-repo ledger), live
   `publish-status.json`, per-run step summaries, a JSON health report artifact,
   and one auto-managed GitHub issue that appears only when something is really
   wrong and closes itself when it isn't.
6. **The git-index class of bug is structurally gone**: content commits use a
   whitelist and always clear workflow paths; workflow writes need `WORKFLOW_PAT`
   and go through a separate, validated commit.
7. **Regression-locked**: 131 assertions across 7 suites now run on every
   `npm test` — including a deliberately broken fixture repo that the health
   checker must mark red.

---

## 5. Knobs (env / CLI)

| What | How | Default |
|---|---|---|
| Catch-up window | `--backfill=N`, `BACKFILL_WINDOW` | 2 runs / 10 days looked back |
| Hard stop if no key at all | `SITE_API_FALLBACK=0` (used by tests) | fallback enabled |
| Auto-cover blog when a story has no new article | `AUTO_BLOG_FALLBACK=0/1` | 1 |
| Let a job push workflow fixes | `WORKFLOW_PAT` + `HEAL_WORKFLOWS=1` | heal disabled, revert only |
| Content floors | `MIN_WORDS` `TARGET_WORDS` `MIN_SECTIONS` `CONTENT_ATTEMPTS` | 1000 / 1600 / 5 / 3 |
| Story floors | `MIN_SLIDES` `WANT_SLIDES` | 6 / 10 |
| Extra Groq models | `GROQ_MODELS_EXTRA="model-a,model-b"` | – |
| Publish freshness limit in CI | `MAX_AGE_DAYS`, `--max-age-days` | 3 |
| Disable publishing from a script run | `SKIP_AUTO_PUBLISH=1` / `NO_PUBLISH=1` | off (publishes) |
| Force publishing from a local run | `FORCE_PUBLISH=1` | off |

```bash
node scripts/generate-blog.mjs --check          # what would happen, no writes
node scripts/generate-blog.mjs --date=2026-08-26 --dry-run
node scripts/daily-publish-helper.mjs status     # config + ledger + drift
node scripts/daily-publish-helper.mjs validate  # workflow YAML lint
node scripts/site-health.mjs                     # live + repo
```
