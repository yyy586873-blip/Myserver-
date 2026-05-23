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
    if (file.mimetype && file.mimetype.indexOf('audio/') === 0) {
      cb(null, true);
    } else {
      cb(new Error('Sirf audio file upload karo.'));
    }
  }
});

app.use(express.json());
app.use('/music', express.static(MUSIC_DIR));

// Root pe index.html khulega
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Song list
app.get('/api/songs', function (req, res) {
  const songs = loadSongs().sort(function (a, b) {
    return new Date(b.uploadedAt) - new Date(a.uploadedAt);
  });
  res.json(songs);
});

// Upload
app.post('/api/upload', upload.single('music'), function (req, res) {
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
      id: crypto.randomUUID(),
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
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message || 'Rename failed' });
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
  } catch (err) {
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

app.use(function (err, req, res, next) {
  res.status(400).json({ error: err.message || 'Bad request' });
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server running on port ' + PORT);
});
