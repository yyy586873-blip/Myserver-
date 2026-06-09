// server.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PORT = process.env.PORT || 10000;
const ROOT = __dirname;

// IMPORTANT:
// Set DATA_DIR on Render to the mounted persistent disk path.
// Example: if your disk is mounted at /var/data, set DATA_DIR=/var/data
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INDEX_FILE = path.join(ROOT, 'index.html');

const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const ADMIN_SESSION_DAYS = 7;
const APP_SESSION_DAYS = 7;
const ACTIVE_WINDOW_MS = 60 * 1000;
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '500', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function defaultDb() {
  return {
    auth: {
      adminSalt: '',
      adminHash: '',
      appSalt: '',
      appHash: ''
    },
    settings: {
      siteName: 'Admin Panel'
    },
    counters: {
      adminLogins: 0,
      appLogins: 0,
      totalUploads: 0,
      totalViews: 0
    },
    sessions: {
      admin: {},
      app: {}
    },
    videos: []
  };
}

function normalizeDb(db) {
  const base = defaultDb();

  if (!db || typeof db !== 'object') db = {};
  if (!db.auth || typeof db.auth !== 'object') db.auth = base.auth;
  if (!db.settings || typeof db.settings !== 'object') db.settings = base.settings;
  if (!db.counters || typeof db.counters !== 'object') db.counters = base.counters;
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = base.sessions;
  if (!db.sessions.admin || typeof db.sessions.admin !== 'object') db.sessions.admin = {};
  if (!db.sessions.app || typeof db.sessions.app !== 'object') db.sessions.app = {};
  if (!Array.isArray(db.videos)) db.videos = [];

  return db;
}

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const db = defaultDb();
      seedFromEnv(db);
      writeDb(db);
      return db;
    }

    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = normalizeDb(JSON.parse(raw));
    seedFromEnv(db);
    return db;
  } catch {
    const db = defaultDb();
    seedFromEnv(db);
    writeDb(db);
    return db;
  }
}

function writeDb(db) {
  const safeDb = normalizeDb(db);
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(safeDb, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

function save() {
  writeDb(db);
}

function seedFromEnv(db) {
  if (!db.auth.adminHash && process.env.ADMIN_PASSWORD) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth.adminSalt = salt;
    db.auth.adminHash = hashPassword(process.env.ADMIN_PASSWORD, salt);
  }

  if (!db.auth.appHash && process.env.APP_PASSWORD) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth.appSalt = salt;
    db.auth.appHash = hashPassword(process.env.APP_PASSWORD, salt);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const attempt = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(attempt, 'hex'),
      Buffer.from(hash, 'hex')
    );
  } catch {
    return false;
  }
}

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function now() {
  return Date.now();
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    const idx = part.indexOf('=');
    if (idx > -1) {
      const key = part.slice(0, idx);
      const val = part.slice(idx + 1);
      if (key === name) return decodeURIComponent(val);
    }
  }
  return '';
}

function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.ip || '';
}

