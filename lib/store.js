// lib/store.js - 多用户数据存储
// 文件:users_data.json
// 结构:{ userId: { pushType, pushKey, subs: [...] } }

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'users_data.json');
let usersData = {};

function load() {
  try {
    usersData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!usersData || typeof usersData !== 'object' || Array.isArray(usersData)) usersData = {};
  } catch (e) { usersData = {}; }
}

function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(usersData, null, 2), 'utf8'); } catch (e) {}
}

function getUser(userId) {
  if (!userId) return null;
  if (!usersData[userId]) usersData[userId] = { pushType: '', pushKey: '', subs: [] };
  if (!Array.isArray(usersData[userId].subs)) usersData[userId].subs = [];
  return usersData[userId];
}

function getSubs(userId) {
  const u = getUser(userId);
  return u ? u.subs : [];
}

function setSubs(userId, subs) {
  const u = getUser(userId);
  if (!u) return false;
  u.subs = Array.isArray(subs) ? subs : [];
  save();
  return true;
}

function addSub(userId, sub) {
  const u = getUser(userId);
  if (!u) return false;
  u.subs.push(sub);
  save();
  return true;
}

function removeSub(userId, subId) {
  const u = getUser(userId);
  if (!u) return false;
  const idx = u.subs.findIndex(function (s) { return s.id === subId; });
  if (idx < 0) return false;
  u.subs.splice(idx, 1);
  save();
  return true;
}

function findSub(userId, subId) {
  const u = getUser(userId);
  if (!u) return null;
  return u.subs.find(function (s) { return s.id === subId; }) || null;
}

function updateSub(userId, subId, updates) {
  const u = getUser(userId);
  if (!u) return false;
  const sub = u.subs.find(function (s) { return s.id === subId; });
  if (!sub) return false;
  Object.assign(sub, updates);
  save();
  return true;
}

function getPushConfig(userId) {
  const u = getUser(userId);
  if (!u) return { pushType: '', pushKey: '' };
  return { pushType: u.pushType || '', pushKey: u.pushKey || '' };
}

function setPushConfig(userId, cfg) {
  const u = getUser(userId);
  if (!u) return false;
  u.pushType = (cfg && cfg.pushType) || '';
  u.pushKey = (cfg && cfg.pushKey) || '';
  save();
  return true;
}

// 收集所有用户的所有订阅,按 (platform:roomId) 去重
// 返回:[{ platform, roomId, owners: [{ userId, sub }] }]
function getAllSubsGroupedByRoom() {
  const map = {};
  for (const userId in usersData) {
    const u = usersData[userId];
    if (!u || !Array.isArray(u.subs)) continue;
    for (const sub of u.subs) {
      if (!sub || !sub.platform || !sub.roomId) continue;
      const key = sub.platform + ':' + sub.roomId;
      if (!map[key]) map[key] = { platform: sub.platform, roomId: String(sub.roomId), owners: [] };
      map[key].owners.push({ userId: userId, sub: sub });
    }
  }
  return Object.values(map);
}

// 找出订阅了某个 room 的所有用户
function getOwnersOfRoom(platform, roomId) {
  const result = [];
  for (const userId in usersData) {
    const u = usersData[userId];
    if (!u || !Array.isArray(u.subs)) continue;
    const sub = u.subs.find(function (s) { return s.platform === platform && String(s.roomId) === String(roomId); });
    if (sub) result.push({ userId: userId, sub: sub });
  }
  return result;
}

// 删除空用户(可选,定期清理)
function cleanupEmptyUsers() {
  let changed = false;
  for (const userId in usersData) {
    const u = usersData[userId];
    if ((!u.subs || u.subs.length === 0) && !u.pushType && !u.pushKey) {
      delete usersData[userId];
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = {
  load: load,
  save: save,
  getUser: getUser,
  getSubs: getSubs,
  setSubs: setSubs,
  addSub: addSub,
  removeSub: removeSub,
  findSub: findSub,
  updateSub: updateSub,
  getPushConfig: getPushConfig,
  setPushConfig: setPushConfig,
  getAllSubsGroupedByRoom: getAllSubsGroupedByRoom,
  getOwnersOfRoom: getOwnersOfRoom,
  cleanupEmptyUsers: cleanupEmptyUsers
};
