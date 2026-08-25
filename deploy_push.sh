#!/bin/bash
# deploy_push.sh - 部署「直播订阅提醒 · 多用户版」
# 用法:把整个 push_patch 目录上传到服务器后,在任意位置运行:
#       bash /path/to/push_patch/deploy_push.sh
#
# 多用户版特性:
#   - 每个用户独立 UUID(浏览器 localStorage 自动生成)
#   - 每个用户独立订阅 + 独立推送配置(Server酱/PushPlus/Bark)
#   - 轮询按 room 去重,开播时按订阅者各自的 key 推送
#   - SSE 按 userId 分发,互不干扰
#
# 数据文件:users_data.json  { userId: { pushType, pushKey, subs:[...] } }
# ============================================================
set -e

APP_DIR="/opt/live-sub-app"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> 多用户版部署脚本"
echo "    应用目录: $APP_DIR"
echo "    源文件目录: $SRC_DIR"

# 校验源文件齐全
for f in lib/store.js lib/push.js server.js public/index.html public/settings.html; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "错误: 缺少源文件 $SRC_DIR/$f"
    exit 1
  fi
done

cd "$APP_DIR" || { echo "错误: $APP_DIR 不存在,请先 git clone 项目"; exit 1; }
mkdir -p lib public
TS=$(date +%s)

echo "==> [1/5] 备份原文件(后缀 .bak.$TS)"
[ -f server.js ]            && cp server.js            "server.js.bak.$TS"
[ -f public/index.html ]    && cp public/index.html    "public/index.html.bak.$TS"
[ -f public/settings.html ] && cp public/settings.html "public/settings.html.bak.$TS"
[ -f lib/push.js ]          && cp lib/push.js          "lib/push.js.bak.$TS"
[ -f lib/store.js ]         && cp lib/store.js         "lib/store.js.bak.$TS"

echo "==> [2/5] 拷贝多用户版文件"
cp "$SRC_DIR/lib/store.js"         lib/store.js
cp "$SRC_DIR/lib/push.js"          lib/push.js
cp "$SRC_DIR/server.js"            server.js
cp "$SRC_DIR/public/index.html"    public/index.html
cp "$SRC_DIR/public/settings.html" public/settings.html

echo "==> [3/5] 初始化数据文件"
if [ ! -f users_data.json ]; then
  echo '{}' > users_data.json
fi
# 迁移旧单用户数据(如有 live_subs.json 且 users_data.json 为空)
if [ -f live_subs.json ] && [ "$(cat users_data.json)" = '{}' ]; then
  echo "    检测到旧的单用户数据 live_subs.json,尝试迁移..."
  node -e '
    const fs = require("fs");
    try {
      const old = JSON.parse(fs.readFileSync("live_subs.json","utf8"));
      if (Array.isArray(old) && old.length > 0) {
        const uid = "migrated-" + Date.now().toString(36);
        const data = {};
        data[uid] = { pushType: "", pushKey: "", subs: old };
        fs.writeFileSync("users_data.json", JSON.stringify(data, null, 2));
        console.log("    已迁移 " + old.length + " 条旧订阅到用户 " + uid);
      } else {
        console.log("    旧数据为空,跳过迁移");
      }
    } catch (e) { console.log("    迁移失败(不影响部署):" + e.message); }
  '
fi

echo "==> [4/5] 语法检查"
node --check server.js      && echo "    server.js 语法 OK"
node --check lib/store.js   && echo "    lib/store.js 语法 OK"
node --check lib/push.js    && echo "    lib/push.js 语法 OK"

echo "==> [5/5] 重启服务"
if systemctl list-unit-files 2>/dev/null | grep -q live-sub-app; then
  systemctl restart live-sub-app
  sleep 2
  echo "    服务状态: $(systemctl is-active live-sub-app)"
  echo ""
  echo "=== 启动日志(看有没有报错) ==="
  journalctl -u live-sub-app -n 12 --no-pager
else
  echo "    未检测到 systemd 服务 live-sub-app,尝试直接重启 node 进程"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart live-sub-app 2>/dev/null || pm2 restart all
  else
    pkill -f "node server.js" 2>/dev/null || true
    nohup node server.js > /tmp/live-sub-app.log 2>&1 &
    sleep 2
    echo "    已后台启动,日志: /tmp/live-sub-app.log"
  fi
fi

echo ""
echo "=========================================="
echo "✅ 多用户版部署完成!"
echo "=========================================="
echo ""
echo "数据文件: $APP_DIR/users_data.json"
echo "原文件备份: *.bak.$TS"
echo ""
echo "下一步:"
echo "  1. 浏览器打开 https://leihuoxiaozhushou.top/"
echo "     每个设备/浏览器会自动生成独立用户 ID(见页面底部)"
echo "  2. 点首页「提醒设置 → 微信/手机推送」配置自己的推送方式"
echo "  3. 添加想订阅的直播间"
echo "  4. 主播开播 → 自动按各用户自己的配置推送到微信/手机"
echo ""
echo "多用户说明:"
echo "  - 不同人用不同浏览器打开,自动是不同用户,互不影响"
echo "  - 同一直播间多人订阅时,服务器只查一次,但各自独立收到推送"
echo "  - 换浏览器/清缓存会变成新用户,需重新配置推送"
