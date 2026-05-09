"""
应用图标主色提取算法对比

直接从 solo.db 的 app_catalog 表读出 icon_png（实际是 BMP）blob，
用多种算法各自提取主色，输出一张 HTML 报告（拼图 + 色块 + hex），
方便人眼对比挑出最佳算法。

用法：
  python dominant_color.py
  python dominant_color.py --db /path/to/solo.db
  python dominant_color.py --image some_icon.png
  python dominant_color.py --image-dir folder/  # 批量

依赖：Pillow（已装）
"""

from __future__ import annotations

import argparse
import base64
import io
import os
import struct
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image


# ── BMP 解码 ─────────────────────────────────────────────────────

def decode_bmp_bgra(blob: bytes) -> tuple[int, int, bytes] | None:
    """解析 perception::bmp_bytes() 写出的 32-bit BGRA BMP（top-down）。"""
    if len(blob) < 54 or blob[:2] != b"BM":
        return None
    pixel_offset = struct.unpack_from("<I", blob, 10)[0]
    width = abs(struct.unpack_from("<i", blob, 18)[0])
    height = abs(struct.unpack_from("<i", blob, 22)[0])
    bit_count = struct.unpack_from("<H", blob, 28)[0]
    if bit_count != 32 or width == 0 or height == 0:
        return None
    need = pixel_offset + width * height * 4
    if len(blob) < need:
        return None
    return width, height, bytes(blob[pixel_offset : pixel_offset + width * height * 4])


def bgra_pixels(blob: bytes) -> tuple[int, int, list[tuple[int, int, int, int]]] | None:
    """把 BMP blob 解码成 [(R, G, B, A), ...]"""
    parsed = decode_bmp_bgra(blob)
    if parsed is None:
        # 试当作普通 PNG/ICO 解析
        try:
            img = Image.open(io.BytesIO(blob)).convert("RGBA")
            w, h = img.size
            data = list(img.getdata())  # list of (R, G, B, A)
            return w, h, [(r, g, b, a) for r, g, b, a in data]
        except Exception:
            return None
    w, h, raw = parsed
    pix = []
    for i in range(0, len(raw), 4):
        b, g, r, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
        pix.append((r, g, b, a))
    return w, h, pix


# ── 算法 ─────────────────────────────────────────────────────────


@dataclass
class AlgoResult:
    name: str
    hex: str | None
    note: str = ""


def hex_color(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def saturation(r: int, g: int, b: int) -> int:
    return max(r, g, b) - min(r, g, b)


def luminance(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def algo_quantize_4bit(
    pix: list[tuple[int, int, int, int]],
    sat_min: int,
    lum_min: int,
    lum_max: int,
) -> tuple[int, int, int] | None:
    """当前 Rust 算法的 Python 复刻：每通道量化到 4 bit，挑频次最大的桶，桶内均值。"""
    counts: Counter[int] = Counter()
    sums: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])
    for r, g, b, a in pix:
        if a < 128:
            continue
        s = r + g + b
        if s < lum_min or s > lum_max:
            continue
        if saturation(r, g, b) < sat_min:
            continue
        key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        counts[key] += 1
        sums[key][0] += r
        sums[key][1] += g
        sums[key][2] += b
    if not counts:
        return None
    key, n = counts.most_common(1)[0]
    if n < 2:
        return None
    rs, gs, bs = sums[key]
    return rs // n, gs // n, bs // n


def algo_current_rust(pix: list[tuple[int, int, int, int]]) -> AlgoResult:
    """三轮 fallback（当前 Rust 实现）"""
    for sat, lo, hi in [(18, 60, 740), (8, 50, 760), (0, 40, 780)]:
        c = algo_quantize_4bit(pix, sat, lo, hi)
        if c is not None:
            return AlgoResult("当前 Rust 算法", hex_color(c), f"sat≥{sat} lum∈[{lo},{hi}]")
    return AlgoResult("当前 Rust 算法", None)


