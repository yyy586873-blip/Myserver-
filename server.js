const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const FILES_DIR = path.join(ROOT_DIR, 'files');
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');

if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

const rooms = {
  global: { title: 'Global Chat', messages: [], lastId: 0 },
  tech: { title: 'Tech Talk', messages: [], lastId: 0 },
  gaming: { title: 'Gaming Room', messages: [], lastId: 0 },
  chill: { title: 'Chill Room', messages: [], lastId: 0 }
};

function cleanText(s, limit) {
  s = String(s || '').replace(/[\r\n\t]+/g, ' ').trim();

  if (s.length > limit) {
    s = s.slice(0, limit);
  }

  return s;
}

function ensureRoom(name) {
  name = cleanText(name, 32).toLowerCase();

  if (!rooms[name]) {
    rooms[name] = {
      title: name,
      messages: [],
      lastId: 0
    };
  }

  return name;
}

/*
 * Home page
 * https://myserver-b0ls.onrender.com/
 */
app.get('/', function (req, res) {
  res.sendFile(INDEX_FILE);
});

/*
 * Server information
 */
app.get('/api', function (req, res) {
  res.json({
    ok: true,
    name: 'myserver',
    rooms: Object.keys(rooms)
  });
});

/*
 * Rooms
 */
app.get('/rooms', function (req, res) {
  const list = Object.keys(rooms).map(function (key) {
    return {
      room: key,
      title: rooms[key].title,
      count: rooms[key].messages.length
    };
  });

  res.json({
    ok: true,
    rooms: list
  });
});

/*
 * Messages
 */
app.get('/messages', function (req, res) {
  const roomName = ensureRoom(req.query.room || 'global');
  const since = parseInt(req.query.since || '0', 10) || 0;

  const room = rooms[roomName];

  const messages = room.messages.filter(function (m) {
    return m.id > since;
  });

  res.json({
    ok: true,
    room: roomName,
    messages: messages
  });
});

/*
 * Send message
 */
app.post('/send', function (req, res) {
  const roomName = ensureRoom(req.body.room || 'global');

  const name =
    cleanText(req.body.name || 'Guest', 24) || 'Guest';

  const text =
    cleanText(req.body.text || '', 500);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: 'text required'
    });
  }

  const room = rooms[roomName];

  room.lastId += 1;

  const msg = {
    id: room.lastId,
    room: roomName,
    name: name,
    text: text,
    time: Date.now()
  };

  room.messages.push(msg);

  if (room.messages.length > 300) {
    room.messages.splice(
      0,
      room.messages.length - 300
    );
  }

  res.json({
    ok: true,
    message: msg
  });
});

/*
 * Get files
 *
 * Returns every file inside /files
 */
app.get('/file-list', function (req, res) {
  fs.readdir(FILES_DIR, { withFileTypes: true }, function (err, entries) {
    if (err) {
      return res.status(500).json({
        ok: false,
        error: 'Unable to read files folder'
      });
    }

    const result = [];

    entries.forEach(function (entry) {
      if (!entry.isFile()) {
        return;
      }

      const fileName = entry.name;
      const fullPath = path.join(FILES_DIR, fileName);

      try {
        const stat = fs.statSync(fullPath);

        result.push({
          name: fileName,
          size: stat.size,
          modified: stat.mtimeMs,
          url: '/download/' + encodeURIComponent(fileName)
        });
      } catch (e) {
      }
    });

    result.sort(function (a, b) {
      return b.modified - a.modified;
    });

    res.json({
      ok: true,
      files: result
    });
  });
});

/*
 * Download a file
 */
app.get('/download/:file', function (req, res) {
  const requestedName = req.params.file;

  /*
   * Decode URL encoded filename.
   */
  let fileName;

  try {
    fileName = decodeURIComponent(requestedName);
  } catch (e) {
    return res.status(400).send('Invalid file name');
  }

  /*
   * Prevent path traversal.
   */
  fileName = path.basename(fileName);

  const fullPath = path.join(FILES_DIR, fileName);

  fs.stat(fullPath, function (err, stat) {
    if (err || !stat.isFile()) {
      return res.status(404).send('File not found');
    }

    res.download(
      fullPath,
      fileName,
      function (downloadError) {
        if (downloadError) {
          if (!res.headersSent) {
            res.status(500).send('Download failed');
          }
        }
      }
    );
  });
});

/*
 * Optional direct file URL.
 *
 * Example:
 * /files/video.mp4
 *
 * This is useful if you want to open a file directly
 * instead of downloading it.
 */
app.use(
  '/files',
  express.static(FILES_DIR)
);

/*
 * Health check
 */
app.get('/health', function (req, res) {
  res.json({
    ok: true,
    server: 'myserver',
    time: Date.now()
  });
});

app.listen(PORT, function () {
  console.log(
    'Server running on port ' + PORT
  );

  console.log(
    'Files directory: ' + FILES_DIR
  );
});