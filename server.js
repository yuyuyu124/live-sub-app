// ================= server.js =================
// 直播订阅提醒 · 手机端后端服务
// 复刻「直播订阅功能移植手册」的核心逻辑：
//   - B站 / 抖音 直播间订阅
//   - 60 秒轮询检测开播状态（多订阅间隔 2 秒）
//   - 通过 SSE 实时推送状态给手机端
// 纯 Node 内置模块，无任何第三方依赖。
//
// 启动：node server.js
// 手机访问：http://<电脑IP>:3000
// 可选环境变量：PORT（默认 3000）、LIVE_POLL_MS（轮询间隔，默认 60000）
// ------------------------------------------------

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---- 配置 ----
const PORT = parseInt(process.env.PORT || '3000', 10);
const POLL_INTERVAL = parseInt(process.env.LIVE_POLL_MS || '60000', 10);
const STAGGER_MS = 2000;                 // 多个订阅之间间隔，避免风控
const DATA_FILE = path.join(__dirname, 'live_subs.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- 数据 ----
let liveSubs = [];          // 订阅列表
let liveTimer = null;       // 轮询定时器
let liveFirstCheck = true;  // 首次检查：已在直播也提醒一次
let sseClients = [];        // SSE 客户端集合

// ============================================================
// 纯 HTTP GET（基于 Node 内置 fetch，可跟随重定向）
// 带完整浏览器头，规避 B站/抖音 的风控拦截
// ============================================================
async function httpGet(urlStr, options) {
  options = options || {};
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': options.referer || 'https://live.douyin.com/',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1'
  };
  if (options.headers) for (const k in options.headers) headers[k] = options.headers[k];
  const resp = await fetch(urlStr, { headers: headers, redirect: 'follow' });
  const body = await resp.text();
  return { body: body, statusCode: resp.status, headers: resp.headers, finalUrl: resp.url || urlStr };
}

async function liveReq(urlStr, options) {
  const r = await httpGet(urlStr, options);
  try { return JSON.parse(r.body.trim()); } catch (e) { throw new Error('parse error'); }
}

// ============================================================
// 解析用户输入 → { platform, roomId } 或 { platform:'douyin', needResolve, url }
// ============================================================
function parseLiveInput(input) {
  input = (input || '').trim();
  if (!input) return null;
  let m = input.match(/live\.bilibili\.com\/(\d+)/);
  if (m) return { platform: 'bilibili', roomId: m[1] };
  if (/^\d{2,10}$/.test(input)) return { platform: 'bilibili', roomId: input };   // 纯数字 = B站房间号
  m = input.match(/live\.douyin\.com\/(\d+)/);
  if (m) return { platform: 'douyin', roomId: m[1] };
  if (/v\.douyin\.com\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };       // 抖音短链
  if (/live\.douyin\.com\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };
  if (/douyin\.com\/user\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };    // 用户主页
  if (/^[a-zA-Z][a-zA-Z0-9_.-]{1,29}$/.test(input)) {                              // 抖音号（字母开头）
    return { platform: 'douyin', needResolve: true, url: 'https://live.douyin.com/' + encodeURIComponent(input) };
  }
  return null;
}

// ============================================================
// 解析抖音短链 / 抖音号 / 用户主页 → 真实 room_id（多级兜底）
// ============================================================
async function resolveDouyinRoomId(shortUrl) {
  const loadUrl = /^https?:\/\//.test(shortUrl) ? shortUrl : 'https://' + shortUrl;
  const resp = await httpGet(loadUrl, { headers: { 'Cookie': 'msToken=; ttwid=1|' + Date.now() + '|1|0|1' } });
  const finalUrl = resp.finalUrl || loadUrl;
  const html = resp.body || '';

  // ① 最终 URL 里直接带 room_id / live.douyin.com/{id}
  let ridFromUrl = finalUrl.match(/room_id=(\d+)/) || finalUrl.match(/live\.douyin\.com\/(\d+)/);
  if (ridFromUrl) return ridFromUrl[1];
  // ② 页面里解析 web_rid / roomId（新版转义 JSON）
  const room = parseDouyinRoom(html);
  if (room && room.web_rid) return room.web_rid;
  const rid2 = html.match(/"web_rid"\s*:\s*"(\d+)"/) || html.match(/"roomId"\s*:\s*"?(\d+)"?/);
  if (rid2) return rid2[1];
  // ③ 提取 UID 兜底
  const uidMatch = html.match(/douyin\.com\/user\/(\d+)/) || html.match(/"uid"\s*:\s*"?(\d+)"?/);
  if (uidMatch) return uidMatch[1];
  throw new Error('无法从页面提取房间号，请尝试直接输入直播间链接或房间号');
}

