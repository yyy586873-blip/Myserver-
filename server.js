const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const ALLOWED_ORIGINS = new Set(['https://myserver-b0ls.onrender.com']);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed.'));
    },
    methods: ['GET', 'POST']
  },
  pingInterval: 25000,
  pingTimeout: 45000,
  connectionStateRecovery: { maxDisconnectionDuration: 60000, skipMiddlewares: true }
});
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const ROOM_TTL = 10 * 60 * 1000;
const RECONNECT_GRACE = 45000;
let consoleSocketId = null;
let uiSettings = { boardStyle: 'classic', moveAnimation: true, spinAnimation: false, captureFx: false };

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(__dirname, { index: false }));
const stockfishAssetDir = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
app.use('/stockfish', express.static(stockfishAssetDir, {
  maxAge: '1d',
  fallthrough: false,
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    else if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  }
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'lobby.html')));
app.get('/create', (req, res) => res.sendFile(path.join(__dirname, 'create.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'join.html')));
app.get('/Admin.html', (req, res) => res.sendFile(path.join(__dirname, 'Admin.html')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));

function validCode(code) { return typeof code === 'string' && /^\d{3}$/.test(code); }
function validToken(token) { return typeof token === 'string' && /^[a-zA-Z0-9_-]{20,100}$/.test(token); }
function clearTimer(seat) {
  if (seat && seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
}
function clearRoomTimer(room) {
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
}
function scheduleRoomCleanup(room) {
  clearRoomTimer(room);
  if (room.players.w || room.players.b) return;
  room.cleanupTimer = setTimeout(() => {
    if (!room.players.w && !room.players.b && rooms.get(room.code) === room) {
      rooms.delete(room.code);
      broadcastRoomList();
      console.log('Expired empty room:', room.code);
    }
  }, ROOM_TTL);
  if (room.cleanupTimer.unref) room.cleanupTimer.unref();
}
function createSeat() { return null; }
function createRoom(code) {
  return {
    code: code,
    chess: new Chess(),
    players: { w: createSeat(), b: createSeat() },
    started: false,
    lastMove: null,
    redoStack: [],
    cleanupTimer: null,
    createdAt: Date.now()
  };
}
function connected(seat) { return !!(seat && seat.connected && seat.socketId); }
function seatReserved(seat) { return !!seat; }
function roomHasConnectedPlayers(room) { return connected(room.players.w) || connected(room.players.b); }
function updateStarted(room) { room.started = connected(room.players.w) && connected(room.players.b); }

app.post('/api/create-room', (req, res) => {
  const code = String(req.body && req.body.code || '');
  if (!validCode(code)) return res.status(400).json({ ok: false, message: 'Please enter exactly 3 digits.' });
  if (rooms.has(code)) return res.status(409).json({ ok: false, message: 'This room code is already in use. Choose another 3-digit code.' });
  const room = createRoom(code);
  rooms.set(code, room);
  scheduleRoomCleanup(room);
  broadcastRoomList();
  return res.json({ ok: true, code: code });
});
app.post('/api/join-room', (req, res) => {
  const code = String(req.body && req.body.code || '');
  if (!validCode(code)) return res.status(400).json({ ok: false, message: 'Enter a valid 3-digit room code.' });
  if (!rooms.has(code)) return res.status(404).json({ ok: false, message: 'Room not found. The code is incorrect or the room has expired.' });
  // Seat availability is decided atomically by joinGame using the persistent player token.
  return res.json({ ok: true, code: code });
});

function getRole(room, socketId) {
  if (room.players.w && room.players.w.socketId === socketId && room.players.w.connected) return 'w';
  if (room.players.b && room.players.b.socketId === socketId && room.players.b.connected) return 'b';
  return null;
}
function getStatus(room) {
  const chess = room.chess;
  if (!room.started) {
    const w = connected(room.players.w), b = connected(room.players.b);
    if (!w && !b) return { state: 'waiting', message: 'Waiting for White and Black players...' };
    if (!w) return { state: 'waiting', message: 'Waiting for White player...' };
    if (!b) return { state: 'waiting', message: 'Waiting for Black player...' };
  }
  if (chess.isCheckmate()) return { state: 'checkmate', winner: chess.turn() === 'w' ? 'b' : 'w', message: (chess.turn() === 'w' ? 'Black' : 'White') + ' wins by checkmate!' };
  if (chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial() || chess.isDraw()) return { state: 'draw', message: 'The game is a draw!' };
  return { state: 'playing', message: chess.isCheck() ? (chess.turn() === 'w' ? 'White' : 'Black') + ' king is in check!' : (chess.turn() === 'w' ? 'White' : 'Black') + "'s turn" };
}
function roomList() {
  return Array.from(rooms.values()).map(r => ({
    code: r.code,
    white: connected(r.players.w),
    black: connected(r.players.b),
    whiteReserved: seatReserved(r.players.w),
    blackReserved: seatReserved(r.players.b),
    started: r.started,
    status: getStatus(r).state,
    turn: r.started ? (r.chess.turn() === 'w' ? 'White' : 'Black') : '—',
    moves: r.chess.history().length
  })).sort((a, b) => a.code.localeCompare(b.code));
}
function broadcastRoomList() { io.emit('roomListUpdate', roomList()); }
function snapshot(room) {
  const chess = room.chess;
  return {
    roomCode: room.code,
    started: room.started,
    board: chess.board(),
    turn: chess.turn(),
    fen: chess.fen(),
    check: chess.isCheck(),
    checkmate: chess.isCheckmate(),
    draw: chess.isDraw(),
    lastMove: room.lastMove,
    players: {
      white: connected(room.players.w),
      black: connected(room.players.b),
      whiteReserved: seatReserved(room.players.w),
      blackReserved: seatReserved(room.players.b)
    },
    status: getStatus(room),
    history: chess.history(),
    canUndo: chess.history().length > 0,
    canRedo: room.redoStack.length > 0
  };
}
function sendState(room) { io.to(room.code).emit('gameState', snapshot(room)); }
function updateLastMove(room) {
  const h = room.chess.history({ verbose: true });
  const m = h.length ? h[h.length - 1] : null;
  room.lastMove = m ? { from: m.from, to: m.to, san: m.san, color: m.color, piece: m.piece, captured: m.captured || null } : null;
}
function isConsole(socket) { return !!consoleSocketId && socket.id === consoleSocketId; }
function selectedConsoleRoom(socket) { return rooms.get(socket.data.selectedRoomCode || '') || null; }
function emitSettings() { io.emit('uiSettings', uiSettings); }

function claimSeat(room, socket, token) {
  let role = null;
  ['w', 'b'].forEach(function(side) {
    const seat = room.players[side];
    if (seat && seat.token === token) role = side;
  });
  if (role) {
    const seat = room.players[role];
    clearTimer(seat);
    const oldSocketId = seat.socketId;
    seat.socketId = socket.id;
    seat.connected = true;
    seat.lastSeen = Date.now();
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.emit('sessionReplaced', { message: 'This player session was resumed in another tab or app.' });
        oldSocket.disconnect(true);
      }
    }
    return role;
  }
  if (!room.players.w) role = 'w';
  else if (!room.players.b) role = 'b';
  if (!role) return null;
  room.players[role] = { token: token, socketId: socket.id, connected: true, lastSeen: Date.now(), graceTimer: null };
  return role;
}
function releaseDisconnectedSeat(room, role, socketId) {
  const seat = room.players[role];
  if (!seat || seat.socketId !== socketId) return;
  seat.socketId = null;
  seat.connected = false;
  seat.lastSeen = Date.now();
  updateStarted(room);
  sendState(room);
  broadcastRoomList();
  clearTimer(seat);
  seat.graceTimer = setTimeout(() => {
    if (room.players[role] === seat && !seat.connected && !seat.socketId) {
      room.players[role] = null;
      updateStarted(room);
      sendState(room);
      broadcastRoomList();
      if (!room.players.w && !room.players.b) scheduleRoomCleanup(room);
    }
  }, RECONNECT_GRACE);
  if (seat.graceTimer.unref) seat.graceTimer.unref();
}

io.on('connection', socket => {
  socket.emit('uiSettings', uiSettings);
  const code = String(socket.handshake.query.room || '');
  const room = validCode(code) ? rooms.get(code) : null;

  socket.on('consoleAuth', data => {
    const key = process.env.CONSOLE_KEY;
    if (!key) return socket.emit('consoleAuthResult', { ok: false, message: 'Set CONSOLE_KEY in Render environment variables.' });
    if (!data || data.key !== key) return socket.emit('consoleAuthResult', { ok: false, message: 'Invalid console key.' });
    if (consoleSocketId && consoleSocketId !== socket.id) {
      const previous = io.sockets.sockets.get(consoleSocketId);
      if (previous) previous.emit('consoleSessionReplaced', { message: 'Console connected from another session.' });
    }
    consoleSocketId = socket.id;
    socket.emit('consoleAuthResult', { ok: true, message: 'Console unlocked. Select any room to manage.' });
    socket.emit('uiSettings', uiSettings);
    socket.emit('roomListUpdate', roomList());
  });
  socket.on('consoleSelectRoom', data => {
    if (!isConsole(socket)) return;
    const nextCode = String(data && data.code || '');
    if (socket.data.selectedRoomCode) socket.leave(socket.data.selectedRoomCode);
    socket.data.selectedRoomCode = null;
    const selected = validCode(nextCode) ? rooms.get(nextCode) : null;
    if (!selected) { socket.emit('consoleSelectedRoom', { ok: false, message: 'Room not found or expired.' }); return; }
    socket.data.selectedRoomCode = nextCode;
    socket.join(nextCode);
    socket.emit('consoleSelectedRoom', { ok: true, code: nextCode, message: 'Managing room ' + nextCode });
    socket.emit('gameState', snapshot(selected));
  });
  socket.on('refreshRoomList', () => { if (isConsole(socket)) socket.emit('roomListUpdate', roomList()); });
  socket.on('setUiSettings', data => {
    if (!isConsole(socket) || !data) return;
    const styles = ['classic', 'yellow'];
    uiSettings = {
      boardStyle: styles.includes(data.boardStyle) ? data.boardStyle : 'classic',
      moveAnimation: data.moveAnimation !== false,
      spinAnimation: data.spinAnimation === true,
      captureFx: data.captureFx === true
    };
    emitSettings();
  });
  socket.on('joinGame', joinData => {
    if (!room) return socket.emit('joinRejected', { message: 'Room not found or expired. Return to lobby and check the 3-digit code.' });
    const token = joinData && joinData.token;
    if (!validToken(token)) return socket.emit('joinRejected', { message: 'Player session could not be verified. Reload the room from the lobby.' });
    const wasKnownSession = !!((room.players.w && room.players.w.token === token) || (room.players.b && room.players.b.token === token));
    const role = claimSeat(room, socket, token);
    if (!role) return socket.emit('joinRejected', { message: 'Both player seats are currently occupied. If you just disconnected, wait a few seconds for your previous session to recover.' });
    clearRoomTimer(room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = token;
    updateStarted(room);
    socket.emit('joined', { role: role, accepted: true, isAdmin: !!(joinData && joinData.admin === true), resumed: wasKnownSession });
    sendState(room);
    broadcastRoomList();
  });
  socket.on('getLegalMoves', data => {
    if (!room || !data) return socket.emit('legalMoves', { square: data && data.square, moves: [] });
    const role = getRole(room, socket.id), chess = room.chess;
    if (!role || !room.started || chess.turn() !== role) return socket.emit('legalMoves', { square: data.square, moves: [] });
    try {
      const p = chess.get(data.square);
      if (!p || p.color !== role) return socket.emit('legalMoves', { square: data.square, moves: [] });
      socket.emit('legalMoves', { square: data.square, moves: chess.moves({ square: data.square, verbose: true }).map(m => ({ from: m.from, to: m.to, san: m.san, flags: m.flags, promotion: m.promotion || null, captured: m.captured || null })) });
    } catch (e) { socket.emit('legalMoves', { square: data.square, moves: [] }); }
  });
  socket.on('makeMove', data => {
    if (!room || !data) return socket.emit('moveError', 'Room is not available.');
    const role = getRole(room, socket.id), chess = room.chess;
    if (!role || !room.started) return socket.emit('moveError', 'Game is not ready.');
    if (chess.isGameOver()) return socket.emit('moveError', 'The game is already over.');
    if (chess.turn() !== role) return socket.emit('moveError', 'It is not your turn.');
    try {
      const m = chess.move({ from: data.from, to: data.to, promotion: data.promotion || 'q' });
      if (!m) return socket.emit('moveError', 'Invalid chess move.');
      room.lastMove = { from: m.from, to: m.to, san: m.san, color: m.color, piece: m.piece, captured: m.captured || null };
      room.redoStack = [];
      sendState(room);
      broadcastRoomList();
    } catch (e) { socket.emit('moveError', 'Invalid chess move.'); }
  });
  socket.on('newGame', () => {
    if (!room || !getRole(room, socket.id) || !room.started || !room.chess.isGameOver()) return;
    room.chess.reset();
    room.lastMove = null;
    room.redoStack = [];
    sendState(room);
    broadcastRoomList();
  });
  socket.on('consoleUndo', () => {
    const target = selectedConsoleRoom(socket);
    if (!isConsole(socket) || !target) return;
    const m = target.chess.undo();
    if (!m) return socket.emit('consoleActionResult', { ok: false, message: 'There are no moves to undo.' });
    target.redoStack.push({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
    updateLastMove(target);
    sendState(target);
    socket.emit('consoleActionResult', { ok: true, message: 'Last move undone.' });
  });
  socket.on('consoleRedo', () => {
    const target = selectedConsoleRoom(socket);
    if (!isConsole(socket) || !target) return;
    const m = target.redoStack.pop();
    if (!m) return socket.emit('consoleActionResult', { ok: false, message: 'There are no moves to redo.' });
    try {
      target.chess.move(m);
      updateLastMove(target);
      sendState(target);
      socket.emit('consoleActionResult', { ok: true, message: 'Move restored.' });
    } catch (e) {
      target.redoStack.push(m);
      socket.emit('consoleActionResult', { ok: false, message: 'Redo failed.' });
    }
  });
  socket.on('disconnect', () => {
    if (socket.id === consoleSocketId) consoleSocketId = null;
    if (!room) return;
    const role = getRole(room, socket.id);
    if (role) releaseDisconnectedSeat(room, role, socket.id);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Chess Arena stable multiplayer server running on port ' + PORT));
