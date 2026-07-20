#!/usr/bin/env python3
"""Render the multicolor Sloga mark (sloga-website/assets/favicon.svg) to a
multi-size ICO. Pure stdlib: supersampled circle rasteriser + zlib PNG writer.

The geometry mirrors the SVG exactly (viewBox 0 0 100 100).
"""
import struct, zlib, sys

CIRCLES = [
    (50, 50, 14.5, "#27A163"),
    (50, 22.5, 10, "#3BB8ED"),
    (69.5, 30.5, 10, "#F5870D"),
    (77.5, 50, 10, "#CF2A27"),
    (69.5, 69.5, 10, "#E3CF1B"),
    (50, 77.5, 10, "#3BB8ED"),
    (30.5, 69.5, 10, "#F5870D"),
    (22.5, 50, 10, "#2B2BD8"),
    (30.5, 30.5, 10, "#C05FC8"),
]
SS = 4  # supersampling factor per axis


def rgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def render(size):
    """Return RGBA bytes, size x size, transparent background."""
    n = size * SS
    scale = n / 100.0
    # accumulate premultiplied coverage at supersample resolution, then box-filter
    acc = [[(0, 0, 0, 0)] * n for _ in range(n)]
    for cx, cy, r, col in CIRCLES:
        cr, cg, cb = rgb(col)
        px, py, pr = cx * scale, cy * scale, r * scale
        r2 = pr * pr
        y0, y1 = max(0, int(py - pr) - 1), min(n - 1, int(py + pr) + 1)
        x0, x1 = max(0, int(px - pr) - 1), min(n - 1, int(px + pr) + 1)
        for y in range(y0, y1 + 1):
            dy = y + 0.5 - py
            row = acc[y]
            for x in range(x0, x1 + 1):
                dx = x + 0.5 - px
                if dx * dx + dy * dy <= r2:
                    row[x] = (cr, cg, cb, 255)  # later circles paint over earlier

    out = bytearray()
    inv = 1.0 / (SS * SS)
    for y in range(size):
        out.append(0)  # PNG filter: none
        for x in range(size):
            tr = tg = tb = ta = 0
            for sy in range(SS):
                row = acc[y * SS + sy]
                for sx in range(SS):
                    r_, g_, b_, a_ = row[x * SS + sx]
                    if a_:
                        tr += r_; tg += g_; tb += b_; ta += a_
            if ta == 0:
                out += b"\0\0\0\0"
            else:
                # average colour over covered samples, alpha = coverage
                cov = ta // 255
                out += bytes((tr // cov, tg // cov, tb // cov, min(255, int(ta * inv))))
    return bytes(out)


def png(size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main(out_path, sizes=(16, 32, 48, 128, 256)):
    imgs = []
    for s in sizes:
        imgs.append((s, png(s, render(s))))
        print(f"  rendered {s}x{s} ({len(imgs[-1][1])} bytes)", file=sys.stderr)
    hdr = struct.pack("<HHH", 0, 1, len(imgs))
    off = len(hdr) + 16 * len(imgs)
    entries, blobs = b"", b""
    for s, data in imgs:
        entries += struct.pack("<BBBBHHII", s if s < 256 else 0, s if s < 256 else 0,
                               0, 0, 1, 32, len(data), off)
        blobs += data
        off += len(data)
    with open(out_path, "wb") as f:
        f.write(hdr + entries + blobs)
    print(f"wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
