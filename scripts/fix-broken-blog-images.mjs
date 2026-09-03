#!/usr/bin/env node
/**
 * One-off + reusable repair for broken blog section images.
 *
 * Bug it fixes: generate-blog.mjs only GENERATES images for the first 4
 * sections (content.sections.slice(0,4)) but buildHtml() emits an <img> for
 * EVERY section, pointing at /blog/img/<slug>-section-N.jpg. Sections 5+
 * therefore 404 — a low-quality / "low value content" signal for AdSense
 * reviewers and Googlebot (broken <img> + missing resource).
 *
 * This script:
 *   1. Scans every blog/*.html for local /blog/img/*.jpg references.
 *   2. For each missing file, tries to download a real on-topic image from
 *      Pollinations (seeded per section so it is stable), normalised 1600x900.
 *   3. If the download fails (offline/sandbox), deterministically copies the
 *      post's existing section-1..4 image so the URL NEVER 404s.
 *
 * Safe to re-run: existing files are never overwritten.
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const BLOG_DIR = path.join(ROOT, 'blog');
const IMG_DIR = path.join(BLOG_DIR, 'img');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* optional */ }

async function downloadImage(url, dest, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 45000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3000) throw new Error('tiny payload');
      if (sharp) {
        const out = await sharp(buf)
          .resize(1600, 900, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
          .sharpen({ sigma: 0.4 })
          .jpeg({ quality: 86, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer();
        await fs.writeFile(dest, out);
      } else {
        await fs.writeFile(dest, buf);
      }
      if (statSync(dest).size > 3000) return true;
    } catch (e) {
      console.warn(`   download try ${i} failed: ${e.message}`);
      await sleep(1500 * i);
    }
  }
  return false;
}

async function main() {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const posts = readdirSync(BLOG_DIR).filter(f => f.endsWith('.html'));
  let fixed = 0, downloaded = 0, copied = 0, stillBroken = 0;

  for (const post of posts) {
    const html = await fs.readFile(path.join(BLOG_DIR, post), 'utf-8');
    const slug = post.replace(/\.html$/, '');
    // root-relative local blog image refs only
    const refs = [...new Set((html.match(/\/blog\/img\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)/g) || []))];
    for (const ref of refs) {
      const dest = path.join(ROOT, ref.replace(/^\//, ''));
      if (existsSync(dest) && statSync(dest).size > 3000) continue;

      // Determine section number + topic from alt text for a decent prompt.
      const m = ref.match(/-section-(\d+)\.(jpg|jpeg|png|webp)$/);
      const sectionNo = m ? Number(m[1]) : null;
      const altMatch = html.match(new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*alt="([^"]*)"'));
      const alt = altMatch ? altMatch[1].replace(/&[a-z]+;/g, ' ').slice(0, 80) : slug.replace(/-/g, ' ');

      let ok = false;
      if (sectionNo) {
        const seed = crypto.createHash('md5').update(ref).digest('hex').slice(0, 8);
        const prompt = `${alt}, editorial photograph, natural light, modern technology workspace, realistic, no text, no watermark`;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1600&height=900&seed=${seed}&model=flux&enhance=true&nologo=true&nofeed=true`;
        process.stdout.write(`   ↳ ${path.basename(dest)} ... `);
        ok = await downloadImage(url, dest);
        if (ok) { console.log('downloaded'); downloaded++; } else { console.log('download failed'); }
      }

      if (!ok) {
        // Deterministic local fallback: reuse the post's own working section
        // image (or hero) so the resource always resolves (no 404).
        const candidates = [];
        for (let n = 1; n <= 4; n++) {
          const c = path.join(IMG_DIR, `${slug}-section-${n}.jpg`);
          if (existsSync(c) && statSync(c).size > 3000 && c !== dest) candidates.push(c);
        }
        const hero = path.join(IMG_DIR, `${slug}-hero.jpg`);
        if (existsSync(hero) && statSync(hero).size > 3000) candidates.push(hero);
        if (candidates.length) {
          const pick = candidates[(sectionNo || 1) % candidates.length];
          copyFileSync(pick, dest);
          console.log(`   ↳ ${path.basename(dest)} <= copied from ${path.basename(pick)} (fallback)`);
          copied++;
          ok = true;
        }
      }

      if (ok) fixed++; else { stillBroken++; console.error(`   ✗ STILL BROKEN: ${ref}`); }
    }
  }
  console.log(`\n✅ Done. fixed=${fixed} (downloaded=${downloaded}, copied=${copied}), stillBroken=${stillBroken}`);
  if (stillBroken) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
