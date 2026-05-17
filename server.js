const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_ROTATE_MS = 15 * 60 * 1000;

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      accounts: [],
      sessions: {},
      contacts: {},
      groups: [],
      messages: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

function loadDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { accounts: [], sessions: {}, contacts: {}, groups: [], messages: [] };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function token(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function now() {
  return Date.now();
}

function error(res, code, message) {
  return res.status(code).json({ ok: false, error: message });
}

function ok(res, payload) {
  return res.json(Object.assign({ ok: true }, payload || {}));
}

function getSlot() {
  return Math.floor(now() / PUBLIC_ROTATE_MS);
}

function makePublicId() {
  return 'U' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function ensurePublicId(account) {
  const slot = String(getSlot());
  if (!account.publicIds) account.publicIds = {};
  if (!account.publicIds[slot]) {
    account.publicIds[slot] = makePublicId();
  }
  account.currentSlot = slot;
  account.currentPublicId = account.publicIds[slot];
  return account.currentPublicId;
}

function normalize(str) {
  return String(str || '').trim();
}

function findAccountByUserId(db, userId) {
  return db.accounts.find(function (a) { return a.userId === userId; }) || null;
}

function findAccountByUsername(db, username) {
  const q = normalize(username).toLowerCase();
  return db.accounts.find(function (a) { return a.username.toLowerCase() === q; }) || null;
}

function findAccountByDeviceId(db, deviceId) {
  const q = normalize(deviceId);
  return db.accounts.find(function (a) { return a.deviceId === q; }) || null;
}

function resolveAccount(db, value) {
  const q = normalize(value);
  if (!q) return null;
  let byUsername = findAccountByUsername(db, q);
  if (byUsername) return byUsername;
  let byId = findAccountByUserId(db, q);
  if (byId) return byId;
  return db.accounts.find(function (a) {
    if (a.currentPublicId === q) return true;
    if (!a.publicIds) return false;
    for (const k in a.publicIds) {
      if (Object.prototype.hasOwnProperty.call(a.publicIds, k) && a.publicIds[k] === q) return true;
    }
    return false;
  }) || null;
}

function auth(req, res, next) {
  const tokenValue = req.headers['x-session-token'];
  if (!tokenValue) return error(res, 401, 'Missing session token');
  const db = loadDb();
  const session = db.sessions[tokenValue];
  if (!session) return error(res, 401, 'Invalid session token');
  if (session.expiresAt <= now()) {
    delete db.sessions[tokenValue];
    saveDb(db);
    return error(res, 401, 'Session expired');
  }
  const account = findAccountByUserId(db, session.userId);
  if (!account) return error(res, 401, 'Account missing');
  req.db = db;
  req.account = account;
  req.sessionToken = tokenValue;
  next();
}

function conversationKeyDirect(a, b) {
  return [a, b].sort().join('|');
}

function lastMessageForDirect(db, userId, otherId) {
  const key = conversationKeyDirect(userId, otherId);
  const msgs = db.messages.filter(function (m) { return m.threadType === 'direct' && m.threadId === key; });
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function lastMessageForGroup(db, groupId) {
  const msgs = db.messages.filter(function (m) { return m.threadType === 'group' && m.threadId === groupId; });
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function isContact(db, ownerId, otherId) {
  const list = db.contacts[ownerId] || [];
  return list.indexOf(otherId) !== -1;
}

function resolveThread(db, threadType, threadId) {
  const t = normalize(threadType);
  const id = normalize(threadId);
  if (t === 'group') {
    return db.groups.find(function (g) { return g.groupId === id; }) || null;
  }
  return resolveAccount(db, id);
}

app.get('/', function (req, res) {
  res.json({ ok: true, name: 'Chat server running' });
});

app.post('/api/create-account', function (req, res) {
  const username = normalize(req.body.username);
  const password = normalize(req.body.password);
  const deviceId = normalize(req.body.deviceId);

  if (username.length < 3) return error(res, 400, 'Username too short');
  if (password.length < 6) return error(res, 400, 'Password too short');
  if (!deviceId) return error(res, 400, 'Missing deviceId');

  const db = loadDb();
  if (findAccountByUsername(db, username)) return error(res, 409, 'Username already exists');
  if (findAccountByDeviceId(db, deviceId)) return error(res, 409, 'This device already has an account');

  const account = {
    userId: token(8),
    username: username,
    passwordHash: sha256(password + ':chatchain_salt_v1'),
    deviceId: deviceId,
    createdAt: now(),
    publicIds: {},
    currentSlot: null,
    currentPublicId: null
  };
  ensurePublicId(account);
  db.accounts.push(account);
  db.contacts[account.userId] = [];

  const sessionToken = token(24);
  db.sessions[sessionToken] = {
    userId: account.userId,
    deviceId: deviceId,
    createdAt: now(),
    expiresAt: now() + 7 * 24 * 60 * 60 * 1000
  };

  saveDb(db);
  return ok(res, {
    userId: account.userId,
    username: account.username,
    publicId: account.currentPublicId,
    sessionToken: sessionToken
  });
});

app.post('/api/login', function (req, res) {
  const username = normalize(req.body.username);
  const password = normalize(req.body.password);
  const deviceId = normalize(req.body.deviceId);

  const db = loadDb();
  const account = findAccountByUsername(db, username);
  if (!account) return error(res, 404, 'Account not found');
  if (account.deviceId !== deviceId) return error(res, 403, 'This account is locked to another device');
  if (account.passwordHash !== sha256(password + ':chatchain_salt_v1')) return error(res, 401, 'Wrong password');

  const sessionToken = token(24);
  db.sessions[sessionToken] = {
    userId: account.userId,
    deviceId: deviceId,
    createdAt: now(),
    expiresAt: now() + 7 * 24 * 60 * 60 * 1000
  };
  ensurePublicId(account);
  saveDb(db);

  return ok(res, {
    userId: account.userId,
    username: account.username,
    publicId: account.currentPublicId,
    sessionToken: sessionToken
  });
});

app.get('/api/me', auth, function (req, res) {
  ensurePublicId(req.account);
  saveDb(req.db);
  return ok(res, {
    userId: req.account.userId,
    username: req.account.username,
    publicId: req.account.currentPublicId
  });
});

app.get('/api/search', auth, function (req, res) {
  const q = normalize(req.query.q).toLowerCase();
  const db = req.db;
  const results = db.accounts.filter(function (a) {
    if (a.userId === req.account.userId) return false;
    if (!q) return true;
    return a.username.toLowerCase().indexOf(q) !== -1 || a.currentPublicId.toLowerCase().indexOf(q) !== -1;
  }).slice(0, 20).map(function (a) {
    ensurePublicId(a);
    return {
      userId: a.userId,
      username: a.username,
      publicId: a.currentPublicId,
      isContact: isContact(db, req.account.userId, a.userId)
    };
  });
  saveDb(db);
  return ok(res, { results: results });
});

app.get('/api/contacts/list', auth, function (req, res) {
  const db = req.db;
  const ids = db.contacts[req.account.userId] || [];
  const results = ids.map(function (id) {
    const user = findAccountByUserId(db, id);
    if (!user) return null;
    ensurePublicId(user);
    const last = lastMessageForDirect(db, req.account.userId, user.userId);
    return {
      userId: user.userId,
      username: user.username,
      publicId: user.currentPublicId,
      lastMessage: last ? last.text : '',
      lastTime: last ? last.createdAt : 0
    };
  }).filter(Boolean);
  saveDb(db);
  return ok(res, { contacts: results });
});

app.post('/api/contacts/add', auth, function (req, res) {
  const target = normalize(req.body.target);
  const db = req.db;
  const user = resolveAccount(db, target);
  if (!user) return error(res, 404, 'User not found');
  if (user.userId === req.account.userId) return error(res, 400, 'Cannot add yourself');
  const list = db.contacts[req.account.userId] || [];
  if (list.indexOf(user.userId) === -1) list.push(user.userId);
  db.contacts[req.account.userId] = list;
  saveDb(db);
  return ok(res, { added: true, userId: user.userId, username: user.username, publicId: user.currentPublicId });
});

app.post('/api/contacts/remove', auth, function (req, res) {
  const target = normalize(req.body.target);
  const db = req.db;
  const user = resolveAccount(db, target);
  if (!user) return error(res, 404, 'User not found');
  const list = db.contacts[req.account.userId] || [];
  db.contacts[req.account.userId] = list.filter(function (id) { return id !== user.userId; });
  saveDb(db);
  return ok(res, { removed: true, userId: user.userId });
});

app.get('/api/conversations', auth, function (req, res) {
  const db = req.db;
  const convMap = {};
  const myId = req.account.userId;

  (db.contacts[myId] || []).forEach(function (otherId) {
    const other = findAccountByUserId(db, otherId);
    if (!other) return;
    ensurePublicId(other);
    const last = lastMessageForDirect(db, myId, otherId);
    const key = 'direct:' + conversationKeyDirect(myId, otherId);
    convMap[key] = {
      threadType: 'direct',
      threadId: otherId,
      title: other.username,
      publicId: other.currentPublicId,
      preview: last ? last.text : '',
      lastTime: last ? last.createdAt : 0
    };
  });

  db.messages.forEach(function (m) {
    if (m.threadType === 'direct') {
      const parts = m.threadId.split('|');
      if (parts.indexOf(myId) === -1) return;
      const otherId = parts[0] === myId ? parts[1] : parts[0];
      const other = findAccountByUserId(db, otherId);
      if (!other) return;
      ensurePublicId(other);
      const key = 'direct:' + conversationKeyDirect(myId, otherId);
      convMap[key] = {
        threadType: 'direct',
        threadId: otherId,
        title: other.username,
        publicId: other.currentPublicId,
        preview: m.text,
        lastTime: m.createdAt
      };
    } else if (m.threadType === 'group') {
      const grp = db.groups.find(function (g) { return g.groupId === m.threadId; });
      if (!grp) return;
      if (grp.members.indexOf(myId) === -1) return;
      const key = 'group:' + grp.groupId;
      convMap[key] = {
        threadType: 'group',
        threadId: grp.groupId,
        title: grp.name,
        publicId: grp.groupId,
        preview: m.text,
        lastTime: m.createdAt
      };
    }
  });

  const list = Object.keys(convMap).map(function (k) { return convMap[k]; });
  list.sort(function (a, b) { return (b.lastTime || 0) - (a.lastTime || 0); });
  return ok(res, { conversations: list });
});

app.get('/api/groups/list', auth, function (req, res) {
  const db = req.db;
  const myId = req.account.userId;
  const groups = db.groups.filter(function (g) { return g.members.indexOf(myId) !== -1; }).map(function (g) {
    const last = lastMessageForGroup(db, g.groupId);
    return {
      groupId: g.groupId,
      name: g.name,
      adminUserId: g.adminUserId,
      membersCount: g.members.length,
      preview: last ? last.text : '',
      lastTime: last ? last.createdAt : 0
    };
  });
  groups.sort(function (a, b) { return (b.lastTime || 0) - (a.lastTime || 0); });
  return ok(res, { groups: groups });
});

app.post('/api/groups/create', auth, function (req, res) {
  const name = normalize(req.body.name);
  const membersRaw = Array.isArray(req.body.members) ? req.body.members : [];
  if (!name) return error(res, 400, 'Group name required');

  const db = req.db;
  const memberIds = {};
  memberIds[req.account.userId] = true;

  membersRaw.forEach(function (item) {
    const account = resolveAccount(db, item);
    if (account) memberIds[account.userId] = true;
  });

  const members = Object.keys(memberIds);
  if (members.length < 2) return error(res, 400, 'Add at least one other member');

  const group = {
    groupId: 'G' + token(6),
    name: name,
    adminUserId: req.account.userId,
    members: members,
    createdAt: now()
  };
  db.groups.push(group);
  saveDb(db);
  return ok(res, { groupId: group.groupId, name: group.name, membersCount: group.members.length });
});

app.get('/api/messages', auth, function (req, res) {
  const db = req.db;
  const threadType = normalize(req.query.threadType || 'direct');
  const threadId = normalize(req.query.threadId);
  if (!threadId) return error(res, 400, 'Missing threadId');

  let messages = db.messages.filter(function (m) {
    return m.threadType === threadType && m.threadId === threadId;
  });

  if (threadType === 'direct') {
    const other = resolveAccount(db, threadId);
    if (!other) return error(res, 404, 'Thread not found');
    const key = conversationKeyDirect(req.account.userId, other.userId);
    messages = db.messages.filter(function (m) {
      return m.threadType === 'direct' && m.threadId === key;
    });
  } else if (threadType === 'group') {
    const group = db.groups.find(function (g) { return g.groupId === threadId; });
    if (!group) return error(res, 404, 'Group not found');
    if (group.members.indexOf(req.account.userId) === -1) return error(res, 403, 'Not a group member');
  } else {
    return error(res, 400, 'Invalid threadType');
  }

  const results = messages.map(function (m) {
    const sender = findAccountByUserId(db, m.fromUserId);
    return {
      id: m.id,
      threadType: m.threadType,
      threadId: m.threadId,
      fromUserId: m.fromUserId,
      fromUsername: sender ? sender.username : 'unknown',
      text: m.text,
      createdAt: m.createdAt
    };
  });
  return ok(res, { messages: results });
});

app.post('/api/send', auth, function (req, res) {
  const text = normalize(req.body.text);
  const threadType = normalize(req.body.threadType || 'direct');
  const threadId = normalize(req.body.threadId);
  if (!text) return error(res, 400, 'Empty message');
  if (!threadId) return error(res, 400, 'Missing threadId');

  const db = req.db;
  let resolvedThread = null;
  let storedThreadId = threadId;

  if (threadType === 'direct') {
    const peer = resolveAccount(db, threadId);
    if (!peer) return error(res, 404, 'User not found');
    if (peer.userId === req.account.userId) return error(res, 400, 'Cannot message yourself');
    storedThreadId = conversationKeyDirect(req.account.userId, peer.userId);
    resolvedThread = peer;
  } else if (threadType === 'group') {
    const group = db.groups.find(function (g) { return g.groupId === threadId; });
    if (!group) return error(res, 404, 'Group not found');
    if (group.members.indexOf(req.account.userId) === -1) return error(res, 403, 'Not a group member');
    resolvedThread = group;
  } else {
    return error(res, 400, 'Invalid threadType');
  }

  const message = {
    id: token(10),
    threadType: threadType,
    threadId: storedThreadId,
    fromUserId: req.account.userId,
    text: text,
    createdAt: now()
  };
  db.messages.push(message);
  saveDb(db);
  return ok(res, { sent: true, messageId: message.id, threadType: threadType, threadId: threadId, resolved: !!resolvedThread });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
