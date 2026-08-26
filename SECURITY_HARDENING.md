# Security Hardening — August 2026

**Kya hua tha:** Cloudflare analytics mein continuous scanner/bot attacks
(`wp-login.php`, `.env`, `phpmyadmin`, `.git` probes) aa rahe the, aur audit
mein multiple real weaknesses mili — including ek **information disclosure
jisme poora internal repo publicly download ho raha tha**.

**Kya kiya gaya:** Neeche har fix ka summary hai. Sab code-level fixes live
hain; "Dashboard steps" section manual hai (10 min ka kaam).

---

## 1. Information disclosure — internal repo public tha (CRITICAL)

`wrangler.toml` mein `pages_build_output_dir = "."` hai, matlab **poora repo**
(static assets ki tarah) deploy ho raha tha. Koi bhi ye URLs khol ke padh
sakta tha:

- `/SESSION_NOTES.md`, `/DEPLOYMENT.md`, `LAUNCH_GUIDE.md`, … (internal notes)
- `/backend/server.py` (pura legacy backend source)
- `/scripts/*.mjs`, `/scripts/topic-history.json` (automation + publishing strategy)
- `/tests/`, `/test_reports/`, `/design_guidelines.json`, `/gsc-url-list.txt`
- `/.emergent/`, `/.github/workflows/*`, `/.gitconfig`, `/package.json`

### Fix
- **`.assetsignore` (naya)** — internal files/dirs Cloudflare upload se hi
  exclude ho jaate hain. Root-cause fix: jo deploy hi nahi hoga, wo leak
  nahi hoga. (`functions/` intentionally included — Pages Functions compile
  ke liye.)
- **`functions/_middleware.js`** — defense-in-depth blocklist: scanner
  probes (WordPress, `.env`, `.git`, `phpmyadmin`, `*.php`, `backup.sql` …)
  + internal paths ko edge par flat **403**. Pehle `_redirects` inhe
  homepage par 301 bhej raha tha — ab kuch bhi serve nahi hota.
- **`frontend/server.js`** (preview) — same blocklist mirror.

Verification: repo ki 333 public files ke against regex blocklist test kiya —
**zero false positives**; legit pages, `robots.txt`, `ads.txt`,
`.well-known/security.txt` sab accessible.

## 2. Security headers (CSP + full suite)

`_headers` update hua:

| Header | Effect |
|---|---|
| `Content-Security-Policy` (naya) | Script/style/connect/frame sources allowlist — injected malicious scripts + data-exfil channels block |
| `X-Permitted-Cross-Domain-Policies: none` | Legacy cross-domain policy abuse band |
| `Cross-Origin-Opener-Policy: same-origin` | Window-reference (tabnabbing) attacks band |
| `Permissions-Policy` (expanded) | payment, usb, midi, sensors, display-capture sab disabled |
| existing | HSTS, XFO, nosniff, Referrer-Policy |

**Important:** Cloudflare Pages par `_headers` sirf static assets par lagta
hai — **Functions responses par nahi**. Isliye `_middleware.js` ab har
`/api/*` response par security headers set karta hai (nosniff, XFO DENY,
no-store, noindex, sandbox CSP, origin-validated CORS).

CSP allowlist sirf wahi domains allow karti hai jo site use karti hai:
Google AdSense/GA/GTM, Google Fonts, jsdelivr (background-remover WASM),
pollinations (AI image generator), ampproject (web stories), emergent assets.

## 3. API endpoints hardening (user data yahin jaata hai)

| Endpoint | Pehle | Ab |
|---|---|---|
| `/api/contact` | No rate limit, no origin check | 5 msgs/10min/IP + origin allowlist + 64KB body cap + honeypot (pehle se) + field caps |
| `/api/subscribe` | **No rate limit, no origin check, `source` unvalidated (arbitrary data dump!)** | 5/min/IP + origin allowlist + `source` sanitized (120 chars, path-only) + honeypot + **IP store karna band (data minimization)** |
| `/api/gemini` | 45/min, no body cap, koi origin enforcement nahi | 30/min/IP + 64KB body cap + browser POSTs origin-validated + (existing: secret redaction, timeouts, provider isolation) |
| all `/api/*` | — | Global 120 req/min/IP outer rate limit (middleware) |

