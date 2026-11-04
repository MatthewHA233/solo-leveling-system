"""权重光晕：把每一轮选择题的概率一层层乘下去，得到整屏的概率分布，画成没有实线的光晕。
权重 ≥ BEAM 的格子都继续细分（同一层并行发），深度到 DEPTH 层为止。
用法：python heat_locator.py   Key 运行时从本地库读，不落盘；出图在本目录 heat_*.png"""
import base64
import ctypes
import io
import json
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageGrab

ctypes.windll.shcore.SetProcessDpiAwareness(2)
sys.stdout.reconfigure(encoding="utf-8")

MODEL = "liquid/d1"
SEND_MAX, SEND_MIN = 1024, 512
DEPTH = 4          # 1920×1080 → 640×360 → 213×120 → 71×40 → 24×13
BEAM = 0.12        # 这一格的总权重够这么多才继续细分
GLOW_RGB = (255, 150, 60)
OUT = os.path.dirname(os.path.abspath(__file__))

H_NAMES = {1: [""], 2: ["左", "右"], 3: ["左", "中", "右"]}
V_NAMES = {1: [""], 2: ["上", "下"], 3: ["上", "中", "下"]}


def plan_split(w, h):
    best = None
    for cols in range(1, 4):
        for rows in range(1, 4):
            if cols * rows < 2:
                continue
            score = -cols * rows + abs(math.log((w / cols) / (h / rows))) * 2
            if best is None or score < best[0]:
                best = (score, cols, rows)
    return best[1], best[2]


def place_name(c, r, cols, rows):
    hn, vn = H_NAMES[cols][c], V_NAMES[rows][r]
    if hn == "中" and vn == "中":
        return "正中"
    if hn == "中":
        return f"{vn}方正中" if vn else "正中"
    if vn == "中":
        return f"{hn}侧中间" if hn else "正中"
    return f"{hn}{vn}" if hn and vn else (f"{hn}半边" if hn else f"{vn}半边")


def options(w, h):
    cols, rows = plan_split(w, h)
    out = {}
    for r in range(rows):
        for c in range(cols):
            box = (round(w * c / cols), round(h * r / rows), round(w * (c + 1) / cols), round(h * (r + 1) / rows))
            parts = ([f"横向第 {c + 1}/{cols} 份"] if cols > 1 else []) + ([f"纵向第 {r + 1}/{rows} 份"] if rows > 1 else [])
            out[f"r{r + 1}c{c + 1}"] = (box, f"在图的{place_name(c, r, cols, rows)}（{'、'.join(parts)}）")
    return out


