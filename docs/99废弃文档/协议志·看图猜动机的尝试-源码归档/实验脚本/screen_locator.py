"""屏幕自适应定位：决策模型 + 程序生成的方位选项，逐轮细分到 5px。
每轮按当前区域长宽比决定切几行几列（每向最多 3 份，格子尽量方），选项文字由程序生成（方位词 + 第几份），
只发一张干净的图（当前区域，太小就放大），选中哪块就裁出来进下一轮，直到两边都 ≤ PRECISION。
用法：python -I screen_locator.py [精度px=5] [模型]   Key 运行时从本地库读，不落盘。"""
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

from PIL import Image, ImageDraw, ImageGrab

ctypes.windll.shcore.SetProcessDpiAwareness(2)
sys.stdout.reconfigure(encoding="utf-8")

PRECISION = int(sys.argv[1]) if len(sys.argv) > 1 else 5
MODEL = sys.argv[2] if len(sys.argv) > 2 else "liquid/d1"
SEND_MAX = 1024     # 发出去的图最长边不超过
SEND_MIN = 512      # 区域太小时放大到至少这么大（不然几十像素的碎片模型看不见）
MAX_SPLIT = 3       # 每个方向最多切几份
GIVE_UP = 0.35      # 把握低于这个就停在当前这一层


# ── 选项清单（程序生成）──

H_NAMES = {1: [""], 2: ["左", "右"], 3: ["左", "中", "右"]}
V_NAMES = {1: [""], 2: ["上", "下"], 3: ["上", "中", "下"]}


def plan_split(w, h):
    """按长宽比决定切几列几行：格子尽量接近正方形"""
    if max(w, h) <= PRECISION:
        return 1, 1
    best = None
    for cols in range(1, MAX_SPLIT + 1):
        for rows in range(1, MAX_SPLIT + 1):
            if cols * rows < 2:
                continue
            cw, ch = w / cols, h / rows
            # 细分越多越好；格子越方越好；已经够细的那一向不再切
            if (w <= PRECISION and cols > 1) or (h <= PRECISION and rows > 1):
                continue
            score = -cols * rows + abs(math.log(cw / ch)) * 2
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
    """{选项 key: (像素框, 选项文字)}"""
    cols, rows = plan_split(w, h)
    out = {}
    for r in range(rows):
        for c in range(cols):
            box = (round(w * c / cols), round(h * r / rows), round(w * (c + 1) / cols), round(h * (r + 1) / rows))
            parts = []
            if cols > 1:
                parts.append(f"横向第 {c + 1}/{cols} 份")
            if rows > 1:
                parts.append(f"纵向第 {r + 1}/{rows} 份")
            out[f"r{r + 1}c{c + 1}"] = (box, f"在图的{place_name(c, r, cols, rows)}（{'、'.join(parts)}）")
    return out


# ── 调用 ──

def key():
    db = os.path.join(os.environ["LOCALAPPDATA"], "solevup", "solo.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    return con.execute("SELECT base_url, api_key FROM jev_config LIMIT 1").fetchone()


def to_send(img):
    im = img.convert("RGB")
    w, h = im.size
    scale = min(SEND_MAX / max(w, h), max(1.0, SEND_MIN / max(w, h)))
    if scale != 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS if scale < 1 else Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode(), im.size


def ask(base, k, img, opts, target):
    b64, sent = to_send(img)
    body = {
        "model": MODEL,
        "state": [
            {"type": "text", "text": f"这是一张屏幕截图（或其中一块，可能被放大过）。要找的东西：{target}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        ],
        "questions": {"where": {"type": "choice", "instructions": f"{target}在图中的哪个位置？", "criteria": {kk: t for kk, (_, t) in opts.items()}}},
    }
    req = urllib.request.Request(base.rstrip("/") + "/v1/systemone", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        print("  HTTP", e.code, e.read().decode("utf-8", "replace")[:400])
        raise SystemExit(1)
    a = resp["answers"]["where"]
    top = sorted(a["probabilities"].items(), key=lambda kv: -kv[1])[:3]
    return a["choice"], a.get("confidence", 0), top, int((time.time() - t0) * 1000), sent


def locate(base, k, shot, target, truth=None):
    """返回最终区域 (x0,y0,x1,y1)；truth 给了就逐轮对答案"""
    x0, y0, img = 0, 0, shot
    total = 0
    for level in range(1, 20):
        w, h = img.size
        if w <= PRECISION and h <= PRECISION:
            break
        opts = options(w, h)
        choice, conf, top, ms, sent = ask(base, k, img, opts, target)
        total += ms
        line = f"  第{level}轮 区域 {w}×{h}（发 {sent[0]}×{sent[1]}）切 {len(opts)} 份：选「{opts[choice][1]}」把握 {conf:.2f}  {ms}ms"
        if truth:
            want = next((kk for kk, (b, _) in opts.items() if b[0] <= truth[0] - x0 < b[2] and b[1] <= truth[1] - y0 < b[3]), None)
            line += "  ✓" if choice == want else f"  ✗ 应为「{opts[want][1] if want else '区域外'}」"
        print(line)
        if conf < GIVE_UP:
            print(f"  把握 {conf:.2f} 太低，停在这一层")
            break
        b = opts[choice][0]
        img = img.crop(b)
        x0, y0 = x0 + b[0], y0 + b[1]
    region = (x0, y0, x0 + img.size[0], y0 + img.size[1])
    cx, cy = (region[0] + region[2]) / 2, (region[1] + region[3]) / 2
    msg = f"  → 最终 {img.size[0]}×{img.size[1]} 区域，中心 ({cx:.0f},{cy:.0f})，共 {total}ms"
    if truth:
        msg += f"，离真实位置 {math.hypot(cx - truth[0], cy - truth[1]):.0f}px"
    print(msg)
    return region


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor():
    p = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def draw_cursor(img, x, y, s):
    pts = [(0, 0), (0, 16), (4, 12), (7, 19), (9, 18), (6, 11), (11, 11)]
    ImageDraw.Draw(img).polygon([(x + px * s, y + py * s) for px, py in pts], fill="white", outline="black", width=max(1, int(s)))


def main():
    base, k = key()
    shot = ImageGrab.grab()
    cx, cy = cursor()
    print(f"精度 {PRECISION}px  模型 {MODEL}  屏幕 {shot.size}  指针 {(cx, cy)}")
    print("首轮选项清单：")
    for kk, (b, t) in options(*shot.size).items():
        print(f"  {kk}: {t}  {b}")
    with_cursor = shot.copy()
    draw_cursor(with_cursor, cx, cy, s=max(1.5, shot.size[0] / 1280))
    print(f"\n=== 白色鼠标箭头的尖端（真实 {(cx, cy)}）")
    locate(base, k, with_cursor, "白色鼠标箭头指针的尖端", (cx, cy))
    clock = tuple(int(v) for v in os.environ.get("CLOCK", "1745,1050").split(","))
    print(f"\n=== 任务栏时钟（大约 {clock}）")
    locate(base, k, shot, "任务栏上显示时间的时钟数字（形如 11:34）", clock)


main()
