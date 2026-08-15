# Google Indexing API — Auto-submit ALL pages to Google

Isse aapki poori site (sitemap ke saare URLs) Google ko automatically submit hoti hai.
Script: `scripts/google-index-all.mjs` (dependency-free).

## One-time setup (~10 min, sirf aap kar sakte ho)

1. **GSC verify pehle zaroori** — `aitoolsnova.com` ko Google Search Console me
   Domain property se verify kar lo (Cloudflare DNS TXT). Iske bina Indexing API kaam nahi karega.

2. **Google Cloud service account banao:**
   - https://console.cloud.google.com → naya project (ya koi bhi) select karo
   - "APIs & Services" → "Enable APIs" → search **"Indexing API"** → Enable
   - "Credentials" → Create Credentials → **Service account** → naam do → Create
   - Us service account me → "Keys" → Add Key → **JSON** → download (ek .json file milegi)
   - Us JSON me `client_email` hoga, jaise `xxx@yyy.iam.gserviceaccount.com`

3. **Service account ko GSC me owner banao:**
   - Search Console → Settings → Users and permissions → Add user
   - Wahi `client_email` paste karo → role **Owner** → Add

## Run karna

Local ya kisi bhi machine par:
```bash
GOOGLE_SERVICE_ACCOUNT_JSON='<poora json paste karo>' node scripts/google-index-all.mjs
```

Ya file se:
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/google-index-all.mjs
```

## GitHub par automatic (rozana) chalane ke liye
1. GitHub repo → Settings → Secrets and variables → Actions → New secret
   - Name: `GOOGLE_SERVICE_ACCOUNT_JSON`  Value: poora JSON
2. Workflow `.github/workflows/google-index.yml` add ho chuka hai — wo secret milte hi rozana chalega.

## Zaroori baatein (honest)
- Google ki daily limit ~**200 URL/din** hai. Aapke paas ~98 URL hain, to ek hi run me ho jayega.
- IndexNow (Bing/Yandex) to already automatic hai — ye sirf **Google** ke liye extra push hai.
- Indexing API "request" hai, guarantee nahi — asli backbone sitemap + GSC hi rehta hai.
