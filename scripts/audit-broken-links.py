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

def candidate_paths(link, base_dir):
    """Return files that can satisfy a public URL on Cloudflare Pages.

    The site intentionally uses extensionless canonical URLs (``/tools`` and
    ``/blog/slug``), while the checked-in files end in ``.html``.  Treating a
    real directory such as ``/tools`` as ``tools/index.html`` also gives a
    false 404 because Cloudflare's clean-URL lookup correctly serves
    ``tools.html`` first.
    """
    link = ihtml.unescape(link).split("#")[0].split("?")[0].strip()
    if not link or any(marker in link for marker in ("${", "+t.")):
        return []
    link = unquote(link)
    if link.startswith("/"):
        p = os.path.join(ROOT, link.lstrip("/"))
    else:
        p = os.path.normpath(os.path.join(base_dir, link))

    candidates = [p]
    if not os.path.splitext(p)[1]:
        candidates.append(p + ".html")
    if link.endswith("/") or os.path.isdir(p):
        candidates.append(os.path.join(p, "index.html"))
    return list(dict.fromkeys(candidates))

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
        link = raw
        if is_external(raw):
            link = check_internal_host(raw)
            if not link:
                continue
        candidates = candidate_paths(link, base)
        if not candidates:
            continue
        if not any(os.path.exists(candidate) for candidate in candidates):
            rel = os.path.relpath(candidates[0], ROOT)
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
        if not any(os.path.exists(p) for p in candidate_paths(path, ROOT)):
            bad.append(path)
    print(f"\n=== SITEMAP URLs with no matching file: {len(bad)} ===")
    for b in bad:
        print("  ", b)

if missing or bad:
    raise SystemExit(1)
