
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const JSON_FILE = path.join(DATA_DIR, 'songs.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile() {
  if (!fs.existsSync(JSON_FILE)) {
    fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function loadSongs() {
  ensureJsonFile();
  try {
    const raw = fs.readFileSync(JSON_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSongs(songs) {
  fs.writeFileSync(JSON_FILE, JSON.stringify(songs, null, 2), 'utf8');
}

function cleanText(value) {
  return String(value || '').trim();
}

function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

ensureDir(DATA_DIR);
ensureDir(MUSIC_DIR);
ensureJsonFile();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/music', express.static(MUSIC_DIR));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, MUSIC_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const fileName = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
    cb(null, fileName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Sirf audio file upload karo.'));
    }
  }
});

app.get('/', function (req, res) {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/api/songs', function (req, res) {
  const songs = loadSongs().sort(function (a, b) {
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });
  res.json(songs);
});

app.post('/api/upload', function (req, res, next) {
  upload.single('music')(req, res, function (err) {
    if (err) return next(err);

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'File missing hai.' });
      }

      let title = cleanText(req.body.title);
      if (!title) {
        title = path.parse(req.file.originalname).name;
      }

      const songs = loadSongs();

      const song = {
        id: generateId(),
        title,
        originalName: req.file.originalname,
        fileName: req.file.filename,
        fileUrl: '/music/' + encodeURIComponent(req.file.filename),
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date().toISOString()
      };

      songs.push(song);
      saveSongs(songs);

      res.json({ ok: true, song });
    } catch (error) {
      next(error);
    }
  });
});

app.post('/api/songs/:id/rename', function (req, res) {
  try {
    const id = req.params.id;
    const newTitle = cleanText(req.body.title);

    if (!newTitle) {
      return res.status(400).json({ error: 'New title required hai.' });
    }

    const songs = loadSongs();
    const song = songs.find(s => s.id === id);

    if (!song) {
      return res.status(404).json({ error: 'Song not found.' });
    }

    song.title = newTitle;
    saveSongs(songs);

    res.json({ ok: true, song });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Rename failed' });
  }
});

app.delete('/api/songs/:id', function (req, res) {
  try {
    const id = req.params.id;
    const songs = loadSongs();
    const index = songs.findIndex(s => s.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Song not found.' });
    }

    const song = songs[index];
    const filePath = path.join(MUSIC_DIR, song.fileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    songs.splice(index, 1);
    saveSongs(songs);

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Delete failed' });
  }
});

app.use(function (err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Max 200MB allowed.' });
  }
  res.status(400).json({ error: err.message || 'Bad request' });
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server running on port ' + PORT);
});
