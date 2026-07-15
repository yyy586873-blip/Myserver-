const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(__dirname));
app.get('/', function (req, res) {
  res.sendFile(__dirname + '/index.html');
});

const onlineUsers = new Map();
let activeCall = null;

function getUsersList() {
  return Array.from(onlineUsers.values());
}

function broadcastUsers() {
  io.emit('onlineUsers', getUsersList());
}

function endCall(reason) {
  if (!activeCall) return;

  io.emit('callEnded', {
    callId: activeCall.callId,
    reason: reason || 'ended'
  });

  activeCall = null;
}

function isCallParticipant(socketId) {
  if (!activeCall) return false;
  return activeCall.callerId === socketId || activeCall.calleeId === socketId;
}

io.on('connection', function (socket) {
  socket.on('register', function (data) {
    var name = 'User';
    if (data && typeof data.name === 'string' && data.name.trim()) {
      name = data.name.trim().slice(0, 30);
    }

    onlineUsers.set(socket.id, {
      id: socket.id,
      name: name
    });

    socket.emit('me', {
      id: socket.id,
      name: name
    });

    broadcastUsers();
  });

  socket.on('requestCall', function () {
    if (!onlineUsers.has(socket.id)) return;

    if (activeCall) {
      socket.emit('callBusy');
      return;
    }

    var me = onlineUsers.get(socket.id);
    var callId = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);

    activeCall = {
      callId: callId,
      callerId: socket.id,
      calleeId: null,
      status: 'ringing'
    };

    socket.emit('outgoingCall', { callId: callId });

    socket.broadcast.emit('incomingCall', {
      callId: callId,
      callerId: socket.id,
      callerName: me ? me.name : 'Caller'
    });
  });

  socket.on('acceptCall', function (data) {
    if (!activeCall) return;
    if (!data || data.callId !== activeCall.callId) return;
    if (activeCall.status !== 'ringing') return;
    if (socket.id === activeCall.callerId) return;

    activeCall.calleeId = socket.id;
    activeCall.status = 'connected';

    io.emit('stopRinging', {
      callId: activeCall.callId
    });

    var caller = onlineUsers.get(activeCall.callerId);
    var callee = onlineUsers.get(socket.id);

    io.to(activeCall.callerId).emit('callAccepted', {
      callId: activeCall.callId,
      role: 'caller',
      peerId: socket.id,
      peerName: callee ? callee.name : 'User'
    });

    socket.emit('callAccepted', {
      callId: activeCall.callId,
      role: 'callee',
      peerId: activeCall.callerId,
      peerName: caller ? caller.name : 'Caller'
    });
  });

  socket.on('signal', function (data) {
    if (!activeCall) return;
    if (!data || data.callId !== activeCall.callId) return;
    if (!data.to) return;
    if (!isCallParticipant(socket.id)) return;

    io.to(data.to).emit('signal', {
      callId: data.callId,
      from: socket.id,
      data: data.data
    });
  });

  socket.on('endCall', function (data) {
    if (!activeCall) return;
    if (!data || data.callId !== activeCall.callId) return;
    if (!isCallParticipant(socket.id)) return;

    endCall('ended');
  });

  socket.on('disconnect', function () {
    var hadUser = onlineUsers.has(socket.id);
    onlineUsers.delete(socket.id);

    if (hadUser) {
      broadcastUsers();
    }

    if (activeCall && isCallParticipant(socket.id)) {
      endCall('disconnect');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
