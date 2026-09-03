# Duplicate publishing fix — same post as blog + web story, same time (2026-09-03)

## The report

> "Website ne ek hi blog aur web story duplicate time par post kar di — why?"

Confirmed on `main`, and it was three separate defects wearing one costume:

| Symptom found on disk | Root cause |
|---|---|
| `blogs.html` listed **22 cards for 20 posts** — `free-no-code-ai-apps` and `free-ai-tools-for-drivers` each appeared **twice** with the same date | `generate-blog.mjs` called `updateBlogsList()` **twice per publish**, and that function only ever prepended a card — no "is this slug already listed?" check (the sitemap had that self-heal, the listing never got it) |
| **11 articles existed as both `/blog/<slug>` and `/web-stories/<slug>`**, 5 of them with the identical headline | `generate-webstory.mjs` builds a story *from* an article and reused the article's slug verbatim |
| The same article storified **twice** (`/web-stories/ai-upload-privacy-checks` + `/web-stories/ai-tool-privacy-checklist-before-upload`) | "does this article already have a story?" was answered by **filename**, so any renamed story file looked like nothing was published |
| Story dated **2026-08-25** for an article dated **2026-09-02** — a summary older than its own source | backfill runs stamped stories with the *gap date*, not a real publish date |
| `feed.xml`: every item at `06:00:00 GMT`, nothing newer than 20 Aug | the file was hand-written and no script regenerated it |
| Both jobs could publish the *same day's* article | `daily-webstory.yml` also generated a blog post (`AUTO_BLOG_FALLBACK` default on) and the two workflows had **different** concurrency groups, so both pushed after a rebase and both commits survived |

## What changed

### 1. Listing inserts are idempotent (`scripts/lib/publish-core.mjs`, `generate-blog.mjs`)

* `dedupeManagedCards()` — removes every `blog-card` inside the `AUTO-BLOG-INSERT` block that links to the slug about to be inserted, then inserts exactly one card.
* `updateBlogsList()` is now called **once** per publish (the duplicate call is gone).
* `updateSitemap()` in the story job got the same strip-then-insert the blog job already had, so a retry can never stack a second `<url>` for one `<loc>`.

### 2. A topic can no longer be published twice

`findExistingPostFor()` compares the candidate post against **every** article slug and against normalized headlines (articles *and* stories, plus `topic-history.json`). On a match the run does **not** rename the slug into a second URL any more — it throws `duplicate-topic`, and `main()` closes that day's gap with the existing slug in the ledger (so the gap planner stops re-trying the same topic forever). The AI-prompt avoid-list grew from 25 titles to ~90 and now includes story titles.
If only a *story* already used the headline, the job asks the model for one more topic
instead of giving up on the day; if an *article* has it, the day is closed as covered.

### 3. Stories are companions, not copies (`generate-webstory.mjs`)

* **Distinct URL:** new stories land on `/web-stories/<article-slug>-story` — never the article's own slug.
* **Provenance:** every story page carries `<meta name="aitoolsnova:source-blog" content="<article-slug>">`; `storiesCoveredSources()` reads it (legacy files fall back to slug/canonical inference). One article → at most one story, for life.
* **Honest date:** `storyDateFor()` = publish date, never earlier than the article, never in the future.
* **Way back:** the CTA page now links "Read the full article →".
* **Canonical policy:** `STORY_CANONICAL=auto` (default) hands the story's canonical to the article whenever the AI kept the article's headline — that is the actual duplicate-content case. `always` = every story canonicals to its article, `self` = old behaviour. Stories stay live and linked from `/web-stories`.
* A second story for the same article is refused **before** any AI call (`duplicate-story`), and the run exits 0 with "already covered" instead of going red.

### 4. One writer per content area

* Both publish workflows share `concurrency.group: auto-publish-content` (they used to be independent), so they can never generate the same day twice.
* `daily-webstory.yml` now sets `AUTO_BLOG_FALLBACK: '0'` and its commit whitelist no longer includes `blog/`. `maybeCoverBlog()` additionally requires a **real** outage (blog workflow broken **and** nothing published for `AUTO_BLOG_MIN_STALE_DAYS=2` days) before this job would ever touch an article.

### 5. RSS is generated now (`scripts/rebuild-feed.mjs`)

`buildFeed()` rebuilds `feed.xml` from `blog/`: newest 30 posts, one item per headline, each item with its **own** deterministic timestamp inside the 04:00–13:00 UTC window (so two posts published the same day no longer share a pubDate), `lastBuildDate` = now. Both jobs run it and commit `feed.xml` (`CONTENT_PATHS` updated). `--check` is a staleness gate.

### 5b. The feed cannot be poisoned by a test fixture

