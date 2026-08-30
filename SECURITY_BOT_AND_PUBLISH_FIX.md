# AIToolsNova — Security, Bot-attack & Publishing fix

Date: 2026-08-29

Ye file do cheezein cover karti hai:
1. **Code me kya fix ho chuka hai** (is commit me — deploy hote hi live).
2. **Cloudflare + GitHub dashboard me aapko kya karna hai** (sirf wahi cheezein jo code se nahi ho sakti).

---

## 1. Code me kya fix hua (deploy hote hi live)

| Problem | Fix |
|---|---|
| Blog/Web Story workflow **green** dikhta tha par kuch publish nahi hota tha (`continue-on-error` failure chhupa deta tha). | Workflow ab generation fail hone par **RED** hota hai aur ek GitHub **issue** khol deta hai (`publish-failure` label). Ab "dikhawa success" nahi hoga. |
| Saare AI providers fail hone par site tools aur auto-publish dono mar jaate the. | Cloudflare **Workers AI native binding** (`env.AI`) add kiya — **bina kisi API key** ke chalta hai, aapke hi Cloudflare account ke andar. Site `/api/gemini` ab use **pehle** try karta hai, isliye keys missing/revoked hone par bhi tools + daily publish chalte rahenge. |
| Bot attacks / API abuse | Edge middleware (`functions/_middleware.js`) me per-IP rate limit (AI: 30/min, forms: 8/min), scanner/SQLi/path-traversal payload block, security headers (HSTS preload, X-Frame-Options, nosniff, Referrer/Permissions policy) **har response** par. |
| Newsletter bot signups | Honeypot field add (bots fill karte hain → server silently discard). |
| Health check baar-baar false-red | Ab retry karta hai (edge cold-start/transient blip par false alarm nahi), aur real outage par issue kholta hai. |
| Auto-publish keyless runner par mar jaata tha | Generation scripts ab keyless runner par **site API fallback ko pehle** try karte hain. |

> Workflow files: `.github/workflows/daily-blog.yml`, `daily-webstory.yml`, `health-check.yml`.
> Edge: `functions/_middleware.js`, `functions/api/gemini.js`, `functions/api/subscribe.js`.
> Binding: `wrangler.toml` (`[ai] binding = "AI"`).

---

## 2. Aapko Cloudflare dashboard me ye 5 cheezein on karni hain (~10 min)

Login: https://dash.cloudflare.com → **aitoolsnova.com**

### A) SSL / "Not secure" — 1 min
1. **SSL/TLS → Overview →** mode **Full (strict)** rakho (Flexible kabhi mat rakho — wo insecure hota hai).
2. **SSL/TLS → Edge Certificates →**
   - **Always Use HTTPS**: ON
   - **HTTP Strict Transport Security (HSTS)**: ON → Enable HSTS, `max-age` 12+ months, **Include subdomains** ON, **Preload** ON.
   - **Minimum TLS Version**: 1.2.
   - **Opportunistic Encryption / TLS 1.3**: ON.

> Code se HSTS header already ja raha hai, par dashboard "Always Use HTTPS" http→https 301 deta hai — dono chahiye.

### B) Bot attacks — 3 min (sabse zyada impact)
1. **Security → Bots →**
   - **Bot Fight Mode**: **ON** (free) — known bad bots ko automatically challenge/block karta hai.
2. **Security → WAF → Managed rules →** free plan par:
   - **Cloudflare Free Managed Ruleset**: **ON**.
3. **Security → Settings → Security Level:** **Medium** (High zyada false-positive deta hai).
   - **Browser Integrity Check**: ON
   - **Challenge Passage**: 30 min.
4. (Optional, best) **Security → WAF → Custom rules** me ek rule:
   - Name: `Block scanners`
   - Expression:
     `(http.user_agent contains "sqlmap") or (http.user_agent contains "nikto") or (http.user_agent contains "nmap") or (http.user_agent contains "wpscan") or (http.user_agent eq "")`
   - Action: **Block** / **Managed Challenge**.

> Edge middleware already rate-limit aur payload-block kar raha hai; Bot Fight Mode + Managed ruleset uske upar network-layer protection dete hain.

### C) Workers AI binding (auto-publish ko bina key zinda rakhta hai) — 2 min
Code `env.AI` use karta hai. Git-connected Pages project par binding **dashboard** me bhi chahiye:
1. **Workers & Pages → aitoolsnova → Settings → Functions (Bindings) → Add → Workers AI**.
2. Variable name exactly: **`AI`** → Save → **Retry deployment** (ya naya deploy).

Iske baad `/api/gemini` bina kisi external key ke bhi jawab dega, aur daily blog/story publish chalta rahega.

### D) Contact/Newsletter KV namespaces bind karo (forms kaam karein) — 2 min
**Workers & Pages → aitoolsnova → Settings → Functions → KV namespace bindings:**
- Variable name **`CONTACT`** → ek KV namespace banao/select (e.g. `aitoolsnova-contact`).
- Variable name **`SUBSCRIBERS`** → KV namespace (e.g. `aitoolsnova-subscribers`).

(Warne contact form 503 deta hai aur newsletter "temporarily unavailable".)

### E) www → apex redirect (SEO duplicate fix) — 1 min
**Rules → Redirect Rules → Create rule:**
- If: `(http.host eq "www.aitoolsnova.com")`
- Then: **Dynamic redirect**, status **301**, to:
  `concat("https://aitoolsnova.com", http.request.uri.path)`

---

## 3. GitHub secrets (optional but recommended) — 2 min

Code ab zero-secret par bhi chal sakta hai (step C ke baad), par ek direct key redundancy ke liye acchi hai:
- Repo → **Settings → Secrets and variables → Actions → New repository secret** (Environment secret **nahi**, wo scheduled runs ko nahi dikhta):
  - `GROQ_API_KEY` — free: https://console.groq.com/keys (sabse aasaan free tier)
- Phir **Actions → Blog Auto-Publish → Run workflow** manually ek baar.

Agar generation phir bhi fail ho to workflow ab **RED** hoga aur ek issue khulega jisme exact reason hoga — pehle ki tarah chup-chaap green nahi rahega.

---

## 4. Verify (deploy ke ~2 min baad)
- `https://aitoolsnova.com/` par lock/padlock ✅, http kholne par https par redirect.
- Blog/Story page khulein, koi purana post 200 de.
- GitHub → Actions: agla scheduled run **green** aur usme "Pushed N files" dikhe.
- GitHub → Issues: agar kuch phirse fail hua to yahan `publish-failure` / `site-down` label ke saath automatic issue milega.
