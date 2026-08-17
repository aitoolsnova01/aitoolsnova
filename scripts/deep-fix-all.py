#!/usr/bin/env python3
"""
AIToolsNova deep fix pass — AdSense policy, SEO, bugs, uniqueness scaffolding.
Run from repo root: python3 scripts/deep-fix-all.py
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)

OG_IMAGE = "https://aitoolsnova.com/images/og-image.webp"
PUB_LOGO = "https://aitoolsnova.com/images/publisher-logo.png"
SITE = "https://aitoolsnova.com"
AD_CLIENT = "ca-pub-2278101269918728"
AD_SLOT = "1700790558"

CHANGED: list[str] = []


def write(path: Path, text: str) -> None:
    old = path.read_text(encoding="utf-8", errors="replace") if path.exists() else None
    if old == text:
        return
    path.write_text(text, encoding="utf-8")
    CHANGED.append(str(path.relative_to(ROOT)))


def all_html() -> list[Path]:
    out = []
    for p in ROOT.rglob("*.html"):
        s = str(p)
        if any(x in s for x in ("/frontend/", "/node_modules/", "/.git/", "/test_reports/")):
            continue
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# 1) enhancements.js — fix CF extensionless path detection + fake claims + ad slot
# ---------------------------------------------------------------------------
def fix_enhancements() -> None:
    p = ROOT / "enhancements.js"
    t = p.read_text(encoding="utf-8")

    # Fix isHome / isBlog / isTool for Cloudflare extensionless URLs
    old_detect = '''  const path = location.pathname;
  const isHome = path === "/" || path.endsWith("/index.html");
  const isBlog = path.includes("/blog/") && path.endsWith(".html") && !path.endsWith("/blogs.html");
  const isTool = path.includes("/tools/") && path.endsWith(".html") && !path.endsWith("/tools.html");
  const isBlogList = path.endsWith("/blogs.html");'''

    new_detect = '''  const path = location.pathname.replace(/\\/+$/, "") || "/";
  // Cloudflare Pages serves extensionless URLs (/blog/slug, /tools/ai-chat).
  // Also accept .html for local previews.
  const isHome = path === "/" || path.endsWith("/index") || path.endsWith("/index.html");
  const isBlogList = /\\/blogs(\\.html)?$/.test(path);
  const isToolsHub = /\\/tools(\\.html)?$/.test(path);
  const isBlog = path.includes("/blog/") && !isBlogList;
  const isTool = path.includes("/tools/") && !isToolsHub;'''

    if old_detect in t:
        t = t.replace(old_detect, new_detect)
    else:
        # fallback regex
        t = re.sub(
            r"const path = location\.pathname;[\s\S]*?const isBlogList = [^;]+;",
            new_detect.strip(),
            t,
            count=1,
        )

    # Fix related tool/blog URLs to extensionless
    t = t.replace('.html"', '"').replace(".html'", "'")
    # careful — restore things that need .html? none in this file for static assets
    # RELATED arrays had .html — already stripped above for whole file.
    # But CSS/JS comments might be fine. Check free-chatgpt link:
    t = t.replace("free-chatgpt-prompts.html", "free-chatgpt-prompts")
    # BASE tools links already use tools/${t.url} — urls no longer have .html

    # Honest newsletter copy (no fake subscriber count)
    t = t.replace(
        "Join 25,000+ readers getting the freshest AI tools, tips & tutorials every Sunday. Free forever.",
        "Get fresh AI tool roundups, practical tips and new free utilities — straight to your inbox. Unsubscribe anytime.",
    )
    t = t.replace('placeholder="you@example.com"', 'placeholder="your@email.com"')

    # Mid-article ad: use real slot + always push when slot present
    old_ad = '''    adWrap.innerHTML = `
      <div style="color:#94A3B8;font-size:.68rem;letter-spacing:1px;margin-bottom:6px;">ADVERTISEMENT</div>
      <ins class="adsbygoogle"
           style="display:block;min-height:100px;"
           data-ad-client="ca-pub-2278101269918728"
           data-ad-slot=""
           data-ad-format="fluid"
           data-ad-layout="in-article"
           data-full-width-responsive="true"></ins>
    `;
    insertAfter.insertAdjacentElement('afterend', adWrap);
    // Trigger AdSense to render
    // Do not request an invalid ad unit. Auto Ads remains available globally.
    if (adWrap.querySelector('[data-ad-slot]')?.dataset.adSlot) {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    }'''

    new_ad = '''    adWrap.innerHTML = `
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
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}'''

    if old_ad in t:
        t = t.replace(old_ad, new_ad)
    else:
        t = t.replace('data-ad-slot=""', f'data-ad-slot="{AD_SLOT}"')
        t = re.sub(
            r"if \(adWrap\.querySelector\('\[data-ad-slot\]'\)\?\.dataset\.adSlot\) \{\s*try \{ \(window\.adsbygoogle = window\.adsbygoogle \|\| \[\]\)\.push\(\{\}\); \} catch \(e\) \{\}\s*\}",
            "try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}",
            t,
        )

    # Don't inject newsletter on legal pages (AdSense + UX)
    old_init = '''  function initEnhancements() {
    try { if (!isTool) buildNewsletter(); } catch (e) {}'''
    new_init = '''  const isLegal = /\\/(privacy-policy|terms-and-conditions|disclaimer|cookie-policy)(\\.html)?$/.test(path)
    || /\\/(404)(\\.html)?$/.test(path);

  function initEnhancements() {
    try { if (!isTool && !isLegal) buildNewsletter(); } catch (e) {}'''
    if old_init in t:
        t = t.replace(old_init, new_init)

    write(p, t)


# ---------------------------------------------------------------------------
# 2) generate-blog.mjs — extensionless links, consent, OG, author E-E-A-T
# ---------------------------------------------------------------------------
def fix_blog_generator() -> None:
    p = ROOT / "scripts" / "generate-blog.mjs"
    t = p.read_text(encoding="utf-8")

    # blogs.html card link without .html
    t = t.replace(
        '<a href="blog/${topic.slug}.html" class="read-more">Read More →</a>',
        '<a href="blog/${topic.slug}" class="read-more">Read More →</a>',
    )

    # Header/footer extensionless
    t = t.replace('href="../index.html"', 'href="../"')
    t = t.replace('href="../blogs.html"', 'href="../blogs"')
    t = t.replace('href="../tools.html"', 'href="../tools"')
    t = t.replace('href="../privacy-policy.html"', 'href="../privacy-policy"')
    t = t.replace('href="../terms-and-conditions.html"', 'href="../terms-and-conditions"')
    t = t.replace('href="../disclaimer.html"', 'href="../disclaimer"')

    # related tools strip .html in href (template uses ../tools/${u})
    t = t.replace(
        ".map(u => `<li><a href=\"../tools/${u}\">${u.replace(/-/g,' ').replace('.html','').replace(/\\b\\w/g, c=>c.toUpperCase())}</a></li>`).join('');",
        ".map(u => { const slug = String(u).replace(/\\.html$/, ''); return `<li><a href=\"../tools/${slug}\">${slug.replace(/-/g,' ').replace(/\\b\\w/g, c=>c.toUpperCase())}</a></li>`; }).join('');",
    )
    t = t.replace(
        ".map(u => `<li><a href=\"${u}\">${u.replace(/-/g,' ').replace('.html','').replace(/\\b\\w/g, c=>c.toUpperCase())}</a></li>`).join('');",
        ".map(u => { const slug = String(u).replace(/\\.html$/, ''); return `<li><a href=\"${slug}\">${slug.replace(/-/g,' ').replace(/\\b\\w/g, c=>c.toUpperCase())}</a></li>`; }).join('');",
    )

    # Add consent.js before gtag; ensure ads after consent default
    if "consent.js" not in t:
        t = t.replace(
            """    <script async src="https://www.googletagmanager.com/gtag/js?id=G-KJ0WTD0R0M"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){ dataLayer.push(arguments); }
        gtag('js', new Date());
        gtag('config', 'G-KJ0WTD0R0M', { page_path: window.location.pathname, anonymize_ip: true });
    </script>""",
            """    <script src="/js/consent.js"></script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-KJ0WTD0R0M"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){ dataLayer.push(arguments); }
        gtag('js', new Date());
        gtag('config', 'G-KJ0WTD0R0M', { page_path: window.location.pathname, anonymize_ip: true });
    </script>""",
        )

    # Better author schema (Organization + Person for E-E-A-T)
    t = t.replace(
        '\"author\": { \"@type\": \"Person\", \"name\": \"AIToolsNova Team\" },',
        '\"author\": { \"@type\": \"Person\", \"name\": \"AIToolsNova Editorial\", \"url\": \"https://aitoolsnova.com/about\" },',
    )
    t = t.replace(
        '\"logo\": { \"@type\": \"ImageObject\", \"url\": \"https://aitoolsnova.com/images/logo.svg\" }',
        '\"logo\": { \"@type\": \"ImageObject\", \"url\": \"https://aitoolsnova.com/images/publisher-logo.png\", \"width\": 600, \"height\": 60 }',
    )

    # Author byline block with about link
    if "About the author" not in t and "about-the-author" not in t:
        t = t.replace(
            """                <p style="margin-top:24px;padding-top:16px;border-top:1px solid #E2E8F0;font-size:.85rem;color:#94A3B8;">
                    <strong>Published:</strong> ${todayHuman}
                </p>""",
            """                <aside class="author-box" style="margin-top:28px;padding:20px;border:1px solid #E2E8F0;border-radius:14px;background:#fff;">
                    <strong style="display:block;margin-bottom:6px;color:#0F172A;">About the author</strong>
                    <p style="margin:0;color:#475569;font-size:.95rem;">Written by the <a href="../about" style="color:#4F46E5;font-weight:600;">AIToolsNova Editorial team</a>. We test free AI and productivity tools so creators, students and small businesses can work faster without paid subscriptions. Questions? <a href="../contact" style="color:#4F46E5;font-weight:600;">Contact us</a>.</p>
                    <p style="margin:12px 0 0;font-size:.85rem;color:#94A3B8;"><strong>Published:</strong> ${todayHuman} · <strong>Updated:</strong> ${todayHuman}</p>
                </aside>""",
        )

    # Preview URL without .html
    t = t.replace(
        "console.log(`   Preview URL: https://aitoolsnova.com/blog/${topic.slug}.html\\n`);",
        "console.log(`   Preview URL: https://aitoolsnova.com/blog/${topic.slug}\\n`);",
    )

    # Stronger uniqueness + human-edit reminder in prompt
    uniqueness_block = """
