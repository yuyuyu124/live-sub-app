// lib/push.js - 多推送服务封装(Server酱 / PushPlus / Bark)
// 无状态:所有函数都接收 pushType + pushKey,不存全局配置

const https = require('https');
const http = require('http');

function httpGetRaw(urlStr, callback) {
  const lib = urlStr.startsWith('https://') ? https : http;
  const req = lib.get(urlStr, function (res) {
    let body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () { callback(null, body); });
  });
  req.on('error', function (e) { callback(e.message, null); });
  req.setTimeout(5000, function () { req.destroy(); callback('timeout', null); });
}

function pushServerchan(key, title, desp) {
  if (!key) return;
  const url = 'https://sctapi.ftqq.com/' + key + '.send?title=' + encodeURIComponent(title) + '&desp=' + encodeURIComponent(desp || '');
  httpGetRaw(url, function (err, body) {
    if (err) console.log('[Server酱] 请求失败:', err);
    else console.log('[Server酱] 推送结果:', body);
  });
}

function pushPushplus(token, title, content) {
  if (!token) return;
  const postData = JSON.stringify({ token: token, title: title, content: content || '', template: 'txt' });
  const req = https.request({
    hostname: 'www.pushplus.plus', port: 443, path: '/send', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  }, function (res) {
    let body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () { console.log('[PushPlus] 推送结果:', body); });
  });
  req.on('error', function (e) { console.log('[PushPlus] 请求失败:', e.message); });
  req.setTimeout(5000, function () { req.destroy(); });
  req.write(postData); req.end();
}

function pushBark(key, title, body) {
  if (!key) return;
  let host = 'api.day.app';
  let barkKey = key;
  if (key.indexOf('://') >= 0) {
    const m = key.match(/^https?:\/\/([^\/]+)\/([^\/]+)/);
    if (m) { host = m[1]; barkKey = m[2]; }
  }
  const url = 'https://' + host + '/' + barkKey + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body || '');
  httpGetRaw(url, function (err, respBody) {
    if (err) console.log('[Bark] 请求失败:', err);
    else console.log('[Bark] 推送结果:', respBody);
  });
}

// 统一推送入口
function pushAlert(pushType, pushKey, title, desp) {
  if (!pushType || !pushKey) return false;
  console.log('[推送] 触发:', pushType, '|', title);
  if (pushType === 'serverchan') pushServerchan(pushKey, title, desp);
  else if (pushType === 'pushplus') pushPushplus(pushKey, title, desp);
  else if (pushType === 'bark') pushBark(pushKey, title, desp);
  else return false;
  return true;
}

// 测试推送
function testPush(pushType, pushKey, callback) {
  if (!pushType || !pushKey) {
    if (callback) callback(false, '未配置推送方式或 key');
    return;
  }
  if (!['serverchan', 'pushplus', 'bark'].includes(pushType)) {
    if (callback) callback(false, '推送方式不支持');
    return;
  }
  pushAlert(pushType, pushKey, '测试推送', '这是一条来自直播订阅服务的测试消息,收到说明配置成功。');
  setTimeout(function () {
    if (callback) callback(true, '已发送测试推送,请到微信/App 查看');
  }, 1500);
}

module.exports = {
  pushAlert: pushAlert,
  testPush: testPush
};