// ============================================================
// 抖音页面解析（新版 RSC 转义 JSON）
// ============================================================
function parseDouyinRoom(html) {
  const marker = '\\"room\\":{\\"id_str\\"';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  let seg = html.substring(idx, idx + 8000);
  seg = seg.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\n/g, '');
  const statusM = seg.match(/"status"\s*:\s*(\d+)/);
  const titleM = seg.match(/"title"\s*:\s*"([^"]{0,100})"/);
  const nickM = seg.match(/"nickname"\s*:\s*"([^"]{0,60})"/);
  const avatarM = seg.match(/"avatar_thumb"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["([^"]+)"/);
  const webRidM = seg.match(/"web_rid"\s*:\s*"(\d+)"/);
  return {
    status: statusM ? parseInt(statusM[1], 10) : null,
    title: titleM ? titleM[1] : '',
    nickname: nickM ? nickM[1] : '',
    avatar: avatarM ? avatarM[1].replace(/\\u002F/g, '/') : '',
    web_rid: webRidM ? webRidM[1] : ''
  };
}

// ============================================================
// 检查单个订阅的直播状态（返回是否发生变化 0→1 或 1→0）
// ============================================================
async function checkOneLive(sub) {
  try {
    if (sub.platform === 'bilibili') {
      const resp = await liveReq('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + sub.roomId);
      if (resp && resp.code === 0 && resp.data) {
        const st = resp.data.live_status === 1 ? 1 : 0;
        const changed = sub.liveStatus !== st;
        sub.liveStatus = st;
        sub.title = resp.data.title || '';
        if (resp.data.user_cover) sub.cover = resp.data.user_cover;
        sub.avatar = sub.cover || sub.avatar || '';
        // 补充主播昵称（best effort）
        if (!sub.uname && resp.data.uid) {
          try {
            const ui = await liveReq('https://api.live.bilibili.com/live_user/v1/Master/info?uid=' + resp.data.uid);
            if (ui && ui.code === 0 && ui.data && ui.data.info && ui.data.info.uname) sub.uname = ui.data.info.uname;
          } catch (e) {}
        }
        return changed;
      }
    } else if (sub.platform === 'douyin') {
      const pageResp = await httpGet('https://live.douyin.com/' + sub.roomId, { headers: { 'Cookie': 'msToken=; ttwid=1|' + Date.now() + '|1|0|1' } });
      const room = parseDouyinRoom(pageResp.body || '');
      const st2 = (room && room.status === 2) ? 1 : 0;
      const changed2 = sub.liveStatus !== st2;
      sub.liveStatus = st2;
      if (room && room.title) sub.title = room.title;
      if (room && room.nickname) sub.uname = room.nickname;
      if (room && room.avatar) sub.avatar = room.avatar;
      return changed2;
    }
  } catch (e) {}
  return false;
}

// ============================================================
// 检查所有订阅（顺序执行，间隔 2 秒，省内存不并发）
// ============================================================
let checking = false;   // 防止并发检查
async function checkAllLive() {
  if (checking) return;
  checking = true;
  try {
    if (liveSubs.length === 0) return;
    for (let i = 0; i < liveSubs.length; i++) {
    const sub = liveSubs[i];
    const changed = await checkOneLive(sub);
    // 0→1 变化触发，或首次检查已在直播也触发
    if ((changed || (liveFirstCheck && sub.liveStatus === 1)) && sub.liveStatus === 1) {
      broadcast('live-started', { id: sub.id, platform: sub.platform, roomId: sub.roomId, uname: sub.uname, title: sub.title, cover: sub.cover, avatar: sub.avatar });
    }
    if (changed && sub.liveStatus === 0) {
      broadcast('live-ended', { id: sub.id });
    }
    broadcast('live-status-update', { id: sub.id, liveStatus: sub.liveStatus, title: sub.title, uname: sub.uname, cover: sub.cover, avatar: sub.avatar });
    if (i < liveSubs.length - 1) await new Promise(function (r) { setTimeout(r, STAGGER_MS); });
    }
    saveLiveSubs();
    liveFirstCheck = false;
    broadcast('live-subs-updated', {});
  } finally {
    checking = false;
  }
}

// ============================================================
// 持久化
// ============================================================
function loadLiveSubs() {
  try { liveSubs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { liveSubs = []; }
  if (!Array.isArray(liveSubs)) liveSubs = [];
}
function saveLiveSubs() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(liveSubs, null, 2), 'utf8'); } catch (e) {}
}

