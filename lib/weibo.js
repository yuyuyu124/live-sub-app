// lib/weibo.js - 微博动态抓取
// 默认走自建 Cloudflare Worker 代理(weibo-proxy),可通过环境变量 WEIBO_PROXY_URL 配置
// 格式:GET https://your-worker.workers.dev/u/:uid
// 备选:RSSHub(WEIBO_BACKEND=rsshub + RSSHUB_BASE) 或 直接访问微博(m.weibo.cn)

const WEIBO_PROXY_URL = (process.env.WEIBO_PROXY_URL || '').replace(/\/$/, '');
const WEIBO_BACKEND = (process.env.WEIBO_BACKEND || (WEIBO_PROXY_URL ? 'proxy' : 'none')).toLowerCase();
const RSSHUB_BASE = (process.env.RSSHUB_BASE || '').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function fetchWithTimeout(urlStr, ms, headers) {
  return Promise.race([
    fetch(urlStr, { headers: headers || { 'User-Agent': UA } }),
    new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })
  ]);
}

// ============================================================
// 后端 1:weibo-proxy Worker(推荐) - 返回干净 JSON
// ============================================================
async function fetchViaProxy(uid) {
  const url = WEIBO_PROXY_URL + '/u/' + uid;
  const resp = await fetchWithTimeout(url, 10000);
  if (!resp.ok) throw new Error('weibo-proxy 返回 HTTP ' + resp.status);
  const data = await resp.json();
  if (!data || data.ok !== true) {
    throw new Error('weibo-proxy 错误: ' + ((data && data.error) || '未知错误'));
  }
  const author = (data.user && data.user.screenName) || '';
  const posts = Array.isArray(data.posts) ? data.posts : [];
  return posts.map(function (p) {
    return {
      mid: p.mid || p.bid || '',
      title: '',
      link: p.url || '',
      pubDate: p.created_at || '',
      description: (p.text || '').substring(0, 300),
      author: author || p.originalAuthor || '',
      isRetweeted: !!p.isRetweeted,
    };
  });
}

// ============================================================
// 后端 2:RSSHub JSON Feed 格式(兼容旧部署)
// ============================================================
async function fetchViaRSSHub(uid) {
  const url = RSSHUB_BASE + '/weibo/user/' + uid + '.json';
  const resp = await fetchWithTimeout(url, 10000);
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
      author: author || (item.author || ''),
    };
  });
}

// ============================================================
// 主入口:拉取博主最新微博列表(从新到旧)
// 返回:[{ mid, title, link, pubDate, description, author }]
// ============================================================
async function fetchWeiboPosts(uid) {
  if (WEIBO_BACKEND === 'proxy' && WEIBO_PROXY_URL) {
    return fetchViaProxy(uid);
  }
  if (WEIBO_BACKEND === 'rsshub' && RSSHUB_BASE) {
    return fetchViaRSSHub(uid);
  }
  throw new Error('未配置微博后端:请设置 WEIBO_PROXY_URL 或 RSSHUB_BASE + WEIBO_BACKEND=rsshub');
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
