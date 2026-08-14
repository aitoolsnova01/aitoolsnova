#!/usr/bin/env python3
"""Generate a clean square brand logo (for AMP Web Story publisher-logo) and
an apple-touch-icon. Pure PIL, no external assets, no AI credits."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "images")
os.makedirs(OUT_DIR, exist_ok=True)


def _font(size):
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make_logo(path, s):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded square with indigo -> violet vertical gradient
    top = (79, 70, 229)      # #4F46E5
    bot = (124, 58, 237)     # #7C3AED
    for y in range(s):
        t = y / s
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        d.line([(0, y), (s, y)], fill=(r, g, b, 255))
    # rounded mask
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    img.putalpha(mask)
    d = ImageDraw.Draw(img)
    # accent spark dot
    d.ellipse([int(s * 0.63), int(s * 0.16), int(s * 0.80), int(s * 0.33)],
              fill=(255, 209, 102, 255))
    # monogram "AI"
    f = _font(int(s * 0.46))
    text = "AI"
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((s - tw) / 2 - bbox[0], (s - th) / 2 - bbox[1] + int(s * 0.03)),
           text, font=f, fill=(255, 255, 255, 255))
    img.save(path)
    print("wrote", path, img.size)


make_logo(os.path.join(OUT_DIR, "publisher-logo.png"), 512)
make_logo(os.path.join(OUT_DIR, "apple-touch-icon.png"), 180)