In-memory rate limits per-isolate best-effort hain (Workers par standard);
Cloudflare dashboard ka WAF rate limiting (neeche) isi ko durable banata hai.

## 4. Legacy FastAPI backend (`backend/server.py`)

- CORS: `allow_origins=["*"]` + `allow_credentials=True` (galat + dangerous
  combo) → explicit origin allowlist (`ALLOWED_ORIGINS` env), credentials off.
- Per-IP rate limit middleware (30/min AI, 5/min subscribe).
- Exception messages ab client par **leak nahi** hote — sirf server logs mein.
- `source` truncate + shape-check.
- Subscriber PII ab repo ke bahar (`SUBSCRIBERS_FILE`, default `/app/data/`)
  + `**/subscribers*.jsonl` gitignore — **PII kabhi commit/deploy nahi hoga.**

## 5. Preview server (`frontend/server.js`)

- Path traversal: `startsWith(ROOT)` → `startsWith(ROOT + path.sep)` (sibling
  directory bypass fix) + dotfile/dot-dir blocking + internal file blocklist.
- Production-equivalent security headers (CSP included) — preview mein hi CSP
  issues dikh jaate hain, production se pehle.
- `/api/*` clean 503 JSON (preview mein Functions nahi hote).

## 6. Tests

- **`scripts/test-security-hardening.mjs` (naya, 41 assertions)** — probe
  blocking, legit-path pass-through, rate limits, origin checks, honeypots,
  `source` clamping, PII minimization, API header hardening. `npm test` mein
  included.
- `test-gemini-fallback.mjs` naye 30/min limit ke liye update hua.
- **Full suite pass: audits + security + fallback + e2e + smoke.**

---

## Dashboard steps (manual, ~10 min) — karna zaroori hai

Code-level protection ka kaafi hai, par Cloudflare ke edge-level tools
sustained DDoS/abuse ke liye zyada powerful hain:

1. **Bot Fight Mode ON**: Cloudflare dashboard → Security → Bots → "Bot
   Fight Mode" enable (free plan par bhi). Automated scanners/signature
   attacks automatically challenge hote hain.
2. **WAF Rate Limiting rule**: Security → WAF → Rate limiting rules:
   - Expression: `(http.request.uri.path contains "/api/")`
   - Action: Block, Duration 1 min, Requests: 100/min per IP.
   (Free plan: 1 rule available — ye wahi lo.)
3. **Security Level**: Security → Settings → "Medium" ya "High".
4. **Under Attack Mode** (sirf jab active attack ho): gives JS challenge to
   all visitors; attack settle hone par wapas Medium.
5. **API keys rotate** (recommended): agar `GEMINI_API_KEY`/`GROQ_API_KEY`/
   `DEEPSEEK_API_KEY` ka use kabhi bhi suspicious laga ho — Cloudflare
   dashboard → Pages → Settings → Environment variables → rotate. Provider
   consoles se purane keys revoke karein.
6. **KV access audit**: Dashboard → Workers & Pages → KV → `CONTACT` /
   `SUBSCRIBERS` namespaces sirf is Pages project se bound hain — koi public
   read route nahi hai (verified: koi GET endpoint exist nahi karta).
7. **Turnstile (optional, strongest)**: contact form par Cloudflare Turnstile
   (free CAPTCHA alternative) lagaya ja sakta hai — future enhancement.

## Files changed

```
_assetsignore                      NEW  — internal files deploy se exclude
_headers                           MOD  — CSP + full security header suite
functions/_middleware.js           MOD  — probe blocking, API rate limit, API headers
functions/api/contact.js           MOD  — rate limit + origin check + body cap
functions/api/subscribe.js         MOD  — rate limit + origin check + source sanitize + honeypot
functions/api/gemini.js            MOD  — 30/min limit + body cap + origin enforcement
backend/server.py                  MOD  — CORS fix, rate limit, error redaction
frontend/server.js                 MOD  — traversal fix, blocklist, headers
scripts/test-security-hardening.mjs NEW — 41-assertion security regression test
scripts/test-gemini-fallback.mjs   MOD  — updated for 30/min limit
package.json                       MOD  — security test in suite
.gitignore                         MOD  — subscribers PII never committed
```
