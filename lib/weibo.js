// lib/weibo.js - 微博动态抓取(通过 RSSHub)
// 依赖:RSSHub 实例(默认 http://localhost:1200,可用环境变量 RSSHUB_BASE 配置)
// 路由:/weibo/user/:uid 返回该博主的微博(原创+转发)

const RSSHUB_BASE = (process.env.RSSHUB_BASE || 'http://localhost:1200').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function fetchWithTimeout(urlStr, ms) {
  return Promise.race([
    fetch(urlStr, { headers: { 'User-Agent': UA } }),
    new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })
  ]);
}

// 拉取博主最新微博列表(从新到旧)
// 返回:[{ mid, title, link, pubDate, description, author }]
async function fetchWeiboPosts(uid) {
  const url = RSSHUB_BASE + '/weibo/user/' + uid + '.json';
  const resp = await fetchWithTimeout(url, 8000);
  if (!resp.ok) throw new Error('RSSHub 返回 ' + resp.status);
  const data = await resp.json();
  const author = (data && data.title) ? data.title.replace(/的微博$/, '').trim() : '';
  const items = (data && Array.isArray(data.item)) ? data.item : [];
  return items.map(function (item) {
    return {
      mid: item.link || item.guid || item.title,
      title: (item.title || '').trim(),
      link: item.link || '',
      pubDate: item.pubDate || '',
      description: stripHtml((item.description || item.title || '')).substring(0, 200),
      author: author || (item.author || '')
    };
  });
}

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

// 解析用户输入:微博主页链接或纯 uid
function parseWeiboInput(input) {
  input = (input || '').trim();
  if (!input) return null;
  let m = input.match(/weibo\.com\/u\/(\d+)/);
  if (m) return { uid: m[1] };
  m = input.match(/weibo\.com\/(\d{5,12})/);
  if (m) return { uid: m[1] };
  m = input.match(/m\.weibo\.cn\/u\/(\d+)/);
  if (m) return { uid: m[1] };
  m = input.match(/m\.weibo\.cn\/profile\/(\d+)/);
  if (m) return { uid: m[1] };
  if (/^\d{5,12}$/.test(input)) return { uid: input };
  return null;
}

module.exports = {
  fetchWeiboPosts: fetchWeiboPosts,
  parseWeiboInput: parseWeiboInput
};
