# Workflow improvements (apply manually)

The automation bot that produced this branch is **not allowed to edit files under
`.github/workflows/`** (GitHub blocks App tokens without the `workflows` scope),
so the improved workflow files are provided here as `.yml.txt` copies.

## What these fix

The current workflows mark the AI-generation step with `continue-on-error: true`.
When publishing fails, the step is only a soft warning and the **job still shows
GREEN** — so the Actions tab says "success" while no blog/story was published for
days. That is the "shows published but nothing happens" problem.

The replacements:

1. **Fail loudly** — remove `continue-on-error` from the generate step so a failed
   publish turns the run **red**.
2. **Open a GitHub issue** (`publish-failure` / `site-down` label) on failure, so an
   outage is impossible to miss.
3. **Health check retries** — transient edge/network blips no longer cause false
   red runs; only a real, repeated outage fails (and opens an issue).
4. Set `SITE_API_FALLBACK=1` explicitly so the keyless fallback (Cloudflare Workers
   AI binding via `/api/gemini`) is always available.

## How to apply (2 minutes)

> ⚠️ **STATUS (2026-08-31): ye step abhi bhi PENDING hai.** PR #29 (30 Aug) ne ye
> files banayi thi, par automation bot ko `.github/workflows/` edit karne ki
> GitHub permission nahi hoti, isliye asli workflows aaj bhi purane (silent-green)
> hain. **Sirf aap (repo owner) hi inhe GitHub web UI se apply kar sakte hain.**

In the GitHub **web UI** (browser — mobile se bhi ho jayega):

1. Repo kholo → `.github/workflows/daily-blog.yml` → pencil (**Edit**) icon.
2. Poora content delete karke `daily-blog.yml.txt` ka content paste karo → **Commit changes** (directly to `main`).
3. Wahi repeat karo: `daily-webstory.yml` ← `daily-webstory.yml.txt`, `health-check.yml` ← `health-check.yml.txt`.

Iske baad agar publish phir fail ho to run **RED** dikhega aur `publish-failure`
label ka issue apne-aap khul jayega — "green par kuch publish nahi hua" wala
silent-failure khatam.

No new secrets are required for the keyless path once the Cloudflare Workers AI
binding `AI` is added (see `SECURITY_BOT_AND_PUBLISH_FIX.md`, section 2C).
