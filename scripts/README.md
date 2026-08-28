# 🤖 Daily Auto-Blog System — Setup Guide

## ✨ Kya Karta Hai?

- **Har din 2 baar (05:20 + 14:20 UTC)** automatically **unique blog post** publish karta hai — aur pichhle chhoot gaye din khud bhar leta hai (backfill)
- Publish hone par bhi shaq hai? Agle run ka last step `origin/main` me file verify karta hai — **"green but empty" ab possible nahi**
- **Duplicate check**: Existing blogs + har generate hua topic history file me save karke, next time repeat nahi hota
- **Professional & Safe**:
  - Sirf verified facts likhta hai
  - Rumors ko clearly "Rumored:" label karta hai
  - Koi illegal/misleading content nahi
  - No specific fake numbers, no defamation
- **Complete SEO**: title + meta description + keywords + OG tags + Article schema + FAQ schema + sitemap entry + blogs.html card + internal links
- **Hero image auto-generated** via Pollinations.ai (free, no API key) — real image on every post, not just emoji
- **AdSense (`ca-pub-2278101269918728`) + Google Analytics (`G-KJ0WTD0R0M`) tags** embedded in every generated post
- **Multi-model AI fallback** (openai/gpt-oss-120b → llama-3.3-70b → openai/gpt-oss-20b) — jab ek model fail ho ya deprecate ho, script automatically next try karta hai
- **Auto retry 3× per model** with exponential backoff on 429/5xx errors
- **IndexNow ping** (optional, if `INDEXNOW_KEY` secret set) — Google/Bing turant naye URL ko index karte hain
- **100% FREE**: Groq API free tier + GitHub Actions free minutes + Pollinations free

---

## 🚀 Setup (Ek Baar Ka Kaam, ~5 Minutes)

### Step 1: AI Key — already done, no new key needed ✅

`DEEPSEEK_API_KEY` pehle se ek **repository** secret ke roop me hai, isliye
generator ka provider ladder (`groq → gemini → deepseek → siteapi`) DeepSeek se
publish kar sakta hai — koi naya key banane ki zaroorat nahi.

(Optional, sirf agar primary providers wapas chahiye: `GROQ_API_KEY` ya
`GEMINI_API_KEY` bana kar Step 2 ki tarah add karo.)

### Step 2: GitHub Secret — already done, no manual paste needed ✅

`WORKFLOW_PAT` secret pehle se hai, isliye hardened workflow YAML
(`scripts/workflow-fixes/*.fixed`) **khud apply** ho jata hai —
`.github/workflows/` me kuch manually paste karne ki zaroorat nahi.

(Agar kabhi `WORKFLOW_PAT` hatao to: har workflow file GitHub UI me kholo aur
`scripts/workflow-fixes/*.fixed` ki copy se replace kar do.)

### Step 3: Workflow Enable Karo (30 sec)

1. Repo me **Actions** tab pe jao
2. Agar dikhe "I understand my workflows, go ahead and enable them" — click karo
3. Left sidebar me **"Daily Blog Auto-Publish"** workflow dikhega ✅

### Step 4: Manual Test Run (Optional, Recommended)

Automation start hone se pehle ek baar test karo:

1. **Actions** tab → **"Daily Blog Auto-Publish"** click
2. Right side me **"Run workflow"** dropdown → **Run workflow** button
3. 30-60 sec baad ek new blog post commit ho jayega automatically ✅
4. `/blog/` folder me new file, `blogs.html` me new card, `sitemap.xml` me new URL — sab automatic add hoga

---

## 📅 Publishing Schedule

- **Har din 2 baar: 05:20 + 14:20 UTC** (India 10:50 AM / 7:50 PM) — `daily-blog.yml`
- Web Story: **06:45 + 16:45 UTC** (`daily-webstory.yml`), Site Health: every 6 h (`health-check.yml`)
- Do baar is liye ki GitHub ka scheduler `:00` wale crons ko kabhi-kabhi ghanton delay kar deta hai — ek run miss ho to dusra catch kar leta hai
- Har run **idempotent + self-healing**: aaj ka post already hai to skip, aur pichhle chhoot gaye din (`--backfill`, default 2/run, oldest-first) apne aap bhar dete hai
- Kyun ye time?
  - 🇺🇸 US East Coast: 9:00 AM (log in karte samay)
  - 🇬🇧 UK: 2:00 PM (lunch break, high engagement)
  - 🇪🇺 Europe: 3:00 PM CET
  - 🇮🇳 India: 7:30 PM (evening browsing peak)
  - 🇦🇺 Australia: 12:00 AM (next day morning read)
  - **Google Search + Reddit + Twitter** ka worldwide peak overlap window hai

