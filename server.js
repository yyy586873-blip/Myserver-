const express = require('express');

const app = express();
app.use(express.json());

const users = new Map();      // userId -> { id, name }
const snoozed = new Map();    // userId -> callId
let activeCall = null;        // { callId, callerId, callerName, calleeId, status }

function makeCallId() {
  return String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
}

function clean(v) {
  return String(v || '').trim();
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
    name: name
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
  snoozed.delete(userId);

  res.json({
    ok: true,
    callId: activeCall.callId,
    state: stateFor(userId)
  });
});

app.post('/snoozeIncoming', function (req, res) {
  const userId = clean(req.body.userId);
  const callId = clean(req.body.callId);

  if (!activeCall) {
    return res.json({ ok: true });
  }

  if (activeCall.callId === callId && activeCall.status === 'ringing' && userId !== activeCall.callerId) {
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

  const isParticipant =
    userId === activeCall.callerId || userId === activeCall.calleeId;

  if (!isParticipant) {
    return res.status(403).json({ ok: false, error: 'not a participant' });
  }

  if (activeCall.callId !== callId) {
    return res.status(400).json({ ok: false, error: 'call mismatch' });
  }

  activeCall = null;
  clearSnoozes();

  res.json({ ok: true, ended: true });
});

app.get('/poll', function (req, res) {
  const userId = clean(req.query.userId);

  if (!userId || !users.has(userId)) {
    return res.json({
      ok: true,
      users: getUsersList(),
      state: { status: 'idle' }
    });
  }

  res.json({
    ok: true,
    users: getUsersList(),
    state: stateFor(userId)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
