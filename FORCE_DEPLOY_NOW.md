# 🚨 Live site deploy nahi ho raha — FIX (2 minutes)

## Diagnosis
- GitHub `main` latest commit: **already pushed** (`0b7735b` + HD image commits)
- Live `aitoolsnova.com` still shows **last-modified ~05:55 UTC** + old homepage text (`live user activity`)
- Meaning: **Cloudflare Pages is NOT picking Git pushes** (webhook off / wrong project / auto-deploy disabled)
- GitHub Action "Deploy to Cloudflare Pages" **failed** because secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are missing on the repo

Code push alone cannot update the live CDN until Cloudflare rebuilds.

---

## Option A — Manual deploy (fastest, no secrets)

1. Open https://dash.cloudflare.com
2. **Workers & Pages** → project connected to `aitoolsnova01/aitoolsnova` (often named `aitoolsnova`)
3. Tab **Deployments**
4. If a failed build exists → **⋯ → Retry deployment**
5. If no new build for latest commit → **Create deployment** / **Retry** from production
6. Wait until status = **Success**
7. Hard refresh site: Ctrl+F5  
   Check homepage source should contain `about-aitoolsnova` and NOT `live user activity`

### Also turn auto-deploy back ON
**Settings → Builds & deployments**
- Production branch: `main`
- Build command: *(empty)* OR `echo Build completed`
- Build output directory: `/` or empty (this repo is static root)
- Root directory: `/`
- Automatic deployments: **On**

---

## Option B — Auto deploy via GitHub Action (recommended long-term)

1. Cloudflare → My Profile → **API Tokens** → Create Token  
   Permission: **Account → Cloudflare Pages → Edit**
2. Copy **Account ID** (dashboard sidebar)
3. GitHub → `aitoolsnova01/aitoolsnova` → **Settings → Secrets and variables → Actions**
   - `CLOUDFLARE_API_TOKEN` = token
   - `CLOUDFLARE_ACCOUNT_ID` = account id
   - Optional `CF_PAGES_PROJECT` = exact Pages project name if not `aitoolsnova`
4. GitHub → **Actions → Deploy to Cloudflare Pages → Run workflow**
5. Wait for green ✅

---

## Verify live is new
```bash
curl -sI https://aitoolsnova.com/ | grep -i last-modified
curl -s https://aitoolsnova.com/ | grep -o 'about-aitoolsnova\|live user activity'
```
Expect: `about-aitoolsnova` present, `live user activity` gone.

---

## After deploy
- Cloudflare → Caching → **Purge Everything** (if still old)
- GSC → resubmit `sitemap.xml`
