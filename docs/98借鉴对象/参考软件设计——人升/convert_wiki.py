"""
LifeUp-Wiki (Docsify) → Obsidian 笔记转换脚本

输出结构：
  人升官方文档/
    人升官方文档索引.md           ← 入口
    01_概览/
      01_应用介绍.md
      02_更新日志.md
      03_开发计划.md              ← 含4个子计划合并
      ...
    02_指引/
      01_快速开始.md
      ...
      09_开放接口.md              ← api + cloud + desktop 合并
    03_用户分享/
      01_体系建设参考手册.md
      02_体系相关视频.md
    04_版本更新.md                ← 22个版本合并，单文件
    05_补充/
      01_成就.md
      ...

用法：python convert_wiki.py
"""

import re
import shutil
from pathlib import Path

SRC  = Path(__file__).parent / "官方文档-zh-cn/docs/zh-cn"
DST  = Path(__file__).parent / "人升官方文档"

SKIP_NAMES = {"_sidebar.md", "_navbar.md", "index.html", "sw.js", "cover.png"}
SKIP_DIRS  = {"_media", "css", "js"}


# ─────────────────────────────────────────────────────────
# Docsify → Obsidian 语法清理
# ─────────────────────────────────────────────────────────

def clean_docsify(text: str) -> str:
    text = re.sub(r'<h1[^>]*>(.*?)</h1>',
                  lambda m: f"# {_strip_tags(m.group(1))}",
                  text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<p[^>]*>(.*?)</p>',
                  lambda m: _strip_tags(m.group(1)).strip(),
                  text, flags=re.DOTALL | re.IGNORECASE)
    text = _conv_callout(text, "?>", "TIP")
    text = _conv_callout(text, "!>", "WARNING")
    text = re.sub(r"(!\[[^\]]*\]\([^\)]+?)\s+':[^']*'(\))", r'\1\2', text)
    text = re.sub(r'\s*:id=\S+', '', text)
    text = re.sub(r'<br\s*/?>', '  \n', text, flags=re.IGNORECASE)
    text = re.sub(r'!\[\[cover[^\]]*\]\]\n?', '', text)
    text = re.sub(r'\]\(/', '](', text)
    text = re.sub(r'\n{4,}', '\n\n\n', text)
    # 清理标题行内及行首装饰块字符（▌ 等）
    text = re.sub(r'^([#\s]*)[▌▍▎▏▐░▒▓█▄▀■□▪▫]+\s*', r'\1', text, flags=re.MULTILINE)
    return text.strip()


def _strip_tags(s: str) -> str:
    return re.sub(r'<[^>]+>', '', s).strip()


def _conv_callout(text: str, marker: str, kind: str) -> str:
    pattern = re.compile(rf'^{re.escape(marker)} (.+)$', re.MULTILINE)
    def repl(m: re.Match) -> str:
        lines = re.split(r'<br\s*/?>', m.group(1), flags=re.IGNORECASE)
        body = "\n".join(f"> {l.strip()}" for l in lines if l.strip())
        return f"> [!{kind}]\n{body}"
    return pattern.sub(repl, text)


def demote_headings(text: str, levels: int = 1) -> str:
    def bump(m: re.Match) -> str:
        return "#" * min(len(m.group(1)) + levels, 6) + m.group(2)
    return re.sub(r'^(#{1,5})( .+)$', bump, text, flags=re.MULTILINE)


def file_content(rel_path: str) -> str:
    p = SRC / rel_path
    if not p.exists():
        return f"> [!WARNING]\n> 文件不存在：{rel_path}\n"
    return clean_docsify(p.read_text(encoding="utf-8"))


def safe_name(label: str) -> str:
    label = re.sub(
        r'[^\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef'
        r'\u2e80-\u2eff\u31c0-\u31ef（）【】《》、，。！？…—·～\-]',
        '', label
    )
    label = re.sub(r'[\\/:*?"<>|#\[\]]', '', label)
    return re.sub(r'\s+', ' ', label).strip()


# ─────────────────────────────────────────────────────────
# 侧栏解析
# ─────────────────────────────────────────────────────────

def parse_sidebar(sidebar: Path) -> list:
    lines = sidebar.read_text(encoding="utf-8").splitlines()
    entries = []
    for line in lines:
        if not line.strip():
            continue
        m_link = re.match(r'^(\s*)-\s+\[([^\]]+)\]\(([^\)]+)\)', line)
        m_sect = re.match(r'^(\s*)-\s+(.+)', line)
        if m_link:
            indent = len(m_link.group(1)) // 2
            label  = re.sub(r'[*_`]', '', m_link.group(2)).strip()
            path   = m_link.group(3)
            etype  = "external" if path.startswith("http") else "item"
            entries.append({"type": etype, "label": label, "path": path, "indent": indent})
        elif m_sect and not m_sect.group(2).strip().startswith('['):
            indent = len(m_sect.group(1)) // 2
            entries.append({"type": "section", "label": m_sect.group(2).strip(), "indent": indent})
    return entries


