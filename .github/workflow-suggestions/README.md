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

In the GitHub web UI (or locally with an account that has `workflows` permission):

1. Open `.github/workflows/daily-blog.yml` on `main`, click **Edit**.
2. Replace its full contents with the contents of `daily-blog.yml.txt` here.
3. Commit. Repeat for `daily-webstory.yml` ← `daily-webstory.yml.txt` and
   `health-check.yml` ← `health-check.yml.txt`.

No new secrets are required for the keyless path once the Cloudflare Workers AI
binding `AI` is added (see `SECURITY_BOT_AND_PUBLISH_FIX.md`, section 2C).
