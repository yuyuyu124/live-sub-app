export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const query = url.search;

    // 首页提示
    if (path === '/' || path === '/favicon.ico') {
      return new Response('Douyin Proxy - usage: /949162394884 或 /webcast/room/web/enter/...', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response('', {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    try {
      const targetUrl = 'https://live.douyin.com' + path + query;

      // 从入站请求继承 headers,但覆盖关键反爬头
      const headers = new Headers(request.headers);
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      headers.set('Referer', 'https://live.douyin.com/');

      const resp = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        redirect: 'follow'
      });

      const contentType = resp.headers.get('content-type') || 'text/html; charset=utf-8';
      const body = await resp.text();

      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    } catch (e) {
      return new Response('Proxy error: ' + e.message, {
        status: 500,
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
