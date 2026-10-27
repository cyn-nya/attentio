"""Generate the PWA PNG icons from the same geometry as public/icon.svg.

Kept as a script rather than a build step: icons change roughly never, and a
checked-in PNG means `npm install` needs no image toolchain.
"""

from __future__ import annotations

import sys

from PIL import Image, ImageDraw

BG_TOP = (16, 26, 38)
BG_BOTTOM = (11, 15, 20)
STOPS = [(74, 222, 128), (56, 189, 248), (167, 139, 250)]


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def gradient_color(t: float) -> tuple[int, int, int]:
    """Two-stop blend across the three ring stops."""
    t = min(max(t, 0.0), 1.0)
    if t < 0.5:
        return lerp(STOPS[0], STOPS[1], t / 0.5)
    return lerp(STOPS[1], STOPS[2], (t - 0.5) / 0.5)


def render(size: int, supersample: int = 4) -> Image.Image:
    s = size * supersample
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Rounded-square background with a subtle vertical gradient.
    radius = round(s * 112 / 512)
    background = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(background)
    for y in range(s):
        color = lerp(BG_TOP, BG_BOTTOM, y / max(s - 1, 1))
        bg_draw.line([(0, y), (s, y)], fill=(*color, 255))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    image.paste(background, (0, 0), mask)

    cx = cy = s / 2
    scale = s / 512

    # Ring 1: wide, faint, cool end of the gradient.
    for r, width, alpha, t in (
        (168 * scale, 26 * scale, 0.28, 0.12),
        (116 * scale, 30 * scale, 0.62, 0.45),
        (64 * scale, 34 * scale, 1.0, 0.85),
    ):
        color = gradient_color(t)
        box = [cx - r, cy - r, cx + r, cy + r]
        draw.ellipse(box, outline=(*color, round(255 * alpha)), width=max(1, round(width)))

    # Core dot.
    dot = 26 * scale
    draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=(232, 244, 255, 255))

    # The tick.
    tick = [(318 * scale, 150 * scale), (352 * scale, 184 * scale), (424 * scale, 106 * scale)]
    draw.line(tick, fill=(74, 222, 128, 255), width=round(30 * scale), joint="curve")
    for point in (tick[0], tick[-1]):
        r = 30 * scale / 2
        draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r], fill=(74, 222, 128, 255))

    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "apps/web/public"
    for size in (192, 512):
        target = f"{out_dir}/icon-{size}.png"
        render(size).save(target, "PNG", optimize=True)
        print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
