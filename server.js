const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const ROOM_TTL = 10 * 60 * 1000;
let consoleSocketId = null;
let uiSettings = { boardStyle: 'classic', moveAnimation: true, spinAnimation: false, captureFx: false };

app.use(express.json());
app.use(express.static(__dirname, { index: false }));
const stockfishAssetDir = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
app.use('/stockfish', express.static(stockfishAssetDir, { maxAge: '1d', fallthrough: false, setHeaders: function(res, filePath) { if (filePath.endsWith('.wasm')) res.setHeader('Content-Type','application/wasm'); else if (filePath.endsWith('.js')) res.setHeader('Content-Type','text/javascript; charset=utf-8'); } }));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'lobby.html')));
app.get('/create', (req,res) => res.sendFile(path.join(__dirname,'create.html')));
app.get('/join', (req,res) => res.sendFile(path.join(__dirname,'join.html')));
app.get('/Admin.html', (req,res) => res.sendFile(path.join(__dirname,'Admin.html')));

function validCode(code) { return typeof code === 'string' && /^\d{3}$/.test(code); }
function clearRoomTimer(room) { if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; } }
function scheduleRoomCleanup(room) {
  clearRoomTimer(room);
  if (hasWhite(room) || hasBlack(room)) return;
  room.cleanupTimer = setTimeout(() => { if (!hasWhite(room) && !hasBlack(room) && rooms.get(room.code) === room) { rooms.delete(room.code); broadcastRoomList(); console.log('Expired empty room:', room.code); } }, ROOM_TTL);
  if (room.cleanupTimer.unref) room.cleanupTimer.unref();
}
function createRoom(code) {
  return { code, chess: new Chess(), players: { w: null, b: null }, httpPlayers: { w: null, b: null }, started: false, lastMove: null, redoStack: [], cleanupTimer: null, createdAt: Date.now() };
}

