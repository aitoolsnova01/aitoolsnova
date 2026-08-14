"""Backend static-site tests for web stories + SEO changes."""
import os
import re
import subprocess
import xml.etree.ElementTree as ET
import pytest
import requests

BASE = "http://localhost:8888"


# ---------- robots.txt ----------
class TestRobots:
    def test_http_200(self):
        r = requests.get(f"{BASE}/robots.txt", timeout=10)
        assert r.status_code == 200
        self.body = r.text

    def test_allows_web_stories(self):
        body = requests.get(f"{BASE}/robots.txt", timeout=10).text
        assert "Allow: /web-stories/" in body

    def test_no_bad_patterns(self):
        body = requests.get(f"{BASE}/robots.txt", timeout=10).text
        for bad in ["/*.ts$", "/package.json", "/.*.yml", "/category/", "/tag/"]:
            assert bad not in body, f"forbidden pattern present: {bad}"

    def test_has_sitemap_line(self):
        body = requests.get(f"{BASE}/robots.txt", timeout=10).text
        assert "Sitemap: https://aitoolsnova.com/sitemap.xml" in body


# ---------- sitemap.xml ----------
class TestSitemap:
    def test_valid_xml_and_contents(self):
        r = requests.get(f"{BASE}/sitemap.xml", timeout=10)
        assert r.status_code == 200
        # Parse
        root = ET.fromstring(r.text)
        assert root.tag.endswith("urlset")
        text = r.text
        assert "https://aitoolsnova.com/web-stories.html" in text
        assert "https://aitoolsnova.com/web-stories/5-free-ai-tools-blow-your-mind-2026.html" in text
        assert "https://aitoolsnova.com/tools.html" in text
        assert "https://aitoolsnova.com/blogs.html" in text
        assert re.search(r"https://aitoolsnova\.com/blog/[^<]+", text), "no blog/ URL preserved"


# ---------- web-stories.html landing page ----------
class TestWebStoriesLanding:
    def test_page_200_and_content(self):
        r = requests.get(f"{BASE}/web-stories.html", timeout=10)
        assert r.status_code == 200
        html = r.text
        assert re.search(r"<h1[^>]*>\s*AI Web Stories", html, re.I), "H1 missing"
        for tid in ["nav-home", "nav-tools", "nav-blogs", "nav-stories", "nav-about"]:
            assert f'data-testid="{tid}"' in html, f"missing testid {tid}"
        assert 'data-testid="web-stories-grid"' in html
        assert "story-card" in html


# ---------- generated AMP story ----------
class TestAmpStory:
    URL = f"{BASE}/web-stories/5-free-ai-tools-2026-hd.html"

    def test_amp_story_structure(self):
        r = requests.get(self.URL, timeout=10)
        assert r.status_code == 200, f"status {r.status_code}"
        html = r.text
        assert "<amp-story" in html
        # 7 amp-story-page ids: cover, s-1..s-5, cta
        ids = re.findall(r'<amp-story-page[^>]*id="([^"]+)"', html)
        assert len(ids) == 7, f"expected 7 pages, got {len(ids)}: {ids}"
        expected = {"cover", "s-1", "s-2", "s-3", "s-4", "s-5", "cta"}
        assert set(ids) == expected, f"page ids mismatch: {ids}"

    def test_amp_img_and_captions_per_slide(self):
        html = requests.get(self.URL, timeout=10).text
        # Split by amp-story-page to inspect each
        pages = re.split(r'<amp-story-page', html)[1:]
        slide_pages = [p for p in pages if re.search(r'id="s-\d"', p)]
        assert len(slide_pages) == 5
        for i, p in enumerate(slide_pages, 1):
            assert "<amp-img" in p, f"slide s-{i} missing amp-img"
            assert "pollinations.ai" in p, f"slide s-{i} missing pollinations url"
            assert re.search(r'<p[^>]*class="[^"]*slide-caption', p), f"slide s-{i} missing slide-caption"

    def test_fonts_and_ldjson_and_canonical(self):
        html = requests.get(self.URL, timeout=10).text
        assert "Playfair+Display" in html
        assert "Poppins" in html
        assert 'application/ld+json' in html
        assert '"@type": "Article"' in html or '"@type":"Article"' in html
        assert re.search(r'<link[^>]+rel="canonical"[^>]+href="https://aitoolsnova\.com/web-stories/"', html)


