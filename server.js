const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}, null, 2));
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify([], null, 2));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function randomToken(len) { return crypto.randomBytes(len).toString('hex'); }
function makeTempId() { return 'U' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function now() { return Date.now(); }

function authMiddleware(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing session token' });
  const sessions = readJson(SESSIONS_FILE, {});
  const sess = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Invalid session token' });
  if (sess.expiresAt <= now()) {
    delete sessions[token];
    writeJson(SESSIONS_FILE, sessions);
    return res.status(401).json({ ok: false, error: 'Session expired' });
  }
  req.session = sess;
  next();
}

function getAccounts() { return readJson(ACCOUNTS_FILE, []); }
function saveAccounts(accounts) { writeJson(ACCOUNTS_FILE, accounts); }
function getSessions() { return readJson(SESSIONS_FILE, {}); }
function saveSessions(sessions) { writeJson(SESSIONS_FILE, sessions); }
function getMessages() { return readJson(MESSAGES_FILE, []); }
function saveMessages(messages) { writeJson(MESSAGES_FILE, messages); }
function getGroups() { return readJson(GROUPS_FILE, []); }
function saveGroups(groups) { writeJson(GROUPS_FILE, groups); }

function uniqueUsername(accounts, username) {
  return accounts.some(function (a) { return a.username.toLowerCase() === username.toLowerCase(); });
}
function getAccountByDeviceId(accounts, deviceId) {
  return accounts.find(function (a) { return a.deviceId === deviceId; });
}
function getAccountByUsername(accounts, username) {
  return accounts.find(function (a) { return a.username.toLowerCase() === username.toLowerCase(); });
}
function getAccountById(accounts, userId) {
  return accounts.find(function (a) { return a.userId === userId; });
}

function createTempPublicIdMap(account) {
  var map = account.publicIds || {};
  var slot = Math.floor(now() / (15 * 60 * 1000));
  if (!map[String(slot)]) map[String(slot)] = makeTempId();
  account.publicIds = map;
  account.currentSlot = slot;
  account.currentPublicId = map[String(slot)];
  return account.currentPublicId;
}

function resolveRecipient(accounts, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  let found = getAccountByUsername(accounts, q);
  if (found) return found;
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    if (a.currentPublicId === q) return a;
    if (a.publicIds && Object.values(a.publicIds).indexOf(q) !== -1) return a;
  }
  return null;
}

ensureDataFiles();

app.post('/api/create-account', function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const deviceId = String(req.body.deviceId || '').trim();

  if (username.length < 3) return res.status(400).json({ ok: false, error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password too short' });
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Missing deviceId' });

  const accounts = getAccounts();
  if (getAccountByDeviceId(accounts, deviceId)) {
    return res.status(409).json({ ok: false, error: 'This phone/device already has an account' });
  }
  if (uniqueUsername(accounts, username)) {
    return res.status(409).json({ ok: false, error: 'Username already taken' });
  }

  const userId = randomToken(8);
  const tempPublicId = makeTempId();
  const passHash = sha256(password + ':chat_salt_v1');

  const account = {
    userId: userId,
    username: username,
    passwordHash: passHash,
    deviceId: deviceId,
    createdAt: now(),
    publicIds: {},
    currentSlot: null,
    currentPublicId: tempPublicId
  };
  account.publicIds[String(Math.floor(now() / (15 * 60 * 1000)))] = tempPublicId;

  accounts.push(account);
  saveAccounts(accounts);

  const token = randomToken(24);
  const sessions = getSessions();
  sessions[token] = {
    userId: userId,
    deviceId: deviceId,
    createdAt: now(),
    expiresAt: now() + (7 * 24 * 60 * 60 * 1000)
  };
  saveSessions(sessions);

  return res.json({
    ok: true,
    userId: userId,
    username: username,
    publicId: tempPublicId,
    sessionToken: token
  });
});

app.post('/api/login', function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const deviceId = String(req.body.deviceId || '').trim();

  const accounts = getAccounts();
  const account = getAccountByUsername(accounts, username);
  if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

  if (account.deviceId !== deviceId) {
    return res.status(403).json({ ok: false, error: 'This account is locked to the original device' });
  }

  const passHash = sha256(password + ':chat_salt_v1');
  if (passHash !== account.passwordHash) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  const token = randomToken(24);
  const sessions = getSessions();
  sessions[token] = {
    userId: account.userId,
    deviceId: deviceId,
    createdAt: now(),
    expiresAt: now() + (7 * 24 * 60 * 60 * 1000)
  };
  saveSessions(sessions);

  const publicId = createTempPublicIdMap(account);
  saveAccounts(accounts);

  return res.json({
    ok: true,
    userId: account.userId,
    username: account.username,
    publicId: publicId,
    sessionToken: token
  });
});

