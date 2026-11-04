"""实时扫描：屏幕上哪一块有「容易抓走注意力、但和主线无关」的东西？
一张截图 → 一次请求里 12 道是非题（4×3 块，方位词写在题目里）→ 每块一个分数。
流水线：同时 CONCURRENCY 个请求在路上，不等上一个回来就发下一张。
屏幕上叠一层透明、鼠标穿透、不抢焦点、不被截图的光晕：分数高的块泛红橙光。
用法：python distraction_scan.py [秒数=60] [并发=4]   Key 运行时从本地库读，不落盘。"""
import base64
import ctypes
import io
import json
import math
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageGrab

ctypes.windll.shcore.SetProcessDpiAwareness(2)
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 60
CONCURRENCY = int(sys.argv[2]) if len(sys.argv) > 2 else 4
MAIN_LINE = os.environ.get("MAIN_LINE", "开发 Solevup 这个软件（写代码、调试、看 Claude Code 终端、查技术资料、看自己的软件界面）")
MODEL = "liquid/d1"
COLS, ROWS = 4, 3
SEND_SIDE = 1024
SHOW_AT = 0.08       # 这一块的概率高于这个就开始发光（越高越亮）
OUT = os.path.dirname(os.path.abspath(__file__))

H4 = ["最左边", "左中", "右中", "最右边"]
V3 = ["上部", "中部", "下部"]