# ---------- GitHub Actions workflow ----------
class TestWorkflow:
    def test_daily_webstory_yaml(self):
        path = "/app/.github/workflows/daily-webstory.yml"
        assert os.path.exists(path)
        import yaml
        with open(path) as f:
            data = yaml.safe_load(f)
        # PyYAML converts bare 'on' key to True boolean
        on_key = "on" if "on" in data else True
        assert on_key in data
        triggers = data[on_key]
        assert "workflow_dispatch" in triggers
        assert "schedule" in triggers
        crons = [c.get("cron") for c in triggers["schedule"]]
        assert "30 15 * * *" in crons
        raw = open(path).read()
        assert "node scripts/generate-webstory.mjs" in raw
        assert "git commit" in raw or "commit" in raw
        assert "git push" in raw or "push" in raw
        # search-engine ping
        assert re.search(r"(indexnow|ping|google\.com/ping|bing\.com)", raw, re.I)

    def test_daily_blog_unchanged(self):
        path = "/app/.github/workflows/daily-blog.yml"
        assert os.path.exists(path)
        assert "Daily Blog Auto-Publish" in open(path).read()


# ---------- Node script ----------
class TestNodeScript:
    def test_node_check(self):
        r = subprocess.run(["node", "--check", "/app/scripts/generate-webstory.mjs"],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr

    def test_smoke(self):
        env = {**os.environ, "GROQ_API_KEY": "test"}
        r = subprocess.run(["node", "/app/scripts/test-webstory-smoke.mjs"],
                           capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode == 0, f"stdout: {r.stdout}\nstderr: {r.stderr}"
        assert "🎉 All smoke checks passed" in r.stdout

    def test_exports(self, tmp_path):
        # Dynamic import via a helper node one-liner
        script = (
            "import(process.argv[1]).then(m => {"
            "const need=['buildStoryHtml','updateSitemap','rebuildStoriesIndex','pickSourceBlog'];"
            "const miss=need.filter(k=>typeof m[k] !== 'function');"
            "if(miss.length){console.error('MISSING:'+miss.join(','));process.exit(1)}"
            "console.log('OK');})"
        )
        # Avoid passing the script as argv[1] (would trip main() guard). Inline import.
        inline = (
            "import('/app/scripts/generate-webstory.mjs').then(m => {"
            "const need=['buildStoryHtml','updateSitemap','rebuildStoriesIndex','pickSourceBlog'];"
            "const miss=need.filter(k=>typeof m[k] !== 'function');"
            "if(miss.length){console.error('MISSING:'+miss.join(','));process.exit(1)}"
            "console.log('OK');process.exit(0);})"
        )
        r = subprocess.run(
            ["node", "--input-type=module", "-e", inline],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "GROQ_API_KEY": "test"},
        )
        assert r.returncode == 0, f"stdout={r.stdout} stderr={r.stderr}"
        assert "OK" in r.stdout


# ---------- Blog content unchanged ----------
class TestBlogsPreserved:
    def test_blogs_dir(self):
        files = [f for f in os.listdir("/app/blog") if f.endswith(".html")]
        assert len(files) > 40, f"only {len(files)} html files in /app/blog"

    def test_blogs_html_size(self):
        size = os.path.getsize("/app/blogs.html")
        assert size > 50 * 1024, f"blogs.html size {size} too small"


# ---------- SEO helper doc ----------
class TestSeoDoc:
    def test_content(self):
        path = "/app/SEO_HEALTH.md"
        assert os.path.exists(path)
        content = open(path).read()
        for keyword in ["Google Search Console", "Bing", "IndexNow", "sitemap"]:
            assert keyword in content, f"missing keyword: {keyword}"