function uaOf(req) {
  return req.headers['user-agent'] || '';
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function publicVideo(v) {
  return {
    id: v.id,
    title: v.title,
    filename: v.filename,
    url: `/uploads/${encodeURIComponent(v.filename)}`,
    uploadedAt: v.uploadedAt,
    size: v.size,
    views: v.views || 0
  };
}

function findVideo(id) {
  return db.videos.find(v => v.id === id) || null;
}

function sessionShape(req, extra) {
  return {
    createdAt: now(),
    lastSeen: now(),
    expiresAt: now() + (extra.kind === 'admin' ? ADMIN_SESSION_DAYS : APP_SESSION_DAYS) * 24 * 60 * 60 * 1000,
    ip: ipOf(req),
    ua: uaOf(req),
    deviceId: extra.deviceId || '',
    videoId: extra.videoId || ''
  };
}

function persistSession(kind, t, data) {
  db.sessions[kind][t] = data;
  save();
}

function deleteSession(kind, t) {
  if (kind === 'admin') {
    adminSessions.delete(t);
  } else {
    appSessions.delete(t);
  }

  if (db.sessions && db.sessions[kind] && db.sessions[kind][t]) {
    delete db.sessions[kind][t];
    save();
  }
}

function createAdminSession(req) {
  const t = token();
  const s = sessionShape(req, { kind: 'admin' });
  adminSessions.set(t, Object.assign({ token: t }, s));
  persistSession('admin', t, adminSessions.get(t));
  return t;
}

function createAppSession(req, deviceId) {
  const t = token();
  const s = sessionShape(req, { kind: 'app', deviceId: deviceId || '' });
  appSessions.set(t, Object.assign({ token: t }, s));
  persistSession('app', t, appSessions.get(t));
  return t;
}

function rehydrateSessions() {
  const cutoff = now();
  let dirty = false;

  Object.keys(db.sessions.admin || {}).forEach(function (t) {
    const s = db.sessions.admin[t];
    if (!s || !s.expiresAt || s.expiresAt < cutoff) {
      delete db.sessions.admin[t];
      dirty = true;
      return;
    }
    adminSessions.set(t, Object.assign({ token: t }, s));
  });

  Object.keys(db.sessions.app || {}).forEach(function (t) {
    const s = db.sessions.app[t];
    if (!s || !s.expiresAt || s.expiresAt < cutoff) {
      delete db.sessions.app[t];
      dirty = true;
      return;
    }
    appSessions.set(t, Object.assign({ token: t }, s));
  });

  if (dirty) save();
}

function getAdminSession(req) {
  const t = cookieValue(req, 'admin_token') || req.headers['x-admin-token'] || '';
  if (!t) return null;

  let s = adminSessions.get(t);
  if (!s && db.sessions.admin[t]) {
    s = Object.assign({ token: t }, db.sessions.admin[t]);
    adminSessions.set(t, s);
  }

  if (!s) return null;

  if (s.expiresAt < now()) {
    deleteSession('admin', t);
    return null;
  }

  s.lastSeen = now();
  if (db.sessions.admin[t]) db.sessions.admin[t].lastSeen = s.lastSeen;
  return s;
}

function getAppSession(req) {
  const t = cookieValue(req, 'app_token') || req.headers['x-app-token'] || '';
  if (!t) return null;

  let s = appSessions.get(t);
  if (!s && db.sessions.app[t]) {
    s = Object.assign({ token: t }, db.sessions.app[t]);
    appSessions.set(t, s);
  }

  if (!s) return null;

  if (s.expiresAt < now()) {
    deleteSession('app', t);
    return null;
  }

  s.lastSeen = now();
  if (db.sessions.app[t]) db.sessions.app[t].lastSeen = s.lastSeen;
  return s;
}

function requireAdmin(req, res, next) {
  const s = getAdminSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.adminSession = s;
  next();
}

function requireApp(req, res, next) {
  const s = getAppSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.appSession = s;
  next();
}

function activeUsersList() {
  const cutoff = now() - ACTIVE_WINDOW_MS;
  let count = 0;
  const list = [];
  let dirty = false;

  Object.keys(db.sessions.app || {}).forEach(function (t) {
    const s = db.sessions.app[t];

    if (!s || !s.expiresAt || s.expiresAt < now()) {
      delete db.sessions.app[t];
      appSessions.delete(t);
      dirty = true;
      return;
    }

    if (s.lastSeen >= cutoff) {
      count += 1;
      list.push({
        tokenPrefix: t.slice(0, 8),
        deviceId: s.deviceId || '',
        ip: s.ip || '',
        ua: s.ua || '',
        lastSeen: s.lastSeen
      });
    }
  });

  list.sort(function (a, b) {
    return b.lastSeen - a.lastSeen;
  });

  if (dirty) save();

  return { count, list };
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    const id = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    cb(null, id + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are allowed'));
    }
    cb(null, true);
  }
});

let db = normalizeDb(readDb());
const adminSessions = new Map();
const appSessions = new Map();