def cells(w, h):
    out = []
    for r in range(ROWS):
        for c in range(COLS):
            out.append((f"r{r + 1}c{c + 1}", (w * c // COLS, h * r // ROWS, w * (c + 1) // COLS, h * (r + 1) // ROWS),
                        f"屏幕{V3[r]}、{H4[c]}那一块（横向第 {c + 1}/{COLS} 份、纵向第 {r + 1}/{ROWS} 份）"))
    return out


def key():
    db = os.path.join(os.environ["LOCALAPPDATA"], "solevup", "solo.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    return con.execute("SELECT base_url, api_key FROM jev_config LIMIT 1").fetchone()


BASE, KEY = key()
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


CROP_SIDE = 512
PER_REQUEST = 6      # 一个请求最多 8 张图：每次放 6 块


def b64_jpeg(img, side):
    im = img.convert("RGB")
    im.thumbnail((side, side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def ask_batch(shot, batch):
    """一批块：每块一张原分辨率裁图 + 一道只问它自己的是非题"""
    state = [{"type": "text", "text": f"用户此刻的主线：{MAIN_LINE}。下面是用户屏幕切成的几块，每块单独一张图，按编号排列。"}]
    questions = {}
    for k, box, place in batch:
        state.append({"type": "text", "text": f"块 {k}（{place.split('（')[0]}）："})
        state.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64_jpeg(shot.crop(box), CROP_SIDE)}})
        questions[k] = {"type": "noul", "instructions": f"块 {k} 这张图里，有容易抓走用户注意力、但和主线无关的东西（比如弹窗、通知、聊天消息、推荐视频、广告、游戏、短视频、新闻热搜）；空白、正在加载、和主线相关的内容都不算"}
    body = {"model": MODEL, "state": state, "questions": questions}
    req = urllib.request.Request(BASE.rstrip("/") + "/v1/systemone", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    resp = json.loads(OPENER.open(req, timeout=30).read())
    return resp["answers"], resp.get("usage", {}).get("input_tokens", 0)


BATCH_POOL = ThreadPoolExecutor(max_workers=16)


NONE_KEY = "none"


def scan(shot):
    """一张干净的整屏图 + 一道选择题：最抓眼又和主线无关的东西在哪一块（或者没有）。
    选择题逼它在各块之间比较；每块的概率就是光的分布，「没有」的概率高时整屏不亮。"""
    cs = cells(*shot.size)
    criteria = {k: f"在{place}" for k, _, place in cs}
    criteria[NONE_KEY] = "屏幕上没有这种东西（都是和主线相关的内容、空白或正常界面）"
    body = {
        "model": MODEL,
        "state": [
            {"type": "text", "text": f"用户此刻的主线：{MAIN_LINE}。下面是用户整块屏幕的截图。"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64_jpeg(shot, SEND_SIDE)}},
        ],
        "questions": {"where": {"type": "choice",
                                "instructions": "屏幕上最容易抓走用户注意力、但和主线无关的东西（比如弹窗、通知、聊天消息、推荐视频封面、广告、游戏、短视频、热搜）在哪个位置？",
                                "criteria": criteria}},
    }
    req = urllib.request.Request(BASE.rstrip("/") + "/v1/systemone", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    resp = json.loads(OPENER.open(req, timeout=30).read())
    probs = resp["answers"]["where"]["probabilities"]
    out = {k: (box, place, float(probs.get(k, 0.0))) for k, box, place in cs}
    out[NONE_KEY] = ((0, 0, 0, 0), "没有", float(probs.get(NONE_KEY, 0.0)))
    return out, resp.get("usage", {}).get("input_tokens", 0)


# ── 透明叠加层（分层窗口，逐像素透明；鼠标穿透、不抢焦点、不被截图）──

user32, gdi32, kernel32 = ctypes.windll.user32, ctypes.windll.gdi32, ctypes.windll.kernel32
WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = ctypes.c_ssize_t
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.CreateWindowExW.restype = wintypes.HWND
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
user32.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte), ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


user32.UpdateLayeredWindow.argtypes = [wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT), ctypes.POINTER(wintypes.SIZE),
                                       wintypes.HDC, ctypes.POINTER(wintypes.POINT), wintypes.COLORREF, ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


class Overlay:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self._proc = WNDPROC(lambda hwnd, msg, wp, lp: user32.DefWindowProcW(hwnd, msg, wp, lp))
        wc = WNDCLASSW(lpfnWndProc=self._proc, hInstance=kernel32.GetModuleHandleW(None), lpszClassName="SolevupScanGlow")
        user32.RegisterClassW(ctypes.byref(wc))
        ex = 0x00080000 | 0x00000020 | 0x00000008 | 0x00000080 | 0x08000000  # LAYERED | TRANSPARENT | TOPMOST | TOOLWINDOW | NOACTIVATE
        self.hwnd = user32.CreateWindowExW(ex, "SolevupScanGlow", "", 0x80000000, 0, 0, w, h, None, None, wc.hInstance, None)
        user32.SetWindowDisplayAffinity(self.hwnd, 0x11)   # WDA_EXCLUDEFROMCAPTURE：自己的光不会被截进下一张图
        user32.ShowWindow(self.hwnd, 4)                     # SW_SHOWNOACTIVATE

    def show(self, rgba):
        arr = np.asarray(rgba, dtype=np.uint8).astype(np.uint16)
        a = arr[..., 3:4]
        pre = (arr[..., :3] * a // 255).astype(np.uint8)
        bgra = np.concatenate([pre[..., ::-1], a.astype(np.uint8)], axis=2).copy()
        screen = user32.GetDC(None)
        mem = gdi32.CreateCompatibleDC(screen)
        bmi = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=self.w, biHeight=-self.h, biPlanes=1, biBitCount=32)
        bits = ctypes.c_void_p()
        hbmp = gdi32.CreateDIBSection(mem, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
        ctypes.memmove(bits, bgra.ctypes.data, bgra.nbytes)
        old = gdi32.SelectObject(mem, hbmp)
        blend = BLENDFUNCTION(0, 0, 255, 1)
        user32.UpdateLayeredWindow(self.hwnd, screen, ctypes.byref(wintypes.POINT(0, 0)), ctypes.byref(wintypes.SIZE(self.w, self.h)),
                                   mem, ctypes.byref(wintypes.POINT(0, 0)), 0, ctypes.byref(blend), 2)
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(None, screen)

    def pump(self):
        msg = wintypes.MSG()
        while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def close(self):
        user32.DestroyWindow(self.hwnd)


def glow(w, h, result):
    """分数高的块：一团没有边框的红橙光（越确定越亮）"""
    ds = 4
    gy, gx = np.mgrid[0:h // ds, 0:w // ds].astype(np.float32)
    gx, gy = gx * ds, gy * ds
    alpha = np.zeros_like(gx)
    # 亮度 = 这一块在各块里的相对份额 × 屏幕上「有分心物」的总强度（1 − 「没有」的概率）
    #   满屏 B 站：总强度高、份额平摊 → 整屏都亮；终端角落几张封面 → 只亮角落；纯终端 → 「没有」占大头，不亮
    total = 1.0 - result.get(NONE_KEY, (None, None, 0.0))[2]
    peak = max((s for k, (_, _, s) in result.items() if k != NONE_KEY), default=0.0)
    if total < SHOW_AT or peak <= 0:
        return Image.new("RGBA", (w, h), (255, 70, 30, 0))
    for k, (box, _, s) in result.items():
        if k == NONE_KEY:
            continue
        level = (s / peak) * total
        if level < SHOW_AT:
            continue
        x0, y0, x1, y1 = box
        sx, sy = (x1 - x0) / 2.6, (y1 - y0) / 2.6
        g = np.exp(-(((gx - (x0 + x1) / 2) / sx) ** 2 + ((gy - (y0 + y1) / 2) / sy) ** 2) / 2)
        alpha = np.maximum(alpha, g * level ** 0.8 * 0.8)
    a = Image.fromarray((alpha * 255).astype(np.uint8), "L").resize((w, h), Image.BILINEAR)
    img = Image.new("RGBA", (w, h), (255, 70, 30, 0))
    img.putalpha(a)
    return img


try:
    HUD_FONT = ImageFont.truetype("msyh.ttc", 18)
except OSError:
    HUD_FONT = ImageFont.load_default()


def hud(img, text):
    """右上角常驻小读数：没有光的时候也看得出它在扫"""
    d = ImageDraw.Draw(img)
    tb = d.textbbox((0, 0), text, font=HUD_FONT)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    x, y = img.size[0] - tw - 40, 60
    d.rounded_rectangle([x - 12, y - 8, x + tw + 12, y + th + 12], radius=8, fill=(12, 14, 18, 215))
    d.text((x, y), text, font=HUD_FONT, fill=(255, 170, 120, 255))
    return img


# ── 主循环 ──

def main():
    w, h = ImageGrab.grab().size
    overlay = Overlay(w, h)
    lock = threading.Lock()
    state = {"latest_cap": 0.0, "result": None, "done": 0, "tokens": 0, "lat": [], "errors": 0}
    stop = time.time() + DURATION
    print(f"主线：{MAIN_LINE}\n屏幕 {w}×{h}，{COLS}×{ROWS} 块，并发 {CONCURRENCY}，跑 {DURATION:.0f} 秒")

    def worker(i):
        time.sleep(i * 0.35)        # 错开发送，让结果均匀地回来
        while time.time() < stop:
            cap = time.time()
            shot = ImageGrab.grab()
            try:
                res, tokens = scan(shot)
            except Exception as e:  # noqa: BLE001 —— 实验脚本：记一下继续扫
                with lock:
                    state["errors"] += 1
                print(f"  ! {type(e).__name__}: {str(e)[:120]}")
                time.sleep(1)
                continue
            now = time.time()
            with lock:
                state["done"] += 1
                state["tokens"] += tokens
                state["lat"].append(now - cap)
                if cap > state["latest_cap"]:       # 只留最新那张截图的结果
                    state["latest_cap"] = cap
                    state["result"] = (res, now - cap)

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(CONCURRENCY)]
    for t in threads:
        t.start()
    overlay.show(hud(Image.new("RGBA", (w, h), (0, 0, 0, 0)), "分心扫描 · 启动中…"))
    shown_cap = 0.0
    last_print = 0.0
    t0 = time.time()
    try:
        while time.time() < stop:
            overlay.pump()
            with lock:
                cap, result = state["latest_cap"], state["result"]
            if result and cap != shown_cap:
                shown_cap = cap
                res, lat = result
                img = glow(w, h, res)
                hot = sorted(((s, place) for _, place, s in res.values()), reverse=True)[:3]
                with lock:
                    n_done = state["done"]
                strength = 1.0 - res[NONE_KEY][2]
                top = max(((s, pl) for kk, (_, pl, s) in res.items() if kk != NONE_KEY), default=(0.0, ""))
                overlay.show(hud(img.copy(), f"分心扫描 #{n_done} · 延迟 {lat:.1f}s · 分心强度 {strength:.2f} · 最集中 {top[1].split('（')[0].replace('屏幕', '')}"))
                print(f"  {time.time() - t0:5.1f}s  截图到结果 {lat:.2f}s  分心强度 {strength:.2f}  最抓眼的：" + "；".join(f"{p.split('（')[0]} {s:.2f}" for s, p in hot))
                if time.time() - last_print > 15:
                    last_print = time.time()
                    Image.alpha_composite(ImageGrab.grab().convert("RGBA"), img).save(os.path.join(OUT, f"scan_{int(time.time() - t0):02d}s.png"))
            time.sleep(0.03)
    finally:
        overlay.close()
        n = state["done"]
        elapsed = time.time() - t0
        print(f"\n共 {n} 次判断，{elapsed:.0f} 秒 → 平均每 {elapsed / max(n, 1):.2f} 秒更新一次；"
              f"截图到结果平均 {sum(state['lat']) / max(n, 1):.2f}s；token {state['tokens']}；出错 {state['errors']} 次")


main()