def algo_saturation_weighted(pix: list[tuple[int, int, int, int]]) -> AlgoResult:
    """每通道量化 4 bit + 权重 = 出现次数 × 饱和度（更鲜艳的桶得票多）。"""
    counts: dict[int, float] = defaultdict(float)
    sums: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0, 0])  # r, g, b, n
    for r, g, b, a in pix:
        if a < 128:
            continue
        s = r + g + b
        if s < 40 or s > 760:
            continue
        sat = saturation(r, g, b)
        # 几乎全灰也允许，但权重低
        weight = 1.0 + sat * 0.1  # 每点饱和度加 0.1 票
        key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        counts[key] += weight
        sums[key][0] += r
        sums[key][1] += g
        sums[key][2] += b
        sums[key][3] += 1
    if not counts:
        return AlgoResult("饱和度加权直方图", None)
    key = max(counts, key=counts.get)
    rs, gs, bs, n = sums[key]
    return AlgoResult("饱和度加权直方图", hex_color((rs // n, gs // n, bs // n)), f"weighted score={counts[key]:.1f}")


def algo_pillow_kmeans(pix: list[tuple[int, int, int, int]], w: int, h: int, k: int = 5) -> AlgoResult:
    """Pillow.quantize（median cut）→ 调色板里挑非黑/白/灰的最高频色"""
    img = Image.new("RGBA", (w, h))
    img.putdata([(r, g, b, a) for r, g, b, a in pix])
    rgb = img.convert("RGB")
    palette = rgb.quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    # 调色板对应索引出现频次
    counts = Counter(palette.getdata())
    pal = palette.getpalette()  # [r0,g0,b0, r1,g1,b1, ...]
    candidates = []
    for idx, n in counts.most_common():
        r, g, b = pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2]
        s = r + g + b
        if s < 60 or s > 720:
            continue
        if saturation(r, g, b) < 10:
            continue
        candidates.append((n, (r, g, b)))
    if not candidates:
        return AlgoResult("Pillow MedianCut", None)
    candidates.sort(reverse=True)
    return AlgoResult("Pillow MedianCut", hex_color(candidates[0][1]), f"k={k}, picked top of {len(candidates)} viable")


def algo_pillow_libimagequant(pix: list[tuple[int, int, int, int]], w: int, h: int, k: int = 5) -> AlgoResult:
    """Pillow.quantize 用 LIBIMAGEQUANT（如果可用）"""
    img = Image.new("RGBA", (w, h))
    img.putdata([(r, g, b, a) for r, g, b, a in pix])
    try:
        palette = img.quantize(colors=k, method=Image.Quantize.LIBIMAGEQUANT)
    except Exception as e:
        return AlgoResult("Pillow libimagequant", None, f"unavailable: {e}")
    rgb_palette = palette.convert("RGBA")
    counts = Counter()
    sums = defaultdict(lambda: [0, 0, 0, 0])
    for r, g, b, a in rgb_palette.getdata():
        if a < 128:
            continue
        if r + g + b < 60 or r + g + b > 720:
            continue
        if saturation(r, g, b) < 10:
            continue
        # 量化到 4 bit 桶再聚合（避免每个像素都是不同色）
        key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        counts[key] += 1
        sums[key][0] += r
        sums[key][1] += g
        sums[key][2] += b
        sums[key][3] += 1
    if not counts:
        return AlgoResult("Pillow libimagequant", None)
    key = counts.most_common(1)[0][0]
    rs, gs, bs, n = sums[key]
    return AlgoResult("Pillow libimagequant", hex_color((rs // n, gs // n, bs // n)), f"k={k}")


def algo_max_saturation_pixel(pix: list[tuple[int, int, int, int]]) -> AlgoResult:
    """直接挑全图饱和度最高 + 在合理亮度范围内的像素均值（取 top 5%）"""
    valid = []
    for r, g, b, a in pix:
        if a < 128:
            continue
        s = r + g + b
        if s < 80 or s > 720:
            continue
        valid.append((saturation(r, g, b), r, g, b))
    if not valid:
        return AlgoResult("Top 5% 饱和", None)
    valid.sort(reverse=True)
    top = valid[: max(1, len(valid) // 20)]
    rs = sum(p[1] for p in top) / len(top)
    gs = sum(p[2] for p in top) / len(top)
    bs = sum(p[3] for p in top) / len(top)
    return AlgoResult("Top 5% 饱和", hex_color((int(rs), int(gs), int(bs))), f"n={len(top)}/{len(valid)}")


ALGOS = [
    algo_current_rust,
    algo_saturation_weighted,
    lambda pix, w=None, h=None: algo_pillow_kmeans(pix, w, h, 5),
    lambda pix, w=None, h=None: algo_pillow_libimagequant(pix, w, h, 5),
    algo_max_saturation_pixel,
]


def run_all(pix, w, h) -> list[AlgoResult]:
    out = []
    for f in ALGOS:
        try:
            try:
                res = f(pix, w, h)
            except TypeError:
                res = f(pix)
        except Exception as e:
            res = AlgoResult(f.__name__, None, f"error: {e}")
        out.append(res)
    return out


# ── 输入源 ───────────────────────────────────────────────────────


def load_from_db(db_path: Path) -> list[tuple[str, bytes]]:
    import sqlite3

    conn = sqlite3.connect(str(db_path))
    rows = conn.execute(
        "SELECT app_key, icon_png FROM app_catalog WHERE icon_png IS NOT NULL ORDER BY app_key"
    ).fetchall()
    conn.close()
    return [(name, bytes(blob)) for name, blob in rows]


def load_from_file(path: Path) -> list[tuple[str, bytes]]:
    return [(path.name, path.read_bytes())]


def load_from_dir(d: Path) -> list[tuple[str, bytes]]:
    out = []
    for ext in ("png", "ico", "bmp", "jpg", "jpeg", "webp"):
        for p in sorted(d.glob(f"*.{ext}")):
            out.append((p.name, p.read_bytes()))
    return out


# ── HTML 报告 ────────────────────────────────────────────────────


def render_html(rows: list[tuple[str, bytes]], out_path: Path) -> None:
    print(f"[INFO] 处理 {len(rows)} 个图标...")
    html_rows = []
    algo_names = []
    seen_algo = False

    for i, (name, blob) in enumerate(rows):
        parsed = bgra_pixels(blob)
        if parsed is None:
            print(f"  [{i+1}/{len(rows)}] {name}: ✗ 解码失败")
            continue
        w, h, pix = parsed
        results = run_all(pix, w, h)
        if not seen_algo:
            algo_names = [r.name for r in results]
            seen_algo = True

        # 把图标编成 base64 PNG 给 HTML 用（无论原本是 BMP 还是别的）
        img = Image.new("RGBA", (w, h))
        img.putdata(pix)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        img_tag = f'<img src="data:image/png;base64,{b64}" style="image-rendering:pixelated;width:48px;height:48px;background:#222;border:1px solid #333"/>'

        cells = [f"<td>{img_tag}</td><td style='font-family:monospace;font-size:11px'>{name}</td>"]
        for r in results:
            if r.hex:
                cells.append(
                    f'<td><div style="display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:32px;height:24px;background:{r.hex};border:1px solid #444"></span>'
                    f'<code style="font-size:10px">{r.hex}</code></div>'
                    f'<div style="font-size:9px;color:#888">{r.note}</div></td>'
                )
            else:
                cells.append(f'<td><span style="color:#a44">— None —</span><div style="font-size:9px;color:#888">{r.note}</div></td>')
        html_rows.append(f"<tr>{''.join(cells)}</tr>")
        print(f"  [{i+1}/{len(rows)}] {name}: " + "  ".join(f"{r.name}={r.hex or 'None'}" for r in results))

    head_cells = "<th>图标</th><th>名称</th>" + "".join(f"<th>{n}</th>" for n in algo_names)
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>主色提取算法对比</title>
<style>
body {{ background:#0a0e1a; color:#ccc; font-family:system-ui; padding:16px; }}
table {{ border-collapse:collapse; }}
th, td {{ padding:8px 12px; border:1px solid #1a2332; vertical-align:middle; }}
th {{ background:#0f1828; color:#7af; text-align:left; font-weight:600; }}
tr:nth-child(even) td {{ background:#0c1320; }}
code {{ background:#1a2332; padding:2px 4px; border-radius:2px; }}
</style></head>
<body>
<h2>应用图标主色提取算法对比 — {len(html_rows)} 个图标</h2>
<table>
<thead><tr>{head_cells}</tr></thead>
<tbody>{''.join(html_rows)}</tbody>
</table>
</body></html>
"""
    out_path.write_text(html, encoding="utf-8")
    print(f"\n[OK] 报告已生成: {out_path}")
    print(f"     在浏览器打开比对各算法效果")


# ── CLI ──────────────────────────────────────────────────────────


def default_db_path() -> Path:
    return Path.home() / "AppData" / "Local" / "solo-agent" / "solo.db"


def main():
    parser = argparse.ArgumentParser(description="应用图标主色提取算法对比")
    parser.add_argument("--db", type=Path, default=None, help="solo.db 路径（默认走 %LOCALAPPDATA%\\solo-agent\\solo.db）")
    parser.add_argument("--image", type=Path, default=None, help="单个图片路径")
    parser.add_argument("--image-dir", type=Path, default=None, help="目录批量")
    parser.add_argument("--out", type=Path, default=Path("dominant_color_report.html"))
    args = parser.parse_args()

    if args.image:
        rows = load_from_file(args.image)
    elif args.image_dir:
        rows = load_from_dir(args.image_dir)
    else:
        db = args.db or default_db_path()
        if not db.exists():
            print(f"[ERR] DB 不存在: {db}", file=sys.stderr)
            print("       用 --image / --image-dir 也行", file=sys.stderr)
            sys.exit(1)
        print(f"[INFO] 从 DB 读取: {db}")
        rows = load_from_db(db)

    if not rows:
        print("[WARN] 无图标可处理", file=sys.stderr)
        sys.exit(1)

    render_html(rows, args.out.resolve())


if __name__ == "__main__":
    main()
