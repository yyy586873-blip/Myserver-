
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

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureFile(ACCOUNTS_FILE, []);
  ensureFile(SESSIONS_FILE, {});
  ensureFile(MESSAGES_FILE, []);
  ensureFile(GROUPS_FILE, []);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function randomToken(len) {
  return crypto.randomBytes(len).toString('hex');
}

function makeTempId() {
  return 'U' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function now() {
  return Date.now();
}

function getAccounts() { return readJson(ACCOUNTS_FILE, []); }
function saveAccounts(data) { writeJson(ACCOUNTS_FILE, data); }
function getSessions() { return readJson(SESSIONS_FILE, {}); }
function saveSessions(data) { writeJson(SESSIONS_FILE, data); }
function getMessages() { return readJson(MESSAGES_FILE, []); }
function saveMessages(data) { writeJson(MESSAGES_FILE, data); }
function getGroups() { return readJson(GROUPS_FILE, []); }
function saveGroups(data) { writeJson(GROUPS_FILE, data); }

function findByUsername(accounts, username) {
  return accounts.find(function (a) {
    return a.username.toLowerCase() === String(username).toLowerCase();
  });
}

function findByUserId(accounts, userId) {
  return accounts.find(function (a) {
    return a.userId === userId;
  });
}

function findByDeviceId(accounts, deviceId) {
  return accounts.find(function (a) {
    return a.deviceId === deviceId;
  });
}

function rotatePublicId(account) {
  var slot = Math.floor(now() / (15 * 60 * 1000));
  if (!account.publicIds) account.publicIds = {};
  if (!account.publicIds[String(slot)]) {
    account.publicIds[String(slot)] = makeTempId();
  }
  account.currentSlot = slot;
  account.currentPublicId = account.publicIds[String(slot)];
  return account.currentPublicId;
}

function resolveUser(accounts, query) {
  var q = String(query || '').trim();
  if (!q) return null;

  var byUsername = findByUsername(accounts, q);
  if (byUsername) return byUsername;

  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    if (a.currentPublicId === q) return a;
    if (a.publicIds) {
      for (var k in a.publicIds) {
        if (a.publicIds.hasOwnProperty(k) && a.publicIds[k] === q) return a;
      }
    }
  }
  return null;
}

function authMiddleware(req, res, next) {
  var token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing session token' });

  var sessions = getSessions();
  var session = sessions[token];
  if (!session) return res.status(401).json({ ok: false, error: 'Invalid session token' });

  if (session.expiresAt <= now()) {
    delete sessions[token];
    saveSessions(sessions);
    return res.status(401).json({ ok: false, error: 'Session expired' });
  }

  req.session = session;
  req.sessionToken = token;
  next();
}

function capMessages() {
  var messages = getMessages();
  if (messages.length > 5000) {
    messages = messages.slice(messages.length - 5000);
    saveMessages(messages);
  }
}

ensureDataFiles();

app.get('/', function (req, res) {
  res.json({ ok: true, name: 'Chat server running' });
});

app.post('/api/create-account', function (req, res) {
  var username = String(req.body.username || '').trim();
  var password = String(req.body.password || '');
  var deviceId = String(req.body.deviceId || '').trim();

  if (username.length < 3) return res.status(400).json({ ok: false, error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password too short' });
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Missing deviceId' });

  var accounts = getAccounts();

  if (findByDeviceId(accounts, deviceId)) {
    return res.status(409).json({ ok: false, error: 'This phone/device already has an account' });
  }
  if (findByUsername(accounts, username)) {
    return res.status(409).json({ ok: false, error: 'Username already taken' });
  }

  var userId = randomToken(8);
  var publicId = makeTempId();

  var account = {
    userId: userId,
    username: username,
    passwordHash: sha256(password + ':chat_salt_v1'),
    deviceId: deviceId,
    createdAt: now(),
    publicIds: {}
  };
  account.publicIds[String(Math.floor(now() / (15 * 60 * 1000)))] = publicId;
  account.currentPublicId = publicId;

  accounts.push(account);
  saveAccounts(accounts);

  var token = randomToken(24);
  var sessions = getSessions();
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
    publicId: publicId,
    sessionToken: token
  });
});

app.post('/api/login', function (req, res) {
  var username = String(req.body.username || '').trim();
  var password = String(req.body.password || '');
  var deviceId = String(req.body.deviceId || '').trim();

  if (!username || !password || !deviceId) {
    return res.status(400).json({ ok: false, error: 'Missing fields' });
  }

  var accounts = getAccounts();
  var account = findByUsername(accounts, username);
  if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

  if (account.deviceId !== deviceId) {
    return res.status(403).json({ ok: false, error: 'This account is locked to the original device' });
  }

  var passHash = sha256(password + ':chat_salt_v1');
  if (passHash !== account.passwordHash) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  var publicId = rotatePublicId(account);
  saveAccounts(accounts);

  var token = randomToken(24);
  var sessions = getSessions();
  sessions[token] = {
    userId: account.userId,
    deviceId: deviceId,
    createdAt: now(),
    expiresAt: now() + (7 * 24 * 60 * 60 * 1000)
  };
  saveSessions(sessions);

  return res.json({
    ok: true,
    userId: account.userId,
    username: account.username,
    publicId: publicId,
    sessionToken: token
  });
});

