"""实验：决策模型能不能用「格子选择题」在屏幕上定位？
截主屏 → 画格子 + 编号 → 选择题「X 在哪一格」→ 裁出选中那格再细分一次 → 和真实坐标比。
Key 运行时从本地库读，不落盘。"""
import base64
import ctypes
import io
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont, ImageGrab

OUT = os.path.dirname(os.path.abspath(__file__))
MODEL = sys.argv[1] if len(sys.argv) > 1 else "liquid/d1"
SEND_SIDE = 1024

ctypes.windll.shcore.SetProcessDpiAwareness(2)
sys.stdout.reconfigure(encoding="utf-8")


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor():
    p = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def key():
    db = os.path.join(os.environ["LOCALAPPDATA"], "solevup", "solo.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    base, k = con.execute("SELECT base_url, api_key FROM jev_config LIMIT 1").fetchone()
    return base, k


def font(size):
    try:
        return ImageFont.truetype("arialbd.ttf", size)
    except OSError:
        return ImageFont.load_default()


def draw_cursor(img, x, y, s):
    pts = [(0, 0), (0, 16), (4, 12), (7, 19), (9, 18), (6, 11), (11, 11)]
    poly = [(x + px * s, y + py * s) for px, py in pts]
    d = ImageDraw.Draw(img)
    d.polygon(poly, fill="white", outline="black", width=max(1, int(s)))


def grid(img, cols, rows):
    """画格子 + 编号，返回 (标注图, {编号: (x0,y0,x1,y1)})"""
    w, h = img.size
    out = img.convert("RGB").copy()
    d = ImageDraw.Draw(out, "RGBA")
    cells = {}
    f = font(max(14, int(min(w / cols, h / rows) / 6)))
    for r in range(rows):
        for c in range(cols):
            x0, y0 = int(w * c / cols), int(h * r / rows)
            x1, y1 = int(w * (c + 1) / cols), int(h * (r + 1) / rows)
            name = f"{chr(65 + c)}{r + 1}"
            cells[name] = (x0, y0, x1, y1)
            d.rectangle([x0, y0, x1, y1], outline=(0, 255, 255, 230), width=3)
            tb = d.textbbox((x0 + 6, y0 + 4), name, font=f)
            d.rectangle([tb[0] - 4, tb[1] - 3, tb[2] + 4, tb[3] + 3], fill=(0, 0, 0, 170))
            d.text((x0 + 6, y0 + 4), name, fill=(0, 255, 255, 255), font=f)
    return out, cells


def jpeg_b64(img):
    im = img.copy()
    im.thumbnail((SEND_SIDE, SEND_SIDE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


MODE = sys.argv[2] if len(sys.argv) > 2 else "grid"


def crop_parts(raw, cells, target):
    """不画线：一张总览 + 每格原分辨率裁图，各带编号"""
    parts = [{"type": "text", "text": f"下面先是整块区域的总览图，然后是把它切成格子后每一格的原图（按编号）。要找的东西：{target}"},
             {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + jpeg_b64(raw)}}]
    for n, box in cells.items():
        parts.append({"type": "text", "text": f"格子 {n}（第{n[1:]}行第{ord(n[0]) - 64}列）："})
        parts.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + jpeg_b64(raw.crop(box))}})
    return parts


def ask(base, k, img, cells, target, raw=None):
    criteria = {n: f"第{n[1:]}行第{ord(n[0]) - 64}列的格子（编号 {n}）" for n in cells}
    state = crop_parts(raw, cells, target) if MODE == "crops" else [
        {"type": "text", "text": f"这是一张屏幕截图，上面用青色线分成了格子，每格左上角写着编号。要找的东西：{target}"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + jpeg_b64(img)}},
    ]
    body = {
        "model": MODEL,
        "state": state,
        "questions": {"cell": {"type": "choice", "instructions": f"{target} 在哪一格？", "criteria": criteria}},
    }
    url = base.rstrip("/") + "/v1/systemone"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    t0 = time.time()
    try:
        resp = json.loads(opener.open(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        print("  HTTP", e.code, e.read().decode("utf-8", "replace")[:600])
        raise SystemExit(1)
    ms = int((time.time() - t0) * 1000)
    a = resp["answers"]["cell"]
    top = sorted(a["probabilities"].items(), key=lambda kv: -kv[1])[:4]
    return a["choice"], a.get("confidence", 0), top, ms, resp.get("usage", {})


def cell_of(cells, x, y):
    for n, (x0, y0, x1, y1) in cells.items():
        if x0 <= x < x1 and y0 <= y < y1:
            return n
    return None


def probe(base, k, shot, target, truth, tag):
    print(f"\n=== {tag}：{target}  真实位置 {truth}")
    ox, oy = 0, 0
    img = shot
    levels = [(3, 2), (3, 2), (3, 2)] if MODE == "crops" else [(6, 4), (3, 3)]
    for level, (cols, rows) in enumerate(levels):
        marked, cells = grid(img, cols, rows)
        marked.save(os.path.join(OUT, f"grid_{MODE}_{tag}_{level}.png"))
        choice, conf, top, ms, usage = ask(base, k, marked, cells, target, raw=img)
        want = cell_of(cells, truth[0] - ox, truth[1] - oy) if truth else None
        ok = "" if want is None else ("✓" if choice == want else f"✗（应为 {want}）")
        print(f"  第{level + 1}轮 {cols}×{rows}：选 {choice} {ok} 把握 {conf:.2f}  前几名 {[(n, round(p, 2)) for n, p in top]}  {ms}ms  tokens {usage.get('input_tokens', usage)}")
        x0, y0, x1, y1 = cells[choice]
        img = img.crop((x0, y0, x1, y1))
        ox, oy = ox + x0, oy + y0
    cx, cy = ox + img.size[0] / 2, oy + img.size[1] / 2
    if truth:
        print(f"  最终格子中心 ({cx:.0f},{cy:.0f})，离真实位置 {((cx - truth[0]) ** 2 + (cy - truth[1]) ** 2) ** 0.5:.0f}px（最后一格 {img.size[0]}×{img.size[1]}）")
    else:
        print(f"  最终格子中心 ({cx:.0f},{cy:.0f})（最后一格 {img.size[0]}×{img.size[1]}）")


def main():
    base, k = key()
    print("模型", MODEL, "接口", base)
    shot = ImageGrab.grab()
    w, h = shot.size
    cx, cy = cursor()
    print("屏幕", shot.size, "指针", (cx, cy))
    with_cursor = shot.copy()
    draw_cursor(with_cursor, cx, cy, s=max(1.5, w / 1280))
    probe(base, k, with_cursor, "白色的鼠标箭头指针", (cx, cy), "cursor")
    probe(base, k, shot, "屏幕右下角任务栏上显示时间的时钟", None, "clock")


main()
