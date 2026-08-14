# 🤖 Daily Auto-Blog System — Setup Guide

## ✨ Kya Karta Hai?

- **Har din 14:00 UTC** (India 7:30 PM / US 9 AM EST / Europe 3 PM CET) automatically **1 unique blog post publish** karta hai
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

### Step 1: Groq API Key Banao (2 min, FREE)

1. https://console.groq.com/keys open karo
2. Google account se login karo (free)
3. **"Create API Key"** click karo → naam do "AIToolsNova Blog Bot"
4. Key copy karo (starts with `gsk_...`)

### Step 2: GitHub Secret Add Karo (1 min)

1. Apne GitHub repo pe jao: `github.com/YOUR_USERNAME/aitoolsnova-main`
2. **Settings** tab → left sidebar me **Secrets and variables** → **Actions**
3. **New repository secret** button click karo
4. Fill karo:
   - Name: `GROQ_API_KEY`
   - Secret: (jo Step 1 me copy kiya tha, `gsk_...`)
5. **Add secret** click karo

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

- **Har din 14:00 UTC** (fixed time)
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

---

## 🎛️ Customization

### Change publishing time:
`.github/workflows/daily-blog.yml` me:
```yaml
- cron: '0 14 * * *'
```
Format: `minute hour * * *` (UTC time). Example:
- `0 6 * * *` = 6 AM UTC daily
- `30 12 * * *` = 12:30 PM UTC daily

### Add more posts per day:
Just change cron to run 2-3 times:
```yaml
- cron: '0 8 * * *'
- cron: '0 14 * * *'
- cron: '0 20 * * *'
```

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

### Blog nahi ban rahi (autoblog rerun fail)?
1. Actions tab me latest failed run open karo → red step ke logs check karo
2. Common issues aur fix:
   - **`GROQ_API_KEY env var missing`** → Step 2 dobara karo. Repo → Settings → Secrets and variables → Actions → New secret → name `GROQ_API_KEY`
   - **`Groq 401 Unauthorized`** → Key invalid ho gayi. Naya key generate karo aur secret update karo
   - **`Groq 429 Rate limit`** → Script auto-retries 3x with backoff. Agar phir bhi fail, 1 hour baad rerun karo
   - **`model_decommissioned` / `model_not_found`** → Script auto-fallback karta hai 3 models me. Agar sab fail — set repo variable `GROQ_MODEL` = `openai/gpt-oss-120b`
   - **`JSON parse failed`** → AI ne malformed response diya. Actions me manual **Run workflow** click karo — 2nd try me usually pass ho jata hai
   - **`Auto-commit failed`** → Repo Settings → Actions → General → Workflow permissions → **"Read and write permissions"** → Save
3. Local test bhi kar sakte ho: `GROQ_API_KEY=gsk_... node scripts/generate-blog.mjs`
4. Pipeline sanity check: `node scripts/test-e2e-mock.mjs` (Groq nahi call karta, sirf HTML pipeline verify karta hai)

### Auto-commit fail?
Repo settings → **Actions** → **General** → scroll down to **Workflow permissions** → select **"Read and write permissions"** → Save.

### Content quality kam lag rahi hai?
`scripts/generate-blog.mjs` line ~110 me `temperature: 0.7` ko `0.4` kar do (more focused output).

---

## 📊 Local Testing (Optional)

Agar aap script ko locally test karna chahte ho:

```bash
export GROQ_API_KEY="gsk_your_key_here"
node scripts/generate-blog.mjs
```

Ye ek new blog post banayega but commit nahi karega (local run). Fir manually check kar lo.

---

## 🎉 Kaam Ho Gaya!

Bas itna hi. Ab har din 14:00 UTC pe ek naya post publish hoga, aap kuch nahi karoge. 🚀

**Pehli blog post 24 hours ke andar aa jayegi** (agla scheduled time). Ya **manual trigger** se abhi test karo.

**Traffic tips**: Har naye post ka URL Google Search Console me **"Request Indexing"** karo — 1-3 din me indexed ho jaayega instead of weeks.
