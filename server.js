const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword";
const rooms = new Map();
const adminTokens = new Set();

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/State.html", function (req, res) {
  res.sendFile(path.join(__dirname, "State.html"));
});

app.get("/cheat.html", function (req, res) {
  res.sendFile(path.join(__dirname, "cheat.html"));
});

function cleanRoomId(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 3);
}

function roomSummary(room) {
  return {
    id: room.id,
    white: !!room.players.w,
    black: !!room.players.b,
    status: !room.started ? "Waiting" : room.game.isGameOver() ? "Finished" : "Playing",
    moves: room.game.history().length,
    turn: room.game.turn(),
    check: room.game.isCheck(),
    createdAt: room.createdAt
  };
}

function getSnapshot(room) {
  return {
    roomId: room.id,
    started: room.started,
    board: room.game.board(),
    fen: room.game.fen(),
    turn: room.game.turn(),
    check: room.game.isCheck(),
    checkmate: room.game.isCheckmate(),
    draw: room.game.isDraw(),
    lastMove: room.lastMove,
    players: { white: !!room.players.w, black: !!room.players.b },
    status: getStatus(room)
  };
}

function getStatus(room) {
  const game = room.game;
  if (!room.started) {
    return {
      state: "waiting",
      message: room.players.w || room.players.b
        ? "Waiting for the second player..."
        : "Waiting for players..."
    };
  }
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "b" : "w";
    return {
      state: "checkmate",
      winner,
      message: (winner === "w" ? "White" : "Black") + " wins by checkmate!"
    };
  }
  if (game.isStalemate()) return { state: "draw", message: "Draw by stalemate!" };
  if (game.isThreefoldRepetition()) return { state: "draw", message: "Draw by threefold repetition!" };
  if (game.isInsufficientMaterial()) return { state: "draw", message: "Draw: insufficient material!" };
  if (game.isDraw()) return { state: "draw", message: "The game is a draw!" };
  return {
    state: "playing",
    message: game.isCheck()
      ? (game.turn() === "w" ? "White" : "Black") + " king is in check!"
      : (game.turn() === "w" ? "White" : "Black") + "'s turn"
  };
}

function emitRoomState(room) {
  io.to(room.id).emit("gameState", getSnapshot(room));
  io.to("admin-room-feed").emit("roomsChanged", getRoomList());
}

function getRoomList() {
  return Array.from(rooms.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(roomSummary);
}

function assignRole(room, socket) {
  if (room.players.w === socket.id) return "w";
  if (room.players.b === socket.id) return "b";
  if (!room.players.w) {
    room.players.w = socket.id;
    socket.data.chessRoom = room.id;
    socket.data.chessRole = "w";
    return "w";
  }
  if (!room.players.b) {
    room.players.b = socket.id;
    socket.data.chessRoom = room.id;
    socket.data.chessRole = "b";
    return "b";
  }
  return null;
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.chessRoom;
  const role = socket.data.chessRole;
  if (!roomId || !role) return;
  const room = rooms.get(roomId);
  if (room && room.players[role] === socket.id) {
    room.players[role] = null;
    room.started = false;
    emitRoomState(room);
  }
  socket.leave(roomId);
  delete socket.data.chessRoom;
  delete socket.data.chessRole;
}

function evaluate(game, perspective) {
  if (game.isCheckmate()) return game.turn() === perspective ? -100000 : 100000;
  if (game.isDraw()) return 0;

  const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  let score = 0;
  const board = game.board();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const value = values[piece.type] || 0;
      score += piece.color === perspective ? value : -value;
    }
  }

  if (game.isCheck()) score += game.turn() === perspective ? -35 : 35;
  return score;
}

