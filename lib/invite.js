// lib/invite.js - 邀请码系统
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cards = require('./cards');
const store = require('./store');
const DATA_FILE = path.join(__dirname, '..', 'invites.json');
let invites = [];
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    invites = raw.invites || [];
  } catch (e) { invites = []; }
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ invites: invites }, null, 2), 'utf8'); } catch (e) {}
}
function getInviteCode(userId) {
  return (userId || '').substring(0, 8).toUpperCase();
}
function findInviterByCode(code) {
  if (!code) return null;
  code = code.trim().toUpperCase();
  const allUsers = store.getAllUsers();
  for (const uid in allUsers) {
    if (getInviteCode(uid) === code) return uid;
  }
  return null;
}
function createInvite(inviterId, inviteeId, cardCode) {
  if (inviterId === inviteeId) return { success: false, error: '不能邀请自己' };
  const existing = invites.find(function (i) { return i.inviteeId === inviteeId; });
  if (existing) return { success: false, error: '该用户已使用过邀请码' };
  const id = 'inv_' + crypto.randomBytes(6).toString('hex');
  const invite = {
    id: id,
    inviterId: inviterId,
    inviteeId: inviteeId,
    cardCode: cardCode,
    rewardStatus: 'pending',
    inviteeRewardStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  invites.unshift(invite);
  save();
  return { success: true, invite: invite };
}
function getUserInvites(userId) {
  return invites.filter(function (i) { return i.inviterId === userId; });
}
function claimReward(inviteId, rewardType, phone, payMethod) {
  const invite = invites.find(function (i) { return i.id === inviteId; });
  if (!invite) return { success: false, error: '邀请记录不存在' };
  if (invite.rewardStatus !== 'pending') return { success: false, error: '该奖励已领取' };
  if (rewardType === 'membership') {
    cards.grantMembership(invite.inviterId, 90, 999);
    invite.rewardStatus = 'membership_granted';
    invite.claimedAt = new Date().toISOString();
    save();
    return { success: true, message: '已获得3个月会员' };
  } else if (rewardType === 'cash') {
    if (!phone || !/^1\d{10}$/.test(phone)) return { success: false, error: '请输入正确的手机号' };
    if (!['alipay', 'wechat'].includes(payMethod)) return { success: false, error: '请选择返现方式' };
    invite.rewardStatus = 'cash_pending';
    invite.claimedAt = new Date().toISOString();
    invite.cashPhone = phone;
    invite.cashMethod = payMethod;
    save();
    return { success: true, message: '已提交返现申请,管理员会尽快打款' };
  }
  return { success: false, error: '无效的奖励类型' };
}
function getInviteePending(userId) {
  return invites.find(function (i) { return i.inviteeId === userId && i.inviteeRewardStatus === 'pending'; });
}
function claimInviteeReward(inviteId, rewardType, phone, payMethod) {
  const invite = invites.find(function (i) { return i.id === inviteId; });
  if (!invite) return { success: false, error: '邀请记录不存在' };
  if (invite.inviteeRewardStatus !== 'pending') return { success: false, error: '该奖励已领取' };
  if (rewardType === 'membership') {
    cards.grantMembership(invite.inviteeId, 60, 999);
    invite.inviteeRewardStatus = 'membership_granted';
    invite.inviteeClaimedAt = new Date().toISOString();
    save();
    return { success: true, message: '已获得2个月会员' };
  } else if (rewardType === 'cash') {
    if (!phone || !/^1\d{10}$/.test(phone)) return { success: false, error: '请输入正确的手机号' };
    if (!['alipay', 'wechat'].includes(payMethod)) return { success: false, error: '请选择返现方式' };
    invite.inviteeRewardStatus = 'cash_pending';
    invite.inviteeClaimedAt = new Date().toISOString();
    invite.inviteeCashPhone = phone;
    invite.inviteeCashMethod = payMethod;
    save();
    return { success: true, message: '已提交返现申请,管理员会尽快打款' };
  }
  return { success: false, error: '无效的奖励类型' };
}
function getAllInvites() {
  return invites;
}
function markCashPaid(inviteId, target) {
  const invite = invites.find(function (i) { return i.id === inviteId; });
  if (!invite) return false;
  if (target === 'invitee') {
    if (invite.inviteeRewardStatus !== 'cash_pending') return false;
    invite.inviteeRewardStatus = 'cash_paid';
    invite.inviteePaidAt = new Date().toISOString();
  } else {
    if (invite.rewardStatus !== 'cash_pending') return false;
    invite.rewardStatus = 'cash_paid';
    invite.paidAt = new Date().toISOString();
  }
  save();
  return true;
}
module.exports = { load: load, getInviteCode: getInviteCode, findInviterByCode: findInviterByCode, createInvite: createInvite, getUserInvites: getUserInvites, claimReward: claimReward, getAllInvites: getAllInvites, markCashPaid: markCashPaid, getInviteePending: getInviteePending, claimInviteeReward: claimInviteeReward };
