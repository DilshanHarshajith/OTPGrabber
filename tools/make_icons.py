#!/usr/bin/env python3
"""Generate the extension's PNG icons.

A rounded blue tile with a white keyhole, drawn at a high resolution and
downsampled so the edges stay smooth at every size. Requires Pillow
(`pip install pillow`); run with no arguments from the project root.
"""
from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

SIZES = [32, 48, 96, 128]
SUPERSAMPLE = 8
BG_TOP = (58, 110, 235, 255)
BG_BOTTOM = (37, 76, 196, 255)
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def vertical_gradient(width: int, height: int) -> Image.Image:
    grad = Image.new("RGBA", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        grad.putpixel(
            (0, y),
            tuple(round(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(4)),
        )
    return grad.resize((width, height))


def render(size: int) -> Image.Image:
    canvas = size * SUPERSAMPLE
    base = vertical_gradient(canvas, canvas)

    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, canvas - 1, canvas - 1), radius=int(canvas * 0.22), fill=255
    )
    tile = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    tile.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(tile)
    cx = canvas / 2
    key_r = canvas * 0.14
    key_cy = canvas * 0.40
    draw.ellipse(
        (cx - key_r, key_cy - key_r, cx + key_r, key_cy + key_r), fill=(255, 255, 255, 255)
    )
    stem_top = key_cy + key_r * 0.35
    stem_bottom = canvas * 0.75
    stem_half = canvas * 0.06
    draw.rounded_rectangle(
        (cx - stem_half, stem_top, cx + stem_half, stem_bottom),
        radius=stem_half,
        fill=(255, 255, 255, 255),
    )

    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        render(size).save(path, "PNG")
        print(f"wrote {os.path.relpath(path)}")


if __name__ == "__main__":
    main()
