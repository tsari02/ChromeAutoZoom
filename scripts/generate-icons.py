#!/usr/bin/env python3
"""Generate icons/icon-16.png, icon-48.png, icon-128.png for AutoZoom.

Pure standard library (zlib + struct) — no Pillow required. Renders a blue
rounded square with a white magnifier whose lens contains a "+", using 4×
supersampling for anti-aliasing, then writes real RGBA PNGs at exactly the
requested pixel sizes.

Usage:  python3 scripts/generate-icons.py
"""
import math
import os
import struct
import sys
import zlib

SIZES = (16, 48, 128)
SS = 4  # supersampling factor

# Colours (RGB 0-255)
BG_TOP = (0x3A, 0x9B, 0xFF)
BG_BOTTOM = (0x0A, 0x5E, 0xD6)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def sd_rounded_rect(px, py, cx, cy, half, radius):
    """Signed distance to a rounded square centred at (cx, cy)."""
    qx = abs(px - cx) - (half - radius)
    qy = abs(py - cy) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def sd_segment(px, py, ax, ay, bx, by):
    """Distance from point to segment AB."""
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx * abx + aby * aby or 1.0
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / denom))
    return math.hypot(apx - abx * t, apy - aby * t)


def render(size):
    """Return a list of rows, each a list of (r, g, b, a) tuples."""
    n = size * SS
    s = float(n)  # work in supersampled units
    # Chrome Web Store requires 128x128 icons to have a 96x96 artwork area
    # with 16px transparent padding per side (16 / 128 = 0.125).
    # Smaller toolbar/management sizes (16, 48) use a tight margin for legibility.
    half = s / 2.0
    margin_frac = (16.0 / 128.0) if size == 128 else 0.03
    margin = s * margin_frac
    box = s - 2.0 * margin
    corner = box * 0.234
    lens_cx = margin + box * 0.436
    lens_cy = margin + box * 0.436
    lens_r = box * 0.234
    ring_w = max(1.0, box * 0.0585)
    plus_len = lens_r * 0.55
    plus_w = max(1.0, box * 0.048)
    handle_w = max(1.0, box * 0.080)
    hx0 = lens_cx + lens_r * math.cos(math.radians(45)) + ring_w * 0.2
    hy0 = lens_cy + lens_r * math.sin(math.radians(45)) + ring_w * 0.2
    hx1 = margin + box * 0.819
    hy1 = margin + box * 0.819

    hi = [[(0, 0, 0, 0)] * n for _ in range(n)]
    for y in range(n):
        py = y + 0.5
        for x in range(n):
            px = x + 0.5
            d = sd_rounded_rect(px, py, half, half, box / 2.0, corner)
            if d > 0.75:
                continue
            bg_a = max(0.0, min(1.0, 0.5 - d))  # 1px AA edge
            t = max(0.0, min(1.0, (py - margin) / box))
            col = lerp(BG_TOP, BG_BOTTOM, t)

            # White magnifier coverage
            dl = abs(math.hypot(px - lens_cx, py - lens_cy) - lens_r) - ring_w / 2.0
            dp1 = sd_segment(px, py, lens_cx - plus_len, lens_cy, lens_cx + plus_len, lens_cy) - plus_w / 2.0
            dp2 = sd_segment(px, py, lens_cx, lens_cy - plus_len, lens_cx, lens_cy + plus_len) - plus_w / 2.0
            dh = sd_segment(px, py, hx0, hy0, hx1, hy1) - handle_w / 2.0
            dw = min(dl, dp1, dp2, dh)
            w_a = max(0.0, min(1.0, 0.5 - dw))

            r = int(round(col[0] + (WHITE[0] - col[0]) * w_a))
            g = int(round(col[1] + (WHITE[1] - col[1]) * w_a))
            b = int(round(col[2] + (WHITE[2] - col[2]) * w_a))
            hi[y][x] = (r, g, b, bg_a)

    # Box-filter downsample to the target size (premultiplied average).
    out = []
    for Y in range(size):
        row = []
        for X in range(size):
            rs = gs = bs = as_ = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    r, g, b, a = hi[Y * SS + dy][X * SS + dx]
                    rs += r * a
                    gs += g * a
                    bs += b * a
                    as_ += a
            if as_ <= 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((int(round(rs / as_)), int(round(gs / as_)), int(round(bs / as_)), int(round(255 * as_ / (SS * SS)))))
        out.append(row)
    return out


def png_bytes(rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, f'icon-{size}.png')
        with open(path, 'wb') as f:
            f.write(png_bytes(render(size)))
        print(f'Created {os.path.relpath(path, root)} ({size}x{size})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
