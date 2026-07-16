const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const users = new Map();      // userId -> { id, name, lastSeen }
const snoozed = new Map();    // userId -> callId
const rooms = new Map();      // callId -> { packets: [] }
let activeCall = null;        // { callId, callerId, callerName, calleeId, status }

function clean(v) {
  return String(v || '').trim();
}

function makeCallId() {
  return String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
}

function getUserName(userId) {
  const u = users.get(userId);
  return u ? u.name : 'User';
}

function getUsersList() {
  return Array.from(users.values()).map(function (u) {
    return { id: u.id, name: u.name };
  });
}

function clearSnoozes() {
  snoozed.clear();
}

function ensureRoom(callId) {
  if (!rooms.has(callId)) {
    rooms.set(callId, { packets: [] });
  }
  return rooms.get(callId);
}

function stateFor(userId) {
  if (!activeCall) {
    return { status: 'idle' };
  }

  if (activeCall.status === 'ringing') {
    if (userId === activeCall.callerId) {
      return {
        status: 'outgoing',
        callId: activeCall.callId,
        callerName: activeCall.callerName
      };
    }

    if (snoozed.get(userId) === activeCall.callId) {
      return { status: 'idle' };
    }

    return {
      status: 'incoming',
      callId: activeCall.callId,
      fromId: activeCall.callerId,
      fromName: activeCall.callerName
    };
  }

  if (activeCall.status === 'connected') {
    if (userId === activeCall.callerId) {
      return {
        status: 'connected',
        callId: activeCall.callId,
        role: 'caller',
        peerId: activeCall.calleeId,
        peerName: getUserName(activeCall.calleeId)
      };
    }

    if (userId === activeCall.calleeId) {
      return {
        status: 'connected',
        callId: activeCall.callId,
        role: 'callee',
        peerId: activeCall.callerId,
        peerName: activeCall.callerName
      };
    }

    return { status: 'idle' };
  }

  return { status: 'idle' };
}

function endCall(reason) {
  if (!activeCall) return;

  ioEventBroadcast({
    type: 'callEnded',
    callId: activeCall.callId,
    reason: reason || 'ended'
  });

  rooms.delete(activeCall.callId);
  activeCall = null;
  clearSnoozes();
}

const subscribers = new Set();

function ioEventBroadcast(payload) {
  subscribers.forEach(function (fn) {
    try { fn(payload); } catch (e) {}
  });
}

app.get('/', function (req, res) {
  res.json({
    ok: true,
    name: 'myserver',
    usersOnline: users.size,
    activeCall: !!activeCall
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
    state: stateFor(userId)
  });
});

app.post('/requestCall', function (req, res) {
  const userId = clean(req.body.userId);

  if (!userId || !users.has(userId)) {
    return res.status(400).json({ ok: false, error: 'not registered' });
  }

  if (activeCall) {
    return res.status(409).json({ ok: false, error: 'busy' });
  }

  clearSnoozes();

  activeCall = {
    callId: makeCallId(),
    callerId: userId,
    callerName: getUserName(userId),
    calleeId: null,
    status: 'ringing'
  };

  res.json({
    ok: true,
    callId: activeCall.callId,
    state: stateFor(userId)
  });
});

app.post('/acceptCall', function (req, res) {
  const userId = clean(req.body.userId);
  const callId = clean(req.body.callId);

  if (!activeCall) {
    return res.status(404).json({ ok: false, error: 'no active call' });
  }

  if (activeCall.callId !== callId) {
    return res.status(400).json({ ok: false, error: 'call mismatch' });
  }

  if (activeCall.status !== 'ringing') {
    return res.status(409).json({ ok: false, error: 'not ringing' });
  }

  if (userId === activeCall.callerId) {
    return res.status(400).json({ ok: false, error: 'caller cannot accept own call' });
  }

  if (!users.has(userId)) {
    return res.status(400).json({ ok: false, error: 'not registered' });
  }

  activeCall.calleeId = userId;
  activeCall.status = 'connected';

  ensureRoom(callId);

  res.json({
    ok: true,
    callId: activeCall.callId,
    state: stateFor(userId)
  });
});

app.post('/rejectCall', function (req, res) {
  const userId = clean(req.body.userId);
  const callId = clean(req.body.callId);

  if (activeCall && activeCall.callId === callId && activeCall.status === 'ringing' && userId !== activeCall.callerId) {
    snoozed.set(userId, callId);
  }

  res.json({ ok: true });
});

app.post('/endCall', function (req, res) {
  const userId = clean(req.body.userId);
  const callId = clean(req.body.callId);

  if (!activeCall) {
    return res.json({ ok: true, ended: false });
  }

  const isParticipant = userId === activeCall.callerId || userId === activeCall.calleeId;
  if (!isParticipant) {
    return res.status(403).json({ ok: false, error: 'not a participant' });
  }

  if (activeCall.callId !== callId) {
    return res.status(400).json({ ok: false, error: 'call mismatch' });
  }

  endCall('ended');
  res.json({ ok: true, ended: true });
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
    state: stateFor(userId)
  });
});

app.post('/audio/send', function (req, res) {
  const userId = clean(req.body.userId);
  const callId = clean(req.body.callId);
  const seq = parseInt(req.body.seq, 10);
  const data = clean(req.body.data);

  if (!activeCall || activeCall.callId !== callId || activeCall.status !== 'connected') {
    return res.status(409).json({ ok: false, error: 'call not connected' });
  }

  const isParticipant = userId === activeCall.callerId || userId === activeCall.calleeId;
  if (!isParticipant) {
    return res.status(403).json({ ok: false, error: 'not a participant' });
  }

  if (!data) {
    return res.status(400).json({ ok: false, error: 'empty audio' });
  }

  const room = ensureRoom(callId);
  room.packets.push({
    seq: isNaN(seq) ? 0 : seq,
    fromId: userId,
    data: data,
    time: Date.now()
  });

  if (room.packets.length > 400) {
    room.packets.splice(0, room.packets.length - 400);
  }

  res.json({ ok: true });
});

app.get('/audio/fetch', function (req, res) {
  const userId = clean(req.query.userId);
  const callId = clean(req.query.callId);
  const after = parseInt(req.query.after, 10);

  if (!activeCall || activeCall.callId !== callId || activeCall.status !== 'connected') {
    return res.json({ ok: true, packets: [] });
  }

  const room = rooms.get(callId);
  if (!room) {
    return res.json({ ok: true, packets: [] });
  }

  const packets = room.packets.filter(function (p) {
    return p.seq > (isNaN(after) ? -1 : after) && p.fromId !== userId;
  });

  res.json({ ok: true, packets: packets });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
