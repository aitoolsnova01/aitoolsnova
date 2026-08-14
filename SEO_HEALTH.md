# SEO Health Fix - GSC, Bing Webmaster & Google Analytics

## What was blocking your data (and what I fixed)

### 1. robots.txt had risky wildcard patterns
**Before:** rules like `Disallow: /.*.yml`, `Disallow: /.*.log$`, `Disallow: /*.ts$`, `Disallow: /package.json`, `Disallow: /category/`, `Disallow: /tag/`, plus a `Crawl-delay: 0.5` for Googlebot (Google ignores crawl-delay).

**After (`robots.txt` v4.0):**
- Explicit `Allow: /web-stories/` added
- Removed all fragile regex-style Disallow rules that could be interpreted differently by Googlebot vs. Bingbot
- Explicit sections for Googlebot, Googlebot-Image, Googlebot-Video, Googlebot-News, Bingbot, AdsBot-Google, Mediapartners-Google
- Bad bots (Semrush/Ahrefs/MJ12/etc.) still blocked
- Single canonical `Sitemap:` line

### 2. Sitemap was missing web-stories
**Fixed:** Added `web-stories.html` (priority 0.9, daily) and each individual story URL (priority 0.8, weekly). The daily-webstory workflow will keep this updated automatically.

### 3. Web stories weren't discoverable
**Fixed:** New `/web-stories.html` landing page listing every story with poster thumbnail + description. Linked from the workflow-updated sitemap so Google/Bing crawlers can find them.

---

## Why "no data" is showing in GSC / Bing / GA

This is almost always ONE of the following (in order of frequency):

### A) Property mismatch (most common)
- If you added `https://aitoolsnova.com` in GSC but your canonical is `https://aitoolsnova.com/` (or vice-versa), data goes to a different property.
- **Fix:** In Google Search Console, add BOTH:
  1. **Domain property** → `aitoolsnova.com` (requires DNS TXT record in Cloudflare — the strongest verification)
  2. **URL prefix property** → `https://aitoolsnova.com`

  Adding a Domain property gives you consolidated data (http, https, www, non-www, all subdomains).

### B) Site is too new (24h - 14 days needed)
- Your first commit shows `Aug 8, 2026`. Google typically shows first crawl data after **3–7 days**, Bing after **5–14 days**.
- Real search impressions can take **2–4 weeks** to accumulate.

### C) Google Analytics tag firing but property wrong
- Your `G-KJ0WTD0R0M` tag is loaded in `index.html`. Double-check the same GA4 Measurement ID appears in every HTML page (tools.html, blogs.html, contact.html, etc.).
- In GA4, go to **Admin → Data Streams** → confirm the stream URL matches `https://aitoolsnova.com`.
- Enable **DebugView** and open your site with `?debug_mode=1` — you should see events firing live.

---

## Instant actions you should take today

1. **Verify Domain property in GSC** (not just URL prefix)
   - GSC → Add Property → Domain → `aitoolsnova.com`
   - Copy the TXT record → Cloudflare Dashboard → DNS → Add record → type: TXT, name: `@`, value: (paste)
   - Wait 5 min → click Verify

2. **Bing Webmaster: use "Import from GSC" (fastest)**
   - Log into `bing.com/webmasters` with same Google account used for GSC
   - Choose "Import your sites from Google Search Console" → 1-click import
   - Bing then trusts the GSC verification, no meta tag needed
   - Your existing `msvalidate.01` tag stays as backup

3. **Submit sitemap manually (right now)**
   - GSC → Sitemaps → Add: `sitemap.xml`
   - Bing → Sitemaps → Add: `https://aitoolsnova.com/sitemap.xml`
   - IndexNow (already automated by the daily workflows)

4. **Force a crawl using GSC URL Inspection**
   - Paste `https://aitoolsnova.com/web-stories.html` → Request Indexing
   - Paste `https://aitoolsnova.com/tools.html` → Request Indexing
   - Do this for your 5 most important pages once — it's free and instant

5. **Check "Coverage" / "Pages" in GSC**
   - After 24h it will show which URLs are indexed vs excluded
   - "Excluded" reasons will tell you exactly what's still wrong

---

## What runs automatically now

| When (UTC) | What | Workflow |
|---|---|---|
| 14:00 daily | New AI blog post → adds to `blog/`, `blogs.html`, `sitemap.xml` | `.github/workflows/daily-blog.yml` |
| 15:30 daily | New AI web story (HD images + caption per slide) → adds to `web-stories/`, updates `web-stories.html`, `sitemap.xml` | `.github/workflows/daily-webstory.yml` |
| After each publish | Ping Google + Bing sitemap + IndexNow (Yandex, Naver, Seznam) | Same workflows |

## Required GitHub secrets (already configured)
- `GROQ_API_KEY` — for AI content generation
- `INDEXNOW_KEY` (optional) — auto-detected from repo root `.txt` key file

## Testing locally
```bash
export GROQ_API_KEY=your_key_here
node scripts/generate-webstory.mjs      # generates one story
node scripts/test-webstory-smoke.mjs    # offline smoke test (no API needed)
```