---

## 🛡️ Safety Guarantees

Script me ye rules **hard-coded** hain:

1. ✅ **No duplicate topics** — 200 previous titles memory + existing blog scan
2. ✅ **No fake facts/rumors** — AI ko explicit instruction: "Only verified facts. Mark rumors as rumors."
3. ✅ **No illegal content** — Prompt explicitly bans it
4. ✅ **No defamation** — No personal attacks on individuals
5. ✅ **No file overwrites** — Only ADDS new files, existing files ko chhoota hi nahi
6. ✅ **Marker-based insertion** — `blogs.html` aur `sitemap.xml` me safe `<!-- AUTO-BLOG-INSERT-START -->` markers, purana structure intact rehta hai
7. ✅ **Koi "green but empty" nahi** — publish na ho to run RED hota hai; last step `scripts/verify-publish.mjs` `origin/main` me file ka existence check karta hai
8. ✅ **Thin content publish nahi hota** — `MIN_WORDS=1000` / `MIN_SECTIONS=5` (story: `MIN_SLIDES=6`); gate fail ho to 3 baar retry, phir bhi fail = RED run
9. ✅ **Index-safe git** — content commit me sirf whitelisted paths jate hain; `.github/workflows/**` har baar index se hataya jata hai (yahi wajah thi ki 40 din se story job red thi)
10. ✅ **Har run ka record** — `scripts/publish-log.json` (ledger) + live `https://aitoolsnova.com/publish-status.json` (sirf status/counts, key values kabhi nahi)

---

## 🎛️ Customization

### Change publishing time:
`.github/workflows/daily-blog.yml` me:
```yaml
- cron: '20 5,14 * * *'
```
Format: `minute hour day month weekday` (UTC). Rule: **minute `:00` mat rakho** — busy
slots me GitHub scheduled runs ko ghanton delay kar deta hai (ek "missed day" ki yahin se
shuruaat hui thi).
- `20 5,14 * * *` = roz 05:20 + 14:20 UTC (current)
- `35 12 * * 1-5` = weekdays 12:35 UTC

### Add more posts per day:
```yaml
- cron: '20 5,11,14 * * *'
```
aur (optional) repo **variable** `POSTS_PER_RUN=2` — ek run me kitne din publish.

### Chhoot gaye din (backfill):
- default: har run aaj + `2` missing din (oldest-first, `BACKFILL_MAX` se change, `0` = off)
- one-off: Actions → *Blog Auto-Publish (daily)* → **Run workflow** → `backfill=5`

### Use different AI model:
`.github/workflows/daily-blog.yml` me `GROQ_MODEL` change karo (Repository → Settings → Variables → Actions → New variable → `GROQ_MODEL`):
- `openai/gpt-oss-120b` (recommended replacement, best quality — script default)
- `llama-3.3-70b-versatile` (legacy, still works till Aug 2026)
- `openai/gpt-oss-20b` (fastest, cheapest fallback)
- `qwen/qwen3.6-27b` (alternative)

Script **automatically tries all 3 models in order** if one fails — you don't need to configure this manually.

Available models: https://console.groq.com/docs/models

---

## 🐛 Troubleshoot

### Sabse pehle ye 3 commands (2 minute me poori diagnosis)
```bash
node scripts/daily-publish-helper.mjs status   # secrets/yaml/ledger ek saath
node scripts/site-health.mjs --offline         # content + sitemap + workflow checks
node scripts/verify-publish.mjs --kind=blog    # origin/main tak pahuncha ya nahi
```

