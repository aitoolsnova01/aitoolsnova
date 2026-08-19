# Deploy is broken — exact cause (19 Aug 2026)

GitHub pe jo green tick dikhta hai **Deploy to Cloudflare Pages**, wo **deploy nahi kar raha**.

Maine latest `main` push (PR #5 merge) ka Actions job khol ke dekha:

| Step | Result |
|---|---|
| Check secrets | ran |
| checkout | **skipped** |
| setup-node | **skipped** |
| Deploy with Wrangler | **skipped** |
| job | marked **success** in 6 seconds |

Matlab: GitHub secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` **set nahi hain**. Workflow khud skip ho jata hai aur green tick de deta hai. Isliye last session ke changes GitHub `main` pe hain, lekin Cloudflare live site refresh nahi hota.

Doosri baat: `_headers` me `/*.js` **1 saal immutable cache** tha. `consent.js` / `enhancements.js` update hone ke baad bhi browser + CDN purani file serve karte rehte. Ye is PR me fix ho gaya (120s + `?v=20260819c` cache-bust).

## Aap 90 second me live karo

### 1) Cloudflare Pages ko `main` se dobara build karo
1. https://dash.cloudflare.com → login
2. **Workers & Pages** → project **`aitoolsnova`**
3. **Settings → Builds & deployments**
   - Production branch: **`main`**
   - Automatic deployments: **Enabled**
   - Connected repository: **`aitoolsnova01/aitoolsnova`**
4. **Deployments** tab → latest → **⋯ → Retry deployment**
   (ya **Create deployment** from `main`)
5. **Caching → Configuration → Purge Everything**
6. Site hard-refresh: Ctrl+F5 → https://aitoolsnova.com

Success check (View Source):
- dikhna chahiye: `consent.js?v=20260819c`
- nahi dikhna chahiye: `live user activity`

### 2) (Optional) taaki main bhi deploy kar sakun
GitHub → repo **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Custom token with **Account → Cloudflare Pages → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | `e1fbd9456c1d1e2c8ae725dfe2f20d53` |
| `CF_PAGES_PROJECT` | `aitoolsnova` (optional) |

Token: https://dash.cloudflare.com/profile/api-tokens → Create Custom Token → **Cloudflare Pages: Edit**. IP restriction mat lagao.

Phir Actions → **Deploy to Cloudflare Pages** → Run workflow.

## Last session kya live site pe dikhega?

PR #5 sirf **scripts** (daily blog/webstory helper) — homepage ka look change nahi hota.
PR #3 (`consent.js` analytics default) **tab** dikhega jab Pages rebuild + cache purge ho.

Is PR me cache-bust + `_headers` fix hai — merge + Cloudflare Retry ke baad View Source me `?v=20260819c` dikhega.
