#!/usr/bin/env python3
"""Rebuild sitemap.xml from all public HTML pages (extensionless URLs)."""
from pathlib import Path
import re
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
SITE = 'https://aitoolsnova.com'
TODAY = date.today().isoformat()
SKIP = {'.git', 'frontend', 'node_modules', 'test_reports', 'backend', 'memory', 'data', 'functions', 'scripts', 'tests', '.emergent', '.github'}
EXCLUDE_NAMES = {'404.html'}

def main():
    pages = []
    for p in ROOT.rglob('*.html'):
        if set(p.parts) & SKIP:
            continue
        if p.name in EXCLUDE_NAMES or (p.name.startswith('google') and p.name.endswith('.html')):
            continue
        if any(part.startswith('.') for part in p.parts if part not in (str(ROOT),) and part != p.name and part not in p.relative_to(ROOT).parts[:0]):
            # skip hidden dirs
            if any(part.startswith('.') for part in p.relative_to(ROOT).parts[:-1]):
                continue
        rel = p.relative_to(ROOT).as_posix()
        if any(part.startswith('.') for part in Path(rel).parts[:-1]):
            continue
        if rel == 'index.html':
            url = f'{SITE}/'
            pr, cf = '1.0', 'daily'
        else:
            slug = rel[:-5] if rel.endswith('.html') else rel
            url = f'{SITE}/{slug}'
            if rel in ('tools.html', 'blogs.html', 'web-stories.html'):
                pr, cf = '0.9', 'daily'
            elif rel.startswith('tools/'):
                pr, cf = '0.85', 'weekly'
            elif rel.startswith('blog/'):
                pr, cf = '0.8', 'weekly'
            elif rel.startswith('web-stories/'):
                pr, cf = '0.8', 'weekly'
            elif rel.startswith('compare/'):
                pr, cf = '0.75', 'monthly'
            elif rel in ('about.html', 'contact.html', 'free-chatgpt-prompts.html', 'monetize-tools.html'):
                pr, cf = '0.7', 'monthly'
            elif rel in ('privacy-policy.html', 'terms-and-conditions.html', 'disclaimer.html', 'cookie-policy.html'):
                pr, cf = '0.3', 'yearly'
            else:
                pr, cf = '0.6', 'monthly'
        mtime = date.fromtimestamp(p.stat().st_mtime).isoformat()
        pages.append((url, rel, pr, cf, mtime))

    seen = {}
    for it in pages:
        seen[it[0]] = it
    pages = sorted(seen.values(), key=lambda x: (-float(x[2]), x[0]))

    def images_for(rel):
        fp = ROOT / rel
        html = fp.read_text(encoding='utf-8', errors='replace')
        imgs = []
        m = re.search(r'property="og:image"\s+content="([^"]+)"', html)
        if m and 'logo.svg' not in m.group(1):
            imgs.append(m.group(1))
        for src in re.findall(r'(?:src|content)="((?:https://aitoolsnova\.com)?/(?:blog|web-stories)/img/[^"]+\.(?:jpg|jpeg|png|webp))"', html, re.I):
            imgs.append(src if src.startswith('http') else SITE + src)
        out, s = [], set()
        for i in imgs:
            i = i.replace('&', '&amp;')
            if i not in s and 'pollinations.ai' not in i:
                s.add(i); out.append(i)
        return out[:6]

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        '',
        f'    <!-- FULL SITE SITEMAP — rebuilt {TODAY} -->',
        '    <!-- AUTO-BLOG-SITEMAP-START -->',
        '    <!-- New daily blog URLs are inserted directly below this marker by generate-blog.mjs -->',
    ]
    for url, rel, pr, cf, mtime in pages:
        lastmod = TODAY if rel in ('index.html', 'tools.html', 'blogs.html', 'web-stories.html') else mtime
        lines += [
            '    <url>',
            f'        <loc>{url}</loc>',
            f'        <lastmod>{lastmod}</lastmod>',
            f'        <changefreq>{cf}</changefreq>',
            f'        <priority>{pr}</priority>',
            f'        <xhtml:link rel="alternate" hreflang="en" href="{url}" />',
            f'        <xhtml:link rel="alternate" hreflang="en-us" href="{url}" />',
            f'        <xhtml:link rel="alternate" hreflang="en-gb" href="{url}" />',
            f'        <xhtml:link rel="alternate" hreflang="en-ca" href="{url}" />',
            f'        <xhtml:link rel="alternate" hreflang="en-in" href="{url}" />',
            f'        <xhtml:link rel="alternate" hreflang="x-default" href="{url}" />',
        ]
        for img in images_for(rel):
            lines += ['        <image:image>', f'            <image:loc>{img}</image:loc>', '        </image:image>']
        lines.append('    </url>')
    lines += ['    <!-- AUTO-BLOG-SITEMAP-END -->', '</urlset>', '']
    out = ROOT / 'sitemap.xml'
    out.write_text('\n'.join(lines), encoding='utf-8')
    print(f'Wrote {out} with {len(pages)} URLs')

if __name__ == '__main__':
    main()