function getHttpRole(room, token) { if (!room || !token) return null; if (room.httpPlayers.w === token) return 'w'; if (room.httpPlayers.b === token) return 'b'; return null; }
function hasWhite(room) { return !!(room.players.w || room.httpPlayers.w); }
function hasBlack(room) { return !!(room.players.b || room.httpPlayers.b); }
function updateStarted(room) { room.started = hasWhite(room) && hasBlack(room); }
function mobileState(room, role) { var s=snapshot(room); s.role=role; return s; }
app.post('/api/mobile/join', (req,res) => {
 const code=String(req.body&&req.body.code||''); const token=String(req.body&&req.body.token||'');
 if(!validCode(code)||token.length<20) return res.status(400).json({ok:false,message:'Invalid room or session.'});
 const room=rooms.get(code); if(!room) return res.status(404).json({ok:false,message:'Room not found.'});
 let role=getHttpRole(room,token);
 if(!role) { if(!hasWhite(room)) { room.httpPlayers.w=token; role='w'; } else if(!hasBlack(room)) { room.httpPlayers.b=token; role='b'; } else return res.status(409).json({ok:false,message:'This room already has two players.'}); }
 clearRoomTimer(room); updateStarted(room); sendState(room); broadcastRoomList(); res.json({ok:true,role,state:mobileState(room,role)});
});
app.get('/api/mobile/state', (req,res) => {
 const code=String(req.query.code||''); const token=String(req.query.token||''); const room=rooms.get(code); if(!room) return res.status(404).json({ok:false,message:'Room not found.'});
 const role=getHttpRole(room,token); if(!role) return res.status(403).json({ok:false,message:'Session not joined.'}); res.json({ok:true,state:mobileState(room,role)});
});
app.post('/api/mobile/legal-moves', (req,res) => {
 const code=String(req.body&&req.body.code||''), token=String(req.body&&req.body.token||''), square=String(req.body&&req.body.square||''); const room=rooms.get(code); if(!room) return res.status(404).json({ok:false,message:'Room not found.'});
 const role=getHttpRole(room,token); if(!role||!room.started||room.chess.turn()!==role) return res.json({ok:true,square,moves:[]});
 try { const p=room.chess.get(square); if(!p||p.color!==role) return res.json({ok:true,square,moves:[]}); return res.json({ok:true,square,moves:room.chess.moves({square,verbose:true}).map(m=>({from:m.from,to:m.to,san:m.san}))}); } catch(e) { return res.json({ok:true,square,moves:[]}); }
});
app.post('/api/mobile/move', (req,res) => {
 const code=String(req.body&&req.body.code||''), token=String(req.body&&req.body.token||''); const room=rooms.get(code); if(!room) return res.status(404).json({ok:false,message:'Room not found.'});
 const role=getHttpRole(room,token); if(!role||!room.started) return res.status(403).json({ok:false,message:'Game is not ready.'}); if(room.chess.turn()!==role) return res.status(409).json({ok:false,message:'It is not your turn.'});
 try { const m=room.chess.move({from:String(req.body.from||''),to:String(req.body.to||''),promotion:req.body.promotion||'q'}); if(!m) return res.status(400).json({ok:false,message:'Invalid move.'}); room.lastMove={from:m.from,to:m.to,san:m.san,color:m.color,piece:m.piece,captured:m.captured||null}; room.redoStack=[]; sendState(room); broadcastRoomList(); return res.json({ok:true,state:mobileState(room,role)}); } catch(e) { return res.status(400).json({ok:false,message:'Invalid move.'}); }
});
app.post('/api/mobile/new-game', (req,res) => { const code=String(req.body&&req.body.code||''), token=String(req.body&&req.body.token||''); const room=rooms.get(code); if(!room) return res.status(404).json({ok:false,message:'Room not found.'}); const role=getHttpRole(room,token); if(!role||!room.started||!room.chess.isGameOver()) return res.status(409).json({ok:false,message:'New game is available after the current game ends.'}); room.chess.reset(); room.lastMove=null; room.redoStack=[]; sendState(room); return res.json({ok:true,state:mobileState(room,role)}); });

app.post('/api/create-room', (req,res) => {
  const code = String(req.body && req.body.code || '');
  if (!validCode(code)) return res.status(400).json({ ok:false, message:'Please enter exactly 3 digits.' });
  if (rooms.has(code)) return res.status(409).json({ ok:false, message:'This room code is already in use. Choose another 3-digit code.' });
  const room = createRoom(code); rooms.set(code, room);
  scheduleRoomCleanup(room);
  broadcastRoomList();
  res.json({ ok:true, code });
});
app.post('/api/join-room', (req,res) => {
  const code = String(req.body && req.body.code || '');
  if (!validCode(code)) return res.status(400).json({ ok:false, message:'Enter a valid 3-digit room code.' });
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ ok:false, message:'Room not found. The code is incorrect or the room has expired.' });
  if (hasWhite(room) && hasBlack(room)) return res.status(409).json({ ok:false, message:'This room already has two players.' });
  res.json({ ok:true, code });
});

