/**
 * AIToolsNova - Enhancements
 * Traffic Booster Package: Newsletter, Social Share, Trending, Related, Free Prompts
 * Auto-detects page type and injects relevant UI.
 */
(function () {
  "use strict";

  const path = location.pathname.replace(/\/+$/, "") || "/";
  // Cloudflare Pages serves extensionless URLs (/blog/slug, /tools/ai-chat).
  // Also accept .html for local previews.
  const isHome = path === "/" || path.endsWith("/index") || path.endsWith("/index.html");
  const isBlogList = /\/blogs(\.html)?$/.test(path);
  const isToolsHub = /\/tools(\.html)?$/.test(path);
  const isBlog = path.includes("/blog/") && !isBlogList;
  const isTool = path.includes("/tools/") && !isToolsHub;

  const BASE = path.includes("/blog/") || path.includes("/tools/") ? "../" : "";

  // ---------- Related Content Data ----------
  const RELATED_TOOLS = [
    { name: "AI Image Generator", url: "ai-image-generator", icon: "🎨", desc: "Text to image AI" },
    { name: "AI Chat", url: "ai-chat", icon: "💬", desc: "Chat with AI assistant" },
    { name: "AI Writer", url: "ai-writer", icon: "✍️", desc: "Generate articles" },
    { name: "Email Generator", url: "email-generator", icon: "📧", desc: "Professional emails" },
    { name: "Resume Builder", url: "resume-builder", icon: "📄", desc: "AI resume maker" },
    { name: "Image Compressor", url: "image-compressor", icon: "🖼️", desc: "Compress images" },
    { name: "Image Resizer", url: "image-resizer", icon: "📐", desc: "Resize photos" },
    { name: "PDF Merger", url: "pdf-merger", icon: "📚", desc: "Merge PDFs" },
    { name: "QR Generator", url: "qr-generator", icon: "📱", desc: "Create QR codes" },
    { name: "Password Generator", url: "password-generator", icon: "🔐", desc: "Secure passwords" },
    { name: "Keyword Density", url: "keyword-density", icon: "📊", desc: "SEO analysis" },
    { name: "Background Remover", url: "background-remover", icon: "✂️", desc: "Remove BG" }
  ];

  const RELATED_BLOGS = [
    { title: "Best Free AI Tools in 2026", url: "best-free-ai-tools-2026" },
    { title: "ChatGPT Alternatives You Must Try", url: "chatgpt-alternatives" },
    { title: "Top 100 AI Tools 2026", url: "top-100-ai-tools-2026" },
    { title: "How to Make Money with AI", url: "how-to-make-money-ai-tools" },
    { title: "AI Tools for Bloggers", url: "ai-writing-tools-bloggers" },
    { title: "AI Productivity Tools", url: "ai-productivity-tools" },
    { title: "AI Tools for Students", url: "ai-tools-for-students" },
    { title: "Complete SEO Guide", url: "seo-guide" }
  ];

  const TRENDING_TOOLS = [
    { name: "AI Image Generator", url: "tools/ai-image-generator", icon: "🎨", tag: "🆕 New", desc: "Text-to-image AI. Free, unlimited, no watermark" },
    { name: "AI Chat", url: "tools/ai-chat", icon: "💬", tag: "🔥 Hot", desc: "Free AI chatbot powered by Gemini" },
    { name: "Resume Builder", url: "tools/resume-builder", icon: "📄", tag: "🔥 Hot", desc: "Build professional resume with AI" },
    { name: "Background Remover", url: "tools/background-remover", icon: "✂️", tag: "⚡ Fast", desc: "Remove image backgrounds instantly" },
    { name: "PDF Converter", url: "tools/pdf-converter", icon: "📚", tag: "🔥 Hot", desc: "Convert PDF to any format" }
  ];

  // ---------- Inject Styles ----------
  const style = document.createElement("style");
  style.textContent = `
    .atn-fade-in { animation: atnFadeIn .5s ease }
    @keyframes atnFadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }

    /* Newsletter */
    .atn-newsletter { max-width:720px; margin:40px auto; padding:32px 28px; background:linear-gradient(135deg,#4F46E5 0%,#06B6D4 100%); color:#fff; border-radius:20px; text-align:center; box-shadow:0 20px 40px rgba(79,70,229,.25) }
    .atn-newsletter h3 { font-size:1.6rem; font-weight:800; margin-bottom:8px }
    .atn-newsletter p { opacity:.92; margin-bottom:20px; font-size:.98rem }
    .atn-nl-form { display:flex; gap:10px; max-width:480px; margin:0 auto; flex-wrap:wrap }
    .atn-nl-form input { flex:1; min-width:220px; padding:14px 18px; border:none; border-radius:50px; font-size:1rem; outline:none; color:#0F172A }
    .atn-nl-form button { padding:14px 28px; border:none; border-radius:50px; background:#0F172A; color:#fff; font-weight:700; cursor:pointer; transition:transform .2s; font-size:.95rem }
    .atn-nl-form button:hover { transform:translateY(-2px); background:#020617 }
    .atn-nl-msg { margin-top:12px; font-size:.9rem; min-height:20px }

    /* Social Share Sticky */
    .atn-share-bar { position:fixed; left:20px; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; gap:10px; z-index:900 }
    .atn-share-bar a { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:#fff; color:#4F46E5; box-shadow:0 4px 12px rgba(0,0,0,.12); text-decoration:none; font-size:1.15rem; transition:all .2s; border:1px solid #E2E8F0 }
    .atn-share-bar a:hover { transform:scale(1.12); background:#4F46E5; color:#fff }
    .atn-share-bar .atn-share-label { font-size:.7rem; text-align:center; color:#64748B; margin-bottom:2px; font-weight:600; letter-spacing:.5px }
    @media(max-width:900px){ .atn-share-bar{position:static;transform:none;flex-direction:row;justify-content:center;margin:20px auto;padding:12px;background:#F8FAFC;border-radius:14px;max-width:340px} .atn-share-bar .atn-share-label{display:none} }

    /* Related grid */
    .atn-related { max-width:900px; margin:36px auto; padding:0 16px }
    .atn-related h3 { font-size:1.4rem; font-weight:800; margin-bottom:16px; color:#0F172A }
    .atn-related-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px }
    .atn-related-card { background:#fff; border:1px solid #E2E8F0; border-radius:14px; padding:16px 18px; text-decoration:none; color:#0F172A; transition:all .2s; display:block }
    .atn-related-card:hover { transform:translateY(-3px); box-shadow:0 10px 24px rgba(79,70,229,.12); border-color:#4F46E5 }
    .atn-related-card .atn-rc-icon { font-size:1.6rem; margin-bottom:6px; display:block }
    .atn-related-card .atn-rc-title { font-weight:700; font-size:.98rem; margin-bottom:2px }
    .atn-related-card .atn-rc-desc { font-size:.82rem; color:#64748B }

    /* Trending Section (home) */
    .atn-trending { max-width:1280px; width:92%; margin:60px auto; padding:0 8px }
    .atn-trending-title { text-align:center; margin-bottom:32px }
    .atn-trending-title h2 { font-size:clamp(1.6rem,3.5vw,2.4rem); font-weight:800; color:#0F172A; margin-bottom:8px }
    .atn-trending-title p { color:#64748B }
    .atn-trending-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:18px }
    .atn-trending-card { background:#fff; border:1px solid #E2E8F0; border-radius:18px; padding:22px; text-decoration:none; color:#0F172A; transition:all .25s; position:relative; overflow:hidden }
    .atn-trending-card:hover { transform:translateY(-4px); box-shadow:0 18px 40px rgba(79,70,229,.15); border-color:#4F46E5 }
    .atn-trending-card::before { content:""; position:absolute; top:0; left:0; right:0; height:4px; background:linear-gradient(90deg,#4F46E5,#06B6D4) }
    .atn-trending-tag { display:inline-block; padding:3px 10px; background:#FEF3C7; color:#92400E; font-size:.72rem; font-weight:700; border-radius:50px; margin-bottom:10px }
    .atn-trending-card .atn-tc-icon { font-size:2rem; margin-bottom:10px; display:block }
    .atn-trending-card .atn-tc-name { font-weight:800; font-size:1.15rem; margin-bottom:4px }
    .atn-trending-card .atn-tc-desc { font-size:.9rem; color:#64748B; margin-bottom:10px }
    .atn-trending-card .atn-tc-cta { color:#4F46E5; font-weight:700; font-size:.88rem }

    /* Free Prompts Banner */
    .atn-freebie { max-width:900px; margin:30px auto; padding:24px 28px; background:#0F172A; color:#fff; border-radius:18px; display:flex; gap:20px; align-items:center; flex-wrap:wrap; justify-content:space-between }
    .atn-freebie h4 { font-size:1.2rem; font-weight:800; margin-bottom:6px }
    .atn-freebie p { color:#CBD5E1; font-size:.92rem }
    .atn-freebie a { display:inline-block; padding:12px 24px; background:linear-gradient(135deg,#4F46E5,#06B6D4); color:#fff; text-decoration:none; border-radius:50px; font-weight:700; font-size:.9rem; white-space:nowrap; transition:transform .2s }
    .atn-freebie a:hover { transform:translateY(-2px) }

    body.dark .atn-related-card { background:#0F172A; border-color:#1E293B; color:#F1F5F9 }
    body.dark .atn-related-card .atn-rc-desc { color:#94A3B8 }
    body.dark .atn-trending-card { background:#0F172A; border-color:#1E293B; color:#F1F5F9 }
    body.dark .atn-trending-card .atn-tc-desc { color:#94A3B8 }
    body.dark .atn-trending-title h2 { color:#F1F5F9 }
    body.dark .atn-related h3 { color:#F1F5F9 }
    body.dark .atn-share-bar a { background:#0F172A; color:#F1F5F9; border-color:#1E293B }
  `;
  document.head.appendChild(style);

  // ---------- Helper: Insert HTML at footer or end of article ----------
  function insertBeforeFooter(node) {
    const footer = document.querySelector("footer, .footer");
    if (footer && footer.parentNode) {
      footer.parentNode.insertBefore(node, footer);
    } else {
      document.body.appendChild(node);
    }
  }

  function insertAfterElement(selector, node) {
    const el = document.querySelector(selector);
    if (el) el.after(node);
    else insertBeforeFooter(node);
  }

  // ---------- Newsletter (all pages except tool pages to keep them focused) ----------
  function buildNewsletter() {
    const div = document.createElement("section");
    div.className = "atn-newsletter atn-fade-in";
    div.setAttribute("aria-label", "Newsletter Signup");
    div.innerHTML = `
      <h3>📬 Get Weekly AI Tool Updates</h3>
      <p>Get fresh AI tool roundups, practical tips and new free utilities — straight to your inbox. Unsubscribe anytime.</p>
      <form class="atn-nl-form" id="atnNlForm" novalidate>
        <input type="email" id="atnNlEmail" placeholder="your@email.com" required aria-label="Your email" />
        <button type="submit">Subscribe Free</button>
      </form>
      <div class="atn-nl-msg" id="atnNlMsg"></div>
    `;
    insertBeforeFooter(div);

    const form = div.querySelector("#atnNlForm");
    const msg = div.querySelector("#atnNlMsg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = div.querySelector("#atnNlEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = "⚠️ Please enter a valid email address.";
        msg.style.color = "#FEE2E2";
        return;
      }
      msg.textContent = "⏳ Subscribing...";
      msg.style.color = "#fff";
      try {
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, source: location.pathname })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          msg.textContent = "✅ Subscribed! Check your inbox for confirmation.";
          form.reset();
        } else {
          msg.textContent = data.detail || "⚠️ Could not subscribe. Try again.";
        }
      } catch (err) {
        msg.textContent = "✅ Thanks! You're on the list.";
        form.reset();
      }
    });
  }

  // ---------- Social Share (blogs only) ----------
  function buildShareBar() {
    const url = encodeURIComponent(location.href);
    const title = encodeURIComponent(document.title);
    const bar = document.createElement("aside");
    bar.className = "atn-share-bar";
    bar.setAttribute("aria-label", "Share this article");
    bar.innerHTML = `
      <div class="atn-share-label">SHARE</div>
      <a href="https://api.whatsapp.com/send?text=${title}%20${url}" target="_blank" rel="noopener" title="WhatsApp" aria-label="Share on WhatsApp">💚</a>
      <a href="https://twitter.com/intent/tweet?url=${url}&text=${title}" target="_blank" rel="noopener" title="Twitter/X" aria-label="Share on Twitter">𝕏</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${url}" target="_blank" rel="noopener" title="Facebook" aria-label="Share on Facebook">f</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url=${url}" target="_blank" rel="noopener" title="LinkedIn" aria-label="Share on LinkedIn">in</a>
      <a href="https://t.me/share/url?url=${url}&text=${title}" target="_blank" rel="noopener" title="Telegram" aria-label="Share on Telegram">✈️</a>
      <a href="#" id="atnCopyLink" title="Copy Link" aria-label="Copy Link">🔗</a>
    `;
    document.body.appendChild(bar);
    bar.querySelector("#atnCopyLink").addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(location.href).then(() => {
        const orig = e.currentTarget.textContent;
        e.currentTarget.textContent = "✅";
        setTimeout(() => { e.currentTarget.textContent = orig; }, 1400);
      });
    });
  }

  // ---------- Related Tools / Blogs ----------
  function buildRelated() {
    const isToolPage = isTool;
    const isBlogPage = isBlog;
    if (!isToolPage && !isBlogPage) return;

    // Random shuffle helper
    const pick = (arr, n, exclude) => arr.filter(x => !exclude || !x.url.includes(exclude))
      .sort(() => Math.random() - 0.5).slice(0, n);

    const currentSlug = path.split("/").pop().replace("", "");

    const section = document.createElement("section");
    section.className = "atn-related atn-fade-in";

    // Related tools
    const tools = pick(RELATED_TOOLS, 4, currentSlug);
    const toolsHtml = tools.map(t => `
      <a class="atn-related-card" href="${BASE}tools/${t.url}">
        <span class="atn-rc-icon">${t.icon}</span>
        <div class="atn-rc-title">${t.name}</div>
        <div class="atn-rc-desc">${t.desc}</div>
      </a>`).join("");

    // Related blogs
    const blogs = pick(RELATED_BLOGS, 4, currentSlug);
    const blogsHtml = blogs.map(b => `
      <a class="atn-related-card" href="${BASE}blog/${b.url}">
        <span class="atn-rc-icon">📖</span>
        <div class="atn-rc-title">${b.title}</div>
        <div class="atn-rc-desc">Read the guide →</div>
      </a>`).join("");

    section.innerHTML = `
      <h3>🛠️ You Might Also Like</h3>
      <div class="atn-related-grid">${toolsHtml}</div>
      <h3 style="margin-top:28px">📚 More From Our Blog</h3>
      <div class="atn-related-grid">${blogsHtml}</div>
    `;
    insertBeforeFooter(section);
  }

  // ---------- Free ChatGPT Prompts Banner (blogs only) ----------
  function buildFreebieBanner() {
    if (!isBlog && !isBlogList) return;
    const banner = document.createElement("section");
    banner.className = "atn-freebie atn-fade-in";
    banner.innerHTML = `
      <div style="flex:1; min-width:240px;">
        <h4>🎁 Free: 100 Powerful ChatGPT Prompts</h4>
        <p>Instant download. No signup needed. Boost productivity today.</p>
      </div>
      <a href="${BASE}free-chatgpt-prompts">Get Free PDF →</a>
    `;
    insertBeforeFooter(banner);
  }

  // ---------- Trending Tools (home only) ----------
  function buildTrending() {
    if (!isHome) return;
    const section = document.createElement("section");
    section.className = "atn-trending atn-fade-in";
    section.id = "trending-tools";
    // Reserve min-height to prevent CLS when content is injected
    section.style.minHeight = "420px";
    section.innerHTML = `
      <div class="atn-trending-title">
        <h2>🔥 Trending Tools This Week</h2>
        <p>The most-loved AI tools our community is using right now</p>
      </div>
      <div class="atn-trending-grid">
        ${TRENDING_TOOLS.map(t => `
          <a class="atn-trending-card" href="${t.url}">
            <span class="atn-trending-tag">${t.tag}</span>
            <span class="atn-tc-icon">${t.icon}</span>
            <div class="atn-tc-name">${t.name}</div>
            <div class="atn-tc-desc">${t.desc}</div>
            <div class="atn-tc-cta">Try Free →</div>
          </a>`).join("")}
      </div>
    `;
    // Insert BELOW-FOLD (before footer) to avoid above-the-fold layout shift
    insertBeforeFooter(section);
  }

  // ---------- Mid-article ad injection for blog posts ----------
  function buildMidArticleAd() {
    if (!isBlog) return;
    // Find the main article body
    const article = document.querySelector('article, .blog-content, main article, main .container');
    if (!article) return;
    // Skip if already injected
    if (article.querySelector('.atn-mid-ad')) return;
    // Get all <p> tags inside article
    const paragraphs = article.querySelectorAll(':scope > p, :scope .container > p, :scope section > p');
    if (paragraphs.length < 4) return;
    // Insert after the 3rd paragraph (~mid-article for average reading start)
    const insertAfter = paragraphs[Math.min(3, Math.floor(paragraphs.length / 2))];

    const adWrap = document.createElement('div');
    adWrap.className = 'atn-mid-ad';
    adWrap.setAttribute('aria-label', 'Advertisement');
    adWrap.style.cssText = 'margin:32px auto;padding:14px;max-width:728px;text-align:center;';
    adWrap.innerHTML = `
      <div style="color:#94A3B8;font-size:.68rem;letter-spacing:1px;margin-bottom:6px;">ADVERTISEMENT</div>
      <ins class="adsbygoogle"
           style="display:block;text-align:center;min-height:100px;"
           data-ad-client="ca-pub-2278101269918728"
           data-ad-slot="1700790558"
           data-ad-format="fluid"
           data-ad-layout="in-article"
           data-full-width-responsive="true"></ins>
    `;
    insertAfter.insertAdjacentElement('afterend', adWrap);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  }

  // ---------- Init (deferred to idle to avoid blocking main thread) ----------
  const isLegal = /\/(privacy-policy|terms-and-conditions|disclaimer|cookie-policy)(\.html)?$/.test(path)
    || /\/(404)(\.html)?$/.test(path);

  function initEnhancements() {
    try { if (!isTool && !isLegal) buildNewsletter(); } catch (e) {}
    try { if (isBlog) buildShareBar(); } catch (e) {}
    try { buildRelated(); } catch (e) {}
    try { buildFreebieBanner(); } catch (e) {}
    try { buildTrending(); } catch (e) {}
    try { buildMidArticleAd(); } catch (e) {}
  }
  function scheduleInit() {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(initEnhancements, { timeout: 2000 });
    } else {
      setTimeout(initEnhancements, 400);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", scheduleInit);
  } else {
    scheduleInit();
  }
})();
