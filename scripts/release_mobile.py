#!/usr/bin/env python3
"""
Solo Leveling mobile —— 发布 release APK 到阿里云 OSS。

流程：
  1. 读 clients/mobile/VERSION 拿 versionName/versionCode
  2. 检查 release APK 是否存在；不存在就跑 `./gradlew assembleRelease`
  3. SHA256 校验
  4. 上传 APK 到 OSS：solo-leveling/android/releases/sls-{versionName}-vc{code}.apk
     （OSS 只保留 latest，先清掉旧 sls-*.apk）
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
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

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

# 复用 MW_ActivityMonitor/.env（同一台机器、同一套 AK）
EXTERNAL_ENV = Path.home() / "Projects" / "Github" / "MW_ActivityMonitor" / ".env"


def load_env() -> None:
    if load_dotenv and EXTERNAL_ENV.exists():
        load_dotenv(EXTERNAL_ENV)
    # 项目本地 .env 优先级更高（如果有）
    local_env = REPO_ROOT / ".env"
    if load_dotenv and local_env.exists():
        load_dotenv(local_env, override=True)


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


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def make_bucket() -> tuple[oss2.Bucket, str, str]:
    ak = os.getenv("OSS_ACCESS_KEY_ID")
    sk = os.getenv("OSS_ACCESS_KEY_SECRET")
    bucket_name = os.getenv("OSS_BUCKET_NAME", "horizn")
    endpoint = os.getenv("OSS_ENDPOINT", "oss-cn-heyuan.aliyuncs.com")
    if not ak or not sk:
        raise SystemExit("缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET")
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)
    bucket.get_bucket_info()  # 验证连通
    return bucket, bucket_name, endpoint


def public_url_for(key: str, bucket_name: str, endpoint: str) -> str:
    cd = os.getenv("OSS_CUSTOM_DOMAIN", "").rstrip("/")
    if cd:
        return f"{cd}/{key}"
    return f"https://{bucket_name}.{endpoint}/{key}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true", help="发布前重建 release APK")
    parser.add_argument("--changelog", default="", help="改动说明（多行用 \\n）")
    parser.add_argument("--min-supported", type=int, default=None, help="强制更新最低 versionCode")
    parser.add_argument("--dry-run", action="store_true", help="不真正上传，只 dump 计划")
    args = parser.parse_args()

    load_env()

    version_name, version_code = read_version()
    print(f"→ VERSION: {version_name} (vc {version_code})")

    if args.build or not APK_PATH.exists():
        assemble_release()
    if not APK_PATH.exists():
        raise SystemExit(f"APK 不存在: {APK_PATH}")

    sha = sha256_of(APK_PATH)
    size = APK_PATH.stat().st_size
    print(f"→ APK: {APK_PATH}  {size / 1024 / 1024:.1f} MB  sha256={sha[:16]}…")

    prefix = os.getenv("SLS_OSS_PATH_PREFIX", "solo-leveling").rstrip("/")
    apk_key = f"{prefix}/android/releases/sls-{version_name}-vc{version_code}.apk"
    manifest_key = f"{prefix}/android/latest.json"

    bucket, bucket_name, endpoint = make_bucket()
    apk_url = public_url_for(apk_key, bucket_name, endpoint)
    manifest_url = public_url_for(manifest_key, bucket_name, endpoint)

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

    print("→ 计划:")
    print(f"  APK      → {apk_url}")
    print(f"  manifest → {manifest_url}")
    print(f"  manifest payload: {json.dumps(manifest, ensure_ascii=False, indent=2)}")

    if args.dry_run:
        print("\n(dry-run，未真正上传)")
        return 0

    # 1. 清掉旧的 sls-*.apk（覆盖式策略）
    print(f"\n→ 清理 {prefix}/android/releases/ 下旧版本…")
    list_prefix = f"{prefix}/android/releases/"
    deleted = 0
    for obj in oss2.ObjectIterator(bucket, prefix=list_prefix):
        if obj.key == apk_key:
            continue
        if not obj.key.startswith(list_prefix) or not obj.key.endswith(".apk"):
            continue
        bucket.delete_object(obj.key)
        print(f"  - 删除 {obj.key}")
        deleted += 1
    if deleted == 0:
        print("  (无旧版本可清)")

    # 2. 上传 APK
    print(f"\n→ 上传 APK → {apk_key}")
    t0 = time.time()
    bucket.put_object_from_file(apk_key, str(APK_PATH))
    print(f"  完成（{time.time() - t0:.1f}s）")

    # 3. 上传 manifest（覆盖）
    print(f"→ 上传 manifest → {manifest_key}")
    bucket.put_object(
        manifest_key,
        json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache, must-revalidate",
        },
    )
    print("  完成")

    print("\n✓ 发布成功")
    print(f"  访问 manifest：{manifest_url}")
    print(f"  下载 APK：    {apk_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
