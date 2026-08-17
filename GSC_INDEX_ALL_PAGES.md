# Google Search Console — Index ALL tools, blogs, web stories, homepage

## Already done automatically (from this workspace)
1. **Canonical sitemap rebuilt** → `https://aitoolsnova.com/sitemap.xml`
2. **IndexNow** submitted all sitemap URLs → HTTP **200** (Bing / Yandex / others)
3. Bing IndexNow endpoint also **200**
4. Lists generated:
   - `gsc-url-list.txt` — every canonical URL
   - `gsc-priority-urls.txt` — hubs → tools → blogs → stories

> Google’s old `google.com/ping?sitemap=` endpoint is dead (404). **GSC sitemap submit** is the real Google path.

---

## YOU must do this in GSC (only you can log in) — 5 minutes

### Step 1 — Open the right property
1. https://search.google.com/search-console  
2. Property: **`aitoolsnova.com`** (Domain property preferred)  
   - If missing: Add property → Domain → `aitoolsnova.com` → DNS TXT in Cloudflare

### Step 2 — Submit sitemap (indexes whole site)
1. Left menu → **Sitemaps**
2. Add: `sitemap.xml`
3. Click **Submit**
4. Wait until status = **Success** (can take minutes–hours)

This is how Google discovers:
- Homepage  
- All tools  
- All blogs  
- All web stories  
- About / contact / legal  

### Step 3 — Force priority pages (URL Inspection)
For each URL below: paste → **Enter** → **Request indexing**

**Must-do first (do these now):**
```
https://aitoolsnova.com/
https://aitoolsnova.com/tools
https://aitoolsnova.com/blogs
https://aitoolsnova.com/web-stories
https://aitoolsnova.com/about
https://aitoolsnova.com/contact
```

Then request indexing for **as many tools + top blogs as GSC allows today**  
(Google limits manual requests; sitemap covers the rest).

Full ordered list is in repo file: **`gsc-priority-urls.txt`**

### Step 4 — Optional supercharge (Google Indexing API)
If you add GitHub secret `GOOGLE_SERVICE_ACCOUNT_JSON` (see `GOOGLE_INDEXING_SETUP.md`),  
workflow `.github/workflows/google-index.yml` can auto-notify Google daily (~200 URLs/day quota).

---

## Honest limits (important)
| Method | What it does |
|--------|----------------|
| Sitemap in GSC | Best way to get **all** pages discovered |
| Request indexing | Speeds **selected** URLs (quota limited) |
| IndexNow | Fast for **Bing** etc. (already done) |
| Indexing API | Extra Google nudge (needs your service account) |

**Nobody can “force Google to index 100% today”.**  
Correct setup = sitemap + crawlable 200 pages + time (usually days).

---

## After submit — check
GSC → **Pages** (Indexing):
- “Why pages aren’t indexed” should drop over 3–14 days  
- Valid tools/blogs/stories should move to **Indexed**
