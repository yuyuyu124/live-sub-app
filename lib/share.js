// lib/share.js - 分享截图审核
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'share_reviews.json');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

let reviews = [];

function load() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    reviews = raw.reviews || [];
  } catch (e) { reviews = []; }
}

function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ reviews: reviews }, null, 2), 'utf8'); } catch (e) {}
}

function createReview(userId, imageBase64) {
  const id = 'rev_' + crypto.randomBytes(6).toString('hex');
  const fileName = id + '.png';
  const filePath = path.join(UPLOAD_DIR, fileName);
  const base64Data = (imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  const review = {
    id: id,
    userId: userId,
    imageUrl: '/uploads/' + fileName,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewNote: ''
  };
  reviews.unshift(review);
  save();
  return review;
}

function getUserReviews(userId) {
  return reviews.filter(function (r) { return r.userId === userId; });
}

function getPendingReviews() {
  return reviews.filter(function (r) { return r.status === 'pending'; });
}

function reviewShare(id, approved, note) {
  const r = reviews.find(function (x) { return x.id === id; });
  if (!r) return null;
  r.status = approved ? 'approved' : 'rejected';
  r.reviewedAt = new Date().toISOString();
  r.reviewNote = note || '';
  save();
  return r;
}

module.exports = { load: load, createReview: createReview, getUserReviews: getUserReviews, getPendingReviews: getPendingReviews, reviewShare: reviewShare };