# ─────────────────────────────────────────────────────────
# 构建输出计划
# ─────────────────────────────────────────────────────────

def build_plan(entries: list) -> tuple[list, dict]:
    """
    返回 (plan_items, path_to_out_path)。

    plan_item 结构：
      {
        "out_path": Path,            # DST 相对路径（含序号和子目录）
        "sources": [(rel, label, demote), ...],
        "_title": str | None,
      }

    path_to_out_path: 源文件 rel_path → out_path（用于生成索引）
    """
    plan: list[dict] = []
    path_to_out: dict[str, Path] = {}

    # 先识别哪些 section 包含版本号文件（这些 section 会被合并为单文件）
    VERSION_RE = re.compile(r'^\d+\.\d+')

    # ── 第一遍：按 section 分组，识别每个 indent=1 条目
    sections: list[tuple[str, list]] = []  # [(section_label, [entries])]
    cur_section = "（未分类）"
    cur_items: list = []

    for e in entries:
        if e["type"] == "section" and e["indent"] == 0:
            if cur_items:
                sections.append((cur_section, cur_items))
            cur_section = e["label"]
            cur_items = []
        else:
            cur_items.append(e)
    if cur_items:
        sections.append((cur_section, cur_items))

    # ── 第二遍：为每个 section 分配序号，处理条目
    section_seq = 1
    for sec_label, sec_entries in sections:
        sec_items: list[dict] = []  # 本 section 的输出条目

        i = 0
        while i < len(sec_entries):
            e = sec_entries[i]
            if e["type"] in ("section", "external") or e["indent"] == 0:
                i += 1
                continue
            if e["indent"] != 1:
                i += 1
                continue

            # 收集 indent=2 子项
            sources = [(e["path"], e["label"], 0)]
            seen: set[str] = {e["path"]}
            j = i + 1
            while j < len(sec_entries) and sec_entries[j]["indent"] >= 2:
                sub = sec_entries[j]
                if sub["type"] == "item" and sub["path"] not in seen:
                    sources.append((sub["path"], sub["label"], 1))
                    seen.add(sub["path"])
                j += 1

            sec_items.append({"label": e["label"], "sources": sources})
            i = j

        if not sec_items:
            continue  # 空 section（如外部链接），不占编号

        # 判断这个 section 是否都是版本号条目
        all_version = all(VERSION_RE.match(it["label"]) for it in sec_items)

        if all_version:
            # 整节合并为一个文件，放在根目录（不建子文件夹）
            merged_sources = []
            for it in sec_items:
                for path, label, _ in it["sources"]:
                    merged_sources.append((path, label, 1))
            out_path = Path(f"{section_seq:02d}_{safe_name(sec_label)}.md")
            item = {
                "out_path": out_path,
                "sources": merged_sources,
                "_title": f"# {sec_label}\n",
            }
            plan.append(item)
            for path, _, _ in merged_sources:
                path_to_out[path] = out_path
            section_seq += 1
        else:
            # 普通 section → 子文件夹
            sec_dir = Path(f"{section_seq:02d}_{safe_name(sec_label)}")
            file_seq = 1
            for it in sec_items:
                fname = f"{file_seq:02d}_{safe_name(it['label'])}.md"
                out_path = sec_dir / fname
                item = {
                    "out_path": out_path,
                    "sources": it["sources"],
                    "_title": None,
                }
                plan.append(item)
                for path, _, _ in it["sources"]:
                    path_to_out[path] = out_path
                file_seq += 1
            section_seq += 1

    return plan, path_to_out


# ─────────────────────────────────────────────────────────
# 收集侧栏未覆盖的 md 文件
# ─────────────────────────────────────────────────────────

