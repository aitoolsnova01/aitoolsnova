/**
 * AIToolsNova - Shared AI Helper
 * Calls /api/gemini (Cloudflare Pages Function -> Cloudflare Workers AI + Groq fallback)
 * Loaded by AI-powered tools: YouTube Title, FB Description, Instagram Caption,
 * Hashtag Generator, Meta Tag Generator, Robots.txt, Sitemap, Keyword Density, etc.
 */
(function (global) {
  "use strict";

  const AI_ENDPOINT = "/api/gemini";
  const TIMEOUT_MS = 45000;

  async function callAI(prompt, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_MS);
    try {
      const res = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        return { ok: false, error: data.error || `Server error (${res.status})` };
      }
      return { ok: true, reply: (data.reply || "").trim() };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") return { ok: false, error: "Request timed out. Please try again." };
      return { ok: false, error: "Network error. Please check your connection." };
    }
  }

  /**
   * generate(prompt, outputEl, opts)
   * - Shows loading, writes reply to outputEl (or opts.onSuccess)
   * - Optional: opts.button (disables during load), opts.showBox (adds .show class)
   */
  async function generate(prompt, outputEl, opts = {}) {
    const btn = opts.button;
    const box = opts.showBox;
    const originalBtnText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Generating..."; }
    if (outputEl) outputEl.textContent = "⏳ AI is thinking...";
    if (box) box.classList.add("show");

    const r = await callAI(prompt);

    if (btn) { btn.disabled = false; btn.textContent = originalBtnText; }
    if (!r.ok) {
      if (outputEl) outputEl.textContent = "❌ " + r.error;
      if (opts.onError) opts.onError(r.error);
      return { ok: false, error: r.error };
    }
    if (outputEl) outputEl.textContent = r.reply;
    if (opts.onSuccess) opts.onSuccess(r.reply);
    return { ok: true, reply: r.reply };
  }

  global.AITools = { callAI, generate };
})(window);
