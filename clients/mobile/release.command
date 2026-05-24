#!/bin/bash
# Solo Leveling mobile - 一键发布
# Finder 双击此文件即可启动 Terminal 运行
#
# 发布前先改：
#   1. clients/mobile/VERSION  (versionName + versionCode 都要 bump)
#   2. clients/mobile/CHANGELOG.next.md  (本次改动说明，可空)

set -e

# 找到 repo 根（这个脚本在 clients/mobile/ 下）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# 清掉系统代理 env（避免国内 OSS 走 Clash）
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY

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
read -p "确认开始发布？回车继续，Ctrl-C 取消... "

# 跑 release（pyenv shim / system python3 都接得到）
python3 "$REPO_ROOT/scripts/release_mobile.py" --changelog "$CHANGELOG"
RC=$?

if [ $RC -eq 0 ]; then
  echo ""
  echo "✓ 发布完成 - 已上传到 OSS"
  echo ""
  read -p "是否清空 CHANGELOG.next.md（为下一版本准备空白）？[y/N] " ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    echo "" > "$CHANGELOG_FILE"
    echo "已清空"
  fi
fi

echo ""
read -p "按回车关闭窗口... "
exit $RC