function minimax(game, depth, alpha, beta, perspective) {
  if (depth === 0 || game.isGameOver()) return evaluate(game, perspective);

  const moves = game.moves({ verbose: true });
  if (game.turn() === perspective) {
    let best = -Infinity;
    for (const move of moves) {
      game.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
      const score = minimax(game, depth - 1, alpha, beta, perspective);
      game.undo();
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    game.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
    const score = minimax(game, depth - 1, alpha, beta, perspective);
    game.undo();
    if (score < best) best = score;
    if (best < beta) beta = best;
    if (beta <= alpha) break;
  }
  return best;
}

function suggestBestMove(room, role) {
  if (!room.started || room.game.isGameOver() || room.game.turn() !== role) {
    return null;
  }
  const moves = room.game.moves({ verbose: true });
  if (!moves.length) return null;

  let bestMove = null;
  let bestScore = -Infinity;
  const perspective = role;

  for (const move of moves) {
    room.game.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
    const score = minimax(room.game, 2, -Infinity, Infinity, perspective);
    room.game.undo();

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  if (!bestMove) return null;
  return {
    from: bestMove.from,
    to: bestMove.to,
    san: bestMove.san,
    promotion: bestMove.promotion || null,
    score: bestScore
  };
}

io.on("connection", function (socket) {
  socket.on("createRoom", function (callback) {
    leaveCurrentRoom(socket);

    let id;
    let attempts = 0;
    do {
      id = String(100 + Math.floor(Math.random() * 900));
      attempts++;
    } while (rooms.has(id) && attempts < 1000);

    if (rooms.has(id)) {
      if (typeof callback === "function") callback({ ok: false, message: "Could not create a room. Try again." });
      return;
    }

    const room = {
      id,
      game: new Chess(),
      players: { w: null, b: null },
      started: false,
      lastMove: null,
      createdAt: Date.now()
    };
    rooms.set(id, room);

    const role = assignRole(room, socket);
    socket.join(id);
    if (typeof callback === "function") callback({ ok: true, roomId: id, role });
    emitRoomState(room);
  });

  socket.on("joinRoom", function (data, callback) {
    leaveCurrentRoom(socket);
    const id = cleanRoomId(data && data.roomId);
    const room = rooms.get(id);

    if (!/^\d{3}$/.test(id) || !room) {
      if (typeof callback === "function") callback({ ok: false, message: "Room not found. Check the 3-digit code." });
      return;
    }

    if (room.players.w && room.players.b) {
      if (typeof callback === "function") callback({ ok: false, message: "This room already has two players." });
      return;
    }

    const role = assignRole(room, socket);
    if (!role) {
      if (typeof callback === "function") callback({ ok: false, message: "This room is full." });
      return;
    }

    socket.join(id);
    room.started = !!(room.players.w && room.players.b);
    if (typeof callback === "function") callback({ ok: true, roomId: id, role });
    emitRoomState(room);
  });

  socket.on("getLegalMoves", function (data) {
    const room = rooms.get(socket.data.chessRoom);
    const role = socket.data.chessRole;
    const square = data && data.square;

    if (!room || !role || !room.started || room.game.turn() !== role || !square) {
      socket.emit("legalMoves", { square: square || null, moves: [] });
      return;
    }

    try {
      const piece = room.game.get(square);
      if (!piece || piece.color !== role) {
        socket.emit("legalMoves", { square, moves: [] });
        return;
      }
      const moves = room.game.moves({ square, verbose: true }).map(function (move) {
        return {
          from: move.from,
          to: move.to,
          san: move.san,
          flags: move.flags,
          promotion: move.promotion || null,
          captured: move.captured || null
        };
      });
      socket.emit("legalMoves", { square, moves });
    } catch (e) {
      socket.emit("legalMoves", { square: square || null, moves: [] });
    }
  });

  socket.on("makeMove", function (data) {
    const room = rooms.get(socket.data.chessRoom);
    const role = socket.data.chessRole;

    if (!room || !role || !room.started || !data || room.game.isGameOver()) {
      socket.emit("moveError", "The game is not ready.");
      return;
    }
    if (room.game.turn() !== role) {
      socket.emit("moveError", "It is not your turn.");
      return;
    }

    try {
      const move = room.game.move({
        from: data.from,
        to: data.to,
        promotion: data.promotion || "q"
      });
      if (!move) {
        socket.emit("moveError", "Invalid chess move.");
        return;
      }

      room.lastMove = {
        from: move.from,
        to: move.to,
        san: move.san,
        color: move.color,
        captured: move.captured || null
      };
      emitRoomState(room);
    } catch (e) {
      socket.emit("moveError", "Invalid chess move.");
    }
  });

  socket.on("suggestMove", function () {
    const room = rooms.get(socket.data.chessRoom);
    const role = socket.data.chessRole;
    if (!room || !role) {
      socket.emit("moveSuggestion", { ok: false, message: "Join a room first." });
      return;
    }
    if (!room.started || room.game.isGameOver()) {
      socket.emit("moveSuggestion", { ok: false, message: "The game is not currently active." });
      return;
    }
    if (room.game.turn() !== role) {
      socket.emit("moveSuggestion", { ok: false, message: "Wait for your turn before asking for a suggestion." });
      return;
    }

    // The result is sent only to the requesting socket, not the opponent or room.
    const suggestion = suggestBestMove(room, role);
    if (!suggestion) {
      socket.emit("moveSuggestion", { ok: false, message: "No legal move found." });
      return;
    }
    socket.emit("moveSuggestion", { ok: true, move: suggestion });
  });

  socket.on("newGame", function () {
    const room = rooms.get(socket.data.chessRoom);
    const role = socket.data.chessRole;
    if (!room || !role || !room.started || !room.game.isGameOver()) return;

    room.game.reset();
    room.lastMove = null;
    emitRoomState(room);
  });

  socket.on("disconnect", function () {
    leaveCurrentRoom(socket);
  });
});

// Admin endpoints: password is checked on the server. Set ADMIN_PASSWORD in Render.
app.post("/api/admin/login", function (req, res) {
  const password = String((req.body && req.body.password) || "");
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Incorrect admin password." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);
  res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, message: "Admin login required." });
  }
  next();
}

app.get("/api/admin/rooms", requireAdmin, function (req, res) {
  res.json({ ok: true, rooms: getRoomList() });
});

app.post("/api/admin/terminate", requireAdmin, function (req, res) {
  const id = cleanRoomId(req.body && req.body.roomId);
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ ok: false, message: "Room not found." });

  io.to(id).emit("roomTerminated", { message: "The admin terminated this room." });
  for (const role of ["w", "b"]) {
    const socketId = room.players[role];
    if (socketId) {
      const playerSocket = io.sockets.sockets.get(socketId);
      if (playerSocket) {
        playerSocket.leave(id);
        delete playerSocket.data.chessRoom;
        delete playerSocket.data.chessRole;
      }
    }
  }
  rooms.delete(id);
  io.to("admin-room-feed").emit("roomsChanged", getRoomList());
  res.json({ ok: true, message: "Room " + id + " terminated." });
});

io.on("connection", function (socket) {
  socket.on("adminSubscribe", function () {
    socket.join("admin-room-feed");
  });
});

server.listen(PORT, "0.0.0.0", function () {
  console.log("Multiplayer chess server running on port " + PORT);
});
