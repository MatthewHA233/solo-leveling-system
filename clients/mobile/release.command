#!/bin/bash
# Solo Leveling mobile - 一键发布
# Finder 双击此文件即可启动 Terminal 运行
#
# 发布前先改：
#   1. clients/mobile/VERSION  (versionName + versionCode 都要 bump)
#   2. clients/mobile/CHANGELOG.next.md  (本次改动说明，可空；已 gitignore 不入库)

set -e

# 找到 repo 根（这个脚本在 clients/mobile/ 下）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# 清掉代理 env（避免国内 OSS 走 Clash），但 macOS 系统级代理（scutil --proxy）
# 这个脚本 unset 不掉，下面循环检测让用户关
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY

# macOS 系统代理探测：HTTPEnable / HTTPSEnable=1 时 oss2 通过 requests
# 会自动走代理，国内访问 OSS 经 Clash 出去再回来速度从几 MB/s 掉到 80KB/s。
# 检测到就 block 等用户手动关，回车重试
while true; do
  PROXY_ON=$(scutil --proxy 2>/dev/null | awk '
    /HTTPEnable[[:space:]]*:[[:space:]]*1/  { http=1 }
    /HTTPSEnable[[:space:]]*:[[:space:]]*1/ { https=1 }
    END { if (http || https) print "on" }
  ')
  if [ -z "$PROXY_ON" ]; then break; fi
  echo ""
  echo "⚠ 检测到 macOS 系统代理开启（HTTP/HTTPS）"
  echo "  国内访问阿里云 OSS 经过代理会拖到 80KB/s，50MB APK 要 10 分钟+"
  echo "  请关闭 Clash / 系统代理（状态栏图标 → System Proxy 取消勾），然后回车重试"
  read -p "  关好后按回车继续... "
done

# 读 CHANGELOG.next.md 作为本次 changelog
CHANGELOG_FILE="$SCRIPT_DIR/CHANGELOG.next.md"
if [ -f "$CHANGELOG_FILE" ]; then
  CHANGELOG=$(cat "$CHANGELOG_FILE")
else
  CHANGELOG=""
fi

echo "=== Solo Leveling mobile release ==="
echo "repo: $REPO_ROOT"
echo ""
echo "本次 changelog："
echo "----------------"
echo "$CHANGELOG"
echo "----------------"
echo ""

# 不再问"确认开始" —— 双击即上传；不需要的话 Ctrl-C 立即中断
# 不带 --build：脚本会用 aapt 校验现有 APK 版本，匹配则跳过 build（省 3~8min），
# 不匹配 / APK 不存在才重建。强制 clean build 用 `python3 release_mobile.py --build`。
python3 "$REPO_ROOT/scripts/release_mobile.py" --changelog "$CHANGELOG"
RC=$?

# 不再问"是否清空 CHANGELOG.next.md" —— 文件已 gitignore，留着不会污染 git，
# 下次发布前用户自己改即可

echo ""
read -p "按回车关闭窗口... "
exit $RC
