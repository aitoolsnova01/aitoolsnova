#!/usr/bin/env python3
"""Idempotent site-wide SEO/meta fixer.

For every normal (non-AMP) HTML page it ensures the following exist, adding
only what is MISSING (never duplicates, safe to re-run):
  - viewport meta
  - favicon links (ico + svg + apple-touch)
  - canonical link (computed from the file path)
  - Open Graph + Twitter card tags (so the site shares nicely everywhere)

AMP web stories (web-stories/) are skipped on purpose - they have a strict
head and extra tags would break AMP validation.
"""
import os
import re
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://aitoolsnova.com"
OG_IMAGE = f"{SITE}/images/og-image.webp"

FAVICON_BLOCK = (
    '<link rel="icon" href="/favicon.ico" sizes="any">\n'
    '  <link rel="icon" type="image/svg+xml" href="/favicon.svg">\n'
    '  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png">'
)


def canonical_for(relpath):
    rel = relpath.replace(os.sep, "/")
    if rel == "index.html":
        return SITE + "/"
    return f"{SITE}/{rel}"


def title_of(html, fallback):
    m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
    t = (m.group(1).strip() if m else fallback)
    return t.replace('"', "&quot;")


def build_additions(html, relpath):
    parts = []
    url = canonical_for(relpath)
    title = title_of(html, "AIToolsNova")

    if not re.search(r'name=["\']viewport["\']', html, re.I):
        parts.append('<meta name="viewport" content="width=device-width, initial-scale=1.0">')

    if not re.search(r'rel=["\']icon["\']|apple-touch-icon|shortcut icon', html, re.I):
        parts.append(FAVICON_BLOCK)

    if not re.search(r'rel=["\']canonical["\']', html, re.I):
        parts.append(f'<link rel="canonical" href="{url}">')

    if not re.search(r'og:title', html, re.I):
        parts.append(
            f'<meta property="og:title" content="{title}">\n'
            f'  <meta property="og:type" content="website">\n'
            f'  <meta property="og:url" content="{url}">\n'
            f'  <meta property="og:image" content="{OG_IMAGE}">\n'
            f'  <meta property="og:site_name" content="AIToolsNova">'
        )

    if not re.search(r'twitter:card', html, re.I):
        parts.append(
            f'<meta name="twitter:card" content="summary_large_image">\n'
            f'  <meta name="twitter:title" content="{title}">\n'
            f'  <meta name="twitter:image" content="{OG_IMAGE}">'
        )
    return parts


def process(path):
    rel = os.path.relpath(path, ROOT)
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        html = fh.read()
    if "<head" not in html.lower():
        return False  # e.g. google verification token file
    parts = build_additions(html, rel)
    if not parts:
        return False
    block = "\n  <!-- SEO auto-added -->\n  " + "\n  ".join(parts) + "\n"
    # insert right after the opening <head ...>
    m = re.search(r"<head[^>]*>", html, re.I)
    new = html[:m.end()] + block + html[m.end():]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new)
    return True


def main():
    targets = []
    for pat in ["*.html", "blog/*.html", "tools/*.html", "compare/*.html"]:
        targets += glob.glob(os.path.join(ROOT, pat))
    changed = 0
    for p in sorted(set(targets)):
        if process(p):
            changed += 1
    print(f"Updated {changed} of {len(set(targets))} pages")


if __name__ == "__main__":
    main()
