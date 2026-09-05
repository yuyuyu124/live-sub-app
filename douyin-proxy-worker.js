export default {
  async fetch(request) {
    const url = new URL(request.url);
    const roomId = url.pathname.replace('/', '');
    if (!roomId || roomId === 'favicon.ico') {
      return new Response('Douyin Proxy - usage: /949162394884', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    try {
      const resp = await fetch('https://live.douyin.com/' + roomId, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://live.douyin.com/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        redirect: 'follow'
      });
      const html = await resp.text();
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response('Proxy error: ' + e.message, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  }
};
