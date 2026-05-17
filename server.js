const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
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

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function sessionsLive(sessions) {
  const t = now();
  const out = {};
  Object.keys(sessions).forEach((k) => {
    const s = sessions[k];
    if (!s) return;
    if (t - (s.lastHeartbeat || 0) <= 30000) {
      out[k] = s;
    }
  });
  return out;
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    // ignore
  }
}

ensureDir(DATA_DIR);
ensureDir(FILES_DIR);
ensureJson(SESSIONS_FILE, {});
ensureJson(MESSAGES_FILE, []);
ensureJson(META_FILE, { lastMessageId: 0 });

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'Chat server running' });
});

app.post('/api/join', (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });

  const sessions = readJson(SESSIONS_FILE, {});
  const token = makeToken();
  sessions[token] = {
    name,
    createdAt: now(),
    lastHeartbeat: now(),
    typing: false,
    typingAt: 0
  };
  writeJson(SESSIONS_FILE, sessions);
  return res.json({ ok: true, token, name });
});

app.post('/api/heartbeat', (req, res) => {
  const token = String(req.body && req.body.token || '').trim();
  const sessions = readJson(SESSIONS_FILE, {});
  const s = sessions[token];
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid token' });

  s.lastHeartbeat = now();
  sessions[token] = s;
  writeJson(SESSIONS_FILE, sessions);
  return res.json({ ok: true });
});

app.post('/api/typing', (req, res) => {
  const token = String(req.body && req.body.token || '').trim();
  const typing = !!(req.body && req.body.typing);
  const sessions = readJson(SESSIONS_FILE, {});
  const s = sessions[token];
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid token' });

  s.lastHeartbeat = now();
  s.typing = typing;
  s.typingAt = now();
  sessions[token] = s;
  writeJson(SESSIONS_FILE, sessions);
  return res.json({ ok: true });
});

function authToken(req) {
  return String((req.body && req.body.token) || req.query.token || '').trim();
}

function requireSession(req, res) {
  const token = authToken(req);
  const sessions = readJson(SESSIONS_FILE, {});
  const s = sessions[token];
  if (!s) {
    res.status(401).json({ ok: false, error: 'Invalid token' });
    return null;
  }
  if (now() - (s.lastHeartbeat || 0) > 60000) {
    res.status(401).json({ ok: false, error: 'Session expired' });
    return null;
  }
  return { token, sessions, session: s };
}

function messageBase(obj) {
  return {
    id: String(obj.id),
    fromToken: obj.fromToken,
    fromName: obj.fromName,
    type: obj.type,
    text: obj.text || '',
    caption: obj.caption || '',
    fileName: obj.fileName || '',
    fileUrl: obj.fileUrl || '',
    mimeType: obj.mimeType || '',
    size: obj.size || 0,
    ts: obj.ts,
    seenCount: Array.isArray(obj.seenBy) ? obj.seenBy.length : 0
  };
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

app.post('/api/send-text', (req, res) => {
  const auth = requireSession(req, res);
  if (!auth) return;

  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Empty message' });
  if (text.length > 3000) return res.status(400).json({ ok: false, error: 'Message too long' });

  const id = appendMessage({
    fromToken: auth.token,
    fromName: auth.session.name,
    type: 'text',
    text,
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

app.post('/api/send-media', (req, res) => {
  const auth = requireSession(req, res);
  if (!auth) return;

  const mimeType = String(req.body && req.body.mimeType || '').trim();
  const fileName = String(req.body && req.body.fileName || 'file').trim().slice(0, 120);
  const caption = String(req.body && req.body.caption || '').trim().slice(0, 1200);
  const dataBase64 = String(req.body && req.body.dataBase64 || '').trim();

  if (!dataBase64) return res.status(400).json({ ok: false, error: 'Missing file data' });
  if (dataBase64.length > 20 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'File too large' });

  const extSafe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storedName = makeToken().slice(0, 16) + '_' + extSafe;
  const filePath = path.join(FILES_DIR, storedName);

  const buffer = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(filePath, buffer);

  let type = 'file';
  if (mimeType.startsWith('image/')) type = 'image';
  else if (mimeType.startsWith('audio/')) type = 'audio';
  else if (mimeType.startsWith('video/')) type = 'video';

  const id = appendMessage({
    fromToken: auth.token,
    fromName: auth.session.name,
    type,
    text: '',
    caption,
    fileName,
    fileUrl: '/files/' + storedName,
    mimeType,
    size: buffer.length,
    ts: now(),
    deleted: false,
    deletedAt: 0,
    storedName,
    seenBy: [auth.token]
  });

  auth.session.lastHeartbeat = now();
  auth.sessions[auth.token] = auth.session;
  writeJson(SESSIONS_FILE, auth.sessions);

  return res.json({ ok: true, id: String(id), fileUrl: '/files/' + storedName, type });
});

app.post('/api/delete', (req, res) => {
  const auth = requireSession(req, res);
  if (!auth) return;

  const id = parseInt(String(req.body && req.body.id || '0'), 10) || 0;
  const messages = readJson(MESSAGES_FILE, []);
  const msg = messages.find(m => Number(m.id) === id);

  if (!msg) return res.status(404).json({ ok: false, error: 'Message not found' });
  if (msg.fromToken !== auth.token) return res.status(403).json({ ok: false, error: 'Not your message' });
  if (msg.deleted) return res.json({ ok: true });

  msg.deleted = true;
  msg.deletedAt = now();

  if (msg.storedName) {
    deleteFileIfExists(path.join(FILES_DIR, msg.storedName));
  }

  writeJson(MESSAGES_FILE, messages);
  return res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  const token = String(req.query.token || '').trim();
  const after = parseInt(String(req.query.after || '0'), 10) || 0;

  const sessions = readJson(SESSIONS_FILE, {});
  const viewer = sessions[token];
  if (!viewer) return res.status(401).json({ ok: false, error: 'Invalid token' });

  viewer.lastHeartbeat = now();
  sessions[token] = viewer;

  const live = sessionsLive(sessions);
  const typingNames = Object.keys(live).filter(k => {
    const s = live[k];
    return k !== token && s.typing && (now() - (s.typingAt || 0) <= 5000);
  }).map(k => live[k].name);

  const allMessages = readJson(MESSAGES_FILE, []);
  const messages = [];
  const deletedIds = [];

  allMessages.forEach((m) => {
    if (m.deleted) {
      deletedIds.push(String(m.id));
      return;
    }
    if (m.id > after) {
      if (m.fromToken !== token) {
        if (!Array.isArray(m.seenBy)) m.seenBy = [];
        if (m.seenBy.indexOf(token) === -1) {
          m.seenBy.push(token);
        }
      }
      messages.push(messageBase(m));
    }
  });

  writeJson(SESSIONS_FILE, sessions);
  writeJson(MESSAGES_FILE, allMessages);

  return res.json({
    ok: true,
    onlineCount: Object.keys(live).length,
    onlineNames: Object.keys(live).map(k => live[k].name),
    typingNames,
    messages,
    deletedIds
  });
});

app.get('/api/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sessions = readJson(SESSIONS_FILE, {});
  const live = sessionsLive(sessions);
  const list = Object.keys(live).map(k => ({
    token: k,
    name: live[k].name,
    typing: !!live[k].typing
  })).filter(u => !q || u.name.toLowerCase().includes(q));

  return res.json({ ok: true, users: list });
});

app.use('/files', express.static(FILES_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Chat server running on port ' + PORT);
});
                                