### Blog nahi ban rahi (autoblog rerun fail)?
1. Actions tab me latest failed run open karo → red step ke logs check karo
2. Common issues aur fix:
   - **`No AI key found`** → secret **repository** level par hona chahiye. *Environment* secrets scheduled runs ko dikhte hi nahi — yahi 5-din ke outage ki asli wajah thi
   - **`green tick par post nahi aaya`** → ab possible nahi: `continue-on-error` hata diya gaya hai aur `verify-publish.mjs` job ka last step hai. Agar aisa phir dikhe to `.github/workflows/daily-blog.yml` purana version hai — `scripts/workflow-fixes/*.fixed` paste karo
   - **`Groq 401 Unauthorized`** → Key invalid ho gayi. Naya key generate karo aur secret update karo
   - **`Groq 429 Rate limit`** → Script auto-retries 3x with backoff. Agar phir bhi fail, 1 hour baad rerun karo
   - **`model_decommissioned` / `model_not_found`** → Script auto-fallback karta hai 3 models me. Agar sab fail — set repo variable `GROQ_MODEL` = `openai/gpt-oss-120b`
   - **`JSON parse failed`** → AI ne malformed response diya. Actions me manual **Run workflow** click karo — 2nd try me usually pass ho jata hai
   - **`Auto-commit failed`** → Repo Settings → Actions → General → Workflow permissions → **"Read and write permissions"** → Save
3. Local dry run: `node scripts/generate-blog.mjs --check` (kuch likhega nahi, bas batayega kya hoga)
   ya `GROQ_API_KEY=gsk_... node scripts/generate-blog.mjs --date=2026-08-26 --dry-run`
4. Pipeline sanity: `npm run test:publish` (mocked Groq — koi API call nahi, publish/ledger/sitemap/guard sab verify)
5. Poora suite: `npm test`

### Auto-commit fail?
Repo settings → **Actions** → **General** → scroll down to **Workflow permissions** → select **"Read and write permissions"** → Save.

### Content quality kam lag rahi hai?
`scripts/generate-blog.mjs` line ~110 me `temperature: 0.7` ko `0.4` kar do (more focused output).

---

## 📊 Local testing

```bash
export GROQ_API_KEY="gsk_your_key_here"
node scripts/generate-blog.mjs --check        # plan only: aaj kaunsa topic + kaunse din missing hain
node scripts/generate-blog.mjs --dry-run      # post banega, commit/push NAHI
FORCE_PUBLISH=1 node scripts/generate-blog.mjs   # poora flow, push ke saath (branch par)
npm test                                      # 131 assertions + audits
```

Local run by default push nahi karta (`SKIP_AUTO_PUBLISH` logic) — safety.

### Scripts ka map

| File | Kaam |
|---|---|
| `lib/publish-core.mjs` | shared spine: keys, timeouts, retry, JSON salvage, word gates, gap planner, ledger, `publishContent()` |
| `generate-blog.mjs` | blog post generate + publish (CLI: `--date --backfill --count --dry-run --force --check`) |
| `generate-webstory.mjs` | web story from newest article (same CLI) |
| `daily-publish-helper.mjs` | `status` / `validate` / `sync` / `heal` — workflow config + self-heal |
| `verify-publish.mjs` | CI ka final gate: file disk par + `origin/main` par + SEO complete |
| `site-health.mjs` | health checker (files/sitemap/freshness/markup/audits/automation/live) |
| `check-workflows.mjs` | workflow YAML lint (GitHub-reject patterns + failure-hiding patterns) |
| `test-publish-core.mjs`, `test-e2e-mock.mjs`, `test-webstory-smoke.mjs`, `test-webstory-e2e.mjs`, `test-publish-helper.mjs`, `test-site-health.mjs`, `test-dry-run.mjs`, `test-gemini-fallback.mjs`, `test-ats.mjs` | tests (sab `npm test` me) |

---

## 🎉 Kaam Ho Gaya!

Bas itna hi. Ab din me 2 baar (05:20 + 14:20 UTC) ek naya post publish hoga, aap kuch nahi karoge. 🚀

**Pehli post agle scheduled slot me** (zyada se zyada ~6.5 ghante, kyunki din me 2 runs hain) — ya Actions → *Blog Auto-Publish (daily)* → **Run workflow** → `backfill=5` se abhi. Deep-dive + owner checklist: [`AUTOMATION_FIX.md`](../AUTOMATION_FIX.md).

**Traffic tips**: Har naye post ka URL Google Search Console me **"Request Indexing"** karo — 1-3 din me indexed ho jaayega instead of weeks.
