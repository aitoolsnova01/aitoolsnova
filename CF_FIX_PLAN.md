# Cloudflare / Analytics Fix Plan — AIToolsNova (19 Aug 2026)

## ✅ Jo maine verify kiya — site ab SAHI chal rahi hai

| Check | Result |
|---|---|
| `https://aitoolsnova.com/` | ✅ 200 OK — sahi content serve ho raha hai (3 alag networks se test kiya) |
| `https://www.aitoolsnova.com/` | ✅ → `aitoolsnova.com` redirect (301) |
| `https://aitoolsnova.pages.dev/` | ✅ → `aitoolsnova.com` redirect (301) — **pehle traffic yahi ja raha tha, ab sahi jagah redirect hota hai** |
| DNS (`aitoolsnova.com` + `www`) | ✅ Cloudflare proxy IPs, nameservers Cloudflare ke |
| `pags.dev` | ⚠️ Ye **kisi aur** (GoDaddy pe hosted) ka personal site hai — aapke Cloudflare account me NAHI hai. Aapka matlab `*.pages.dev` tha (site ka default subdomain) — wo ab fix hai. |
| GA4 tag `G-KJ0WTD0R0M` | ✅ Har page pe laga hai |
| Google + Bing verification meta | ✅ Dono hain (`index.html` me) |
| `sitemap.xml`, `robots.txt`, `ads.txt` | ✅ Sab live aur sahi |
| Automatic health check (5 ghante pehle) | ✅ Homepage 200, ads.txt OK, saare sitemap URLs 200 |

## 🔧 Jo maine repo me FIX kiya (deploy ke baad live hoga)

**Google Analytics data nahi aa raha tha — asli wajah mil gayi:**
Cookie-consent banner har visitor ke liye default me `analytics_storage: denied` kar raha tha.
Matlab: jo bhi visitor "Accept" nahi dabata (zyadatar traffic), uski koi bhi hit GA4 me **nahi** jaati → GA me data zero.

**Fix:** `js/consent.js` me ab default `analytics_storage: granted` hai.
Ads wale consent (`ad_storage`, `ad_user_data`, `ad_personalization`) pehle jaisi hi gated hain — AdSense compliance safe.
Deploy hote hi GA data wapas aana shuru hoga. (Reject dabane wale visitors ke liye analytics band hi rahega — unki choice.)

## 🖱 Aapko kya karna hai (sabse fast — ~2 min)

1. **GitHub PR merge karo** — maine `consent.js` fix ke saath PR bana diya hai.
   Merge karte hi Cloudflare Pages auto-deploy karega (GitHub integration already connected hai) → fix live.
2. **Cloudflare dashboard — 3 quick checks** (agar traffic abhi bhi block lagta ho):
   - **Workers & Pages → apna project → Custom domains:** sirf `aitoolsnova.com` + `www.aitoolsnova.com` hona chahiye. Koi aur domain (jaise koi `*.pages.dev` ya galti se koi aur) ho to remove karo.
   - **Security → Bots:** **Bot Fight Mode OFF** karo (ON ho to Google/Bing ke crawlers block hote hain → GSC/Bing me data zero).
   - **Security → Settings:** Security level **Medium** (agar "Under Attack" mode ON hai to poora traffic block hota hai).
3. **GSC + Bing Webmaster:** sitemap (`https://aitoolsnova.com/sitemap.xml`) dobara submit karo — indexing refresh hoga.

## 🤖 Option: main Cloudflare poora khud fix karun (automatic, recommended agar upar wale steps me kuch bhi galat mile)

Maine ek script bana di hai — `scripts/cf-fix.sh` — jo Cloudflare API se **sab check/fix** kar sakti hai:
custom domains, Bot Fight Mode, security level, WAF rules, IP rules, cache purge, pages.dev redirect.

Us script ko chalane ke liye GitHub pe 2 chhote steps aapko karne padenge (sirf repo owner kar sakta hai):

1. **Secret add karo:** GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: aapka Cloudflare API token (jo aapne chat me diya tha)
2. **Workflow file banao:** GitHub repo → **Add file → Create new file**
   - Path: `.github/workflows/cf-fix.yml`
   - Content: `scripts/cf-fix-workflow.yml` file ka poora content copy-paste karo (repo me already maujood hai)

Phir mujhe bas "ho gaya" batao — main ek push karunga, workflow chalega,
report GitHub issue **#2** me aayegi, aur main sab settings check/fix kar ke verify karunga.

## 🔒 Security note (important)

Aapne Cloudflare aur GitHub ke tokens chat me bheje hain — inka koi bhi misuse aapke
poore account pe kabza karwa sakta hai. Mainne kisi file me token save NAHI kiya hai.
Kaam khatam hone ke baad:
- Cloudflare dashboard → My Profile → API Tokens → **ye token revoke karo** aur naya banao.
- GitHub → Settings → Developer settings → Fine-grained tokens → **ye PAT revoke karo**.