`scripts/test-e2e-mock.mjs` runs the real generator, so its throwaway
"Mock Test Post Please Ignore <ts>" article briefly exists in `blog/` — and the
feed rebuild picked it up as the newest item, which a local run then left
behind. Two fixes: `rebuild-feed.mjs` skips anything that looks like a fixture
(`mock` / `please ignore` / `test only` / `^test-`, override with
`FEED_ALLOW_MOCK=1`), and the mock test now backs up + restores `feed.xml` and
asserts the mock never appears in it.

### 6. Repair of what already shipped (`scripts/dedupe-listings.mjs`)

Dry-run by default, `--apply` to write. Idempotent (a clean repo reports 0 changes). Applied on 2026-09-03:

* 2 duplicate cards removed from `blogs.html`;
* 13 legacy stories given provenance + article link, 2 canonicalized to their article, 2 re-dated (`free-no-code-ai-apps` 08-25 → 09-02, `free-ai-tools-for-drivers` 08-26 → 08-31);
* the accidental second story `web-stories/ai-tool-privacy-checklist-before-upload.html` removed with a **301 → `/web-stories/ai-upload-privacy-checks`** (managed block in `_redirects`), its card + sitemap entry dropped, and its 11 now-unreferenced images deleted.

### 7. Alarms so this cannot rot silently (`site-health.mjs`)

New `duplicates` check group, run every 6 h by `health-check.yml`: duplicate card in `blogs.html`/`web-stories.html`, story missing provenance, story dated before its article, headline-clashing story without canonical, feed pubDate collisions, feed missing the newest article. Each failure names the repair command.

## Verification

```bash
npm test                    # full suite, incl. scripts/test-dedup.mjs (18) + test-dedup-mock.mjs (7)
node scripts/site-health.mjs --offline
npm run feed:check          # or: node scripts/rebuild-feed.mjs --check
node scripts/dedupe-listings.mjs   # dry run must report 0 changes
```

`scripts/test-dedup-mock.mjs` is the end-to-end proof: it runs the real generator
with a mocked AI answer that repeats the newest published article, and asserts the
run exits 0, no second file appears, `blogs.html` / `sitemap.xml` / `feed.xml` are
**byte-identical**, and the day is closed in the ledger against the existing slug.

The workflow-YAML assertions in `test-dedup.mjs` read `scripts/workflow-fixes/*.fixed`
(what actually reaches main through the self-heal) and accept the live file once it
has been healed - an App token without the `workflows` scope can never make the live
copy pass, and a test that requires the impossible gets muted within a week.

After the fix: `blogs.html` 20 cards / 20 unique, `web-stories.html` 13 / 13, sitemap 115 URLs all unique, every story traceable to its article, `feed.xml` carrying the newest post with distinct timestamps.

## How the workflow YAML actually lands

`.github/workflows/**` cannot be pushed by the automation token (GitHub refuses
workflow writes from a GitHub App token without the `workflows` scope — the same
rule this repo's commit steps are built around), so the new YAML is delivered the
way this repo already does it:

* `scripts/workflow-fixes/daily-blog.yml.fixed` + `daily-webstory.yml.fixed` hold
  the new content, and the story job's `healWorkflowsIfAllowed()` applies + pushes
  them with `WORKFLOW_PAT` on its next run (06:45 UTC);
* `.github/workflow-suggestions/*.yml.txt` are regenerated from those `.fixed`
  files, so a manual paste in the GitHub web UI gives the identical result.

Nothing else in this fix depends on that: the code-level guards (skip on
duplicate topic/story, idempotent listing insert, provenance-based story dedupe,
date rules) already hold with the old YAML in place. The shared concurrency lock
only closes the remaining race window.

## What the owner has to do

Nothing. No new secret, no settings change. Next scheduled runs (05:20 / 14:20 UTC blog, 06:45 / 16:45 UTC story) use the new rules automatically.

Optional knobs (repo variables or workflow env): `STORY_CANONICAL=always|auto|self`,
`AUTO_BLOG_MIN_STALE_DAYS=2`, `FEED_ITEMS=30`, `ALLOW_DUPLICATE_TOPIC=1` /
`ALLOW_DUPLICATE_DAY=1` (deliberate double publish, e.g. when back-filling by hand).

## Deliberately not done

* Stories canonicalizing to their article do **stay** in `sitemap.xml`: `scripts/verify-publish.mjs` (the CI gate) requires the freshest story to be listed there, and Google's story/Discover crawlers follow the sitemap. Dropping them would turn every story run red for no ranking gain.
* Legacy `/blog/x` + `/web-stories/x` pairs whose story headline is genuinely different (7 pairs) are left in place — they are distinct pages, and the provenance + canonical machinery stops new ones.
