# AIToolsNova — PRD / Working Memory

## Project
Static HTML site (`aitoolsnova.com`) — 100+ free AI/SEO/PDF/Image tools. Hosted on Cloudflare Pages.
Tech: plain HTML/CSS/JS, Cloudflare Pages Functions (`functions/api/*` = Gemini AI chat + subscribe),
GitHub Actions cron for daily auto-blog + daily auto web-story, Groq API for content, Pollinations for images.

NOTE: This Emergent workspace was a fresh React/FastAPI template. The real site was cloned in from
GitHub repo `aitoolsnova01/aitoolsnova` and overlaid into `/app`. Deploy via "Save to GitHub" → Cloudflare.

## Original problem statement (user, Hinglish)
Index all pages on Google/Bing/Cloudflare; web-stories HD images missing + not indexing; site unknown to Google;
autoblog lacks uniqueness + attractive/SEO/global-trending content; web-stories auto-upload; poor site speed;
favicon missing; make site AdSense-approval ready; do it within minimum credit; first audit then fix.

## Work done — Aug 14, 2026 (session 1)
- Fixed missing `favicon.ico` (404 on every page) + regenerated proper `apple-touch-icon.png` (180) and
  new square `images/publisher-logo.png` (512) via PIL (no AI credit).
- Localized ALL web-story images: downloaded 39 images (Pollinations + Unsplash) into `web-stories/img/`,
  rewrote all 6 stories to serve local HD images (fast, reliable, indexable). `web-stories.html` rebuilt.
- Fixed AMP Web Story `publisher-logo-src` from invalid `.ico` → valid square PNG (Google requirement).
- Added "Web Stories" nav links on homepage (desktop, mobile, quick-links, footer) for discoverability.
- Upgraded `scripts/generate-webstory.mjs`: future stories auto-download images locally + use PNG logo.
- Upgraded `scripts/generate-blog.mjs` prompts: hook, unique angle, power words, Quick Takeaways,
  benefit-driven H2s, 1600+ words, global/2026 trending tone (temp 0.6->0.78).
- Added `scripts/localize-webstory-images.mjs` (reusable), `scripts/make-icons.py`, `ACTION_PLAN.md`.
- Verified: 34 images valid, sitemap.xml well-formed (98 URLs), 0 remote hotlinks left in stories.

## Manual steps still required (user's own accounts — cannot be coded)
GSC Domain property + Cloudflare DNS TXT verify; submit sitemap; URL-inspect top 5; Bing "Import from GSC".
See ACTION_PLAN.md.

## Backlog / next
- P1: Localize blog hero images (currently still hotlinked from Pollinations in `generate-blog.mjs`).
- P2: Improve/rewrite top 5 existing blogs for uniqueness (AI cost — needs user OK).
- P2: Image sitemap for web-story images; Hindi web-story variant; social auto-share.
