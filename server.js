const express = require('express');

const app = express();
app.use(express.json({ limit: '64kb' }));

const rooms = {
  global: { title: 'Global Chat', messages: [], lastId: 0 },
  tech: { title: 'Tech Talk', messages: [], lastId: 0 },
  gaming: { title: 'Gaming Room', messages: [], lastId: 0 },
  chill: { title: 'Chill Room', messages: [], lastId: 0 }
};

function cleanText(s, limit) {
  s = String(s || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

function ensureRoom(name) {
  name = cleanText(name, 32).toLowerCase();
  if (!rooms[name]) {
    rooms[name] = { title: name, messages: [], lastId: 0 };
  }
  return name;
}

app.get('/', function (req, res) {
  res.json({
    ok: true,
    name: 'myserver',
    rooms: Object.keys(rooms)
  });
});

app.get('/rooms', function (req, res) {
  const list = Object.keys(rooms).map(function (key) {
    return {
      room: key,
      title: rooms[key].title,
      count: rooms[key].messages.length
    };
  });

  res.json({ ok: true, rooms: list });
});

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

app.post('/send', function (req, res) {
  const roomName = ensureRoom(req.body.room || 'global');
  const name = cleanText(req.body.name || 'Guest', 24) || 'Guest';
  const text = cleanText(req.body.text || '', 500);

  if (!text) {
    return res.status(400).json({ ok: false, error: 'text required' });
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
    room.messages.splice(0, room.messages.length - 300);
  }

  res.json({ ok: true, message: msg });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
