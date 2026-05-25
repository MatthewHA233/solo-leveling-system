#!/usr/bin/env python3
"""
Solo Leveling mobile —— 发布 release APK 到阿里云 OSS。

流程：
  1. 读 clients/mobile/VERSION 拿 versionName/versionCode
  2. 检查 release APK 是否存在；不存在就跑 `./gradlew assembleRelease`
  3. SHA256 校验
  4. 上传 APK 到 OSS：solo-leveling/android/releases/sls-{versionName}-vc{code}-{sha}.apk
     （文件名带 sha 前缀绕开 CDN 旧缓存；OSS 只保留 latest，先清掉旧 sls-*.apk）
  5. 写 latest.json 上传到 solo-leveling/android/latest.json
  6. 输出公开访问 URL

OSS 配置：复用 MW_ActivityMonitor/.env（OSS_ACCESS_KEY_ID/SECRET/BUCKET/ENDPOINT），
路径前缀和自定义域则按 sls 自己的：

  OSS_BUCKET_NAME=horizn
  OSS_ENDPOINT=oss-cn-heyuan.aliyuncs.com
  OSS_CUSTOM_DOMAIN=https://assets.lingflow.cn        (可选)
  SLS_OSS_PATH_PREFIX=solo-leveling                   (默认 solo-leveling)

用法：
  python scripts/release_mobile.py                # 用现有 release APK
  python scripts/release_mobile.py --build        # 先重建 release APK
  python scripts/release_mobile.py --changelog "..." [--min-supported 1]

依赖：pip install oss2 python-dotenv
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

STEP_TOTAL = 8
_step_n = [0]
_t_global = [time.time()]


def step(label: str) -> float:
    """打印阶段头并返回 start 时间戳。结尾用 step_done(t0) 收尾。"""
    _step_n[0] += 1
    n = _step_n[0]
    elapsed = time.time() - _t_global[0]
    print(f"\n[{n}/{STEP_TOTAL}] {label}   ({elapsed:.1f}s since start)", flush=True)
    return time.time()


def step_done(t0: float) -> None:
    print(f"    ✓ 完成（{time.time() - t0:.1f}s）", flush=True)


def info(msg: str) -> None:
    print(f"    {msg}", flush=True)

try:
    import oss2
except ImportError:
    print("需要 oss2 库：pip install oss2 python-dotenv", file=sys.stderr)
    sys.exit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore


REPO_ROOT = Path(__file__).resolve().parent.parent
MOBILE_DIR = REPO_ROOT / "clients" / "mobile"
ANDROID_DIR = MOBILE_DIR / "android"
APK_PATH = ANDROID_DIR / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
VERSION_FILE = MOBILE_DIR / "VERSION"

# sls 自己的 .env（OSS_ACCESS_KEY_* + OSS_BUCKET_NAME + OSS_ENDPOINT +
# OSS_CUSTOM_DOMAIN + SLS_OSS_PATH_PREFIX）。模板见 .env.example。
LOCAL_ENV = REPO_ROOT / ".env"


def load_env() -> None:
    if not load_dotenv:
        return
    if LOCAL_ENV.exists():
        load_dotenv(LOCAL_ENV)
    else:
        raise SystemExit(
            f"找不到 {LOCAL_ENV}\n请按 .env.example 复制并填值（OSS_ACCESS_KEY_ID / "
            "OSS_ACCESS_KEY_SECRET / OSS_BUCKET_NAME / OSS_ENDPOINT / OSS_CUSTOM_DOMAIN）"
        )


def read_version() -> tuple[str, int]:
    if not VERSION_FILE.exists():
        raise SystemExit(f"找不到 {VERSION_FILE}")
    name, code = None, None
    for line in VERSION_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("versionName="):
            name = line.split("=", 1)[1].strip()
        elif line.startswith("versionCode="):
            code = int(line.split("=", 1)[1].strip())
    if not name or code is None:
        raise SystemExit(f"VERSION 格式错误：缺 versionName 或 versionCode\n{VERSION_FILE.read_text()}")
    return name, code


def assemble_release() -> None:
    print(f"→ 构建 release APK: cd {ANDROID_DIR} && ./gradlew assembleRelease")
    subprocess.run(
        ["./gradlew", "assembleRelease"],
        cwd=ANDROID_DIR,
        check=True,
    )


def find_aapt() -> str | None:
    candidates = []
    for env_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        sdk = os.getenv(env_name)
        if sdk:
            candidates.extend(sorted(Path(sdk).glob("build-tools/*/aapt"), reverse=True))
    candidates.extend(sorted((Path.home() / "Library/Android/sdk/build-tools").glob("*/aapt"), reverse=True))
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which("aapt")


def read_apk_version(path: Path) -> tuple[str, int]:
    aapt = find_aapt()
    if not aapt:
        raise SystemExit(
            "找不到 Android SDK 的 aapt，无法校验 APK 内嵌版本；为避免发布错包，停止。"
        )
    output = subprocess.check_output(
        [aapt, "dump", "badging", str(path)],
        text=True,
        stderr=subprocess.STDOUT,
    )
    first_line = output.splitlines()[0] if output else ""
    name_match = re.search(r"versionName='([^']+)'", first_line)
    code_match = re.search(r"versionCode='(\d+)'", first_line)
    if not name_match or not code_match:
        raise SystemExit(f"无法从 APK 读取版本信息：{first_line}")
    return name_match.group(1), int(code_match.group(1))


def verify_apk_version(path: Path, expected_name: str, expected_code: int) -> None:
    apk_name, apk_code = read_apk_version(path)
    info(f"  APK 内嵌版本 = {apk_name} (vc {apk_code})")
    if apk_name != expected_name or apk_code != expected_code:
        raise SystemExit(
            "    ✗ APK 内嵌版本与 clients/mobile/VERSION 不一致，停止发布。\n"
            f"      VERSION: {expected_name} (vc {expected_code})\n"
            f"      APK:     {apk_name} (vc {apk_code})\n"
            "      请重新构建 release APK 后再发布。"
        )


def sha256_of(path: Path) -> str:
    total = path.stat().st_size
    h = hashlib.sha256()
    consumed = 0
    last_print = 0.0
    t0 = time.time()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            consumed += len(chunk)
            now = time.time()
            if now - last_print >= 0.3 or consumed >= total:
                last_print = now
                pct = consumed * 100.0 / total if total else 100.0
                sys.stdout.write(
                    f"\r    sha256: {consumed / 1024 / 1024:.1f}/{total / 1024 / 1024:.1f} MB  {pct:5.1f}%"
                )
                sys.stdout.flush()
    sys.stdout.write(f"  ({time.time() - t0:.1f}s)\n")
    sys.stdout.flush()
    return h.hexdigest()


def make_bucket() -> tuple[oss2.Bucket, str, str]:
    ak = os.getenv("OSS_ACCESS_KEY_ID")
    sk = os.getenv("OSS_ACCESS_KEY_SECRET")
    bucket_name = os.getenv("OSS_BUCKET_NAME", "lingflow")
    endpoint = os.getenv("OSS_ENDPOINT", "oss-cn-heyuan.aliyuncs.com")
    if not ak or not sk:
        raise SystemExit("缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET")
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)
    bucket.get_bucket_info()  # 验证连通
    return bucket, bucket_name, endpoint


def public_url_for_apk(key: str, bucket_name: str, endpoint: str) -> str:
    """APK 走 CDN/CNAME 域。OSS 禁止用原生 *.aliyuncs.com 分发 .apk
    （ApkDownloadForbidden）。"""
    cd = os.getenv("OSS_CUSTOM_DOMAIN", "").rstrip("/")
    if cd:
        return f"{cd}/{key}"
    return f"https://{bucket_name}.{endpoint}/{key}"


def public_url_for_manifest(key: str, bucket_name: str, endpoint: str) -> str:
    """latest.json 走 OSS 原生域，不过 CDN。
    原因：CDN 边缘节点常忽略 Cache-Control: no-cache 头，缓存几小时甚至几天，
    新版本发布后用户拿到旧 manifest 误以为没更新；OSS 原生域永远是最新。
    小文件几百字节，不走加速也无所谓。JSON 不在 ApkDownloadForbidden 限制内。"""
    return f"https://{bucket_name}.{endpoint}/{key}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true", help="发布前重建 release APK")
    parser.add_argument("--changelog", default="", help="改动说明（多行用 \\n）")
    parser.add_argument("--min-supported", type=int, default=None, help="强制更新最低 versionCode")
    parser.add_argument("--dry-run", action="store_true", help="不真正上传，只 dump 计划")
    args = parser.parse_args()

    _t_global[0] = time.time()
    print(f"=== Solo Leveling mobile release ===   (开始 {datetime.now().strftime('%H:%M:%S')})", flush=True)

    # ── 步骤 1：环境变量 ──
    t = step("加载 .env")
    info(f"  从 {LOCAL_ENV} 读 OSS 凭证 + 端点 + CNAME")
    load_env()
    if not (os.getenv("OSS_ACCESS_KEY_ID") and os.getenv("OSS_ACCESS_KEY_SECRET")):
        raise SystemExit("    ✗ 缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET，停止")
    info(f"  bucket          = {os.getenv('OSS_BUCKET_NAME', 'lingflow')}")
    info(f"  endpoint        = {os.getenv('OSS_ENDPOINT', 'oss-cn-heyuan.aliyuncs.com')}")
    info(f"  customDomain    = {os.getenv('OSS_CUSTOM_DOMAIN', '(空)') or '(空)'}")
    info(f"  pathPrefix      = {os.getenv('SLS_OSS_PATH_PREFIX', 'solo-leveling')}")
    proxies = [k for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy") if os.getenv(k)]
    if proxies:
        info(f"  ⚠ 检测到代理 env: {', '.join(proxies)} —— 可能被国内 OSS 拒绝")
    step_done(t)

    # ── 步骤 2：版本号 ──
    t = step("读 VERSION 文件")
    version_name, version_code = read_version()
    info(f"  versionName = {version_name}")
    info(f"  versionCode = {version_code}")
    step_done(t)

    # ── 步骤 3：APK 准备 ──
    # 决策：现有 APK 内嵌版本 == VERSION → 直接复用（build 一次几分钟，太贵）；
    # APK 不存在 / 版本不一致 / 用户显式 --build → 才跑 gradlew assembleRelease。
    # 上传前再 verify_apk_version 兜底，确保跳过 build 的路径也安全。
    t = step("准备 release APK")
    need_build = args.build or not APK_PATH.exists()
    if not need_build:
        try:
            apk_name, apk_code = read_apk_version(APK_PATH)
            if apk_name == version_name and apk_code == version_code:
                info(f"  复用现有 APK（版本匹配 {apk_name} vc{apk_code}）: {APK_PATH}")
            else:
                info(f"  现有 APK 版本 {apk_name} vc{apk_code} ≠ VERSION {version_name} vc{version_code}，需重建")
                need_build = True
        except SystemExit:
            # aapt 找不到 / 读 APK 失败 → 保险起见重建
            info("  现有 APK 版本读取失败，需重建")
            need_build = True
    if need_build:
        info("  → 跑 gradlew assembleRelease …")
        assemble_release()
    if not APK_PATH.exists():
        raise SystemExit(f"    ✗ APK 不存在: {APK_PATH}")
    size = APK_PATH.stat().st_size
    info(f"  大小 {size / 1024 / 1024:.2f} MB")
    verify_apk_version(APK_PATH, version_name, version_code)
    step_done(t)

    # ── 步骤 4：SHA256 ──
    t = step("计算 SHA256")
    sha = sha256_of(APK_PATH)
    info(f"  sha256 = {sha}")
    step_done(t)

    # ── 步骤 5：连 OSS ──
    t = step("连接 OSS")
    info(f"  TCP probe {os.getenv('OSS_ENDPOINT', 'oss-cn-heyuan.aliyuncs.com')}:443 …")
    try:
        socket.create_connection(
            (os.getenv("OSS_ENDPOINT", "oss-cn-heyuan.aliyuncs.com"), 443),
            timeout=5,
        ).close()
        info("  TCP 通")
    except Exception as e:
        info(f"  ⚠ TCP 探测失败: {e}（继续尝试 HTTPS，可能 oss2 自己能走通）")
    bucket, bucket_name, endpoint = make_bucket()
    info(f"  bucket {bucket_name} get_bucket_info 通过")
    step_done(t)

    # ── 准备路径和 manifest payload ──
    prefix = os.getenv("SLS_OSS_PATH_PREFIX", "solo-leveling").rstrip("/")
    apk_key = f"{prefix}/android/releases/sls-{version_name}-vc{version_code}-{sha[:12]}.apk"
    manifest_key = f"{prefix}/android/latest.json"
    apk_url = public_url_for_apk(apk_key, bucket_name, endpoint)
    manifest_url = public_url_for_manifest(manifest_key, bucket_name, endpoint)
    changelog = args.changelog.replace("\\n", "\n").strip()
    manifest = {
        "version_name": version_name,
        "version_code": version_code,
        "url": apk_url,
        "sha256": sha,
        "size_bytes": size,
        "released_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "changelog": changelog,
    }
    if args.min_supported is not None:
        manifest["min_supported_code"] = args.min_supported

    print("\n── 计划 ──")
    print(f"  APK      → {apk_url}")
    print(f"  manifest → {manifest_url}")
    print(f"  manifest payload:\n{json.dumps(manifest, ensure_ascii=False, indent=2)}")

    if args.dry_run:
        print("\n(dry-run，未真正上传)")
        return 0

    # ── 步骤 6：清旧 APK ──
    t = step(f"清理 {prefix}/android/releases/ 下旧 APK")
    list_prefix = f"{prefix}/android/releases/"
    deleted = 0
    for obj in oss2.ObjectIterator(bucket, prefix=list_prefix):
        if obj.key == apk_key:
            continue
        if not obj.key.startswith(list_prefix) or not obj.key.endswith(".apk"):
            continue
        bucket.delete_object(obj.key)
        info(f"  - 删除 {obj.key}")
        deleted += 1
    if deleted == 0:
        info("  (无旧版本可清)")
    step_done(t)

    # ── 步骤 7：上传 APK ──
    t = step(f"上传 APK → {apk_key}")
    t_upload = time.time()
    last_print_at = [0.0]

    def progress_cb(consumed: int, total: int) -> None:
        now = time.time()
        # 不要每个 chunk 都刷屏（oss2 chunk 偏小，频率太高）
        if total and consumed < total and now - last_print_at[0] < 0.3:
            return
        last_print_at[0] = now
        elapsed = max(now - t_upload, 0.001)
        speed = consumed / elapsed
        speed_str = (
            f"{speed / 1024 / 1024:.2f} MB/s"
            if speed >= 1024 * 1024
            else f"{speed / 1024:.0f} KB/s"
        )
        if total:
            pct = consumed * 100.0 / total
            done_mb = consumed / 1024 / 1024
            total_mb = total / 1024 / 1024
            bar_w = 30
            filled = int(bar_w * consumed / total)
            bar = "█" * filled + "░" * (bar_w - filled)
            eta = (total - consumed) / speed if speed > 0 else 0
            sys.stdout.write(
                f"\r    [{bar}] {pct:5.1f}%  {done_mb:.1f}/{total_mb:.1f} MB  "
                f"{speed_str}  ETA {eta:.0f}s   "
            )
        else:
            sys.stdout.write(
                f"\r    {consumed / 1024 / 1024:.1f} MB  {speed_str}   "
            )
        sys.stdout.flush()
        if total and consumed >= total:
            sys.stdout.write("\n")
            sys.stdout.flush()

    # 分片 + 4 线程并行：把大文件切 4MB part 同时上传，国内带宽抖时累计速度更稳
    # multipart_threshold=10MB → 文件 > 10MB 自动走 resumable，否则走单流 put_object
    oss2.resumable_upload(
        bucket,
        apk_key,
        str(APK_PATH),
        multipart_threshold=10 * 1024 * 1024,
        part_size=4 * 1024 * 1024,
        num_threads=4,
        progress_callback=progress_cb,
    )
    step_done(t)

    # ── 步骤 8：上传 manifest ──
    t = step(f"上传 manifest → {manifest_key}")
    bucket.put_object(
        manifest_key,
        json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache, must-revalidate",
        },
    )
    step_done(t)

    total_s = time.time() - _t_global[0]
    print(f"\n✓ 发布成功（总耗时 {total_s:.1f}s）")
    print(f"  访问 manifest：{manifest_url}")
    print(f"  下载 APK：    {apk_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