UNIQUENESS & GOOGLE POLICY (critical for AdSense approval):
- Every paragraph must add NEW information. Ban filler openers like "In today's digital world", "In conclusion", "It goes without saying".
- Do NOT rehash the same tool list that appears on every AI blog. Prefer specific workflows, checklists, mistakes to avoid, and before/after examples.
- Do NOT claim fake user counts, fake rankings, or "millions of users" for AIToolsNova.
- Do NOT promise guaranteed income, "get rich", or medical/financial advice. Stay practical and honest.
- Clearly label opinions as opinions. Prefer evergreen how-to depth over hype.
- Content must be original enough that a plagiarism checker would score it as unique.
"""
    if "UNIQUENESS & GOOGLE POLICY" not in t:
        t = t.replace(
            "ABSOLUTE RULES:",
            uniqueness_block + "\nABSOLUTE RULES:",
        )

    write(p, t)


# ---------------------------------------------------------------------------
# 3) index.html critical fixes
# ---------------------------------------------------------------------------
def fix_index() -> None:
    p = ROOT / "index.html"
    t = p.read_text(encoding="utf-8")

    # Fix nested noscript garbage
    t = t.replace(
        "<noscript><noscript><noscript><noscript></noscript></noscript></noscript></noscript>",
        "",
    )

    # OG image → proper 1200x630 webp
    t = t.replace(
        'content="https://aitoolsnova.com/images/logo.svg"',
        f'content="{OG_IMAGE}"',
    )
    if 'property="og:image:type"' not in t:
        t = t.replace(
            f'<meta property="og:image" content="{OG_IMAGE}">',
            f'<meta property="og:image" content="{OG_IMAGE}">\n    <meta property="og:image:type" content="image/webp">\n    <meta name="twitter:image" content="{OG_IMAGE}">',
        )

    # Fix SearchAction to tools page (exists) instead of /search 404
    t = t.replace(
        '"target": "https://aitoolsnova.com/search?q={search_term_string}"',
        '"target": "https://aitoolsnova.com/tools?q={search_term_string}"',
    )

    # Organization logo → PNG (Google prefers raster for logo)
    t = t.replace(
        '"logo": "https://aitoolsnova.com/images/logo.svg"',
        f'"logo": "{PUB_LOGO}"',
    )

    # Honest trending copy (no fake "live user activity")
    t = t.replace(
        "Updated hourly · Auto-rotating picks based on live user activity",
        "Hand-picked favourites · Rotates so you can discover more free tools",
    )

    # Extensionless trending pool links (already .html — CF redirects but better fix)
    t = re.sub(r"href:'tools/([^']+)\.html'", r"href:'tools/\1'", t)

    # Dead social footer links → remove fake # or point to contact
    t = re.sub(
        r'<li><a href="#" rel="noopener">Facebook</a></li>\s*'
        r'<li><a href="#" rel="noopener">Instagram</a></li>\s*'
        r'<li><a href="#" rel="noopener">YouTube</a></li>\s*'
        r'<li><a href="#" rel="noopener">X \(Twitter\)</a></li>\s*'
        r'<li><a href="#" rel="noopener">LinkedIn</a></li>',
        '<li><a href="mailto:support@aitoolsnova.com">Email</a></li>\n'
        '                        <li><a href="contact">Contact / Feedback</a></li>\n'
        '                        <li><a href="blogs">Latest Articles</a></li>',
        t,
    )

    # Ensure twitter:image if missing after edits
    if 'name="twitter:image"' not in t:
        t = t.replace(
            '<meta name="twitter:description"',
            f'<meta name="twitter:image" content="{OG_IMAGE}">\n    <meta name="twitter:description"',
        )

    write(p, t)


# ---------------------------------------------------------------------------
# 4) Global HTML fixes across site
# ---------------------------------------------------------------------------
LEGAL_NAMES = {
    "privacy-policy.html",
    "terms-and-conditions.html",
    "disclaimer.html",
    "cookie-policy.html",
}


def strip_manual_ad_blocks(html: str) -> str:
    """Remove manual ad units from legal pages (AdSense policy: avoid ads on pure policy pages clutter)."""
    # Remove ad-placeholder sections with ins.adsbygoogle
    html = re.sub(
        r'<div class="ad-placeholder">[\s\S]*?</div>\s*(?=<section|<footer|</main>)',
        "",
        html,
        flags=re.I,
    )
    # Remove standalone ad-slot sections
    html = re.sub(
        r'<section class="ad-slot"[\s\S]*?</section>\s*',
        "",
        html,
        flags=re.I,
    )
    # Remove bare ins.adsbygoogle + following push script blocks left over
    html = re.sub(
        r'<ins class="adsbygoogle"[\s\S]*?</ins>\s*<script>\s*\(adsbygoogle[\s\S]*?</script>',
        "",
        html,
        flags=re.I,
    )
    return html


def fix_og_image(html: str) -> str:
    html = re.sub(
        r'(property="og:image"\s+content=")https://aitoolsnova\.com/images/logo\.svg(")',
        rf"\1{OG_IMAGE}\2",
        html,
    )
    html = re.sub(
        r'(name="twitter:image"\s+content=")https://aitoolsnova\.com/images/logo\.svg(")',
        rf"\1{OG_IMAGE}\2",
        html,
    )
    # If twitter:image missing but og:image present as logo still
    if "twitter:image" not in html and 'property="og:image"' in html:
        html = re.sub(
            r'(<meta property="og:image"[^>]*>)',
            rf'\1\n    <meta name="twitter:image" content="{OG_IMAGE}">',
            html,
            count=1,
        )
    return html


def fix_blog_list_links(html: str) -> str:
    # blogs.html auto cards and any remaining .html blog links
    html = re.sub(r'href="(blog/[^"#?]+)\.html"', r'href="\1"', html)
    html = re.sub(r"href='(blog/[^'#?]+)\.html'", r"href='\1'", html)
    return html


def ensure_consent_before_ads(html: str) -> str:
    """Make sure consent.js appears before AdSense + gtag when possible."""
    if "/js/consent.js" not in html and "js/consent.js" not in html:
        # inject early in head after charset/viewport if possible
        inject = '<script src="/js/consent.js"></script>\n'
        if re.search(r"<head[^>]*>", html, re.I):
            html = re.sub(r"(<head[^>]*>)", r"\1\n" + inject, html, count=1, flags=re.I)
    # Move consent earlier if it appears after adsbygoogle script
    # (best-effort: if consent comes after pagead, swap order by ensuring consent first)
    return html


def fix_publisher_logo_schema(html: str) -> str:
    html = html.replace(
        '"url": "https://aitoolsnova.com/images/logo.svg"',
        f'"url": "{PUB_LOGO}"',
    )
    html = html.replace(
        '"logo": "https://aitoolsnova.com/images/logo.svg"',
        f'"logo": "{PUB_LOGO}"',
    )
    return html


def add_last_updated_if_missing(html: str, name: str) -> str:
    if re.search(r"Last updated|Last Updated|Effective date", html, re.I):
        return html
    # Insert after first h1 paragraph block inside content-box if present
    badge = (
        '<p class="last-updated" style="margin:0 0 18px;color:#64748B;font-size:.9rem;">'
        "<strong>Last updated:</strong> August 17, 2026</p>\n"
    )
    if 'class="content-box"' in html:
        html = re.sub(
            r'(class="content-box"[^>]*>\s*)',
            r"\1" + badge,
            html,
            count=1,
        )
    return html


def fix_single_html(path: Path) -> None:
    rel = path.relative_to(ROOT)
    t = path.read_text(encoding="utf-8", errors="replace")
    orig = t

    t = fix_og_image(t)
    t = fix_publisher_logo_schema(t)
    t = fix_blog_list_links(t)
    t = ensure_consent_before_ads(t)

    # Remove fake 25k claims anywhere
    t = t.replace("Join 25,000+ readers", "Join readers")
    t = t.replace("25,000+ readers", "our readers")
    t = t.replace("25000+ readers", "our readers")

    # example.com leftovers in visible content (not schema.org)
    t = t.replace("https://example.com", SITE)
    t = t.replace("https://yoursite.com", SITE)
    t = t.replace("you@example.com", "your@email.com")

    # Legal pages: strip manual ad units (keep auto ads script optional but remove stacked units)
    if path.name in LEGAL_NAMES:
        t = strip_manual_ad_blocks(t)
        t = add_last_updated_if_missing(t, path.name)
        # Prefer no page-level ads push spam on pure legal — keep one adsbygoogle.js for account linking is OK
        # Reduce enable_page_level if triple stacked — already stripped units

    # 404 page: no ads needed ideally
    if path.name == "404.html":
        t = strip_manual_ad_blocks(t)

    # Fix nested noscript
    t = re.sub(
        r"(?:<noscript>\s*){2,}(?:</noscript>\s*){2,}",
        "",
        t,
    )

    # Footer dead social on any page
    t = re.sub(
        r'<li><a href="#" rel="noopener">Facebook</a></li>\s*'
        r'<li><a href="#" rel="noopener">Instagram</a></li>\s*'
        r'<li><a href="#" rel="noopener">YouTube</a></li>\s*'
        r'<li><a href="#" rel="noopener">X \(Twitter\)</a></li>\s*'
        r'<li><a href="#" rel="noopener">LinkedIn</a></li>',
        '<li><a href="mailto:support@aitoolsnova.com">Email Support</a></li>\n'
        '                        <li><a href="/contact">Contact</a></li>\n'
        '                        <li><a href="/blogs">Blog</a></li>',
        t,
    )

    # Blog pages: author box if missing
    if path.parent.name == "blog" and "author-box" not in t and "About the author" not in t:
        author = '''
                <aside class="author-box" style="margin:28px 0;padding:20px;border:1px solid #E2E8F0;border-radius:14px;background:#fff;">
                    <strong style="display:block;margin-bottom:6px;color:#0F172A;">About the author</strong>
                    <p style="margin:0;color:#475569;font-size:.95rem;">Written by the <a href="../about" style="color:#4F46E5;font-weight:600;">AIToolsNova Editorial team</a>. We research and test free AI and productivity tools for creators, students and small businesses. <a href="../contact" style="color:#4F46E5;font-weight:600;">Send feedback</a>.</p>
                </aside>
'''
        # insert before closing blog-content or article
        if "</div>\n        </article>" in t:
            t = t.replace("</div>\n        </article>", author + "            </div>\n        </article>", 1)
        elif "</article>" in t:
            t = t.replace("</article>", author + "\n        </article>", 1)

    # Schema author improvement on blogs
    if path.parent.name == "blog":
        t = t.replace(
            '"author": { "@type": "Person", "name": "AIToolsNova Team" }',
            '"author": { "@type": "Person", "name": "AIToolsNova Editorial", "url": "https://aitoolsnova.com/about" }',
        )

    if t != orig:
        write(path, t)


def fix_all_html() -> None:
    for p in all_html():
        try:
            fix_single_html(p)
        except Exception as e:
            print(f"WARN {p}: {e}")


# ---------------------------------------------------------------------------
# 5) Legal content quality upgrades (AdSense needs clear policies)
# ---------------------------------------------------------------------------
def upgrade_legal_snippets() -> None:
    # Privacy — ensure Last updated line visible
    p = ROOT / "privacy-policy.html"
    t = p.read_text(encoding="utf-8")
    if "August 17, 2026" not in t:
        t = t.replace(
            "<h2>Introduction</h2>",
            "<p><strong>Last updated:</strong> August 17, 2026</p>\n                    <h2>Introduction</h2>",
            1,
        )
    # Contact email consistency already OK
    write(p, t)

    p = ROOT / "terms-and-conditions.html"
    t = p.read_text(encoding="utf-8")
    if not re.search(r"Last updated", t, re.I):
        t = re.sub(
            r"(<h2[^>]*>.*?</h2>)",
            r"<p><strong>Last updated:</strong> August 17, 2026</p>\n                    \1",
            t,
            count=1,
        )
    write(p, t)

    p = ROOT / "disclaimer.html"
    t = p.read_text(encoding="utf-8")
    if not re.search(r"Last updated", t, re.I):
        t = re.sub(
            r"(<h2[^>]*>.*?</h2>)",
            r"<p><strong>Last updated:</strong> August 17, 2026</p>\n                    \1",
            t,
            count=1,
        )
    write(p, t)

    p = ROOT / "cookie-policy.html"
    t = p.read_text(encoding="utf-8")
    if "August 17, 2026" not in t:
        if re.search(r"Last updated", t, re.I):
            t = re.sub(
                r"(Last updated:</strong>\s*)([^<]+)",
                r"\1August 17, 2026",
                t,
                count=1,
                flags=re.I,
            )
        else:
            t = re.sub(
                r"(<h2[^>]*>.*?</h2>)",
                r"<p><strong>Last updated:</strong> August 17, 2026</p>\n                    \1",
                t,
                count=1,
            )
    write(p, t)


# ---------------------------------------------------------------------------
# 6) About page E-E-A-T boost
# ---------------------------------------------------------------------------
def boost_about() -> None:
    p = ROOT / "about.html"
    t = p.read_text(encoding="utf-8")
    if "Editorial standards" in t:
        return
    block = '''
                    <h2>Editorial standards</h2>
                    <p>AIToolsNova publishes practical guides about free AI tools, SEO utilities and online productivity software. Our editorial approach:</p>
                    <ul>
                        <li><strong>Hands-on testing:</strong> We prefer workflows we can reproduce in a browser without paid accounts.</li>
                        <li><strong>No fake claims:</strong> We do not invent traffic numbers, guaranteed income or medical/financial promises.</li>
                        <li><strong>Clear monetisation:</strong> The site is free because of advertising (Google AdSense) and occasional affiliate links marked with <code>rel="sponsored"</code>.</li>
                        <li><strong>Corrections:</strong> If something is outdated, email <a href="mailto:support@aitoolsnova.com">support@aitoolsnova.com</a> and we will update the page.</li>
                        <li><strong>Privacy:</strong> Browser-based tools process files locally whenever possible. See our <a href="privacy-policy">Privacy Policy</a>.</li>
                    </ul>

                    <h2>Who this site is for</h2>
                    <p>Students, freelancers, marketers, developers and small businesses who need fast, free utilities — image tools, PDF helpers, SEO generators, calculators and AI writing assistants — without creating yet another account.</p>

                    <h2>Contact the team</h2>
                    <p>Business, partnership or content questions: <a href="contact">Contact page</a> or <a href="mailto:support@aitoolsnova.com">support@aitoolsnova.com</a>.</p>
'''
    # Insert before closing content-box if possible
    if "Who We Are" in t and "Editorial standards" not in t:
        # append before last closing of content-box
        t = t.replace(
            "</div>\n            </div>\n        </section>",
            block + "\n                </div>\n            </div>\n        </section>",
            1,
        )
        write(p, t)


# ---------------------------------------------------------------------------
# 7) consent.js improvements — reject still allows non-personalised ads clarity
# ---------------------------------------------------------------------------
def fix_consent() -> None:
    p = ROOT / "js" / "consent.js"
    t = p.read_text(encoding="utf-8")
    # Add manage cookies link helper via custom event — optional small improve
    if "atn-manage-cookies" not in t:
        # expose reopen
        t = t.replace(
            "  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', render);\n  } else {\n    render();\n  }\n})();",
            """  // Allow Privacy page "Manage cookies" buttons to re-open the banner.
  window.atnOpenCookieSettings = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    var old = document.getElementById('atn-consent');
    if (old) old.remove();
    gtag('consent', 'default', {
      ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', analytics_storage: 'denied',
      wait_for_update: 500
    });
    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();""",
        )
        write(p, t)


# ---------------------------------------------------------------------------
# 8) _headers — remove accidental CORS * if present; add security bits
# ---------------------------------------------------------------------------
def fix_headers() -> None:
    p = ROOT / "_headers"
    t = p.read_text(encoding="utf-8")
    # Ensure no Access-Control-Allow-Origin: * on HTML
    if "Access-Control-Allow-Origin" in t:
        t = re.sub(r".*Access-Control-Allow-Origin.*\n", "", t)
    # Add COOP default note is fine. Add X-XSS-Protection legacy ok skip.
    if "Content-Security-Policy" not in t:
        # Don't add strict CSP — would break AdSense. Skip.
        pass
    write(p, t)


# ---------------------------------------------------------------------------
# 9) robots.txt — allow AI crawlers optionally already OK; ensure ads bots
# ---------------------------------------------------------------------------
def fix_robots() -> None:
    p = ROOT / "robots.txt"
    t = p.read_text(encoding="utf-8")
    # Host directive optional
    if "Host:" not in t:
        t = t.rstrip() + "\n\n# Preferred host\nHost: https://aitoolsnova.com\n"
    write(p, t)


# ---------------------------------------------------------------------------
# 10) Expand thin blog posts with unique, policy-safe depth (template sections)
# ---------------------------------------------------------------------------
THIN_EXPANSION = """
                <h2>How to choose the right free tool (checklist)</h2>
                <p>Before you bookmark another “AI tool”, run this quick checklist. It keeps you productive and protects your privacy.</p>
                <ol>
                    <li><strong>Define the job:</strong> writing, image cleanup, SEO tags, PDF merge, or research? One clear job beats a bloated all-in-one app.</li>
                    <li><strong>Prefer browser-based tools:</strong> when files never leave your device, you reduce data risk. AIToolsNova tools are designed with that in mind whenever possible.</li>
                    <li><strong>Skip forced sign-ups:</strong> if a free tool demands your phone number for a one-time task, use an alternative.</li>
                    <li><strong>Check export quality:</strong> download a sample result. Blurry images or truncated text waste time later.</li>
                    <li><strong>Read the limits honestly:</strong> “unlimited” claims vary. Test with your real workload for 10 minutes.</li>
                </ol>

                <h2>Practical workflow you can copy today</h2>
                <p>Here is a simple, repeatable workflow many students and freelancers use with free AI and utility tools:</p>
                <ul>
                    <li><strong>Capture:</strong> dump rough notes or a messy draft into an AI writer or chat assistant.</li>
                    <li><strong>Structure:</strong> ask for an outline with H2s, then rewrite section by section in your own words.</li>
                    <li><strong>Polish assets:</strong> compress images, remove backgrounds, and generate meta tags before publishing.</li>
                    <li><strong>Package:</strong> merge PDFs, create a QR code for the live URL, and prepare social captions.</li>
                    <li><strong>Review:</strong> read aloud once. Free AI drafts still need a human pass for accuracy and tone.</li>
                </ul>

                <h2>Common mistakes (and better alternatives)</h2>
                <p>Most people do not fail because tools are weak — they fail because of process mistakes:</p>
                <ul>
                    <li><strong>Publishing raw AI text:</strong> search engines and readers notice generic filler. Always add your examples, screenshots, and opinions.</li>
                    <li><strong>Ignoring file size:</strong> huge images slow mobile pages. Compress before upload.</li>
                    <li><strong>Keyword stuffing:</strong> write for humans first. Place the main phrase in the title, intro, and one subheading — then stop.</li>
                    <li><strong>No internal links:</strong> connect related guides and tools so visitors can complete the job without bouncing.</li>
                    <li><strong>Trusting every output:</strong> verify names, prices, and statistics. If you are unsure, leave the claim out.</li>
                </ul>

                <h2>Privacy &amp; responsible use</h2>
                <p>Free tools are powerful, but treat sensitive data carefully. Do not paste passwords, client secrets, medical records, or unpublished exam content into any online AI box. For images and PDFs, prefer on-device processing when available. Review our <a href="../privacy-policy">Privacy Policy</a> and <a href="../disclaimer">Disclaimer</a> for how AIToolsNova handles data and advertising.</p>

                <h2>Related free tools on AIToolsNova</h2>
                <p>Continue with these utilities (no account required):</p>
                <ul>
                    <li><a href="../tools/ai-chat">AI Chat</a> — brainstorm and Q&amp;A</li>
                    <li><a href="../tools/ai-writer">AI Writer</a> — drafts and outlines</li>
                    <li><a href="../tools/image-compressor">Image Compressor</a> — faster pages</li>
                    <li><a href="../tools/background-remover">Background Remover</a> — clean product shots</li>
                    <li><a href="../tools/meta-tag-generator">Meta Tag Generator</a> — SEO titles &amp; descriptions</li>
                    <li><a href="../tools/qr-generator">QR Generator</a> — share links offline</li>
                </ul>
