function parseDouyinRoom(html) {
  if (!html || html.length < 1000) return null;

  // === 新版(2024+):数据在 __pace_f 的 RSC 数据中 ===
  // 每个 push 在单独的 <script> 里,用 </script> 定位边界
  var paceFull = '';
  var searchStr = '__pace_f.push([1,';
  var pos = 0;
  while (true) {
    var idx = html.indexOf(searchStr, pos);
    if (idx < 0) break;
    var scriptEnd = html.indexOf('</script>', idx);
    if (scriptEnd < 0) break;
    var chunk = html.substring(idx, scriptEnd);
    var q1 = chunk.indexOf('"');
    var q2 = chunk.lastIndexOf('"]');
    if (q1 >= 0 && q2 > q1) {
      var content = chunk.substring(q1 + 1, q2);
      content = content.split('\\"').join('"').split('\\/').join('/').split('\\n').join('');
      paceFull += content;
    }
    pos = scriptEnd + 9;
  }

  // 找 roomStore 下有实际数据的(含 nickname 或 web_rid)
  var rsStart = 0;
  while (true) {
    var rsIdx = paceFull.indexOf('roomStore', rsStart);
    if (rsIdx < 0) break;
    rsStart = rsIdx + 10;
    var seg = paceFull.substring(rsIdx, rsIdx + 8000);
    var lsMatch = seg.match(/"liveStatus"\s*:\s*"([^"]+)"/);
    var nickMatch = seg.match(/"nickname"\s*:\s*"([^"]{0,60})"/);
    var ridMatch = seg.match(/"web_rid"\s*:\s*"(\d+)"/);
    var avatarMatch = seg.match(/"avatar_thumb"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["([^"]+)"/);
    var titleMatch = seg.match(/"title"\s*:\s*"([^"]{0,100})"/);
    if ((lsMatch || nickMatch) && (nickMatch || ridMatch)) {
      // 在整个 paceFull 中搜索 web_stream_url(不限 8000 字符范围)
      var streamUrlMatch = paceFull.indexOf('flv_pull_url') >= 0;
      var isLive = lsMatch && (lsMatch[1] === 'live' || lsMatch[1] === 'streaming');
      var hasStream = !!streamUrlMatch;
      return {
        status: (isLive || hasStream) ? 2 : 0,
        title: titleMatch ? titleMatch[1] : '',
        nickname: nickMatch ? nickMatch[1] : '',
        avatar: avatarMatch ? avatarMatch[1].replace(/\\u002F/g, '/') : '',
        web_rid: ridMatch ? ridMatch[1] : ''
      };
    }
  }

  // === 旧版兼容 ===
  var marker1 = '\\"room\\":{\\"id_str\\"';
  var idx2 = html.indexOf(marker1);
  if (idx2 >= 0) {
    var seg2 = html.substring(idx2, idx2 + 12000);
    seg2 = seg2.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\n/g, '');
    var result2 = extractRoomFromJson(seg2);
    if (result2 && result2.status !== null) return result2;
  }
  var marker2 = '"room":{';
  idx2 = html.indexOf(marker2);
  if (idx2 >= 0) {
    var seg3 = html.substring(idx2, idx2 + 12000);
    var result3 = extractRoomFromJson(seg3);
    if (result3 && result3.status !== null) return result3;
  }
  var initProps = html.match(/window\.__INIT_PROPS__\s*=\s*(\{.*?\})\s*;\s*</);
  if (initProps) {
    try {
      var data = JSON.parse(initProps[1]);
      var roomInfo = findRoomInObject(data);
      if (roomInfo) return roomInfo;
    } catch (e) {}
  }
  var statusM = html.match(/"status"\s*:\s*(\d+)/);
  var titleM2 = html.match(/"title"\s*:\s*"([^"]{0,100})"/);
  var nickM2 = html.match(/"nickname"\s*:\s*"([^"]{0,60})"/);
  var avatarM2 = html.match(/"avatar_thumb"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["([^"]+)"/);
  var webRidM2 = html.match(/"web_rid"\s*:\s*"(\d+)"/);
  if (statusM || titleM2 || nickM2) {
    return {
      status: statusM ? parseInt(statusM[1], 10) : null,
      title: titleM2 ? titleM2[1] : '', nickname: nickM2 ? nickM2[1] : '',
      avatar: avatarM2 ? avatarM2[1].replace(/\\u002F/g, '/') : '',
      web_rid: webRidM2 ? webRidM2[1] : ''
    };
  }
  return null;
}
