const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
  }
}
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureFile(SESSIONS_FILE, {});
  ensureFile(MESSAGES_FILE, []);
  ensureFile(META_FILE, { lastMessageId: 0 });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function now() { return Date.now(); }
function token() { return crypto.randomBytes(18).toString('hex'); }
function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
function visibleSessions(sessions) {
  const t = now();
  const out = {};
  Object.keys(sessions).forEach(k => {
    const s = sessions[k];
    if (s && t - s.lastHeartbeat <= 20000) out[k] = s;
  });
  return out;
}
function typingSessions(sessions, viewerToken) {
  const t = now();
  const names = [];
  Object.keys(sessions).forEach(k => {
    const s = sessions[k];
    if (!s) return;
    if (k === viewerToken) return;
    if (s.typing && t - s.typingAt <= 5000 && t - s.lastHeartbeat <= 20000) {
      names.push(s.name);
    }
  });
  return names;
}
function attachSeenCount(messages) {
  return messages.map(m => {
    const seenCount = Array.isArray(m.seenBy) ? m.seenBy.length : 0;
    return {
      id: String(m.id),
      fromToken: m.fromToken,
      fromName: m.fromName,
      text: m.text,
      ts: m.ts,
      seenCount: seenCount
    };
  });
}
function auth(req, res) {
  const tokenValue = String((req.body && req.body.token) || req.query.token || '').trim();
  if (!tokenValue) {
    res.status(401).json({ ok: false, error: 'Missing token' });
    return null;
  }
  const sessions = readJson(SESSIONS_FILE, {});
  const session = sessions[tokenValue];
  if (!session) {
    res.status(401).json({ ok: false, error: 'Invalid token' });
    return null;
  }
  if (now() - session.lastHeartbeat > 60000) {
    res.status(401).json({ ok: false, error: 'Session expired' });
    return null;
  }
  return { tokenValue, sessions, session };
}

ensureData();

app.get('/', function(req, res) {
  res.json({ ok: true, name: 'Chat server running' });
});

app.post('/api/join', function(req, res) {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });

  const sessions = readJson(SESSIONS_FILE, {});
  const t = token();
  sessions[t] = {
    name: name,
    createdAt: now(),
    lastHeartbeat: now(),
    typing: false,
    typingAt: 0
  };
  writeJson(SESSIONS_FILE, sessions);
  return res.json({ ok: true, token: t, name: name });
});

app.post('/api/heartbeat', function(req, res) {
  const authData = auth(req, res);
  if (!authData) return;
  authData.session.lastHeartbeat = now();
  authData.sessions[authData.tokenValue] = authData.session;
  writeJson(SESSIONS_FILE, authData.sessions);
  return res.json({ ok: true });
});

app.post('/api/typing', function(req, res) {
  const authData = auth(req, res);
  if (!authData) return;
  const typing = !!(req.body && req.body.typing);
  authData.session.lastHeartbeat = now();
  authData.session.typing = typing;
  authData.session.typingAt = now();
  authData.sessions[authData.tokenValue] = authData.session;
  writeJson(SESSIONS_FILE, authData.sessions);
  return res.json({ ok: true });
});

app.post('/api/send', function(req, res) {
  const authData = auth(req, res);
  if (!authData) return;
  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Empty message' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'Message too long' });

  const meta = readJson(META_FILE, { lastMessageId: 0 });
  meta.lastMessageId = (meta.lastMessageId || 0) + 1;

  const messages = readJson(MESSAGES_FILE, []);
  messages.push({
    id: meta.lastMessageId,
    fromToken: authData.tokenValue,
    fromName: authData.session.name,
    text: text,
    ts: now(),
    seenBy: [authData.tokenValue]
  });

  authData.session.lastHeartbeat = now();
  authData.sessions[authData.tokenValue] = authData.session;
  writeJson(META_FILE, meta);
  writeJson(MESSAGES_FILE, messages);
  writeJson(SESSIONS_FILE, authData.sessions);

  return res.json({ ok: true, id: String(meta.lastMessageId) });
});

app.get('/api/state', function(req, res) {
  const tokenValue = String(req.query.token || '').trim();
  const after = parseInt(String(req.query.after || '0'), 10) || 0;

  const sessions = readJson(SESSIONS_FILE, {});
  const viewer = sessions[tokenValue];
  if (!viewer) return res.status(401).json({ ok: false, error: 'Invalid token' });

  viewer.lastHeartbeat = now();
  sessions[tokenValue] = viewer;

  const allMessages = readJson(MESSAGES_FILE, []);
  const changed = [];
  const resultMessages = [];

  allMessages.forEach(m => {
    if (m.id > after) {
      if (m.fromToken !== tokenValue) {
        if (!Array.isArray(m.seenBy)) m.seenBy = [];
        if (m.seenBy.indexOf(tokenValue) === -1) {
          m.seenBy.push(tokenValue);
          changed.push(m.id);
        }
      }
      resultMessages.push({
        id: String(m.id),
        fromToken: m.fromToken,
        fromName: m.fromName,
        text: m.text,
        ts: m.ts,
        seenCount: Array.isArray(m.seenBy) ? m.seenBy.length : 0
      });
    }
  });

  if (changed.length > 0) writeJson(MESSAGES_FILE, allMessages);
  writeJson(SESSIONS_FILE, sessions);

  const online = visibleSessions(sessions);
  const typing = typingSessions(sessions, tokenValue);
  return res.json({
    ok: true,
    onlineCount: Object.keys(online).length,
    onlineNames: Object.values(online).map(s => s.name),
    typingNames: typing,
    messages: resultMessages
  });
});

app.post('/api/logout', function(req, res) {
  const tokenValue = String(req.body && req.body.token || '').trim();
  const sessions = readJson(SESSIONS_FILE, {});
  if (sessions[tokenValue]) {
    delete sessions[tokenValue];
    writeJson(SESSIONS_FILE, sessions);
  }
  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Chat server running on port ' + PORT);
});
