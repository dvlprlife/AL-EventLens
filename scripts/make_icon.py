"""
Generate images/icon.png for the AL EventLens VS Code extension.

Style matches the dvlprlife portfolio (Markdown Foundry, Selection Count):
dark navy rounded-square background with a small 2-3 color foreground
that reads at 16px.

Concept: a magnifying lens ("EventLens") framing a publisher node connected
to two subscriber nodes by yellow lines.

Renders at 4x and downsamples with LANCZOS for clean edges.
"""

from __future__ import annotations
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "images" / "icon.png"

# 128 design grid, rendered at SCALE for AA, downsampled at the end.
SCALE = 8
SIZE = 128 * SCALE

# Palette (matches existing portfolio tone)
BG     = (26, 34, 54, 255)     # #1A2236 dark navy
CYAN   = (0, 229, 255, 255)    # #00E5FF lens + handle
YELLOW = (233, 210, 104, 255)  # #E9D268 publisher/subscriber nodes


def s(n: float) -> float:
    return n * SCALE


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1) Rounded square background
    radius = s(22)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=radius, fill=BG)

    # 2) Magnifying-glass handle: a fat rounded diagonal stroke,
    #    drawn before the lens so the lens overlaps it cleanly.
    handle_start = (s(82), s(82))
    handle_end   = (s(112), s(112))
    handle_half  = s(5.5)
    dx = handle_end[0] - handle_start[0]
    dy = handle_end[1] - handle_start[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy / length, dx / length  # perpendicular unit vector
    p1 = (handle_start[0] + nx * handle_half, handle_start[1] + ny * handle_half)
    p2 = (handle_end[0]   + nx * handle_half, handle_end[1]   + ny * handle_half)
    p3 = (handle_end[0]   - nx * handle_half, handle_end[1]   - ny * handle_half)
    p4 = (handle_start[0] - nx * handle_half, handle_start[1] - ny * handle_half)
    draw.polygon([p1, p2, p3, p4], fill=CYAN)
    draw.ellipse(
        (handle_start[0] - handle_half, handle_start[1] - handle_half,
         handle_start[0] + handle_half, handle_start[1] + handle_half),
        fill=CYAN,
    )
    draw.ellipse(
        (handle_end[0] - handle_half, handle_end[1] - handle_half,
         handle_end[0] + handle_half, handle_end[1] + handle_half),
        fill=CYAN,
    )

    # 3) Lens ring
    lens_cx, lens_cy = s(52), s(52)
    lens_r = s(38)
    stroke = s(7)
    draw.ellipse(
        (lens_cx - lens_r, lens_cy - lens_r, lens_cx + lens_r, lens_cy + lens_r),
        outline=CYAN, width=int(stroke),
    )

    # 4) Inside the lens: 1 publisher (top) + 2 subscribers (bottom),
    #    joined by lines forming an inverted V.
    pub  = (s(52), s(33))
    sub1 = (s(35), s(66))
    sub2 = (s(69), s(66))
    line_w = int(s(3.2))
    draw.line([pub, sub1], fill=YELLOW, width=line_w)
    draw.line([pub, sub2], fill=YELLOW, width=line_w)

    # Round line ends so the inverted-V looks clean at apex/feet
    for (x, y) in (pub, sub1, sub2):
        rcap = s(1.6)
        draw.ellipse((x - rcap, y - rcap, x + rcap, y + rcap), fill=YELLOW)

    pub_r = s(8.5)
    sub_r = s(6.5)
    draw.ellipse((pub[0] - pub_r, pub[1] - pub_r, pub[0] + pub_r, pub[1] + pub_r), fill=YELLOW)
    draw.ellipse((sub1[0] - sub_r, sub1[1] - sub_r, sub1[0] + sub_r, sub1[1] + sub_r), fill=YELLOW)
    draw.ellipse((sub2[0] - sub_r, sub2[1] - sub_r, sub2[0] + sub_r, sub2[1] + sub_r), fill=YELLOW)

    # 5) Downsample to 128x128 with LANCZOS
    out = img.resize((128, 128), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT} ({out.size[0]}x{out.size[1]} {out.mode})")


if __name__ == "__main__":
    main()