app.get('/api/me', authMiddleware, function (req, res) {
  var accounts = getAccounts();
  var account = findByUserId(accounts, req.session.userId);
  if (!account) return res.status(404).json({ ok: false, error: 'Account missing' });

  var publicId = rotatePublicId(account);
  saveAccounts(accounts);

  return res.json({
    ok: true,
    userId: account.userId,
    username: account.username,
    publicId: publicId
  });
});

app.get('/api/search', authMiddleware, function (req, res) {
  var q = String(req.query.q || '').trim();
  var accounts = getAccounts();
  var account = resolveUser(accounts, q);

  if (!account) {
    return res.json({ ok: true, found: false });
  }

  return res.json({
    ok: true,
    found: true,
    userId: account.userId,
    username: account.username,
    publicId: rotatePublicId(account)
  });
});

app.post('/api/send', authMiddleware, function (req, res) {
  var to = String(req.body.to || '').trim();
  var text = String(req.body.text || '').trim();
  var isGroup = String(req.body.isGroup || '') === '1';

  if (!text) return res.status(400).json({ ok: false, error: 'Empty message' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'Message too long' });

  var accounts = getAccounts();
  var sender = findByUserId(accounts, req.session.userId);
  if (!sender) return res.status(404).json({ ok: false, error: 'Sender missing' });

  var messages = getMessages();

  if (isGroup) {
    var groups = getGroups();
    var group = null;
    for (var gi = 0; gi < groups.length; gi++) {
      if (groups[gi].groupId === to) {
        group = groups[gi];
        break;
      }
    }
    if (!group) return res.status(404).json({ ok: false, error: 'Group not found' });
    if (group.members.indexOf(sender.userId) === -1) {
      return res.status(403).json({ ok: false, error: 'Not a member of group' });
    }

    for (var i = 0; i < group.members.length; i++) {
      var memberId = group.members[i];
      if (memberId === sender.userId) continue;
      messages.push({
        id: randomToken(10),
        type: 'group',
        groupId: group.groupId,
        fromUserId: sender.userId,
        toUserId: memberId,
        text: text,
        createdAt: now()
      });
    }
    saveMessages(messages);
    capMessages();
    return res.json({ ok: true, sent: true });
  }

  var receiver = resolveUser(accounts, to);
  if (!receiver) return res.status(404).json({ ok: false, error: 'User not found' });

  messages.push({
    id: randomToken(10),
    type: 'direct',
    fromUserId: sender.userId,
    toUserId: receiver.userId,
    text: text,
    createdAt: now()
  });
  saveMessages(messages);
  capMessages();

  return res.json({ ok: true, sent: true });
});

app.get('/api/poll', authMiddleware, function (req, res) {
  var userId = req.session.userId;
  var messages = getMessages();
  var accounts = getAccounts();
  var out = [];
  var keep = [];

  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.toUserId === userId) {
      var sender = findByUserId(accounts, m.fromUserId);
      out.push({
        id: m.id,
        type: m.type,
        groupId: m.groupId || null,
        fromUserId: m.fromUserId,
        fromUsername: sender ? sender.username : 'unknown',
        text: m.text,
        createdAt: m.createdAt
      });
      continue;
    }
    keep.push(m);
  }

  // Delivered messages are deleted from server right after polling.
  saveMessages(keep);

  return res.json({ ok: true, messages: out });
});

app.post('/api/create-group', authMiddleware, function (req, res) {
  var name = String(req.body.name || '').trim();
  var membersRaw = req.body.members;
  if (!name) return res.status(400).json({ ok: false, error: 'Group name required' });

  if (!Array.isArray(membersRaw)) membersRaw = [];

  var accounts = getAccounts();
  var creator = findByUserId(accounts, req.session.userId);
  if (!creator) return res.status(404).json({ ok: false, error: 'Creator missing' });

  var memberMap = {};
  memberMap[creator.userId] = true;

  for (var i = 0; i < membersRaw.length; i++) {
    var found = resolveUser(accounts, String(membersRaw[i]).trim());
    if (found) memberMap[found.userId] = true;
  }

  var group = {
    groupId: 'G' + randomToken(6),
    name: name,
    adminUserId: creator.userId,
    members: Object.keys(memberMap),
    createdAt: now()
  };

  var groups = getGroups();
  groups.push(group);
  saveGroups(groups);

  return res.json({ ok: true, groupId: group.groupId, name: group.name });
});

app.get('/api/groups', authMiddleware, function (req, res) {
  var groups = getGroups();
  var userId = req.session.userId;
  var mine = [];
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].members.indexOf(userId) !== -1) mine.push(groups[i]);
  }
  return res.json({ ok: true, groups: mine });
});

app.post('/api/heartbeat', authMiddleware, function (req, res) {
  var accounts = getAccounts();
  var account = findByUserId(accounts, req.session.userId);
  if (!account) return res.status(404).json({ ok: false, error: 'Account missing' });
  var publicId = rotatePublicId(account);
  saveAccounts(accounts);
  return res.json({ ok: true, publicId: publicId });
});

app.post('/api/cleanup', function (req, res) {
  capMessages();
  return res.json({ ok: true });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
  