function getRole(room, id) { if (room.players.w === id) return 'w'; if (room.players.b === id) return 'b'; return null; }
function getStatus(room) {
 const chess=room.chess;
 if (!room.started) return { state:'waiting', message: !hasWhite(room) ? 'Waiting for White player...' : (!hasBlack(room) ? 'Waiting for Black player...' : 'Waiting for players...') };
 if (chess.isCheckmate()) return { state:'checkmate', winner:chess.turn()==='w'?'b':'w', message:(chess.turn()==='w'?'Black':'White')+' wins by checkmate!' };
 if (chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial() || chess.isDraw()) return { state:'draw', message:'The game is a draw!' };
 return { state:'playing', message:chess.isCheck()?(chess.turn()==='w'?'White':'Black')+' king is in check!':(chess.turn()==='w'?'White':'Black')+"'s turn" };
}
function roomList() { return Array.from(rooms.values()).map(r => ({code:r.code, white:hasWhite(r), black:hasBlack(r), started:r.started, status:getStatus(r).state, turn:r.started?(r.chess.turn()==='w'?'White':'Black'):'—', moves:r.chess.history().length})).sort((a,b)=>a.code.localeCompare(b.code)); }
function broadcastRoomList() { io.emit('roomListUpdate', roomList()); }
function snapshot(room) {
 const chess=room.chess;
 return { roomCode:room.code, started:room.started, board:chess.board(), turn:chess.turn(), fen:chess.fen(), check:chess.isCheck(), checkmate:chess.isCheckmate(), draw:chess.isDraw(), lastMove:room.lastMove, players:{white:hasWhite(room),black:hasBlack(room)}, status:getStatus(room), history:chess.history(), canUndo:chess.history().length>0, canRedo:room.redoStack.length>0 };
}
function sendState(room) { io.to(room.code).emit('gameState', snapshot(room)); }
function updateLastMove(room) {
 const h=room.chess.history({verbose:true}); const m=h.length?h[h.length-1]:null;
 room.lastMove=m?{from:m.from,to:m.to,san:m.san,color:m.color,piece:m.piece,captured:m.captured||null}:null;
}
function isConsole(socket) { return !!consoleSocketId && socket.id===consoleSocketId; }
function selectedConsoleRoom(socket) { return rooms.get(socket.data.selectedRoomCode || '') || null; }
function emitSettings() { io.emit('uiSettings',uiSettings); }

