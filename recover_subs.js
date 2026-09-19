// 恢复脚本:把旧用户的订阅/偏好/推送配置复制到当前用户
// 用法(在服务器上): node recover_subs.js
// 会列出所有有订阅的用户,输入源用户ID和目标用户ID即可恢复

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_FILE = path.join(__dirname, 'users_data.json');
let users = {};
try {
  users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('读取 users_data.json 失败:', e.message);
  process.exit(1);
}

// 列出有订阅的用户
const list = Object.keys(users).map(function (uid) {
  const u = users[uid] || {};
  const live = (u.subs || []).length;
  const weibo = (u.weiboSubs || []).length;
  return { uid: uid, live: live, weibo: weibo, total: live + weibo };
}).filter(function (x) { return x.total > 0; });

if (list.length === 0) {
  console.log('没有找到任何有订阅的用户,无法恢复。');
  process.exit(0);
}

console.log('\n===== 有订阅数据的用户 =====');
list.forEach(function (x, i) {
  console.log((i + 1) + '. ' + x.uid.substring(0, 12) + '...' +
    '  直播:' + x.live + '  微博:' + x.weibo);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('\n请输入【源用户ID】(有订阅的那个,完整ID): ', function (src) {
  src = src.trim();
  if (!users[src]) { console.log('源用户不存在'); rl.close(); return; }
  rl.question('请输入【目标用户ID】(当前要恢复的用户,完整ID): ', function (dst) {
    dst = dst.trim();
    if (!dst) { console.log('目标用户不能为空'); rl.close(); return; }
    if (src === dst) { console.log('源和目标不能相同'); rl.close(); return; }

    if (!users[dst]) users[dst] = { pushType: '', pushKey: '', endedAlert: false, subs: [], weiboSubs: [] };
    const s = users[src];
    const d = users[dst];

    // 备份
    const backupFile = DATA_FILE + '.bak.' + Date.now();
    fs.writeFileSync(backupFile, JSON.stringify(users, null, 2));
    console.log('\n已备份原文件到:', backupFile);

    // 复制直播订阅(目标已有则跳过同平台+房间号)
    const existingKeys = {};
    (d.subs || []).forEach(function (s2) { existingKeys[s2.platform + ':' + s2.roomId] = true; });
    let addedLive = 0;
    (s.subs || []).forEach(function (sub) {
      const key = sub.platform + ':' + sub.roomId;
      if (!existingKeys[key]) { d.subs.push(sub); existingKeys[key] = true; addedLive++; }
    });

    // 复制微博订阅
    const existingWeibo = {};
    (d.weiboSubs || []).forEach(function (w) { existingWeibo[w.uid] = true; });
    let addedWeibo = 0;
    (s.weiboSubs || []).forEach(function (w) {
      if (!existingWeibo[w.uid]) { d.weiboSubs.push(w); existingWeibo[w.uid] = true; addedWeibo++; }
    });

    // 复制偏好(下播提醒)
    if (typeof s.endedAlert === 'boolean') d.endedAlert = s.endedAlert;

    // 复制推送配置(只在目标没有时复制)
    if (!d.pushType && s.pushType) {
      d.pushType = s.pushType;
      d.pushKey = s.pushKey || '';
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
    console.log('\n✅ 恢复完成!');
    console.log('  直播订阅新增: ' + addedLive + ' 个');
    console.log('  微博订阅新增: ' + addedWeibo + ' 个');
    console.log('  目标用户当前直播订阅: ' + (d.subs || []).length + ' 个');
    console.log('  目标用户当前微博订阅: ' + (d.weiboSubs || []).length + ' 个');
    console.log('\n请执行: systemctl restart live-sub-app');
    rl.close();
  });
});