def key():
    db = os.path.join(os.environ["LOCALAPPDATA"], "solevup", "solo.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    return con.execute("SELECT base_url, api_key FROM jev_config LIMIT 1").fetchone()


BASE, KEY = key()


def to_send(img):
    im = img.convert("RGB")
    w, h = im.size
    scale = min(SEND_MAX / max(w, h), max(1.0, SEND_MIN / max(w, h)))
    if scale != 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS if scale < 1 else Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def ask(img, opts, target):
    body = {
        "model": MODEL,
        "state": [
            {"type": "text", "text": f"这是一张屏幕截图（或其中一块，可能被放大过）。要找的东西：{target}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + to_send(img)}},
        ],
        "questions": {"where": {"type": "choice", "instructions": f"{target}在图中的哪个位置？", "criteria": {kk: t for kk, (_, t) in opts.items()}}},
    }
    req = urllib.request.Request(BASE.rstrip("/") + "/v1/systemone", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(3):
        try:
            resp = json.loads(opener.open(req, timeout=60).read())
            return resp["answers"]["where"]["probabilities"]
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if attempt == 2:
                raise RuntimeError(f"HTTP {e.code} {msg}")
            time.sleep(1.5)


def expand(shot, target):
    """返回末端格子 [(x0,y0,x1,y1, 权重)]：权重 = 这条路上每一层概率的连乘"""
    frontier = [((0, 0, shot.size[0], shot.size[1]), 1.0)]
    leaves = []
    calls = 0
    t0 = time.time()
    for depth in range(DEPTH):
        jobs = []
        for box, mass in frontier:
            if mass < BEAM:
                leaves.append((*box, mass))
                continue
            region = shot.crop(box)
            jobs.append((box, mass, region, options(*region.size)))
        if not jobs:
            frontier = []   # 这一层的格子都已经记进 leaves 了
            break
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda j: ask(j[2], j[3], target), jobs))
        calls += len(jobs)
        frontier = []
        for (box, mass, _, opts), probs in zip(jobs, results):
            for kk, (b, _) in opts.items():
                child = (box[0] + b[0], box[1] + b[1], box[0] + b[2], box[1] + b[3])
                frontier.append((child, mass * probs.get(kk, 0.0)))
        print(f"  第{depth + 1}层：问了 {len(jobs)} 块（并行），累计 {calls} 次，{time.time() - t0:.1f}s")
    leaves += [(*b, m) for b, m in frontier]
    return leaves, calls, time.time() - t0


def render(shot, leaves, path, truth=None):
    """亮度 = 概率密度（权重 / 面积），模糊成没有硬边的光晕，叠在压暗的截图上"""
    w, h = shot.size
    ds = 4
    gy, gx = np.mgrid[0:h // ds + 1, 0:w // ds + 1].astype(np.float64)
    gx, gy = gx * ds, gy * ds
    dens = np.zeros_like(gx)
    for x0, y0, x1, y1, m in leaves:
        # 每个末端格子 = 一团高斯光：中心在格子中心，扩散随格子大小（大格子 = 大而淡，小格子 = 小而亮），总量 = 权重
        sx, sy = max(14.0, (x1 - x0) / 2.2), max(14.0, (y1 - y0) / 2.2)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        dens += m / (2 * math.pi * sx * sy) * np.exp(-((gx - cx) ** 2 / (2 * sx ** 2) + (gy - cy) ** 2 / (2 * sy ** 2)))
    # 按概率质量分层：像素按密度从高到低排，累计质量 c ∈ [0,1]；最核心那 50% 最亮，往外到 95% 渐淡
    #（模型越确定，光越小越集中；越拿不准，光摊得越开；两处分歧就亮两块）
    flat = dens.ravel()
    order = np.argsort(-flat)
    cum = np.empty_like(flat)
    cum[order] = np.cumsum(flat[order]) / flat.sum()
    light = np.clip((0.95 - cum.reshape(dens.shape)) / 0.95, 0, 1) ** 0.7
    mask = Image.fromarray((light * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(3)).resize((w, h), Image.BICUBIC)
    mask.save(path.replace('.png', '_mask.png'))
    top = max(leaves, key=lambda l: l[4])
    tx, ty = (top[0] + top[2]) // 2, (top[1] + top[3]) // 2
    print(f'    遮罩：最高权重格中心 ({tx},{ty}) 亮度 {mask.getpixel((tx, ty))}，全图最亮 {mask.getextrema()[1]}，亮度>128 的像素 {sum(1 for v in mask.getdata() if v > 128)}')
    rgb = shot.convert("RGB")
    dim = ImageEnhance.Brightness(rgb).enhance(0.4)
    lit = Image.composite(rgb, dim, mask)                    # 权重高的地方恢复原亮度
    glow = Image.new("RGB", (w, h), GLOW_RGB)
    out = Image.composite(glow, lit, mask.point(lambda v: int(v * 0.45)))  # 再叠一层半透明的橙光
    if truth:
        d = ImageDraw.Draw(out)
        d.ellipse([truth[0] - 3, truth[1] - 3, truth[0] + 3, truth[1] + 3], outline=(80, 220, 255), width=2)
    out.save(path)
    return out


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor():
    p = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def draw_cursor(img, x, y, s):
    pts = [(0, 0), (0, 16), (4, 12), (7, 19), (9, 18), (6, 11), (11, 11)]
    ImageDraw.Draw(img).polygon([(x + px * s, y + py * s) for px, py in pts], fill="white", outline="black", width=max(1, int(s)))


def summarize(leaves, truth):
    total = sum(m for *_, m in leaves)
    top = sorted(leaves, key=lambda l: -l[4])[:3]
    for x0, y0, x1, y1, m in top:
        print(f"    权重 {m / total:.2f}  区域 ({x0},{y0})-({x1},{y1})  中心 ({(x0 + x1) // 2},{(y0 + y1) // 2})")
    if truth:
        near = sum(m for x0, y0, x1, y1, m in leaves if x0 - 30 <= truth[0] <= x1 + 30 and y0 - 30 <= truth[1] <= y1 + 30)
        print(f"    真实位置 30px 范围内的权重合计 {near / total:.2f}")


def main():
    shot = ImageGrab.grab()
    cx, cy = cursor()
    print(f"屏幕 {shot.size}  指针 {(cx, cy)}  模型 {MODEL}  深度 {DEPTH}  继续细分门槛 {BEAM}")
    with_cursor = shot.copy()
    draw_cursor(with_cursor, cx, cy, s=max(1.5, shot.size[0] / 1280))
    tasks = [
        ("cursor", with_cursor, "白色鼠标箭头指针的尖端", (cx, cy)),
        ("clock", shot, "任务栏上显示时间的时钟数字（形如 11:34）", None),
        ("attention", shot, "用户此刻最可能正在看、正在输入或编辑的地方", None),
    ]
    only = sys.argv[1:] or [t[0] for t in tasks]
    for tag, img, target, truth in tasks:
        if tag not in only:
            continue
        print(f"\n=== {tag}：{target}")
        leaves, calls, secs = expand(img, target)
        summarize(leaves, truth)
        path = os.path.join(OUT, f"heat_{tag}.png")
        render(img, leaves, path, truth)
        print(f"    → {path}（{calls} 次请求，{secs:.1f}s）")


main()