io.on('connection', socket => {
 socket.emit('uiSettings',uiSettings);
 const code=String(socket.handshake.query.room||'');
 const room=validCode(code)?rooms.get(code):null;
 socket.on('consoleAuth', data => {
   const key=process.env.CONSOLE_KEY;
   if (!key) return socket.emit('consoleAuthResult',{ok:false,message:'Set CONSOLE_KEY in Render environment variables.'});
   if (!data || data.key!==key) return socket.emit('consoleAuthResult',{ok:false,message:'Invalid console key.'});
   consoleSocketId=socket.id;
   socket.emit('consoleAuthResult',{ok:true,message:'Console unlocked. Select any room to manage.'});
   socket.emit('uiSettings',uiSettings); socket.emit('roomListUpdate',roomList());
 });
 socket.on('consoleSelectRoom', data => {
   if (!isConsole(socket)) return;
   var nextCode=String(data&&data.code||'');
   if (socket.data.selectedRoomCode) socket.leave(socket.data.selectedRoomCode);
   socket.data.selectedRoomCode=null;
   var selected=validCode(nextCode)?rooms.get(nextCode):null;
   if (!selected) { socket.emit('consoleSelectedRoom',{ok:false,message:'Room not found or expired.'}); return; }
   socket.data.selectedRoomCode=nextCode; socket.join(nextCode);
   socket.emit('consoleSelectedRoom',{ok:true,code:nextCode,message:'Managing room '+nextCode});
   socket.emit('gameState',snapshot(selected));
 });
 socket.on('refreshRoomList',()=>{ if(isConsole(socket)) socket.emit('roomListUpdate',roomList()); });
 socket.on('setUiSettings', data => {
   if (!isConsole(socket)||!data) return;
   const styles=['classic','modern','mono','modern-split'];
   uiSettings={boardStyle:styles.includes(data.boardStyle)?data.boardStyle:'classic',moveAnimation:data.moveAnimation!==false,spinAnimation:data.spinAnimation===true,captureFx:data.captureFx===true}; emitSettings();
 });
 socket.on('joinGame', joinData => {
   if (!room) return socket.emit('joinRejected',{message:'Room not found or expired. Return to lobby and check the 3-digit code.'});
   let role=getRole(room,socket.id);
   if (!role) {
     if (!hasWhite(room)) { room.players.w=socket.id; role='w'; }
     else if (!hasBlack(room)) { room.players.b=socket.id; role='b'; }
     else return socket.emit('joinRejected',{message:'This room is full. Only two players can play.'});
   }
   clearRoomTimer(room); socket.join(code); socket.data.roomCode=code;
   updateStarted(room);
   socket.emit('joined',{role,accepted:true,isAdmin:!!(joinData&&joinData.admin===true)});
   sendState(room); broadcastRoomList();
 });
 socket.on('getLegalMoves', data => {
   if (!room||!data) return socket.emit('legalMoves',{square:data&&data.square,moves:[]});
   const role=getRole(room,socket.id), chess=room.chess;
   if (!role||!room.started||chess.turn()!==role) return socket.emit('legalMoves',{square:data.square,moves:[]});
   try { const p=chess.get(data.square); if(!p||p.color!==role) return socket.emit('legalMoves',{square:data.square,moves:[]});
     socket.emit('legalMoves',{square:data.square,moves:chess.moves({square:data.square,verbose:true}).map(m=>({from:m.from,to:m.to,san:m.san,flags:m.flags,promotion:m.promotion||null,captured:m.captured||null}))});
   } catch(e) { socket.emit('legalMoves',{square:data.square,moves:[]}); }
 });
 socket.on('makeMove', data => {
   if(!room||!data) return socket.emit('moveError','Room is not available.');
   const role=getRole(room,socket.id), chess=room.chess;
   if(!role||!room.started) return socket.emit('moveError','Game is not ready.');
   if(chess.isGameOver()) return socket.emit('moveError','The game is already over.');
   if(chess.turn()!==role) return socket.emit('moveError','It is not your turn.');
   try { const m=chess.move({from:data.from,to:data.to,promotion:data.promotion||'q'}); if(!m)return socket.emit('moveError','Invalid chess move.');
     room.lastMove={from:m.from,to:m.to,san:m.san,color:m.color,piece:m.piece,captured:m.captured||null}; room.redoStack=[]; sendState(room); broadcastRoomList();
   } catch(e) { socket.emit('moveError','Invalid chess move.'); }
 });
 socket.on('newGame',()=>{ if(!room||!getRole(room,socket.id)||!room.started||!room.chess.isGameOver())return; room.chess.reset();room.lastMove=null;room.redoStack=[];sendState(room); });
 socket.on('consoleUndo',()=>{ const target=selectedConsoleRoom(socket); if(!isConsole(socket)||!target)return;const m=target.chess.undo();if(!m)return socket.emit('consoleActionResult',{ok:false,message:'There are no moves to undo.'});target.redoStack.push({from:m.from,to:m.to,promotion:m.promotion||'q'});updateLastMove(target);sendState(target);socket.emit('consoleActionResult',{ok:true,message:'Last move undone.'}); });
 socket.on('consoleRedo',()=>{const target=selectedConsoleRoom(socket);if(!isConsole(socket)||!target)return;const m=target.redoStack.pop();if(!m)return socket.emit('consoleActionResult',{ok:false,message:'There are no moves to redo.'});try{target.chess.move(m);updateLastMove(target);sendState(target);socket.emit('consoleActionResult',{ok:true,message:'Move restored.'});}catch(e){target.redoStack.push(m);socket.emit('consoleActionResult',{ok:false,message:'Redo failed.'});}});
 socket.on('disconnect',()=>{
   if(socket.id===consoleSocketId)consoleSocketId=null;
   if(!room)return;
   const role=getRole(room,socket.id);
   if(role){room.players[role]=null;updateStarted(room);sendState(room);if(!hasWhite(room)&&!hasBlack(room))scheduleRoomCleanup(room);broadcastRoomList();}
 });
});
server.listen(PORT,'0.0.0.0',()=>console.log('Chess Arena server running on port '+PORT));
