#!/usr/bin/env python3
"""Scan every HTML page for internal links/assets that point to files which do
NOT exist in the repo -> these are the 404s Cloudflare is reporting.
Also cross-checks sitemap.xml. Read-only: just reports."""
import os, re, glob, html as ihtml
from collections import defaultdict
from urllib.parse import urlparse, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_HOSTS = {"aitoolsnova.com", "www.aitoolsnova.com"}

def is_external(u):
    return u.startswith(("http://", "https://", "//", "mailto:", "tel:", "javascript:", "data:", "#"))

def to_path(link, base_dir):
    link = ihtml.unescape(link).split("#")[0].split("?")[0].strip()
    if not link:
        return None
    link = unquote(link)
    if link.startswith("/"):
        p = os.path.join(ROOT, link.lstrip("/"))
    else:
        p = os.path.normpath(os.path.join(base_dir, link))
    if link.endswith("/") or os.path.isdir(p):
        p = os.path.join(p, "index.html")
    return p

def check_internal_host(u):
    """For absolute URLs to our own domain, return the path part; else None."""
    pr = urlparse(u)
    if pr.netloc in SITE_HOSTS:
        return pr.path or "/"
    return None

missing = defaultdict(list)   # target -> [pages referencing]
files = glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True)
files = [f for f in files if ".git" not in f and "frontend" not in f]

ATTR_RE = re.compile(r'(?:href|src|poster-portrait-src|publisher-logo-src)\s*=\s*"([^"]+)"', re.I)

for f in files:
    base = os.path.dirname(f)
    with open(f, "r", encoding="utf-8", errors="ignore") as fh:
        html = fh.read()
    for m in ATTR_RE.finditer(html):
        raw = m.group(1).strip()
        if is_external(raw):
            path = check_internal_host(raw)
            if not path:
                continue
            target = to_path(path, base)
        else:
            target = to_path(raw, base)
        if not target:
            continue
        if not os.path.exists(target):
            rel = os.path.relpath(target, ROOT)
            missing[rel].append(os.path.relpath(f, ROOT))

print("=== MISSING INTERNAL TARGETS (404 sources) ===")
for tgt, refs in sorted(missing.items(), key=lambda x: -len(x[1])):
    print(f"[{len(refs):>3} refs] {tgt}   e.g. {refs[0]}")
print(f"\nTotal distinct missing targets: {len(missing)}")

# sitemap cross-check
smap = os.path.join(ROOT, "sitemap.xml")
if os.path.exists(smap):
    with open(smap) as fh:
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", fh.read())
    bad = []
    for loc in locs:
        path = urlparse(loc).path
        p = os.path.join(ROOT, path.lstrip("/"))
        if path.endswith("/"):
            p = os.path.join(p, "index.html")
        if not os.path.exists(p):
            bad.append(path)
    print(f"\n=== SITEMAP URLs with no matching file: {len(bad)} ===")
    for b in bad:
        print("  ", b)
