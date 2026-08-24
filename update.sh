#!/bin/bash
# ==========================================
# 直播订阅应用 · 一键更新脚本
# ==========================================
set -e

echo "=========================================="
echo " 直播订阅应用 · 一键更新"
echo "=========================================="

APP_DIR=/opt/live-sub-app

if [ ! -d "$APP_DIR" ]; then
  echo "[错误] 应用目录不存在: $APP_DIR"
  echo "请先运行部署脚本 deploy.sh"
  exit 1
fi

cd "$APP_DIR"

echo "[1/3] 拉取最新代码 ..."
git pull

echo "[2/3] 重启服务 ..."
systemctl restart live-sub-app

sleep 2

echo "[3/3] 检查服务状态 ..."
if systemctl is-active --quiet live-sub-app; then
  echo "✓ 服务运行正常"
  systemctl status live-sub-app --no-pager | head -5
else
  echo "✗ 服务启动失败，请检查日志：journalctl -u live-sub-app -f"
  exit 1
fi

echo ""
echo "=========================================="
echo " 更新完成！"
echo "=========================================="
