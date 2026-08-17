# 🚨 Cloudflare deploy — RIGHT NOW (token issue explained)

## Live site setup (confirmed)
- DNS: `aitoolsnova.com` → **CNAME `aitoolsnova.pages.dev`** (Cloudflare Pages)
- Project name is almost certainly: **`aitoolsnova`**
- GitHub `main` already has all fixes
- Live CDN still on old build (`last-modified` ~05:55, still shows `live user activity`)

## Why the token you sent cannot deploy
API test result:
- ✅ Token valid for **Account** + **Zone DNS** (`aitoolsnova.com`)
- ❌ **Cloudflare Pages API = Authentication error (10000)**
- So this token is missing: **Account → Cloudflare Pages → Edit**

Without that permission, neither this server nor GitHub Actions can run:
`wrangler pages deploy`

---

## FIX A — Dashboard manual deploy (fastest, 60 seconds)

1. https://dash.cloudflare.com → login  
2. **Workers & Pages** → open project **`aitoolsnova`**  
3. **Deployments** → find latest → **⋯ → Retry deployment**  
   OR **Create deployment** from branch **`main`**  
4. Wait for **Success**  
5. **Caching** → **Purge Everything** (optional but recommended)  
6. Hard refresh https://aitoolsnova.com (Ctrl+F5)

### Success check
Page source must contain: `about-aitoolsnova`  
Must NOT contain: `live user activity`

### Turn auto-deploy ON
Workers & Pages → `aitoolsnova` → **Settings → Builds & deployments**
- Production branch: `main`
- Build command: empty
- Build output directory: empty or `/`
- Automatic deployments: **Enabled**
- Connected repo: `aitoolsnova01/aitoolsnova`

---

## FIX B — New API token (so I / GitHub Action can deploy)

1. https://dash.cloudflare.com/profile/api-tokens  
2. **Create Token** → **Create Custom Token**  
3. Permissions (exact):
   - **Account** → **Cloudflare Pages** → **Edit**
   - **Account** → **Account Settings** → **Read** (optional)
4. Account Resources: **Include → your account**
5. **NO IP restriction** (important)
6. Create → copy token once

7. GitHub → `aitoolsnova01/aitoolsnova` → **Settings → Secrets and variables → Actions**
   - `CLOUDFLARE_API_TOKEN` = new token  
   - `CLOUDFLARE_ACCOUNT_ID` = `e1fbd9456c1d1e2c8ae725dfe2f20d53`  
   - optional `CF_PAGES_PROJECT` = `aitoolsnova`

8. GitHub → **Actions → Deploy to Cloudflare Pages → Run workflow**

OR paste the new **Pages Edit** token here and say “deploy” — then I can push live from here.

---

## Security
Revoke every token you pasted in chat after deploy:
- Old IP-restricted tokens
- This Zone-only token  
Create a fresh one only when needed.
