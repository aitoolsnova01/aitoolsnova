#!/usr/bin/env python3
"""Generate the AIToolsNova brand logo at every size the site + Play Store need.

Design: square with an indigo -> violet gradient, a soft top sheen, a bold
white "AI" monogram, and an amber 4-point spark. App icons (icon.png, logo.png,
apple-touch-icon, publisher-logo) are full-bleed squares (Play Store / iOS round
them). The favicon.ico is generated with transparent rounded corners.

Pure Pillow, no network, deterministic.
"""
from PIL import Image, ImageDraw, ImageFont
import os
import math

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "images")
os.makedirs(OUT, exist_ok=True)

TOP = (99, 102, 241)     # #6366F1
MID = (79, 70, 229)      # #4F46E5
BOT = (124, 58, 237)     # #7C3AED
AMBER = (255, 209, 102)  # #FFD166
WHITE = (255, 255, 255)


def _font(size):
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def gradient_at(t):
    if t < 0.5:
        tt = t * 2
        return tuple(int(TOP[i] + (MID[i] - TOP[i]) * tt) for i in range(3))
    tt = (t - 0.5) * 2
    return tuple(int(MID[i] + (BOT[i] - MID[i]) * tt) for i in range(3))


def draw_logo(s, rounded=False):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for y in range(s):
        t = y / s
        base = gradient_at(t)
        # manual sheen blend across the top ~42%
        if y < int(s * 0.42):
            a = 0.28 * (1 - y / (s * 0.42))
            c = tuple(int(base[i] + (255 - base[i]) * a) for i in range(3))
        else:
            c = base
        d.line([(0, y), (s, y)], fill=c + (255,))

    if rounded:
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255
        )
        img.putalpha(mask)
        d = ImageDraw.Draw(img)

    # Amber 4-point spark, top-right corner
    cx, cy, r = s * 0.79, s * 0.17, s * 0.055
    outer = [(cx + r * 1.6 * math.cos(i * math.pi / 2), cy + r * 1.6 * math.sin(i * math.pi / 2)) for i in range(4)]
    inner = [(cx + r * math.cos(i * math.pi / 2 + math.pi / 4), cy + r * math.sin(i * math.pi / 2 + math.pi / 4)) for i in range(4)]
    pts = []
    for i in range(4):
        pts.append(outer[i])
        pts.append(inner[(i + 1) % 4])
    d.polygon(pts, fill=AMBER + (255,))

    # "AI" monogram
    f = _font(int(s * 0.42))
    text = "AI"
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (s - tw) / 2 - bbox[0]
    y = (s - th) / 2 - bbox[1] + int(s * 0.03)
    d.text((x, y), text, font=f, fill=WHITE + (255,))
    return img


def save_png(path, size, rounded=False):
    im = draw_logo(size, rounded=rounded)
    if rounded:
        im.save(path, "PNG")
    else:
        im.convert("RGB").save(path, "PNG")
    print("wrote", os.path.relpath(path, ROOT), f"{size}x{size}")


def save_webp(path, size):
    draw_logo(size).convert("RGB").save(path, "WEBP", quality=92)
    print("wrote", os.path.relpath(path, ROOT), f"{size}x{size}")


def save_ico(path, sizes):
    base = draw_logo(sizes[-1], rounded=True).convert("RGBA")
    base.save(path, "ICO", sizes=[(x, x) for x in sizes])
    print("wrote", os.path.relpath(path, ROOT), sizes)


if __name__ == "__main__":
    save_ico(os.path.join(ROOT, "favicon.ico"), [16, 32, 48])
    save_ico(os.path.join(ROOT, "fevicon.ico"), [16, 32, 48])
    save_png(os.path.join(ROOT, "icon.png"), 512)
    save_png(os.path.join(ROOT, "logo.png"), 512)
    save_png(os.path.join(OUT, "publisher-logo.png"), 512)
    save_png(os.path.join(ROOT, "apple-touch-icon.png"), 180)
    save_png(os.path.join(OUT, "apple-touch-icon.png"), 180)
    save_webp(os.path.join(ROOT, "logo.webp"), 512)
    save_webp(os.path.join(OUT, "logo.webp"), 512)
    print("done")
