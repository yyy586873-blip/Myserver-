const express = require('express');

const app = express();
app.use(express.json());

const users = new Map();   // userId -> { id, name, lastSeen }
const messages = [];       // { id, userId, name, text, time }

function clean(s) {
  return String(s || '').trim();
}

function makeId() {
  return String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
}

function getUsersList() {
  return Array.from(users.values()).map(function (u) {
    return { id: u.id, name: u.name };
  });
}

function trimMessages() {
  while (messages.length > 100) {
    messages.shift();
  }
}

app.get('/', function (req, res) {
  res.json({
    ok: true,
    name: 'myserver',
    usersOnline: users.size,
    messages: messages.length
  });
});

app.post('/register', function (req, res) {
  const userId = clean(req.body.userId);
  const name = clean(req.body.name) || 'User';

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId required' });
  }

  users.set(userId, {
    id: userId,
    name: name,
    lastSeen: Date.now()
  });

  res.json({
    ok: true,
    me: { id: userId, name: name },
    users: getUsersList(),
    messages: messages
  });
});

app.post('/sendMessage', function (req, res) {
  const userId = clean(req.body.userId);
  const text = clean(req.body.text);

  if (!userId || !users.has(userId)) {
    return res.status(400).json({ ok: false, error: 'not registered' });
  }

  if (!text) {
    return res.status(400).json({ ok: false, error: 'empty message' });
  }

  const user = users.get(userId);
  const msg = {
    id: makeId(),
    userId: userId,
    name: user.name,
    text: text.slice(0, 500),
    time: Date.now()
  };

  messages.push(msg);
  trimMessages();

  res.json({
    ok: true,
    message: msg
  });
});

app.get('/poll', function (req, res) {
  const userId = clean(req.query.userId);

  if (userId && users.has(userId)) {
    const u = users.get(userId);
    u.lastSeen = Date.now();
    users.set(userId, u);
  }

  res.json({
    ok: true,
    users: getUsersList(),
    messages: messages
  });
});

app.post('/unregister', function (req, res) {
  const userId = clean(req.body.userId);
  if (userId) {
    users.delete(userId);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
