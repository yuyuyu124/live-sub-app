// ================= server.js =================
// 直播订阅提醒 · 多用户版
//   - 每个用户独立 UUID(浏览器 localStorage)
//   - 每个用户独立订阅 + 独立推送配置
//   - 轮询按 room 去重,开播时按订阅者各自的 key 推送
//   - SSE 按 userId 分发
// 启动:node server.js
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const push = require('./lib/push');

// ---- 配置 ----
const PORT = parseInt(process.env.PORT || '3000', 10);
const POLL_INTERVAL = parseInt(process.env.LIVE_POLL_MS || '60000', 10);
const STAGGER_MS = 2000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let liveTimer = null;
let liveFirstCheck = true;
let sseClients = [];   // [{ res, userId }]

// ============================================================
// HTTP 工具
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
// 抖音反风控 Cookie
// ============================================================
function genDouyinCookie() {
  const now = Date.now();
  const randStr = Math.random().toString(36).substring(2, 34);
  const msToken = randStr;
  const ttwid = '1%7C' + now + '%7C1%7C0%7C1%7C' + Math.random().toString(36).substring(2, 18);
  return 'msToken=' + msToken + '; ttwid=' + ttwid + '; IsDouyinOpen=false; s_v_web_id=verify_' + randStr.substring(0, 20);
}

async function douyinGet(urlStr) {
  const headers = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
    'Referer': 'https://live.douyin.com/',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1', 'Upgrade-Insecure-Requests': '1', 'Cookie': genDouyinCookie()
  };
  try {
    const resp = await fetch(urlStr, { headers: headers, redirect: 'follow' });
    const body = await resp.text();
    return { body: body, statusCode: resp.status, finalUrl: resp.url || urlStr };
  } catch (e) { return { body: '', statusCode: 0, finalUrl: urlStr }; }
}

// ============================================================
// 解析用户输入
// ============================================================
function parseLiveInput(input) {
  input = (input || '').trim();
  if (!input) return null;
  let m = input.match(/live\.bilibili\.com\/(\d+)/);
  if (m) return { platform: 'bilibili', roomId: m[1] };
  if (/^\d{1,10}$/.test(input)) return { platform: 'bilibili', roomId: input };
  m = input.match(/live\.douyin\.com\/(\d+)/);
  if (m) return { platform: 'douyin', roomId: m[1] };
  if (/v\.douyin\.com\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };
  if (/live\.douyin\.com\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };
  if (/douyin\.com\/user\//.test(input)) return { platform: 'douyin', needResolve: true, url: input };
  if (/^[a-zA-Z][a-zA-Z0-9_.-]{1,29}$/.test(input)) {
    return { platform: 'douyin', needResolve: true, url: 'https://live.douyin.com/' + encodeURIComponent(input) };
  }
  return null;
}

async function resolveDouyinRoomId(shortUrl) {
  const loadUrl = /^https?:\/\//.test(shortUrl) ? shortUrl : 'https://' + shortUrl;
  const resp = await douyinGet(loadUrl);
  const finalUrl = resp.finalUrl || loadUrl;
  const html = resp.body || '';
  let ridFromUrl = finalUrl.match(/room_id=(\d+)/) || finalUrl.match(/live\.douyin\.com\/(\d+)/);
  if (ridFromUrl) return ridFromUrl[1];
  const room = parseDouyinRoom(html);
  if (room && room.web_rid) return room.web_rid;
  const rid2 = html.match(/"web_rid"\s*:\s*"(\d+)"/) || html.match(/"roomId"\s*:\s*"?(\d+)"?/);
  if (rid2) return rid2[1];
  const uidMatch = html.match(/douyin\.com\/user\/(\d+)/) || html.match(/"uid"\s*:\s*"?(\d+)"?/);
  if (uidMatch) return uidMatch[1];
  throw new Error('无法从页面提取房间号');
}

function parseDouyinRoom(html) {
  if (!html || html.length < 1000) return null;
  const marker1 = '\\"room\\":{\\"id_str\\"';
  let idx = html.indexOf(marker1);
  if (idx >= 0) {
    let seg = html.substring(idx, idx + 12000);
    seg = seg.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\n/g, '');
    const result = extractRoomFromJson(seg);
    if (result && result.status !== null) return result;
  }
  const marker2 = '"room":{';
  idx = html.indexOf(marker2);
  if (idx >= 0) {
    let seg = html.substring(idx, idx + 12000);
    const result = extractRoomFromJson(seg);
    if (result && result.status !== null) return result;
  }
  const initProps = html.match(/window\.__INIT_PROPS__\s*=\s*(\{.*?\})\s*;\s*</);
  if (initProps) {
    try {
      const data = JSON.parse(initProps[1]);
      const roomInfo = findRoomInObject(data);
      if (roomInfo) return roomInfo;
    } catch (e) {}
  }
  const statusM = html.match(/"status"\s*:\s*(\d+)/);
  const titleM = html.match(/"title"\s*:\s*"([^"]{0,100})"/);
  const nickM = html.match(/"nickname"\s*:\s*"([^"]{0,60})"/);
  const avatarM = html.match(/"avatar_thumb"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["([^"]+)"/);
  const webRidM = html.match(/"web_rid"\s*:\s*"(\d+)"/);
  if (statusM || titleM || nickM) {
    return {
      status: statusM ? parseInt(statusM[1], 10) : null,
      title: titleM ? titleM[1] : '', nickname: nickM ? nickM[1] : '',
      avatar: avatarM ? avatarM[1].replace(/\\u002F/g, '/') : '',
      web_rid: webRidM ? webRidM[1] : ''
    };
  }
  return null;
}

