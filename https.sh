#!/bin/bash
# ============================================================
# 直播订阅应用 · HTTPS 一键配置脚本
# 适用：Ubuntu/Debian + nginx（已部署 live-sub-app）
# 用法：SSH 登录服务器后执行（需 root 或 sudo）
#   bash <(curl -sL https://raw.githubusercontent.com/yuyuyu124/live-sub-app/main/https.sh) leihuoxiaozhushou.top
# 效果：
#   1. 安装 certbot + nginx 插件
#   2. 自动申请 Let's Encrypt 免费证书（HTTP 验证）
#   3. 自动配置 nginx：HTTP 自动跳转 HTTPS
#   4. 配置自动续期（证书 90 天有效，自动续）
# ============================================================
set -e

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -p "请输入你的域名（如 example.com）: " DOMAIN
fi
if [ -z "$DOMAIN" ]; then
  echo "错误：未提供域名"
  exit 1
fi

echo "=========================================="
echo " 为 $DOMAIN 配置 HTTPS"
echo "=========================================="

# ---------- 1. 安装 certbot ----------
echo "[1/4] 安装 certbot ..."
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

# ---------- 2. 申请证书并自动配置 nginx ----------
echo "[2/4] 申请证书并配置 nginx ..."
# --nginx 插件会自动修改 nginx 配置并启用 HTTPS
# --redirect 自动添加 HTTP -> HTTPS 跳转
# --non-interactive 非交互
# --agree-tos 同意条款
# --no-eff-email 不订阅邮件
# --email 提供注册邮箱（certbot 必需）
EMAIL="${EMAIL:-admin@${DOMAIN}}"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --no-eff-email --email "$EMAIL"

# ---------- 3. 验证 ----------
echo "[3/4] 验证 HTTPS ..."
sleep 2
if curl -sI "https://$DOMAIN/" | head -1 | grep -q "200\|301\|302"; then
  echo "  HTTPS 配置成功！https://$DOMAIN 可访问"
else
  echo "  警告：HTTPS 验证未通过，请检查"
fi

# ---------- 4. 配置自动续期 ----------
echo "[4/4] 配置自动续期 ..."
# certbot 安装时会自动添加 systemd timer，这里再确认
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true
echo "  自动续期已启用（证书 90 天有效，到期前自动续）"

echo ""
echo "=========================================="
echo " HTTPS 配置完成！"
echo "  访问: https://$DOMAIN"
echo "  测试续期: certbot renew --dry-run"
echo "=========================================="