app.get('/api/search', authMiddleware, function (req, res) {
  const q = String(req.query.q || '').trim();
  const accounts = getAccounts();
  const account = resolveRecipient(accounts, q);
  if (!account) return res.json({ ok: true, found: false });
  return res.json({
    ok: true,
    found: true,
    userId: account.userId,
    username: account.username,
    publicId: createTempPublicIdMap(account)
  });
});

app.post('/api/send', authMiddleware, function (req, res) {
  const to = String(req.body.to || '').trim();
  const text = String(req.body.text || '').trim();
  const isGroup = String(req.body.isGroup || '') === '1';

  if (!text) return res.status(400).json({ ok: false, error: 'Empty message' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'Message too long' });

  const accounts = getAccounts();
  const sender = getAccountById(accounts, req.session.userId);
  if (!sender) return res.status(404).json({ ok: false, error: 'Sender missing' });

  const messages = getMessages();

  if (isGroup) {
    const groups = getGroups();
    const group = groups.find(function (g) { return g.groupId === to; });
    if (!group) return res.status(404).json({ ok: false, error: 'Group not found' });
    if (group.members.indexOf(sender.userId) === -1) {
      return res.status(403).json({ ok: false, error: 'Not a member of group' });
    }
    group.members.forEach(function (memberId) {
      if (memberId === sender.userId) return;
      messages.push({
        id: randomToken(10),
        type: 'group',
        groupId: group.groupId,
        fromUserId: sender.userId,
        toUserId: memberId,
        text: text,
        createdAt: now(),
        delivered: false
      });
    });
    saveMessages(messages);
    return res.json({ ok: true, sent: true });
  }

  const receiver = resolveRecipient(accounts, to);
  if (!receiver) return res.status(404).json({ ok: false, error: 'User not found' });

  messages.push({
    id: randomToken(10),
    type: 'direct',
    fromUserId: sender.userId,
    toUserId: receiver.userId,
    text: text,
    createdAt: now(),
    delivered: false
  });
  saveMessages(messages);
  return res.json({ ok: true, sent: true });
});

app.get('/api/poll', authMiddleware, function (req, res) {
  const userId = req.session.userId;
  const messages = getMessages();
  const accounts = getAccounts();
  const out = [];
  const kept = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.toUserId === userId) {
      const sender = getAccountById(accounts, m.fromUserId);
      out.push({
        id: m.id,
        type: m.type,
        groupId: m.groupId || null,
        fromUserId: m.fromUserId,
        fromUsername: sender ? sender.username : 'unknown',
        text: m.text,
        createdAt: m.createdAt
      });
    } else {
      kept.push(m);
    }
  }

  saveMessages(kept);
  return res.json({ ok: true, messages: out });
});

app.post('/api/create-group', authMiddleware, function (req, res) {
  const name = String(req.body.name || '').trim();
  const membersRaw = Array.isArray(req.body.members) ? req.body.members : [];
  if (!name) return res.status(400).json({ ok: false, error: 'Group name required' });

  const accounts = getAccounts();
  const creator = getAccountById(accounts, req.session.userId);
  if (!creator) return res.status(404).json({ ok: false, error: 'Creator missing' });

  const memberIds = {};
  memberIds[creator.userId] = true;
  for (let i = 0; i < membersRaw.length; i++) {
    const found = resolveRecipient(accounts, String(membersRaw[i]).trim());
    if (found) memberIds[found.userId] = true;
  }

  const group = {
    groupId: 'G' + randomToken(6),
    name: name,
    adminUserId: creator.userId,
    members: Object.keys(memberIds),
    createdAt: now()
  };

  const groups = getGroups();
  groups.push(group);
  saveGroups(groups);
  return res.json({ ok: true, groupId: group.groupId, name: group.name });
});

app.get('/api/groups', authMiddleware, function (req, res) {
  const groups = getGroups();
  const userId = req.session.userId;
  const mine = groups.filter(function (g) { return g.members.indexOf(userId) !== -1; });
  return res.json({ ok: true, groups: mine });
});

app.post('/api/cleanup', function (req, res) {
  const messages = getMessages().filter(function (m) { return !m.delivered; });
  saveMessages(messages);
  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
  
