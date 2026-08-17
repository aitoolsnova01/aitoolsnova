/**
 * AIToolsNova shared AI client
 * - Abort/timeout so hung calls don't freeze the UI
 * - Consistent error messages for global users
 * - Optional simple retry on 429/5xx
 */
(function (global) {
  'use strict';

  async function callAI(opts) {
    const {
      message,
      tool = 'chat',
      history = null,
      timeoutMs = 45000,
      retries = 1,
    } = opts || {};

    if (!message || !String(message).trim()) {
      throw new Error('Please enter a message first.');
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const body = { message: String(message), tool };
        if (history && history.length) body.history = history;

        const res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });

        const data = await res.json().catch(() => ({}));

        if (res.status === 429) {
          lastErr = new Error(data.error || 'Too many requests. Wait a minute and try again.');
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        if (!res.ok || data.error) {
          lastErr = new Error(data.error || ('AI error (' + res.status + ')'));
          if (res.status >= 500 && attempt < retries) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            continue;
          }
          throw lastErr;
        }
        if (!data.reply || !String(data.reply).trim()) {
          throw new Error('Empty AI response. Please try again.');
        }
        return { reply: String(data.reply).trim(), provider: data.provider || '' };
      } catch (e) {
        if (e && e.name === 'AbortError') {
          lastErr = new Error('Request timed out. Try a shorter prompt or retry.');
        } else {
          lastErr = e instanceof Error ? e : new Error(String(e));
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Network error');
  }

  function setBusy(btn, busy, labelBusy, labelIdle) {
    if (!btn) return;
    if (busy) {
      btn.dataset._label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = labelBusy || 'Working…';
    } else {
      btn.disabled = false;
      btn.innerHTML = labelIdle || btn.dataset._label || 'Generate';
    }
  }

  global.ATN = global.ATN || {};
  global.ATN.callAI = callAI;
  global.ATN.setBusy = setBusy;
})(typeof window !== 'undefined' ? window : globalThis);
