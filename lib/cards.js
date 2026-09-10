// lib/cards.js - 卡密系统
// 文件: cards_data.json
// 结构: { cards: { code: { code, days, maxLiveSubs, status, boundUserId, activatedAt, expiresAt, createdAt, remark } } }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'cards_data.json');
let cardsData = { cards: {} };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    cardsData = raw && raw.cards ? raw : { cards: {} };
  } catch (e) { cardsData = { cards: {} }; }
}

function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(cardsData, null, 2), 'utf8'); } catch (e) {}
}

// 生成随机卡密: LIVE-XXXX-XXXX-XXXX
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let code = 'LIVE-';
  for (let g = 0; g < 3; g++) {
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (g < 2) code += '-';
  }
  return code;
}

// 生成一张卡密
function generateCard(days, maxLiveSubs, remark) {
  const code = genCode();
  cardsData.cards[code] = {
    code: code,
    days: parseInt(days, 10) || 30,
    maxLiveSubs: parseInt(maxLiveSubs, 10) || 10,
    status: 'unused', // unused / used / disabled
    boundUserId: null,
    activatedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    remark: remark || ''
  };
  save();
  return cardsData.cards[code];
}

// 批量生成
function generateCards(count, days, maxLiveSubs, remark) {
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(generateCard(days, maxLiveSubs, remark));
  }
  return result;
}

// 获取卡密
function getCard(code) {
  return cardsData.cards[code] || null;
}

// 列出所有卡密
function listCards() {
  return Object.values(cardsData.cards).sort(function (a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

// 激活卡密（绑定到用户）
function activateCard(code, userId) {
  const card = cardsData.cards[code];
  if (!card) return { success: false, error: '卡密不存在' };
  if (card.status === 'disabled') return { success: false, error: '卡密已被停用' };
  if (card.status === 'used') return { success: false, error: '卡密已被使用' };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + card.days * 24 * 3600 * 1000);

  card.status = 'used';
  card.boundUserId = userId;
  card.activatedAt = now.toISOString();
  card.expiresAt = expiresAt.toISOString();
  save();

  return {
    success: true,
    card: card
  };
}

// 停用卡密
function disableCard(code) {
  const card = cardsData.cards[code];
  if (!card) return false;
  card.status = 'disabled';
  save();
  return true;
}

// 修改卡密备注
function updateCardRemark(code, remark) {
  const card = cardsData.cards[code];
  if (!card) return false;
  card.remark = (remark || '').trim();
  save();
  return true;
}

// 删除卡密
function deleteCard(code) {
  if (!cardsData.cards[code]) return false;
  delete cardsData.cards[code];
  save();
  return true;
}


// 启动免费试用(3天,1个订阅,IP 24h 防滥用)
function startTrial(userId, ip) {
  // 检查该 IP 24 小时内是否已试用过
  for (const code in cardsData.cards) {
    const card = cardsData.cards[code];
    if (card.type === 'trial' && card.trialIp === ip) {
      const age = Date.now() - new Date(card.activatedAt).getTime();
      if (age < 24 * 3600 * 1000) {
        return { success: false, error: '该 IP 24 小时内已试用过,请明天再试或激活正式卡密' };
      }
    }
  }
  // 检查该用户是否已有试用或正式卡密
  for (const code in cardsData.cards) {
    const card = cardsData.cards[code];
    if (card.boundUserId === userId && card.type === 'trial') {
      const exp = new Date(card.expiresAt).getTime();
      if (exp > Date.now()) {
        return { success: false, error: '你已有正在进行的试用' };
      }
    }
  }
  // 创建试用卡密
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
  const trialCode = 'TRIAL-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  cardsData.cards[trialCode] = {
    code: trialCode,
    type: 'trial',
    days: 3,
    maxLiveSubs: 1,
    status: 'used',
    boundUserId: userId,
    trialIp: ip,
    activatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    remark: '免费试用'
  };
  save();
  return { success: true };
}

// 检查用户授权状态
// 返回: { active: bool, expiresAt: string, maxLiveSubs: number, cardCode: string, daysLeft: number }
function getUserAuth(userId) {
  // 找绑定到这个用户的卡密
  for (const code in cardsData.cards) {
    const card = cardsData.cards[code];
    if (card.boundUserId === userId && card.status === 'used') {
      const now = Date.now();
      const exp = new Date(card.expiresAt).getTime();
      const active = exp > now;
      const daysLeft = Math.max(0, Math.ceil((exp - now) / (24 * 3600 * 1000)));
      return {
        active: active,
        expiresAt: card.expiresAt,
        maxLiveSubs: card.maxLiveSubs,
        cardCode: code,
        daysLeft: daysLeft,
        type: card.type || 'formal',
        expiredTrial: !active && card.type === 'trial'
      };
    }
  }
  return { active: false, expiresAt: null, maxLiveSubs: 0, cardCode: null, daysLeft: 0, type: null, expiredTrial: false };
}

module.exports = {
  load: load,
  generateCard: generateCard,
  generateCards: generateCards,
  getCard: getCard,
  listCards: listCards,
  activateCard: activateCard,
  disableCard: disableCard,
  deleteCard: deleteCard,
  updateCardRemark: updateCardRemark,
  getUserAuth: getUserAuth,
  startTrial: startTrial
};
