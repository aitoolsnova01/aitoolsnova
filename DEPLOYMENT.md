# 🚀 AIToolsNova - Cloudflare Pages Deployment Guide

## ⚠️ VERY IMPORTANT — Yeh Read Karein

Aapke website me ab **12 tools AI-powered hain** — lekin ye AI features tabhi kaam karenge jab aap Cloudflare Pages pe **environment variables** set kar denge.

**Preview URL pe AI test nahi hoga** kyunki preview server sirf static files serve karta hai (`/api/gemini` sirf Cloudflare Pages pe kaam karta hai).

> **AI "Generate" not working on the live site? (quick fix)**
> 1. Cloudflare Pages dashboard → project → **Settings → Environment variables → Production** me `GEMINI_API_KEY` aur `GROQ_API_KEY` add karein.
> 2. Env vars save karne ke baad **Deployments → ⋯ → Retry deployment** zaroor karein — purani deployment ko nayi keys nahi milti.
> 3. Bina in dashboard keys ke `/api/gemini` har provider par fail karega; code me koi fallback/fake response nahi hai (by design).

---

## ✅ Step 1: GitHub pe Push Karein

Chat input ke **"Save to GitHub"** button ka use karein. Ye automatically GitHub par push kar dega, aur Cloudflare Pages **auto-deploy** ho jayega.

---

## ✅ Step 2: Cloudflare Pages Env Variables Set Karein

Cloudflare dashboard me jaayein → apna project select karein → **Settings → Environment variables → Production** → yeh 3 keys add karein:

### 🎯 Option A: Cloudflare Workers AI (FREE, Recommended)

| Variable Name | Value | Kaise milega? |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Aapka Cloudflare API token | [Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → Custom Token → Permissions: `Workers AI: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | Aapka Cloudflare Account ID | Right sidebar in your Cloudflare dashboard (long alphanumeric string) |
| `CLOUDFLARE_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | (optional, default already set) |

**Free tier**: 10,000 tokens/day free — enough for hundreds of AI generations.

### 🎯 Option B: Groq (Fallback, also FREE)

| Variable Name | Value | Kaise milega? |
|---|---|---|
| `GROQ_API_KEY` | Aapka Groq API key | https://console.groq.com/keys → **Create API Key** (free) |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | (optional, default already set) |

**Free tier**: 30 requests/minute, unlimited daily on free tier.

---

## ✅ Step 3: Redeploy

Env variables set karne ke baad **Cloudflare dashboard → Deployments → Retry deployment** click karein. AI features live ho jayenge.

---

## 🧪 Kaise Test Karein?

1. `https://aitoolsnova.com/tools/youtube-title.html` khole
2. "How to build a website" jaisa topic likhein
3. "Generate Titles" click karein
4. 5-10 seconds me AI-generated titles milenge ✅

---

## 🎨 AI-Powered Tools Ki List (12 tools)

| Tool | AI Feature |
|---|---|
| ✍️ AI Writer | AI-generated articles (already working) |
| 💬 AI Chat | AI chatbot (already working) |
| 📧 Email Generator | AI-written professional emails |
| 📄 Resume Builder | AI-written resume sections |
| 🎨 **AI Image Generator (NEW)** | Text-to-image (Pollinations, no key needed) |
| 🎬 YouTube Title Generator | AI viral titles (10 per click) |
| 📝 YouTube Description | AI SEO description with timestamps |
| 👍 Facebook Description | AI engaging FB posts |
| 📸 Instagram Caption | AI captions + 20-25 smart hashtags |
| 🔍 Hashtag Generator | AI hashtags (high/med/low volume mix) |
| 🏷️ Meta Tag Generator | AI SEO meta tags (auto-fill description + keywords) |
| 📊 Keyword Density | AI LSI keyword suggestions + SEO tips |
| 🗺️ Sitemap Generator | AI URL suggestions button |
| 🤖 Robots.txt Generator | AI recommendation (blocks GPTBot, ClaudeBot, etc.) |

---

## 💡 Fallback Behavior

Agar `/api/gemini` fail hota hai (env vars missing ya rate limit hit), tools user-friendly error dikha denge — aur YouTube Title generator me template-based fallback bhi hai. Site kabhi bhi break nahi hogi.

---

## ❓ Troubleshoot

**Q: AI response nahi aa raha?**
- Check karein Cloudflare Pages → Deployments → Latest → **Functions logs** — kya error aa raha hai
- Env variables sahi hain? (dashboard me case-sensitive check karein)
- Retry deployment karein env set karne ke baad

**Q: "Server error 500"?**
- Groq API key expired ho sakti hai — dashboard se new key generate karein

**Q: Rate limit hit?**
- Cloudflare Workers AI ya Groq ka free tier exceed hua ho sakta hai. Wait 1 min ya paid plan pe upgrade karein.

---
**Deploy successful ho gaya toh mujhe batayein — main aur bhi enhancements suggest karta hoon!** 🚀