function extractRoomFromJson(seg) {
  const statusM = seg.match(/"status"\s*:\s*(\d+)/);
  const titleM = seg.match(/"title"\s*:\s*"([^"]{0,100})"/);
  const nickM = seg.match(/"nickname"\s*:\s*"([^"]{0,60})"/);
  const avatarM = seg.match(/"avatar_thumb"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["([^"]+)"/);
  const webRidM = seg.match(/"web_rid"\s*:\s*"(\d+)"/);
  const idStrM = seg.match(/"id_str"\s*:\s*"(\d+)"/);
  return {
    status: statusM ? parseInt(statusM[1], 10) : null,
    title: titleM ? titleM[1] : '', nickname: nickM ? nickM[1] : '',
    avatar: avatarM ? avatarM[1].replace(/\\u002F/g, '/') : '',
    web_rid: webRidM ? webRidM[1] : (idStrM ? idStrM[1] : '')
  };
}

function findRoomInObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.room && typeof obj.room === 'object') {
    const r = obj.room;
    return {
      status: r.status !== undefined ? parseInt(r.status, 10) : null,
      title: r.title || '', nickname: (r.owner && r.owner.nickname) || r.nickname || '',
      avatar: (r.owner && r.owner.avatar_thumb && r.owner.avatar_thumb.url_list && r.owner.avatar_thumb.url_list[0]) ||
              (r.avatar_thumb && r.avatar_thumb.url_list && r.avatar_thumb.url_list[0]) || '',
      web_rid: r.web_rid || r.id_str || r.roomId || ''
    };
  }
  for (const key in obj) {
    const result = findRoomInObject(obj[key]);
    if (result && result.status !== null) return result;
  }
  return null;
}

