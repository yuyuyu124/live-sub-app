#!/bin/bash
# ============================================================
# 直播订阅应用 · 国内服务器一键部署脚本
# 适用：阿里云/腾讯云轻量应用服务器（Ubuntu 20.04/22.04 或 Debian）
# 用法：SSH 登录服务器后，粘贴本脚本执行（需 root 或 sudo）
#   bash deploy.sh
# 效果：
#   1. 安装 Node.js 20 + nginx
#   2. 从 GitHub 拉取代码
#   3. 用 systemd 守护服务（开机自启、崩溃自动重启）
#   4. nginx 反向代理：http://你的域名 -> 本机 3000 端口
#   5. 访问 http://你的域名 即可使用
# ============================================================
set -e

echo "=========================================="
echo " 直播订阅应用 · 一键部署"
echo "=========================================="

# ---------- 1. 安装 Node.js 20 ----------
echo "[1/5] 安装 Node.js 20 ..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node.js 版本: $(node -v)"

# ---------- 2. 安装 nginx ----------
echo "[2/5] 安装 nginx ..."
if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y nginx
fi

# ---------- 3. 拉取代码 ----------
echo "[3/5] 拉取代码 ..."
APP_DIR=/opt/live-sub-app
if [ ! -d "$APP_DIR" ]; then
  git clone https://github.com/yuyuyu124/live-sub-app.git "$APP_DIR"
else
  cd "$APP_DIR" && git pull
fi
cd "$APP_DIR"

# ---------- 4. 配置 systemd 服务（开机自启 + 崩溃重启） ----------
echo "[4/5] 配置 systemd 服务 ..."
cat > /etc/systemd/system/live-sub-app.service <<'EOF'
[Unit]
Description=Live Subscription App
After=network.target

[Service]
WorkingDirectory=/opt/live-sub-app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable live-sub-app
systemctl restart live-sub-app
sleep 2
echo "  服务状态: $(systemctl is-active live-sub-app)"

# ---------- 5. 配置 nginx 反向代理 ----------
echo "[5/5] 配置 nginx 反向代理 ..."
# 提示用户输入域名
if [ -z "$DOMAIN" ]; then
  read -p "  请输入你的域名（如 example.com，不含 http://）: " DOMAIN
fi
if [ -z "$DOMAIN" ]; then
  echo "  未输入域名，跳过 nginx 配置。可稍后手动配置。"
  echo "  现在可通过 http://服务器IP:3000 访问"
else
  cat > /etc/nginx/sites-available/live-sub-app <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # SSE 需要关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/live-sub-app /etc/nginx/sites-enabled/live-sub-app
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "  nginx 已配置，访问 http://$DOMAIN 即可"
fi

echo ""
echo "=========================================="
echo " 部署完成！"
echo "  服务地址: http://$DOMAIN 或 http://服务器IP:3000"
echo "  查看日志: journalctl -u live-sub-app -f"
echo "  重启服务: systemctl restart live-sub-app"
echo "=========================================="