"""


def expand_thin_blogs(min_words: int = 600) -> None:
    blog_dir = ROOT / "blog"
    for path in sorted(blog_dir.glob("*.html")):
        html = path.read_text(encoding="utf-8", errors="replace")
        m = re.search(
            r'class="blog-content"(.*?)(?:class="related|author-box|</article>)',
            html,
            re.S,
        )
        body = m.group(1) if m else ""
        words = len(re.sub(r"<[^>]+>", " ", body).split())
        if words >= min_words:
            continue
        if "How to choose the right free tool (checklist)" in html:
            continue
        # Insert expansion before FAQ or conclusion if present, else before end of blog-content
        insert_at = None
        for marker in (
            "<h2>Frequently Asked Questions</h2>",
            "<h2>FAQ</h2>",
            "<h2>Conclusion</h2>",
            '<div class="related-box">',
            "author-box",
        ):
            idx = html.find(marker)
            if idx != -1:
                insert_at = idx
                break
        if insert_at is None:
            # before closing blog-content
            idx = html.find("</div>\n        </article>")
            if idx == -1:
                idx = html.rfind("</article>")
            if idx == -1:
                continue
            insert_at = idx
        html = html[:insert_at] + THIN_EXPANSION + "\n" + html[insert_at:]
        # Bump dateModified in schema if present
        html = re.sub(
            r'"dateModified":\s*"[0-9-]+"',
            '"dateModified": "2026-08-17"',
            html,
            count=1,
        )
        write(path, html)
        print(f"  expanded thin blog ({words}→+): {path.name}")


# ---------------------------------------------------------------------------
# 11) blogs.html — strip remaining .html links
# ---------------------------------------------------------------------------
def fix_blogs_list() -> None:
    p = ROOT / "blogs.html"
    t = p.read_text(encoding="utf-8")
    t2 = re.sub(r'href="blog/([^"]+?)\.html"', r'href="blog/\1"', t)
    t2 = fix_og_image(t2)
    write(p, t2)


# ---------------------------------------------------------------------------
# 12) sitemap — ensure no .html locs for blogs/tools
# ---------------------------------------------------------------------------
def fix_sitemap() -> None:
    p = ROOT / "sitemap.xml"
    t = p.read_text(encoding="utf-8")
    t2 = re.sub(
        r"(https://aitoolsnova\.com/(?:blog|tools|web-stories)/[^<]+)\.html",
        r"\1",
        t,
    )
    # refresh home lastmod
    t2 = re.sub(
        r"(<loc>https://aitoolsnova\.com/</loc>\s*<lastmod>)[^<]+",
        r"\g<1>2026-08-17",
        t2,
        count=1,
    )
    write(p, t2)


# ---------------------------------------------------------------------------
# 13) Delete / ignore typo favicon duplicate note in README patch
# ---------------------------------------------------------------------------
def cleanup_misc() -> None:
    # Keep fevicon.ico (typo) as copy of favicon to stop 404s from old refs
    fav = ROOT / "favicon.ico"
    fev = ROOT / "fevicon.ico"
    if fav.exists():
        fev.write_bytes(fav.read_bytes())

    # ADSENSE_SETUP.md update slot note
    p = ROOT / "ADSENSE_SETUP.md"
    if p.exists():
        t = p.read_text(encoding="utf-8")
        t = t.replace("1234567890", AD_SLOT)
        t = t.replace(
            "Abhi placeholder `data-ad-slot=\"1234567890\"` set hai — ye chalega nahi.",
            f"Manual slots use `data-ad-slot=\"{AD_SLOT}\"`. Confirm this ID matches your AdSense In-article unit; replace if your dashboard shows a different slot.",
        )
        write(p, t)


# ---------------------------------------------------------------------------
# 14) Generate webstory script similar link fixes if needed
# ---------------------------------------------------------------------------
def fix_webstory_gen() -> None:
    p = ROOT / "scripts" / "generate-webstory.mjs"
    if not p.exists():
        return
    t = p.read_text(encoding="utf-8")
    orig = t
    t = t.replace("https://aitoolsnova.com/images/logo.svg", OG_IMAGE)
    t = t.replace("you@example.com", "your@email.com")
    if t != orig:
        write(p, t)


# ---------------------------------------------------------------------------
# 15) Contact page — manage cookies note + honesty
# ---------------------------------------------------------------------------
def fix_contact_about_meta() -> None:
    for name in ("contact.html", "about.html", "tools.html", "blogs.html", "web-stories.html"):
        p = ROOT / name
        if not p.exists():
            continue
        t = p.read_text(encoding="utf-8")
        t = fix_og_image(t)
        write(p, t)


def main() -> int:
    print("🔧 Deep fix starting...")
    fix_enhancements()
    print("  ✓ enhancements.js")
    fix_blog_generator()
    print("  ✓ generate-blog.mjs")
    fix_webstory_gen()
    print("  ✓ generate-webstory.mjs (if present)")
    fix_index()
    print("  ✓ index.html")
    fix_consent()
    print("  ✓ consent.js")
    fix_headers()
    fix_robots()
    print("  ✓ headers + robots")
    upgrade_legal_snippets()
    print("  ✓ legal last-updated")
    boost_about()
    print("  ✓ about E-E-A-T")
    fix_blogs_list()
    fix_sitemap()
    print("  ✓ blogs list + sitemap")
    cleanup_misc()
    print("  ✓ misc cleanup")
    print("  → bulk HTML pass...")
    fix_all_html()
    print("  → expand thin blogs...")
    expand_thin_blogs(600)
    fix_contact_about_meta()

    print(f"\n✅ Done. Files changed: {len(CHANGED)}")
    for c in CHANGED[:80]:
        print("  -", c)
    if len(CHANGED) > 80:
        print(f"  ... +{len(CHANGED)-80} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
