'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOM_TTL = 10 * 60 * 1000;
const MAX_ROOMS = Math.max(10, Number(process.env.MAX_ROOMS) || 500);
const rooms = new Map();
const consoleSockets = new Set();
let uiSettings = { boardStyle: 'classic', moveAnimation: true, spinAnimation: false, captureFx: false };

const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 20000,
  transports: ['websocket', 'polling'],
  allowEIO3: false
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '10kb', strict: true }));
const stockfishAssetDir = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
app.use('/stockfish', express.static(stockfishAssetDir, {
  maxAge: '1d', fallthrough: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    else if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  }
}));

// Small per-IP limiter for room-code endpoints. It is intentionally local to
// this process and resets on deploy/restart; gameplay sockets are unaffected.
const apiHits = new Map();
function roomApiLimit(req, res, next) {
  const now = Date.now();
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  let item = apiHits.get(ip);
  if (!item || now - item.start > 60000) item = { start: now, count: 0 };
  item.count++;
  apiHits.set(ip, item);
  if (item.count > 50) return res.status(429).json({ ok: false, message: 'Too many requests. Please wait a minute and try again.' });
  next();
}
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, item] of apiHits) if (item.start < cutoff) apiHits.delete(ip);
}, 60000).unref();

app.get('/health', (req, res) => res.status(200).json({
  ok: true, service: 'chess-arena', uptime: Math.floor(process.uptime()),
  rooms: rooms.size, maxRooms: MAX_ROOMS
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'lobby.html')));
app.get('/create', (req, res) => res.sendFile(path.join(__dirname, 'create.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'join.html')));
app.get('/Admin.html', (req, res) => {
  if (validCode(String(req.query.room || ''))) return res.sendFile(path.join(__dirname, 'Admin.html'));
  return res.sendFile(path.join(__dirname, 'lobby.html'));
});
app.get('/admin-game', (req, res) => res.sendFile(path.join(__dirname, 'Admin.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname, { index: false, dotfiles: 'deny', etag: true, maxAge: '1h' }));

function validCode(code) { return typeof code === 'string' && /^\d{3}$/.test(code); }
function clearRoomTimer(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
}
function scheduleRoomCleanup(room) {
  clearRoomTimer(room);
  if (room.players.w || room.players.b) return;
  room.cleanupTimer = setTimeout(() => {
    if (!room.players.w && !room.players.b && rooms.get(room.code) === room) {
      rooms.delete(room.code);
      broadcastRoomList();
      console.log('[room] expired empty room', room.code);
    }
  }, ROOM_TTL);
  if (room.cleanupTimer.unref) room.cleanupTimer.unref();
}
function createRoom(code) {
  return {
    code, chess: new Chess(), players: { w: null, b: null }, started: false,
    lastMove: null, redoStack: [], cleanupTimer: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
}
function getRole(room, id) {
  if (room.players.w === id) return 'w';
  if (room.players.b === id) return 'b';
  return null;
}
function getStatus(room) {
  const chess = room.chess;
  if (!room.started) {
    if (!room.players.w) return { state: 'waiting', message: 'Waiting for White player...' };
    if (!room.players.b) return { state: 'waiting', message: 'Waiting for Black player...' };
    return { state: 'waiting', message: 'Waiting for players...' };
  }
  if (chess.isCheckmate()) return { state: 'checkmate', winner: chess.turn() === 'w' ? 'b' : 'w', message: (chess.turn() === 'w' ? 'Black' : 'White') + ' wins by checkmate!' };
  if (chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial() || chess.isDraw()) return { state: 'draw', message: 'The game is a draw!' };
  return { state: 'playing', message: chess.isCheck() ? (chess.turn() === 'w' ? 'White' : 'Black') + ' king is in check!' : (chess.turn() === 'w' ? 'White' : 'Black') + "'s turn" };
}
function roomList() {
  return Array.from(rooms.values()).map(room => ({
    code: room.code, white: !!room.players.w, black: !!room.players.b,
    started: room.started, status: getStatus(room).state,
    turn: room.started ? (room.chess.turn() === 'w' ? 'White' : 'Black') : '—',
    moves: room.chess.history().length, createdAt: room.createdAt
  })).sort((a, b) => a.code.localeCompare(b.code));
}
function broadcastRoomList() { io.emit('roomListUpdate', roomList()); }
function snapshot(room) {
  const chess = room.chess;
  return {
    roomCode: room.code, started: room.started, board: chess.board(),
    turn: chess.turn(), fen: chess.fen(), check: chess.isCheck(),
    checkmate: chess.isCheckmate(), draw: chess.isDraw(), lastMove: room.lastMove,
    players: { white: !!room.players.w, black: !!room.players.b },
    status: getStatus(room), history: chess.history(),
    canUndo: chess.history().length > 0, canRedo: room.redoStack.length > 0
  };
}
function sendState(room) { io.to(room.code).emit('gameState', snapshot(room)); }
function updateLastMove(room) {
  const history = room.chess.history({ verbose: true });
  const move = history.length ? history[history.length - 1] : null;
  room.lastMove = move ? {
    from: move.from, to: move.to, san: move.san, color: move.color,
    piece: move.piece, captured: move.captured || null
  } : null;
}
function isConsole(socket) { return consoleSockets.has(socket.id); }
function selectedConsoleRoom(socket) { return rooms.get(socket.data.selectedRoomCode || '') || null; }
function emitSettings() { io.emit('uiSettings', uiSettings); }
function safeString(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.post('/api/create-room', roomApiLimit, (req, res) => {
  const code = safeString(req.body && req.body.code, 3);
  if (!validCode(code)) return res.status(400).json({ ok: false, message: 'Please enter exactly 3 digits.' });
  if (rooms.has(code)) return res.status(409).json({ ok: false, message: 'This room code is already in use. Choose another 3-digit code.' });
  if (rooms.size >= MAX_ROOMS) return res.status(503).json({ ok: false, message: 'The server is currently full. Please try again later.' });
  const room = createRoom(code);
  rooms.set(code, room);
  scheduleRoomCleanup(room);
  broadcastRoomList();
  return res.status(201).json({ ok: true, code });
});
app.post('/api/join-room', roomApiLimit, (req, res) => {
  const code = safeString(req.body && req.body.code, 3);
  if (!validCode(code)) return res.status(400).json({ ok: false, message: 'Enter a valid 3-digit room code.' });
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ ok: false, message: 'Room not found. The code is incorrect or the room has expired.' });
  if (room.players.w && room.players.b) return res.status(409).json({ ok: false, message: 'This room already has two players.' });
  return res.json({ ok: true, code });
});

io.on('connection', socket => {
  socket.emit('uiSettings', uiSettings);
  const code = safeString(socket.handshake.query.room, 3);
  const room = validCode(code) ? rooms.get(code) : null;

  socket.on('consoleAuth', data => {
    const key = process.env.CONSOLE_KEY;
    if (!key) return socket.emit('consoleAuthResult', { ok: false, message: 'Set CONSOLE_KEY in Render environment variables.' });
    if (!data || !timingSafeStringEqual(data.key || '', key)) return socket.emit('consoleAuthResult', { ok: false, message: 'Invalid console key.' });
    consoleSockets.add(socket.id);
    socket.emit('consoleAuthResult', { ok: true, message: 'Console unlocked. Select any room to manage.' });
    socket.emit('uiSettings', uiSettings);
    socket.emit('roomListUpdate', roomList());
  });

  socket.on('consoleSelectRoom', data => {
    if (!isConsole(socket)) return;
    const nextCode = safeString(data && data.code, 3);
    const previous = socket.data.selectedRoomCode;
    if (previous) socket.leave(previous);
    socket.data.selectedRoomCode = null;
    const selected = validCode(nextCode) ? rooms.get(nextCode) : null;
    if (!selected) return socket.emit('consoleSelectedRoom', { ok: false, message: 'Room not found or expired.' });
    socket.data.selectedRoomCode = nextCode;
    socket.join(nextCode);
    socket.emit('consoleSelectedRoom', { ok: true, code: nextCode, message: 'Managing room ' + nextCode });
    socket.emit('gameState', snapshot(selected));
  });

  socket.on('refreshRoomList', () => {
    if (isConsole(socket)) socket.emit('roomListUpdate', roomList());
  });
  socket.on('setUiSettings', data => {
    if (!isConsole(socket) || !data || typeof data !== 'object') return;
    const styles = ['classic', 'modern', 'mono', 'modern-split'];
    uiSettings = {
      boardStyle: styles.includes(data.boardStyle) ? data.boardStyle : 'classic',
      moveAnimation: data.moveAnimation !== false,
      spinAnimation: data.spinAnimation === true,
      captureFx: data.captureFx === true
    };
    emitSettings();
  });

  socket.on('joinGame', joinData => {
    if (!room || rooms.get(code) !== room) return socket.emit('joinRejected', { message: 'Room not found or expired. Return to lobby and check the 3-digit code.' });
    let role = getRole(room, socket.id);
    if (!role) {
      if (!room.players.w) { room.players.w = socket.id; role = 'w'; }
      else if (!room.players.b) { room.players.b = socket.id; role = 'b'; }
      else return socket.emit('joinRejected', { message: 'This room is full. Only two players can play.' });
    }
    clearRoomTimer(room);
    socket.join(code);
    socket.data.roomCode = code;
    room.started = !!(room.players.w && room.players.b);
    room.updatedAt = Date.now();
    socket.emit('joined', { role, accepted: true, isAdmin: !!(joinData && joinData.admin === true) });
    sendState(room);
    broadcastRoomList();
  });

  socket.on('getLegalMoves', data => {
    if (!room || !data) return socket.emit('legalMoves', { square: data && data.square, moves: [] });
    const role = getRole(room, socket.id);
    const chess = room.chess;
    if (!role || !room.started || chess.turn() !== role) return socket.emit('legalMoves', { square: data.square, moves: [] });
    try {
      const square = safeString(data.square, 2);
      const piece = chess.get(square);
      if (!piece || piece.color !== role) return socket.emit('legalMoves', { square, moves: [] });
      socket.emit('legalMoves', { square, moves: chess.moves({ square, verbose: true }).map(move => ({
        from: move.from, to: move.to, san: move.san, flags: move.flags,
        promotion: move.promotion || null, captured: move.captured || null
      })) });
    } catch (error) { socket.emit('legalMoves', { square: data.square, moves: [] }); }
  });

  socket.on('makeMove', data => {
    if (!room || rooms.get(code) !== room || !data) return socket.emit('moveError', 'Room is not available.');
    const role = getRole(room, socket.id);
    const chess = room.chess;
    if (!role || !room.started) return socket.emit('moveError', 'Game is not ready.');
    if (chess.isGameOver()) return socket.emit('moveError', 'The game is already over.');
    if (chess.turn() !== role) return socket.emit('moveError', 'It is not your turn.');
    const from = safeString(data.from, 2), to = safeString(data.to, 2);
    const promotion = ['q', 'r', 'b', 'n'].includes(data.promotion) ? data.promotion : 'q';
    try {
      const move = chess.move({ from, to, promotion });
      if (!move) return socket.emit('moveError', 'Invalid chess move.');
      room.lastMove = { from: move.from, to: move.to, san: move.san, color: move.color, piece: move.piece, captured: move.captured || null };
      room.redoStack = [];
      room.updatedAt = Date.now();
      sendState(room);
      broadcastRoomList();
    } catch (error) { socket.emit('moveError', 'Invalid chess move.'); }
  });

  socket.on('newGame', () => {
    if (!room || !getRole(room, socket.id) || !room.started || !room.chess.isGameOver()) return;
    room.chess.reset(); room.lastMove = null; room.redoStack = []; room.updatedAt = Date.now();
    sendState(room); broadcastRoomList();
  });

  socket.on('consoleUndo', () => {
    const target = selectedConsoleRoom(socket);
    if (!isConsole(socket) || !target) return;
    const move = target.chess.undo();
    if (!move) return socket.emit('consoleActionResult', { ok: false, message: 'There are no moves to undo.' });
    target.redoStack.push({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    updateLastMove(target); target.updatedAt = Date.now();
    sendState(target); broadcastRoomList();
    socket.emit('consoleActionResult', { ok: true, message: 'Last move undone.' });
  });
  socket.on('consoleRedo', () => {
    const target = selectedConsoleRoom(socket);
    if (!isConsole(socket) || !target) return;
    const move = target.redoStack.pop();
    if (!move) return socket.emit('consoleActionResult', { ok: false, message: 'There are no moves to redo.' });
    try {
      target.chess.move(move); updateLastMove(target); target.updatedAt = Date.now();
      sendState(target); broadcastRoomList();
      socket.emit('consoleActionResult', { ok: true, message: 'Move restored.' });
    } catch (error) {
      target.redoStack.push(move);
      socket.emit('consoleActionResult', { ok: false, message: 'Redo failed.' });
    }
  });

  socket.on('disconnect', reason => {
    consoleSockets.delete(socket.id);
    if (!room || rooms.get(code) !== room) return;
    const role = getRole(room, socket.id);
    if (role) {
      room.players[role] = null;
      room.started = false;
      room.updatedAt = Date.now();
      sendState(room);
      scheduleRoomCleanup(room);
      broadcastRoomList();
      console.log('[player] disconnected', role === 'w' ? 'White' : 'Black', 'from room', code, '(' + reason + ')');
    }
  });
});

app.use((err, req, res, next) => {
  console.error('[http] request error:', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  const status = err && err.status === 413 ? 413 : 400;
  res.status(status).json({ ok: false, message: status === 413 ? 'Request is too large.' : 'Invalid request.' });
});

server.on('error', error => {
  console.error('[server] fatal server error:', error);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => console.log('[server] Chess Arena listening on ' + HOST + ':' + PORT));

function gracefulShutdown(signal) {
  console.log('[server] ' + signal + ' received; closing gracefully');
  for (const room of rooms.values()) clearRoomTimer(room);
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
