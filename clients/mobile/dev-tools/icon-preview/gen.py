#!/usr/bin/env python3
"""从 TabBar.tsx / FairyOrb.tsx 提取 SVG,生成放大预览 HTML(单一来源是 tsx)"""
import re, sys, os

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')

def jsx_to_svg(jsx: str) -> str:
    s = jsx
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.S)
    # JSX 表达式属性 {0.45} / {`...`} → 字面量
    s = re.sub(r'=\{"?([^}"]+)"?\}', r'="\1"', s)
    # 组件名 → 小写
    for a, b in [('Svg','svg'),('Path','path'),('Circle','circle'),('Rect','rect'),
                 ('RadialGradient','radialGradient'),('Stop','stop'),('Defs','defs')]:
        s = re.sub(rf'<{a}(\s|>|/)', rf'<{b}\1', s)
        s = re.sub(rf'</{a}>', rf'</{b}>', s)
    # camelCase 属性 → kebab
    for a, b in [('strokeWidth','stroke-width'),('strokeLinecap','stroke-linecap'),
                 ('strokeLinejoin','stroke-linejoin'),('fillOpacity','fill-opacity'),
                 ('strokeDasharray','stroke-dasharray'),('stopColor','stop-color'),
                 ('stopOpacity','stop-opacity'),('fillRule','fill-rule')]:
        s = s.replace(a, b)
    return s

def extract_icons(path):
    src = open(path).read()
    icons = {}
    for m in re.finditer(r'function (Icon\w+)\(.*?\n\}', src, flags=re.S):
        name = m.group(1)
        body = m.group(0)
        svg_m = re.search(r'<Svg.*</Svg>', body, flags=re.S)
        if not svg_m: continue
        svg = jsx_to_svg(svg_m.group(0))
        svg = re.sub(r'width="size"|width="\{size\}"', 'width="220"', svg)
        svg = re.sub(r'height="size"|height="\{size\}"', 'height="220"', svg)
        svg = svg.replace('opacity="active ? 1 : 0.45"', 'opacity="1"')
        icons[name] = svg
    return icons

def extract_fairy():
    src = open(os.path.join(ROOT, 'src/components/FairyOrb.tsx')).read()
    # 提取三段 <Svg ...>...</Svg>
    svgs = re.findall(r'<Svg.*?</Svg>', src, flags=re.S)
    out = []
    for svg in svgs:
        s = jsx_to_svg(svg)
        s = re.sub(r'width="canvas"', 'width="400"', s)
        s = re.sub(r'height="canvas"', 'height="400"', s)
        s = s.replace('viewBox="`0 0 ${VB} ${VB}`"', 'viewBox="0 0 400 400"')
        s = re.sub(r'viewBox="[^"]*VB[^"]*"', 'viewBox="0 0 400 400"', s)
        # cx={C} 等
        s = s.replace('cx="C"', 'cx="200"').replace('cy="C"', 'cy="200"')
        s = s.replace('d="GYRO_PATH"', '')
        s = s.replace('style="{{ position: \'absolute\' }}"', '')
        out.append(s)
    # gyro path 单独拼
    gyro = re.search(r"const GYRO_PATH =\n((?:.|\n)*?)\n\n", src).group(1)
    gyro_d = ''.join(re.findall(r"'([^']*)'", gyro))
    sc = 280/340
    tx = 200 - 170*sc
    return out, gyro_d, sc, tx

icons = extract_icons(os.path.join(ROOT, 'src/components/TabBar.tsx'))
fairy_svgs, gyro_d, sc, tx = extract_fairy()

html = ['<!doctype html><meta charset="utf-8"><body style="background:#F4F4F1;font-family:sans-serif;padding:20px">']
html.append('<h3>TabBar 图标(220px 放大,浅色底)</h3><div style="display:flex;gap:30px;flex-wrap:wrap">')
for name, svg in icons.items():
    html.append(f'<div style="text-align:center"><div style="background:#FFFFFF;padding:16px;border-radius:12px">{svg}</div><p>{name}</p></div>')
html.append('</div>')
# FairyOrb 静态合成(400px)
html.append('<h3>FairyOrb(400px,浅色底)</h3>')
html.append('<div style="position:relative;width:400px;height:400px;background:#FFFFFF;border-radius:12px">')
html.append(f'<div style="position:absolute;inset:0">{fairy_svgs[0]}</div>')
html.append(f'<div style="position:absolute;inset:0"><svg width="400" height="400" viewBox="0 0 400 400"><path d="{gyro_d}" fill="rgb(7,22,72)" transform="translate({tx} {tx}) scale({sc})"/></svg></div>')
html.append(f'<div style="position:absolute;inset:0">{fairy_svgs[2] if len(fairy_svgs)>2 else fairy_svgs[1]}</div>')
# 卫星球 142°
import math
ang = math.radians(142)
bx = 200 + math.sin(ang)*36; by = 200 - math.cos(ang)*36
html.append(f'<div style="position:absolute;left:{bx-22}px;top:{by-22}px;width:44px;height:44px;border-radius:22px;background:#fff"></div>')
html.append('</div></body>')
open('/tmp/icon-preview.html','w').write('\n'.join(html))
print('html ok:', list(icons.keys()), 'fairy svgs:', len(fairy_svgs))
