# Unique Content Strategy — AIToolsNova

This document describes the editorial + technical strategy that makes AIToolsNova's
auto-published blogs and web stories **harder to copy, lower-competition, and genuinely
useful** instead of generic AI spam. It is the spec behind the changes in
`scripts/generate-blog.mjs` and `scripts/generate-webstory.mjs`.

---

## 1. The core idea: a `unique_angle` drives every article

Every post now starts from a **single, under-covered angle** rather than a broad
keyword. The topic generator returns a `unique_angle` field (a one-line punchy
sentence) that is injected into the content prompt and **must drive the whole
article**. This prevents near-identical "10 best AI tools" clones and pushes the
model to commit to a specific, testable point of view.

Example angles:
- "Tested 5 free Hindi AI tools on a ₹7,000 phone, ranked by real offline usefulness."
- "Ran the same resume through 4 free builders — only one passed an ATS scan."
- "WhatsApp Business auto-reply with zero paid software: setup that actually replies."

If the model omits `unique_angle`, the generator falls back to
`A fresh, hands-on take on <title>` so the field is never empty downstream.

---

## 2. Blog format: longer, deeper, opinionated

| Property | Old | New |
| --- | --- | --- |
| Target length | ~1200–1600 words | **1900–2400 words** |
| Publish gate (hard floor) | 1000 words | **1500 words** |
| H2 sections | 6 | **7** (must include the three below) |
| Expansion trigger | `< 1000` words | `< 1500` words (expands toward ~2000) |
| Content `max_tokens` | 4500 | **6500** |
| Expansion `max_tokens` | 3000 | **4200** |
| DeepSeek provider cap | 6000 | **8000** |

### Required 7-section structure
The 7 H2 sections must include, at minimum:
1. A **hands-on walkthrough** with real numbers, step sequences, and named tools
   (screenshots/descriptions of what was actually tried).
2. An honest **"Downsides / when it's NOT worth it"** section — we say when the
   tool is the wrong choice.
3. A **"Comparison verdict"** section that picks a clear winner rather than
   hedging.

The remaining sections cover setup, alternatives, and use-case-specific detail.
FAQs stay at 5 (question phrasing a real person would type).

### Why these numbers
- 1900–2400 words gives Google enough substance to rank for long-tail intent
  without padding.
- The 1500-word publish gate guarantees we never ship a thin post (the old 1000
  gate still let weak drafts through after expansion).
- Bigger `max_tokens` (6500 content / 4200 expansion / 8000 DeepSeek cap) give the
  model room to actually hit the word target instead of truncating mid-article.

---

## 3. Web stories: richer captions

| Property | Old | New |
| --- | --- | --- |
| Caption length | 18–30 words (2–3 lines) | **30–45 words (2–4 lines)** |
| DeepSeek `max_tokens` | 1800 | **2600** |
| Groq fallback `max_tokens` | 1800 | **2600** |

Longer captions let each slide tell a mini-story (a tip + a reason + a tiny
caution) instead of a one-liner, which improves watch-time and ad-eligible
engagement on Google Web Stories.

---

## 4. The 15 low-competition niches

These were added to the `NICHES` pool in `generate-blog.mjs`. They target
audiences and intents that bigger AI blogs ignore — regional, vernacular,
offline, and "real job / real business" use cases:

1. AI tools in regional Indian languages (Hindi, Tamil, Telugu, Bengali)
2. AI for WhatsApp Business automation and catalogs
3. AI tools for government exam (UPSC, SSC, banking) prep
4. AI for local trades and small shops (plumbers, electricians, salons)
5. AI tools for gig workers (delivery, ride-share, freelancing)
6. AI tools for Indian farmers (crop, weather, mandi prices)
7. Offline AI tools that need no signup or account
8. Free vs paid AI tools: honest head-to-head comparisons
9. AI for regional language voice content (Marathi, Kannada, Gujarati)
10. AI auto-reply for WhatsApp Business in India
11. AI study planners for competitive exams and scholarships
12. AI for street vendors and kirana store billing/inventory
13. AI resume builders for freshers in tier-2/3 Indian cities
14. AI tools for truck drivers, cab drivers and logistics helpers
15. Best no-internet AI tools for low-data smartphone users

These pair naturally with the `unique_angle` field: a niche like #6 (farmers)
almost demands a specific, testable angle ("checked 3 mandi-price bots during
kharif sowing") which is exactly the kind of content that ranks with little
competition.

---

## 5. Operational notes

- The blog/web-story writers run **DeepSeek-first** (`deepseek,gemini,groq`), with
  Gemini and Groq as automatic fallbacks. Override order with
  `AI_PROVIDER_ORDER`.
- Images still generate via Gemini image models with a Pollinations fallback.
- Publishing is gated at write time: any post under the word floor is deleted
  from disk and the run fails loudly rather than shipping thin content.
- Do **not** edit `.github/workflows/*` from a token without `workflows`
  permission — the push will be rejected. Schedule/cron changes must go through
  the GitHub web UI or a user PAT.
