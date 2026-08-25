#!/usr/bin/env python3
"""SEO / asset hygiene audit for AIToolsNova.

Catches the regression classes that previously shipped silently:

  1. Hot-linked remote images (image.pollinations.ai / images.unsplash.com) in
     blog/ and web-stories/ HTML. These are slow, unreliable and bad for LCP
     and indexing; content must be localized into /blog/img and /web-stories/img.
  2. Blog / web-story pages missing an og:image (broken social previews).
  3. Meta descriptions outside the 50-165 char window (Google ignores / truncates).
  4. Orphan images shipped to the deploy but referenced by nothing (dead weight).
  5. Web-story index cards whose title no longer matches the story's <title>.

Exit code 0 = healthy, 1 = at least one failure. Pure stdlib, offline, fast.
Run:  python3 scripts/audit-seo-assets.py
"""
import glob
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE_IMG_RE = re.compile(r'https?://(?:image\.pollinations\.ai|images\.unsplash\.com)/')
TEXT_EXTS = ('.html', '.css', '.js', '.mjs', '.xml', '.json', '.md')
IMG_EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.svg')
META_DESC_RE = re.compile(
    r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']'
    r'|<meta[^>]*content=["\'](.*?)["\'][^>]*name=["\']description["\']',
    re.I | re.S)

failures = []
warnings = []


def fail(msg):
    failures.append(msg)


def all_text_blob():
    """Concatenate every non-image text file in the repo (for orphan + ref checks)."""
    chunks = []
    for p in ROOT.rglob('*'):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if '.git' in rel.parts or 'node_modules' in rel.parts:
            continue
        if p.suffix.lower() not in TEXT_EXTS:
            continue
        try:
            chunks.append(p.read_text(encoding='utf-8', errors='replace'))
        except OSError:
            pass
    return "\n".join(chunks)


def content_pages():
    """blog/ and web-stories/ HTML files (the socially-shared content)."""
    return sorted(
        str(p.relative_to(ROOT)) for p in
        [*ROOT.glob('blog/*.html'), *ROOT.glob('web-stories/*.html')]
    )


def check_remote_hotlinks():
    for rel in content_pages():
        text = (ROOT / rel).read_text(encoding='utf-8', errors='replace')
        n = len(REMOTE_IMG_RE.findall(text))
        if n:
            fail(f"{rel}: {n} hot-linked remote image reference(s) — localize into /blog/img or /web-stories/img")


def check_og_image():
    for rel in content_pages():
        text = (ROOT / rel).read_text(encoding='utf-8', errors='replace')
        if 'property="og:image"' not in text and "property='og:image'" not in text:
            fail(f"{rel}: missing og:image (broken social preview)")


def check_meta_description_length():
    for rel in content_pages():
        text = (ROOT / rel).read_text(encoding='utf-8', errors='replace')
        m = META_DESC_RE.search(text)
        if not m:
            fail(f"{rel}: missing meta description")
            continue
        desc = (m.group(1) or m.group(2) or '').strip()
        if not (50 <= len(desc) <= 165):
            fail(f"{rel}: meta description is {len(desc)} chars (want 50-165)")


def check_orphan_images(blob):
    scanned = 0
    orphans = 0
    for d in ('blog/img', 'web-stories/img', 'images/og'):
        for p in sorted((ROOT / d).glob('*')):
            if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
                continue
            scanned += 1
            base = p.name
            if base in blob or ('/' + p.relative_to(ROOT).as_posix()) in blob:
                continue
            orphans += 1
            fail(f"{p.relative_to(ROOT)}: orphan image (referenced by nothing) — delete it or reference it")
    return scanned, orphans


def check_story_card_titles():
    index = ROOT / 'web-stories.html'
    if not index.exists():
        return
    idx = index.read_text(encoding='utf-8', errors='replace')
    for p in sorted((ROOT / 'web-stories').glob('*.html')):
        text = p.read_text(encoding='utf-8', errors='replace')
        t = re.search(r'<title>([^<]+)</title>', text, re.I)
        if not t:
            continue
        title = t.group(1).strip()
        # The index card must show the same <title> (and alt) as the story.
        if f'<h3>{title}</h3>' not in idx:
            fail(f"web-stories.html: card for {p.name} does not show the story title '{title}'")


def main():
    print('🔎 SEO/asset audit')
    blob = all_text_blob()
    check_remote_hotlinks()
    check_og_image()
    check_meta_description_length()
    scanned, orphans = check_orphan_images(blob)
    check_story_card_titles()

    for w in warnings:
        print('  ⚠️ ', w)
    if failures:
        print('\n❌ SEO/asset audit FAILED:')
        for f in failures:
            print('  -', f)
        sys.exit(1)
    print('  ✅ no hot-linked remote images in blog/web-stories')
    print('  ✅ og:image present on all content pages')
    print('  ✅ meta descriptions within 50-165 chars')
    print(f'  ✅ no orphan images ({scanned} scanned, {orphans} unreferenced)')
    print('  ✅ web-story index cards match story titles')
    print('✅ SEO/asset audit passed')
    sys.exit(0)


if __name__ == '__main__':
    main()
