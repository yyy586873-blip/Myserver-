const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '30mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureJson(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function now() {
  return Date.now();
}

function makeToken() {
  return crypto.randomBytes(18).toString('hex');
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function liveSessions(sessions) {
  const t = now();
  const out = {};
  Object.keys(sessions).forEach(function (k) {
    const s = sessions[k];
    if (!s) return;
    if (t - (s.lastHeartbeat || 0) <= 30000) {
      out[k] = s;
    }
  });
  return out;
}

function requireSession(req, res) {
  const token = String((req.body && req.body.token) || req.query.token || '').trim();
  if (!token) {
    res.status(401).json({ ok: false, error: 'Missing token' });
    return null;
  }

  const sessions = readJson(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session) {
    res.status(401).json({ ok: false, error: 'Invalid token' });
    return null;
  }

  if (now() - (session.lastHeartbeat || 0) > 60000) {
    res.status(401).json({ ok: false, error: 'Session expired' });
    return null;
  }

  return { token: token, sessions: sessions, session: session };
}

function appendMessage(message) {
  const meta = readJson(META_FILE, { lastMessageId: 0 });
  meta.lastMessageId = (meta.lastMessageId || 0) + 1;
  message.id = meta.lastMessageId;

  const messages = readJson(MESSAGES_FILE, []);
  messages.push(message);

  writeJson(META_FILE, meta);
  writeJson(MESSAGES_FILE, messages);
  return message.id;
}

function safeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

ensureDir(DATA_DIR);
ensureDir(FILES_DIR);
ensureJson(SESSIONS_FILE, {});
ensureJson(MESSAGES_FILE, []);
ensureJson(META_FILE, { lastMessageId: 0 });

app.get('/', function (req, res) {
  res.json({ ok: true, name: 'Chat server running' });
});

app.post('/api/join', function (req, res) {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });

  const sessions = readJson(SESSIONS_FILE, {});
  const token = makeToken();

  sessions[token] = {
    name: name,
    createdAt: now(),
    lastHeartbeat: now(),
    typing: false,
    typingAt: 0
  };

  writeJson(SESSIONS_FILE, sessions);
  return res.json({ ok: true, token: token, name: name });
});

app.post('/api/heartbeat', function (req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;

  auth.session.lastHeartbeat = now();
  auth.sessions[auth.token] = auth.session;
  writeJson(SESSIONS_FILE, auth.sessions);

  return res.json({ ok: true });
});

app.post('/api/typing', function (req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;

  auth.session.lastHeartbeat = now();
  auth.session.typing = !!(req.body && req.body.typing);
  auth.session.typingAt = now();
  auth.sessions[auth.token] = auth.session;
  writeJson(SESSIONS_FILE, auth.sessions);

  return res.json({ ok: true });
});

app.post('/api/send-text', function (req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;

  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Empty message' });
  if (text.length > 3000) return res.status(400).json({ ok: false, error: 'Message too long' });

  const id = appendMessage({
    fromToken: auth.token,
    fromName: auth.session.name,
    type: 'text',
    text: text,
    caption: '',
    fileName: '',
    fileUrl: '',
    mimeType: '',
    size: 0,
    ts: now(),
    deleted: false,
    deletedAt: 0,
    seenBy: [auth.token]
  });

  auth.session.lastHeartbeat = now();
  auth.sessions[auth.token] = auth.session;
  writeJson(SESSIONS_FILE, auth.sessions);

  return res.json({ ok: true, id: String(id) });
});

app.post('/api/send-media', function (req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;

  const mimeType = String(req.body && req.body.mimeType || '').trim();
  const fileName = safeFileName(req.body && req.body.fileName);
  const caption = String(req.body && req.body.caption || '').trim().slice(0, 1200);
  const dataBase64 = String(req.body && req.body.dataBase64 || '').trim();

  if (!dataBase64) return res.status(400).json({ ok: false, error: 'Missing file data' });

  const storedName = makeToken().slice(0, 16) + '_' + fileName;
  const filePath = path.join(FILES_DIR, storedName);
  const buffer = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(filePath, buffer);

  let type = 'file';
  if (mimeType.indexOf('image/') === 0) type = 'image';
  else if (mimeType.indexOf('video/') === 0) type = 'video';
  else if (mimeType.indexOf('audio/') === 0) type = 'audio';

  const id = appendMessage({
    fromToken: auth.token,
    fromName: auth.session.name,
    type: type,
    text: '',
    caption: caption,
    fileName: fileName,
    fileUrl: '/files/' + storedName,
    mimeType: mimeType,
    size: buffer.length,
    ts: now(),
    deleted: false,
    deletedAt: 0,
    storedName: storedName,
    seenBy: [auth.token]
  });

  auth.session.lastHeartbeat = now();
  auth.sessions[auth.token] = auth.session;
  writeJson(SESSIONS_FILE, auth.sessions);

  return res.json({ ok: true, id: String(id), fileUrl: '/files/' + storedName, type: type });
});

app.post('/api/delete', function (req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;

  const id = parseInt(String(req.body && req.body.id || '0'), 10) || 0;
  const messages = readJson(MESSAGES_FILE, []);
  const msg = messages.find(function (m) { return Number(m.id) === id; });

  if (!msg) return res.status(404).json({ ok: false, error: 'Message not found' });
  if (msg.fromToken !== auth.token) return res.status(403).json({ ok: false, error: 'Not your message' });

  msg.deleted = true;
  msg.deletedAt = now();

  if (msg.storedName) {
    const fp = path.join(FILES_DIR, msg.storedName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  writeJson(MESSAGES_FILE, messages);
  return res.json({ ok: true });
});

app.get('/api/state', function (req, res) {
  const token = String(req.query.token || '').trim();
  const after = parseInt(String(req.query.after || '0'), 10) || 0;

  const sessions = readJson(SESSIONS_FILE, {});
  const viewer = sessions[token];
  if (!viewer) return res.status(401).json({ ok: false, error: 'Invalid token' });

  viewer.lastHeartbeat = now();
  sessions[token] = viewer;

  const live = liveSessions(sessions);
  const typingNames = Object.keys(live).filter(function (k) {
    const s = live[k];
    return k !== token && s.typing && (now() - (s.typingAt || 0) <= 5000);
  }).map(function (k) {
    return live[k].name;
  });

  const allMessages = readJson(MESSAGES_FILE, []);
  const messages = [];
  const deletedIds = [];

  allMessages.forEach(function (m) {
    if (m.deleted) {
      deletedIds.push(String(m.id));
      return;
    }

    if (m.id > after) {
      if (m.fromToken !== token) {
        if (!Array.isArray(m.seenBy)) m.seenBy = [];
        if (m.seenBy.indexOf(token) === -1) m.seenBy.push(token);
      }
      messages.push({
        id: String(m.id),
        fromToken: m.fromToken,
        fromName: m.fromName,
        type: m.type,
        text: m.text,
        caption: m.caption,
        fileName: m.fileName,
        fileUrl: m.fileUrl,
        mimeType: m.mimeType,
        size: m.size,
        ts: m.ts,
        seenCount: Array.isArray(m.seenBy) ? m.seenBy.length : 0
      });
    }
  });

  writeJson(SESSIONS_FILE, sessions);
  writeJson(MESSAGES_FILE, allMessages);

  return res.json({
    ok: true,
    onlineCount: Object.keys(live).length,
    onlineNames: Object.keys(live).map(function (k) { return live[k].name; }),
    typingNames: typingNames,
    messages: messages,
    deletedIds: deletedIds
  });
});

app.use('/files', express.static(FILES_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Chat server running on port ' + PORT);
});