rehydrateSessions();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.get('/health', function (req, res) {
  res.json({ ok: true });
});

app.get('/', function (req, res) {
  res.sendFile(INDEX_FILE);
});

app.get('/api/bootstrap', function (req, res) {
  res.json({
    ok: true,
    hasAdminPassword: Boolean(db.auth.adminHash),
    hasAppPassword: Boolean(db.auth.appHash),
    siteName: db.settings.siteName || 'Admin Panel'
  });
});

app.post('/api/admin/setup', function (req, res) {
  if (db.auth.adminHash) {
    return res.status(409).json({ ok: false, error: 'already_initialized' });
  }

  const adminPassword = String(req.body.adminPassword || '').trim();
  const appPassword = String(req.body.appPassword || '').trim();

  if (adminPassword.length < 4) {
    return res.status(400).json({ ok: false, error: 'admin_password_too_short' });
  }
  if (appPassword.length < 4) {
    return res.status(400).json({ ok: false, error: 'app_password_too_short' });
  }

  const aSalt = crypto.randomBytes(16).toString('hex');
  const pSalt = crypto.randomBytes(16).toString('hex');

  db.auth.adminSalt = aSalt;
  db.auth.adminHash = hashPassword(adminPassword, aSalt);
  db.auth.appSalt = pSalt;
  db.auth.appHash = hashPassword(appPassword, pSalt);

  save();

  const sess = createAdminSession(req);
  res.cookie('admin_token', sess, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

app.post('/api/admin/login', function (req, res) {
  if (!db.auth.adminHash) {
    return res.status(400).json({ ok: false, error: 'not_initialized' });
  }

  const password = String(req.body.password || '');
  if (!verifyPassword(password, db.auth.adminSalt, db.auth.adminHash)) {
    return res.status(401).json({ ok: false, error: 'wrong_password' });
  }

  db.counters.adminLogins += 1;
  save();

  const sess = createAdminSession(req);
  res.cookie('admin_token', sess, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, function (req, res) {
  deleteSession('admin', req.adminSession.token);
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, function (req, res) {
  const active = activeUsersList();
  res.json({
    ok: true,
    siteName: db.settings.siteName || 'Admin Panel',
    stats: {
      totalVideos: db.videos.length,
      totalUploads: db.counters.totalUploads,
      totalViews: db.counters.totalViews,
      adminLogins: db.counters.adminLogins,
      appLogins: db.counters.appLogins,
      activeUsers: active.count
    }
  });
});

app.get('/api/admin/stats', requireAdmin, function (req, res) {
  const active = activeUsersList();
  res.json({
    ok: true,
    counters: db.counters,
    totalVideos: db.videos.length,
    activeUsers: active.count,
    activeSessions: active.list,
    videos: db.videos.map(publicVideo).sort(function (a, b) {
      return b.uploadedAt - a.uploadedAt;
    })
  });
});

app.post('/api/admin/upload', requireAdmin, upload.single('video'), function (req, res) {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'no_file' });
  }

  const title = cleanTitle(req.body.title || req.file.originalname || 'video');
  const id = crypto.randomUUID ? crypto.randomUUID() : token();

  const video = {
    id: id,
    title: title,
    filename: req.file.filename,
    originalName: req.file.originalname || '',
    mimeType: req.file.mimetype || '',
    size: req.file.size || 0,
    uploadedAt: now(),
    views: 0
  };

  db.videos.unshift(video);
  db.counters.totalUploads += 1;
  save();

  res.json({ ok: true, video: publicVideo(video) });
});

app.delete('/api/admin/videos/:id', requireAdmin, function (req, res) {
  const id = String(req.params.id || '');
  const idx = db.videos.findIndex(function (v) {
    return v.id === id;
  });

  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const video = db.videos[idx];
  db.videos.splice(idx, 1);

  try {
    const fp = path.join(UPLOAD_DIR, video.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}

  save();
  res.json({ ok: true });
});

app.post('/api/admin/passwords', requireAdmin, function (req, res) {
  const adminPassword = String(req.body.adminPassword || '').trim();
  const appPassword = String(req.body.appPassword || '').trim();

  if (adminPassword && adminPassword.length < 4) {
    return res.status(400).json({ ok: false, error: 'admin_password_too_short' });
  }
  if (appPassword && appPassword.length < 4) {
    return res.status(400).json({ ok: false, error: 'app_password_too_short' });
  }

  if (adminPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth.adminSalt = salt;
    db.auth.adminHash = hashPassword(adminPassword, salt);
  }

  if (appPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth.appSalt = salt;
    db.auth.appHash = hashPassword(appPassword, salt);
  }

  save();
  res.json({ ok: true });
});

app.post('/api/public/login', function (req, res) {
  if (!db.auth.appHash) {
    return res.status(400).json({ ok: false, error: 'app_password_not_set' });
  }

  const password = String(req.body.password || '');
  const deviceId = String(req.body.deviceId || '');

  if (!verifyPassword(password, db.auth.appSalt, db.auth.appHash)) {
    return res.status(401).json({ ok: false, error: 'wrong_password' });
  }

  db.counters.appLogins += 1;
  save();

  const sess = createAppSession(req, deviceId);
  res.cookie('app_token', sess, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: APP_SESSION_DAYS * 24 * 60 * 60 * 1000
  });

  res.json({
    ok: true,
    videos: db.videos.map(publicVideo).sort(function (a, b) {
      return b.uploadedAt - a.uploadedAt;
    })
  });
});

app.post('/api/public/logout', requireApp, function (req, res) {
  deleteSession('app', req.appSession.token);
  res.clearCookie('app_token');
  res.json({ ok: true });
});

app.get('/api/public/me', requireApp, function (req, res) {
  const active = activeUsersList();
  res.json({
    ok: true,
    activeUsers: active.count,
    videos: db.videos.length
  });
});

app.post('/api/public/heartbeat', requireApp, function (req, res) {
  const s = appSessions.get(req.appSession.token);
  if (s) {
    s.lastSeen = now();
    if (req.body && req.body.deviceId) s.deviceId = String(req.body.deviceId);
    if (req.body && req.body.videoId) s.videoId = String(req.body.videoId);
    if (db.sessions.app[s.token]) {
      db.sessions.app[s.token].lastSeen = s.lastSeen;
      db.sessions.app[s.token].deviceId = s.deviceId;
      db.sessions.app[s.token].videoId = s.videoId;
      save();
    }
  }
  res.json({ ok: true });
});

app.get('/api/public/videos', requireApp, function (req, res) {
  res.json({
    ok: true,
    videos: db.videos.map(publicVideo).sort(function (a, b) {
      return b.uploadedAt - a.uploadedAt;
    })
  });
});

app.post('/api/public/video-view', requireApp, function (req, res) {
  const videoId = String(req.body.videoId || '');
  const video = findVideo(videoId);

  if (!video) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  video.views = (video.views || 0) + 1;
  db.counters.totalViews += 1;
  save();

  const s = appSessions.get(req.appSession.token);
  if (s) {
    s.lastSeen = now();
    s.videoId = videoId;
    if (db.sessions.app[s.token]) {
      db.sessions.app[s.token].lastSeen = s.lastSeen;
      db.sessions.app[s.token].videoId = videoId;
      save();
    }
  }

  res.json({ ok: true, views: video.views });
});

app.use(function (err, req, res, next) {
  if (!err) return next();
  const msg = String(err.message || 'error').toLowerCase();

  if (msg.includes('only video files')) {
    return res.status(400).json({ ok: false, error: 'only_video_files_allowed' });
  }
  if (msg.includes('file too large')) {
    return res.status(413).json({ ok: false, error: 'file_too_large' });
  }

  res.status(500).json({ ok: false, error: 'server_error' });
});

app.listen(PORT, function () {
  console.log('Server running on ' + PORT);
});
