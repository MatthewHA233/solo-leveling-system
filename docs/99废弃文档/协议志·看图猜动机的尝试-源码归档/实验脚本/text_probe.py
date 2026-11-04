"""实验：只发一张干净截图（不画格子），位置全写在选项文字里，看决策模型能不能定位。
两种写法：words = 方位词；box = 视觉模型惯用的 0~1000 归一化坐标框。每轮 3×3，选中那块裁出来再问，三轮。
用法：python -I text_probe.py <words|box> [模型]   Key 运行时从本地库读，不落盘。"""
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

from PIL import Image, ImageDraw, ImageGrab

ctypes.windll.shcore.SetProcessDpiAwareness(2)
sys.stdout.reconfigure(encoding="utf-8")

STYLE = sys.argv[1] if len(sys.argv) > 1 else "words"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "liquid/d1"
SEND_SIDE = 1024
ROUNDS = 3
NAMES = [["左上", "上中", "右上"], ["左中", "正中", "右中"], ["左下", "下中", "右下"]]
OUT = os.path.dirname(os.path.abspath(__file__))


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor():
    p = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def key():
    db = os.path.join(os.environ["LOCALAPPDATA"], "solevup", "solo.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    return con.execute("SELECT base_url, api_key FROM jev_config LIMIT 1").fetchone()


def draw_cursor(img, x, y, s):
    pts = [(0, 0), (0, 16), (4, 12), (7, 19), (9, 18), (6, 11), (11, 11)]
    ImageDraw.Draw(img).polygon([(x + px * s, y + py * s) for px, py in pts], fill="white", outline="black", width=max(1, int(s)))


def jpeg_b64(img):
    im = img.convert("RGB")
    im.thumbnail((SEND_SIDE, SEND_SIDE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def cells_of(w, h):
    """3×3：{选项 key: (像素框, 选项文字)}"""
    out = {}
    for r in range(3):
        for c in range(3):
            box = (w * c // 3, h * r // 3, w * (c + 1) // 3, h * (r + 1) // 3)
            n = [c * 1000 // 3, r * 1000 // 3, (c + 1) * 1000 // 3, (r + 1) * 1000 // 3]
            if STYLE == "box":
                text = f"在图中这个范围里：[{n[0]},{n[1]},{n[2]},{n[3]}]（左上角 x1,y1 到右下角 x2,y2，坐标按 0~1000 归一化）"
            else:
                text = f"在图的{NAMES[r][c]}（横向第 {c + 1} 份、纵向第 {r + 1} 份，各占三分之一）"
            out[f"r{r + 1}c{c + 1}"] = (box, text)
    return out


def ask(base, k, img, cells, target):
    body = {
        "model": MODEL,
        "state": [
            {"type": "text", "text": f"这是一张屏幕截图（或其中一块）。要找的东西：{target}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + jpeg_b64(img)}},
        ],
        "questions": {"where": {"type": "choice", "instructions": f"{target}在图中的哪个位置？", "criteria": {kk: t for kk, (_, t) in cells.items()}}},
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
    return a["choice"], a.get("confidence", 0), top, int((time.time() - t0) * 1000), resp.get("usage", {}).get("input_tokens")


def probe(base, k, shot, target, truth, tag):
    print(f"\n=== {tag}：{target}  真实位置 {truth}")
    ox, oy, img, total = 0, 0, shot, 0
    for level in range(ROUNDS):
        cells = cells_of(*img.size)
        choice, conf, top, ms, tokens = ask(base, k, img, cells, target)
        total += ms
        want = next((kk for kk, (b, _) in cells.items() if b[0] <= truth[0] - ox < b[2] and b[1] <= truth[1] - oy < b[3]), None)
        mark = "✓" if choice == want else f"✗（应为 {want}）"
        print(f"  第{level + 1}轮 {img.size[0]}×{img.size[1]}：选 {choice} {mark} 把握 {conf:.2f}  前几名 {[(n, round(p, 2)) for n, p in top]}  {ms}ms  tokens {tokens}")
        box = cells[choice][0]
        img = img.crop(box)
        ox, oy = ox + box[0], oy + box[1]
    cx, cy = ox + img.size[0] / 2, oy + img.size[1] / 2
    print(f"  最终中心 ({cx:.0f},{cy:.0f})，离真实位置 {((cx - truth[0]) ** 2 + (cy - truth[1]) ** 2) ** 0.5:.0f}px，三轮共 {total}ms")


def main():
    base, k = key()
    shot = ImageGrab.grab()
    cx, cy = cursor()
    print("写法", STYLE, "模型", MODEL, "屏幕", shot.size, "指针", (cx, cy))
    with_cursor = shot.copy()
    draw_cursor(with_cursor, cx, cy, s=max(1.5, shot.size[0] / 1280))
    probe(base, k, with_cursor, "白色的鼠标箭头指针", (cx, cy), "指针")
    clock = tuple(int(v) for v in os.environ.get("CLOCK", "1745,1050").split(","))
    probe(base, k, shot, "任务栏上显示时间的时钟（形如 11:34 的数字）", clock, "时钟")


main()