// ============================================================
// 检查单个 room 的状态(返回 { status, title, uname, avatar, cover })
// ============================================================
async function checkOneRoom(platform, roomId) {
  try {
    if (platform === 'bilibili') {
      const resp = await liveReq('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + roomId);
      if (resp && resp.code === 0 && resp.data) {
        const result = {
          liveStatus: resp.data.live_status === 1 ? 1 : 0,
          title: resp.data.title || '',
          cover: resp.data.user_cover || '',
          avatar: resp.data.user_cover || '',
          uname: ''
        };
        if (resp.data.uid) {
          try {
            const ui = await liveReq('https://api.live.bilibili.com/live_user/v1/Master/info?uid=' + resp.data.uid);
            if (ui && ui.code === 0 && ui.data && ui.data.info && ui.data.info.uname) result.uname = ui.data.info.uname;
          } catch (e) {}
        }
        return result;
      }
    } else if (platform === 'douyin') {
      const pageResp = await douyinGet('https://live.douyin.com/' + roomId);
      const room = parseDouyinRoom(pageResp.body || '');
      return {
        liveStatus: (room && room.status === 2) ? 1 : 0,
        title: (room && room.title) || '',
        avatar: (room && room.avatar) || '',
        cover: '', uname: (room && room.nickname) || ''
      };
    }
  } catch (e) {}
  return null;
}

// ============================================================
// 检查所有订阅(按 room 去重 → 检测 → 按订阅者推送)
// ============================================================
let checking = false;
async function checkAllLive() {
  if (checking) return;
  checking = true;
  try {
    const rooms = store.getAllSubsGroupedByRoom();
    if (rooms.length === 0) return;

    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const info = await checkOneRoom(room.platform, room.roomId);
      if (!info) {
        if (i < rooms.length - 1) await new Promise(function (r) { setTimeout(r, STAGGER_MS); });
        continue;
      }

      // 遍历订阅该 room 的所有用户
      for (const owner of room.owners) {
        const userId = owner.userId;
        const sub = owner.sub;
        const prevStatus = sub.liveStatus || 0;
        const changed = prevStatus !== info.liveStatus;

        // 更新该用户该 sub 的状态
        store.updateSub(userId, sub.id, {
          liveStatus: info.liveStatus,
          title: info.title || sub.title || '',
          uname: info.uname || sub.uname || '',
          avatar: info.avatar || sub.avatar || '',
          cover: info.cover || sub.cover || ''
        });

        // 0→1 或 首次检查已在直播 → 触发提醒
        const shouldAlert = (changed || (liveFirstCheck && info.liveStatus === 1)) && info.liveStatus === 1;
        if (shouldAlert) {
          // SSE 推给该用户
          broadcastToUser(userId, 'live-started', {
            id: sub.id, platform: sub.platform, roomId: sub.roomId,
            uname: info.uname || sub.uname || '', title: info.title || '',
            cover: info.cover || sub.cover || '', avatar: info.avatar || sub.avatar || ''
          });
          // 服务器主动推送(用该用户的 pushKey)
          const cfg = store.getPushConfig(userId);
          if (cfg.pushType && cfg.pushKey) {
            const title = '开播提醒: ' + (info.uname || sub.uname || sub.roomId);
            const desp = (sub.platform || '') + ' 主播 ' + (info.uname || sub.uname || sub.roomId) +
              ' 开播了\n标题: ' + (info.title || '无') + '\n房间号: ' + sub.roomId;
            push.pushAlert(cfg.pushType, cfg.pushKey, title, desp);
          }
        }
        if (changed && info.liveStatus === 0) {
          broadcastToUser(userId, 'live-ended', { id: sub.id });
        }
        if (changed || liveFirstCheck) {
          broadcastToUser(userId, 'live-status-update', {
            id: sub.id, liveStatus: info.liveStatus, title: info.title || '',
            uname: info.uname || '', cover: info.cover || '', avatar: info.avatar || ''
          });
        }
      }
      if (i < rooms.length - 1) await new Promise(function (r) { setTimeout(r, STAGGER_MS); });
    }
    liveFirstCheck = false;
    broadcastAll('live-subs-updated', {});
  } finally {
    checking = false;
  }
}

// ============================================================
// SSE:按 userId 分发
// ============================================================
function broadcastToUser(userId, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const c = sseClients[i];
    if (c.userId !== userId) continue;
    try { c.res.write(payload); } catch (e) { sseClients.splice(i, 1); }
  }
}

function broadcastAll(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const c = sseClients[i];
    try { c.res.write(payload); } catch (e) { sseClients.splice(i, 1); }
  }
}

// ============================================================
// HTTP 工具
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

function getUserId(req) {
  // 优先从 header 拿(普通 fetch)
  let uid = (req.headers['x-user-id'] || '').trim();
  if (uid) return uid;
  // 兜底从 URL query 拿(EventSource 不支持自定义 header)
  try {
    const u = new URL(req.url, 'http://localhost');
    uid = (u.searchParams.get('userId') || '').trim();
  } catch (e) {}
  return uid;
}

