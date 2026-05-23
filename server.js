  const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Root repo folder ke andar hi data save hoga
const DATA_DIR = path.join(__dirname, 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const JSON_FILE = path.join(DATA_DIR, 'songs.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

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
  } catch (err) {
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

// Auto-create folders/files
ensureDir(DATA_DIR);
ensureDir(MUSIC_DIR);
ensureJsonFile();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, MUSIC_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const fileName = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
    cb(null, fileName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 200 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    if (file && file.mimetype && file.mimetype.indexOf('audio/') === 0) {
      cb(null, true);
    } else {
      cb(new Error('Sirf audio file upload karo.'));
    }
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/music', express.static(MUSIC_DIR));

// Root pe index.html khulega
app.get('/', function (req, res) {
  if (!fs.existsSync(INDEX_FILE)) {
    return res.status(404).send('index.html not found');
  }
  res.sendFile(INDEX_FILE);
});

// Song list
app.get('/api/songs', function (req, res) {
  const songs = loadSongs().sort(function (a, b) {
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });
  res.json(songs);
});

// Upload
app.post('/api/upload', function (req, res, next) {
  upload.single('music')(req, res, function (err) {
    if (err) {
      return next(err);
    }

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
        title: title,
        originalName: req.file.originalname,
        fileName: req.file.filename,
        fileUrl: '/music/' + encodeURIComponent(req.file.filename),
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date().toISOString()
      };

      songs.push(song);
      saveSongs(songs);

      res.json({ ok: true, song: song });
    } catch (error) {
      next(error);
    }
  });
});

// Rename
app.post('/api/songs/:id/rename', function (req, res) {
  try {
    const id = req.params.id;
    const newTitle = cleanText(req.body.title);

    if (!newTitle) {
      return res.status(400).json({ error: 'New title required hai.' });
    }

    const songs = loadSongs();
    const song = songs.find(function (s) {
      return s.id === id;
    });

    if (!song) {
      return res.status(404).json({ error: 'Song not found.' });
    }

    song.title = newTitle;
    saveSongs(songs);

    res.json({ ok: true, song: song });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Rename failed' });
  }
});

// Delete
app.delete('/api/songs/:id', function (req, res) {
  try {
    const id = req.params.id;
    const songs = loadSongs();
    const index = songs.findIndex(function (s) {
      return s.id === id;
    });

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

// Multer / general error handler
app.use(function (err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Max 200MB allowed.' });
  }

  res.status(400).json({ error: err.message || 'Bad request' });
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server running on port ' + PORT);
});