// ============================================================
// SSE 广播
// ============================================================
function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const c = sseClients[i];
    try { c.res.write(payload); }
    catch (e) { sseClients.splice(i, 1); }
  }
}

// ============================================================
// HTTP 路由
// ============================================================
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve) {
    let d = '';
    req.on('data', function (c) { d += c; });
    req.on('end', function () {
      try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function handleApi(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean); // ['api', 'subs', ...]

  // GET /api/subs
  if (method === 'GET' && parts[1] === 'subs' && parts.length === 2) {
    return sendJson(res, 200, { success: true, subs: liveSubs.map(function (s) {
      return { id: s.id, platform: s.platform, roomId: s.roomId, uname: s.uname || '', avatar: s.avatar || '', cover: s.cover || '', liveStatus: s.liveStatus, title: s.title || '', remark: s.remark || '' };
    }) });
  }

  // POST /api/subs/sync  { subs: [{id, platform, roomId, remark}] }
  // 客户端权威模式：手机把本地订阅列表同步给服务端，服务端据此轮询检测。
  // 订阅数据保存在手机浏览器 localStorage，服务端重启/休眠不丢数据（适配免费托管）。
  if (method === 'POST' && parts[1] === 'subs' && parts[2] === 'sync') {
    return readBody(req).then(async function (body) {
      const incoming = Array.isArray(body.subs) ? body.subs : [];
      const next = [];
      const seen = {};
      for (const s of incoming) {
        if (!s || !s.roomId) continue;
        const key = (s.platform === 'douyin' ? 'douyin' : 'bilibili') + ':' + String(s.roomId);
        if (seen[key]) continue;
        seen[key] = true;
        const existing = liveSubs.find(function (x) { return x.platform === (s.platform === 'douyin' ? 'douyin' : 'bilibili') && x.roomId === String(s.roomId); });
        next.push({
          id: s.id || (Date.now().toString() + Math.floor(Math.random() * 1000)),
          platform: s.platform === 'douyin' ? 'douyin' : 'bilibili',
          roomId: String(s.roomId),
          remark: (s.remark || '').trim(),
          uname: existing ? existing.uname : '',
          avatar: existing ? existing.avatar : '',
          cover: existing ? existing.cover : '',
          liveStatus: existing ? existing.liveStatus : 0,
          title: existing ? existing.title : ''
        });
      }
      liveSubs = next;
      saveLiveSubs();
      if (liveSubs.length > 0 && !liveTimer) startLiveChecker();
      await checkAllLive();
      broadcast('live-subs-updated', {});
      return sendJson(res, 200, { success: true, subs: liveSubs.map(function (s) {
        return { id: s.id, platform: s.platform, roomId: s.roomId, uname: s.uname || '', avatar: s.avatar || '', cover: s.cover || '', liveStatus: s.liveStatus, title: s.title || '', remark: s.remark || '' };
      }) });
    });
  }

  // POST /api/subs  { input }
  if (method === 'POST' && parts[1] === 'subs' && parts.length === 2) {
    return readBody(req).then(async function (body) {
      const parsed = parseLiveInput(body.input || '');
      if (!parsed) return sendJson(res, 200, { success: false, error: '无法识别链接，请输入B站或抖音直播间链接/房间号' });
      if (parsed.needResolve) {
        try { parsed.roomId = await resolveDouyinRoomId(parsed.url); }
        catch (e) { return sendJson(res, 200, { success: false, error: '抖音链接解析失败，请尝试直接输入房间号' }); }
      }
      const existing = liveSubs.find(function (s) { return s.platform === parsed.platform && s.roomId === parsed.roomId; });
      if (existing) return sendJson(res, 200, { success: false, error: '该直播间已添加过啦' });
      const sub = { id: Date.now().toString() + Math.floor(Math.random() * 1000), platform: parsed.platform, roomId: parsed.roomId, uname: '', avatar: '', cover: '', liveStatus: 0, title: '', remark: '' };
      await checkOneLive(sub);
      liveSubs.push(sub);
      saveLiveSubs();
      if (liveSubs.length === 1 && !liveTimer) startLiveChecker();
      broadcast('live-subs-updated', {});
      return sendJson(res, 200, { success: true, sub: sub });
    });
  }

  // DELETE /api/subs/:id
  if (method === 'DELETE' && parts[1] === 'subs' && parts.length === 3) {
    const idx = liveSubs.findIndex(function (s) { return s.id === parts[2]; });
    if (idx >= 0) { liveSubs.splice(idx, 1); saveLiveSubs(); }
    broadcast('live-subs-updated', {});
    return sendJson(res, 200, { success: true });
  }

  // PATCH /api/subs/:id/remark  { remark }
  if (method === 'PATCH' && parts[1] === 'subs' && parts.length === 4 && parts[3] === 'remark') {
    return readBody(req).then(function (body) {
      const sub = liveSubs.find(function (s) { return s.id === parts[2]; });
      if (sub) { sub.remark = (body.remark || '').trim(); saveLiveSubs(); broadcast('live-subs-updated', {}); return sendJson(res, 200, { success: true }); }
      return sendJson(res, 200, { success: false });
    });
  }

  // POST /api/check
  if (method === 'POST' && parts[1] === 'check') {
    checkAllLive();
    return sendJson(res, 200, { success: true });
  }

  // GET /api/events  (SSE)
  if (method === 'GET' && parts[1] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    const client = { res: res };
    sseClients.push(client);
    req.on('close', function () {
      const i = sseClients.indexOf(client);
      if (i >= 0) sseClients.splice(i, 1);
    });
    return;
  }

  return sendJson(res, 404, { success: false, error: 'not found' });
}

function handleStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return handleStatic(req, res, pathname);
}

// ============================================================
// 启动 / 停止
// ============================================================
function startLiveChecker() {
  if (liveTimer) return;
  loadLiveSubs();
  if (liveSubs.length > 0) setTimeout(checkAllLive, 3000);
  liveTimer = setInterval(function () { if (liveSubs.length > 0) checkAllLive(); }, POLL_INTERVAL);
}
function stopLiveChecker() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

// ---- 启动 ----
loadLiveSubs();
const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', function () {
  console.log('📡 直播订阅服务已启动');
  console.log('   本机访问:   http://localhost:' + PORT);
  console.log('   手机访问:   http://<本机局域网IP>:' + PORT);
  console.log('   当前订阅:   ' + liveSubs.length + ' 个');
  startLiveChecker();
});

process.on('SIGINT', function () { stopLiveChecker(); process.exit(0); });
process.on('SIGTERM', function () { stopLiveChecker(); process.exit(0); });