function genUserId() {
  return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substring(2, 10));
}

// ============================================================
// API 路由
// ============================================================
function handleApi(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean);
  const userId = getUserId(req);

  // GET /api/whoami  - 返回/生成 userId(前端首次访问用来拿 UUID)
  if (method === 'GET' && parts[1] === 'whoami' && parts.length === 2) {
    let uid = userId;
    if (!uid) uid = genUserId();
    // 确保用户在 store 里存在
    store.getUser(uid);
    return sendJson(res, 200, { success: true, userId: uid });
  }

  // 没带 userId 的请求(除了 whoami)都拒绝
  if (!userId) return sendJson(res, 401, { success: false, error: '缺少 X-User-Id,请刷新页面' });

  // GET /api/subs
  if (method === 'GET' && parts[1] === 'subs' && parts.length === 2) {
    const subs = store.getSubs(userId);
    return sendJson(res, 200, { success: true, subs: subs.map(function (s) {
      return { id: s.id, platform: s.platform, roomId: s.roomId, uname: s.uname || '', avatar: s.avatar || '', cover: s.cover || '', liveStatus: s.liveStatus, title: s.title || '', remark: s.remark || '' };
    }) });
  }

  // POST /api/subs/sync
  if (method === 'POST' && parts[1] === 'subs' && parts[2] === 'sync') {
    return readBody(req).then(async function (body) {
      const incoming = Array.isArray(body.subs) ? body.subs : [];
      const existingSubs = store.getSubs(userId);
      const next = [];
      const seen = {};
      for (const s of incoming) {
        if (!s || !s.roomId) continue;
        const pf = s.platform === 'douyin' ? 'douyin' : 'bilibili';
        const key = pf + ':' + String(s.roomId);
        if (seen[key]) continue;
        seen[key] = true;
        const existing = existingSubs.find(function (x) { return x.platform === pf && x.roomId === String(s.roomId); });
        next.push({
          id: s.id || (Date.now().toString() + Math.floor(Math.random() * 1000)),
          platform: pf, roomId: String(s.roomId), remark: (s.remark || '').trim(),
          uname: existing ? existing.uname : '', avatar: existing ? existing.avatar : '',
          cover: existing ? existing.cover : '', liveStatus: existing ? existing.liveStatus : 0,
          title: existing ? existing.title : ''
        });
      }
      store.setSubs(userId, next);
      if (next.length > 0 && !liveTimer) startLiveChecker();
      await checkAllLive();
      broadcastToUser(userId, 'live-subs-updated', {});
      const subs = store.getSubs(userId);
      return sendJson(res, 200, { success: true, subs: subs.map(function (s) {
        return { id: s.id, platform: s.platform, roomId: s.roomId, uname: s.uname || '', avatar: s.avatar || '', cover: s.cover || '', liveStatus: s.liveStatus, title: s.title || '', remark: s.remark || '' };
      }) });
    });
  }

  // POST /api/subs  { input }
  if (method === 'POST' && parts[1] === 'subs' && parts.length === 2) {
    return readBody(req).then(async function (body) {
      const parsed = parseLiveInput(body.input || '');
      if (!parsed) return sendJson(res, 200, { success: false, error: '无法识别链接,请输入B站或抖音直播间链接/房间号' });
      if (parsed.needResolve) {
        try { parsed.roomId = await resolveDouyinRoomId(parsed.url); }
        catch (e) { return sendJson(res, 200, { success: false, error: '抖音链接解析失败,请尝试直接输入房间号' }); }
      }
      const subs = store.getSubs(userId);
      const existing = subs.find(function (s) { return s.platform === parsed.platform && s.roomId === parsed.roomId; });
      if (existing) return sendJson(res, 200, { success: false, error: '该直播间已添加过啦' });
      const sub = { id: Date.now().toString() + Math.floor(Math.random() * 1000), platform: parsed.platform, roomId: parsed.roomId, uname: '', avatar: '', cover: '', liveStatus: 0, title: '', remark: '' };
      // 检查一次状态
      const info = await checkOneRoom(sub.platform, sub.roomId);
      if (info) {
        sub.liveStatus = info.liveStatus; sub.title = info.title || '';
        sub.uname = info.uname || ''; sub.avatar = info.avatar || ''; sub.cover = info.cover || '';
      }
      store.addSub(userId, sub);
      if (store.getSubs(userId).length === 1 && !liveTimer) startLiveChecker();
      broadcastToUser(userId, 'live-subs-updated', {});
      return sendJson(res, 200, { success: true, sub: sub });
    });
  }

  // DELETE /api/subs/:id
  if (method === 'DELETE' && parts[1] === 'subs' && parts.length === 3) {
    store.removeSub(userId, parts[2]);
    broadcastToUser(userId, 'live-subs-updated', {});
    return sendJson(res, 200, { success: true });
  }

  // PATCH /api/subs/:id/remark
  if (method === 'PATCH' && parts[1] === 'subs' && parts.length === 4 && parts[3] === 'remark') {
    return readBody(req).then(function (body) {
      const ok = store.updateSub(userId, parts[2], { remark: (body.remark || '').trim() });
      if (ok) { broadcastToUser(userId, 'live-subs-updated', {}); return sendJson(res, 200, { success: true }); }
      return sendJson(res, 200, { success: false });
    });
  }

  // POST /api/check
  if (method === 'POST' && parts[1] === 'check') {
    checkAllLive();
    return sendJson(res, 200, { success: true });
  }

  // GET /api/events (SSE)
  if (method === 'GET' && parts[1] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-User-Id'
    });
    res.write(': connected\n\n');
    const client = { res: res, userId: userId };
    sseClients.push(client);
    req.on('close', function () {
      const i = sseClients.indexOf(client);
      if (i >= 0) sseClients.splice(i, 1);
    });
    return;
  }

  // ===== 推送配置接口 =====
  // GET /api/push-config
  if (method === 'GET' && parts[1] === 'push-config' && parts.length === 2) {
    const cfg = store.getPushConfig(userId);
    return sendJson(res, 200, { success: true, config: { pushType: cfg.pushType, pushKey: cfg.pushKey } });
  }
  // POST /api/push-config
  if (method === 'POST' && parts[1] === 'push-config' && parts.length === 2) {
    return readBody(req).then(function (body) {
      const cfg = { pushType: (body.pushType || '').trim(), pushKey: (body.pushKey || '').trim() };
      if (cfg.pushType && !['serverchan', 'pushplus', 'bark'].includes(cfg.pushType)) {
        return sendJson(res, 200, { success: false, message: '推送方式不支持' });
      }
      store.setPushConfig(userId, cfg);
      return sendJson(res, 200, { success: true });
    });
  }
  // POST /api/push-config/test
  if (method === 'POST' && parts[1] === 'push-config' && parts[2] === 'test') {
    return readBody(req).then(function (body) {
      const cfg = { pushType: (body.pushType || '').trim(), pushKey: (body.pushKey || '').trim() };
      push.testPush(cfg.pushType, cfg.pushKey, function (ok, msg) {
        return sendJson(res, 200, { success: ok, message: msg });
      });
    });
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
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id'
    });
    return res.end();
  }
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return handleStatic(req, res, pathname);
}

// ============================================================
// 启动
// ============================================================
function startLiveChecker() {
  if (liveTimer) return;
  store.load();
  const rooms = store.getAllSubsGroupedByRoom();
  if (rooms.length > 0) setTimeout(checkAllLive, 3000);
  liveTimer = setInterval(function () {
    const rooms2 = store.getAllSubsGroupedByRoom();
    if (rooms2.length > 0) checkAllLive();
  }, POLL_INTERVAL);
}
function stopLiveChecker() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

store.load();
const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', function () {
  console.log('📡 直播订阅服务(多用户版)已启动');
  console.log('   端口: ' + PORT);
  const rooms = store.getAllSubsGroupedByRoom();
  console.log('   当前订阅房间数(去重): ' + rooms.length);
  startLiveChecker();
});

process.on('SIGINT', function () { stopLiveChecker(); process.exit(0); });
process.on('SIGTERM', function () { stopLiveChecker(); process.exit(0); });