def collect_extra(plan: list, path_to_out: dict) -> tuple[list, dict]:
    referenced = set(path_to_out.keys())

    # 找版本更新那个合并 item，extras 里 features/ 的文件也追加进去
    version_item = next(
        (p for p in plan if (p.get("_title") or "").strip().lstrip("#").strip() in ("版本更新", "更新")),
        None
    )

    extra_map: dict[str, dict] = {}
    extra_out: dict[str, Path] = {}
    # 补充目录序号 = 已有输出的最大序号 + 1
    max_seq = 0
    for p in plan:
        stem = p["out_path"].parts[0]  # 取第一个路径段
        m = re.match(r'^(\d+)_', stem)
        if m:
            max_seq = max(max_seq, int(m.group(1)))
    extra_dir = Path(f"{max_seq + 1:02d}_补充")
    seq = 1

    for f in sorted(SRC.rglob("*.md")):
        rel = str(f.relative_to(SRC)).replace("\\", "/")
        if f.name in SKIP_NAMES:
            continue
        if any(part in SKIP_DIRS for part in f.parts):
            continue
        if rel in referenced:
            continue

        raw = f.read_text(encoding="utf-8")
        m = re.search(r'^#\s+(.+)$', raw, re.MULTILINE)
        if not m:
            m = re.search(r'<h1[^>]*>(.*?)</h1>', raw, re.IGNORECASE | re.DOTALL)
        title = _strip_tags(m.group(1)).strip() if m else f.stem

        # features/ 未引用的版本文件 → 追加到版本更新合并文件
        if rel.startswith("features/") and version_item is not None:
            version_item["sources"].append((rel, title, 1))
            path_to_out[rel] = version_item["out_path"]
            referenced.add(rel)
            continue

        fname = safe_name(title) or safe_name(f.stem) or f.stem
        if fname in extra_map:
            extra_map[fname]["sources"].append((rel, title, 1))
        else:
            out_path = extra_dir / f"{seq:02d}_{fname}.md"
            extra_map[fname] = {
                "out_path": out_path,
                "sources": [(rel, title, 0)],
                "_title": None,
            }
            extra_out[rel] = out_path
            path_to_out[rel] = out_path
            seq += 1

    extras = list(extra_map.values())
    return extras, path_to_out


# ─────────────────────────────────────────────────────────
# 写入
# ─────────────────────────────────────────────────────────

def write_item(item: dict) -> None:
    out_path = DST / item["out_path"]
    out_path.parent.mkdir(parents=True, exist_ok=True)

    parts: list[str] = []
    if item.get("_title"):
        parts.append(item["_title"])

    for path, label, demote in item["sources"]:
        content = file_content(path)
        if demote > 0:
            content = demote_headings(content, demote)
            parts.append(f"\n---\n\n{content}")
        else:
            parts.append(content)

    full = "\n\n".join(p.strip() for p in parts if p.strip())
    out_path.write_text(full + "\n", encoding="utf-8")


def write_index(plan: list, extras: list, path_to_out: dict) -> None:
    sidebar = SRC / "_sidebar.md"
    lines = sidebar.read_text(encoding="utf-8").splitlines()

    out = ["# 人升（LifeUp）官方文档索引\n"]
    current_section = None

    for line in lines:
        m_link = re.match(r'^(\s*)-\s+\[([^\]]+)\]\(([^\)]+)\)', line)
        m_sect = re.match(r'^(\s*)-\s+(.+)', line)

        if m_link:
            indent = len(m_link.group(1)) // 2
            label  = re.sub(r'[*_`]', '', m_link.group(2)).strip()
            path   = m_link.group(3)
            if path.startswith("http"):
                continue
            op = path_to_out.get(path)
            if op:
                # wikilink 用不含 .md 的路径（Obsidian 自动识别）
                link_name = str(op.with_suffix("")).replace("\\", "/")
                prefix = "  " * (indent - 1)
                out.append(f"{prefix}- [[{link_name}|{label}]]")

        elif m_sect and not m_sect.group(2).strip().startswith('['):
            section = m_sect.group(2).strip()
            if section != current_section:
                current_section = section
                out.append(f"\n## {section}\n")

    if extras:
        out.append("\n## 补充文档\n")
        for item in extras:
            link_name = str(item["out_path"].with_suffix("")).replace("\\", "/")
            _, display = item["out_path"].stem.split("_", 1) if "_" in item["out_path"].stem else ("", item["out_path"].stem)
            out.append(f"- [[{link_name}|{display}]]")

    (DST / "人升官方文档索引.md").write_text("\n".join(out) + "\n", encoding="utf-8")


# ─────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────

def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    entries = parse_sidebar(SRC / "_sidebar.md")
    plan, path_to_out = build_plan(entries)
    extras, path_to_out = collect_extra(plan, path_to_out)

    for item in plan + extras:
        write_item(item)

    write_index(plan, extras, path_to_out)

    print(f"生成 {len(plan)} 个主条目 + {len(extras)} 个补充文件")
    print(f"输出目录：{DST}\n")
    for f in sorted(DST.rglob("*")):
        rel = f.relative_to(DST)
        if f.is_dir():
            print(f"  📁 {rel}/")
        else:
            print(f"     {rel}")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
