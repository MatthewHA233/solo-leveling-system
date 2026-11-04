"""Claude 亲自标注：每个分心物给一个粗框 + 浓度，程序把框吸附到真实像素上，再画像素级浓度图。
  thumb：图块，按亮背景上的硬边吸附成精确矩形
  text ：文字，取框内真实笔画像素（膨胀 2px）
  badge：小图标 / 角标，取框内和背景差异大的像素
输出：me_items.json（每项像素框 + 浓度 + 像素数）、me_heat.png（叠加图）、me_density.png（纯浓度图）"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")
OUT = os.path.dirname(os.path.abspath(__file__))
shot = Image.open(os.path.join(OUT, "me_shot.png")).convert("RGB")
W, H = shot.size
px = np.asarray(shot).astype(np.int16)
lum = px.mean(axis=2)

# (名字, 类型, 粗框 x0,y0,x1,y1, 浓度 0~1)
ITEMS = [
    ("封面·剑之大陆（人脸 + 大字）", "thumb", (1540, 286, 1832, 456), 0.95),
    ("封面·当代年轻人最佳版本答案", "thumb", (1540, 552, 1832, 721), 0.88),
    ("封面·Codex 怎么装了两份（浅底，按同列版式直接给框）", "rect", (1545, 824, 1826, 982), 0.70),
    ("封面·被终端挡住的一截（14:49）", "thumb", (1470, 286, 1530, 456), 0.40),
    ("封面·被终端挡住的一截（00:44）", "thumb", (1470, 552, 1530, 721), 0.40),
    ("封面·被终端挡住的一截（下）", "thumb", (1470, 818, 1530, 988), 0.35),
    ("封面·底排 22.7万（露上半截）", "thumb", (334, 898, 626, 988), 0.45),
    ("封面·底排 154.2万", "thumb", (634, 898, 928, 988), 0.55),
    ("封面·底排《禁止禁止》红色大字", "thumb", (936, 898, 1229, 988), 0.75),
    ("封面·底排 有个押送任务", "thumb", (1237, 898, 1531, 988), 0.60),
    ("标题·3天卖了18000份？剑之大陆火了以后", "text", (1540, 460, 1832, 510), 0.55),
    ("标题·年轻人当代最佳版本答案", "text", (1540, 728, 1832, 752), 0.50),
    ("标题·AI工具装了一堆，都装哪儿了？", "text", (1540, 994, 1832, 1018), 0.45),
    ("底排标题（菲比吃完月球… / 找陌生人… / 电登熄灭… / 带蝙蝠侠…）", "text", (334, 994, 1531, 1018), 0.40),
    ("UP 主 / 收藏时间小字", "text", (1540, 514, 1832, 532), 0.15),
    ("书签·(65封未读) 网易邮箱", "text", (1585, 112, 1755, 140), 0.60),
    ("书签·《幻兽帕鲁》正式…", "text", (1478, 112, 1560, 140), 0.30),
    ("B站数据·关注 / 粉丝 / 获赞 / 播放数", "text", (1505, 164, 1825, 216), 0.30),
    ("B站左侧收藏夹列表", "text", (90, 255, 232, 1000), 0.18),
    ("标签页·达克莱伊的棒棒糖的个人空间", "text", (88, 14, 300, 38), 0.22),
    ("任务栏·通知中心 17", "badge", (1862, 1038, 1900, 1074), 0.50),
    ("任务栏·游戏图标（幻兽帕鲁等）", "badge", (750, 1036, 795, 1076), 0.25),
]


def bg_color(box):
    """框外一圈的中位色当背景"""
    x0, y0, x1, y1 = box
    ring = np.concatenate([
        px[max(0, y0 - 4):y0, x0:x1].reshape(-1, 3), px[y1:min(H, y1 + 4), x0:x1].reshape(-1, 3),
        px[y0:y1, max(0, x0 - 4):x0].reshape(-1, 3), px[y0:y1, x1:min(W, x1 + 4)].reshape(-1, 3),
    ])
    return np.median(ring, axis=0) if len(ring) else np.array([245, 245, 245])


def snap_thumb(box):
    """图块：框内和背景明显不同的像素，按行列占比找出连续的实心范围"""
    x0, y0, x1, y1 = box
    region = px[y0:y1, x0:x1]
    diff = np.abs(region - bg_color(box)).sum(axis=2) > 40
    cols = np.where(diff.mean(axis=0) > 0.35)[0]
    rows = np.where(diff.mean(axis=1) > 0.35)[0]
    if len(cols) == 0 or len(rows) == 0:
        return box, None
    sb = (x0 + int(cols[0]), y0 + int(rows[0]), x0 + int(cols[-1]) + 1, y0 + int(rows[-1]) + 1)
    m = np.zeros((H, W), bool)
    m[sb[1]:sb[3], sb[0]:sb[2]] = True
    return sb, m


def snap_ink(box, thresh, dilate):
    """文字 / 角标：框内和背景差异大的像素（笔画），膨胀几像素连成一片"""
    x0, y0, x1, y1 = box
    region = px[y0:y1, x0:x1]
    ink = np.abs(region - bg_color(box)).sum(axis=2) > thresh
    if not ink.any():
        return box, None
    m = np.zeros((H, W), np.uint8)
    m[y0:y1, x0:x1] = ink * 255
    m = np.asarray(Image.fromarray(m).filter(ImageFilter.MaxFilter(dilate * 2 + 1))) > 0
    ys, xs = np.where(m)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1), m


density = np.zeros((H, W), np.float32)
records = []
for name, kind, box, strength in ITEMS:
    if kind == "rect":
        sb, m = box, np.zeros((H, W), bool)
        m[box[1]:box[3], box[0]:box[2]] = True
    elif kind == "thumb":
        sb, m = snap_thumb(box)
    elif kind == "text":
        sb, m = snap_ink(box, 120, 2)
    else:
        sb, m = snap_ink(box, 90, 1)
    if m is None:
        print(f"  ? 没吸附上：{name}")
        continue
    density = np.maximum(density, m * strength)
    records.append({"name": name, "kind": kind, "box": sb, "density": strength, "pixels": int(m.sum())})
    print(f"  {strength:.2f}  {name:<36} 粗框 {box} → 像素框 {sb}  {int(m.sum())} px")

# 浓度图：像素级，只做 2px 的软化（没有实线边框）
soft = np.asarray(Image.fromarray((density * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255
Image.fromarray((soft * 255).astype(np.uint8)).save(os.path.join(OUT, "me_density.png"))

base = np.asarray(shot).astype(np.float32)
dim = base * 0.35
lit = dim + (base - dim) * soft[..., None]                       # 越浓越接近原亮度
glow = np.array([255, 70, 30], np.float32)
out = lit * (1 - soft[..., None] * 0.5) + glow * (soft[..., None] * 0.5)   # 再按浓度叠红橙光
Image.fromarray(out.clip(0, 255).astype(np.uint8)).save(os.path.join(OUT, "me_heat.png"))

total = sum(r["density"] * r["pixels"] for r in records)
print(f"\n共 {len(records)} 项；分心像素 {int((density > 0).sum())}（占屏 {(density > 0).mean() * 100:.1f}%）；浓度加权像素 {total:.0f}")
with open(os.path.join(OUT, "me_items.json"), "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False, indent=1)
