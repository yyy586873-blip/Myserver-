const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", function (req, res) {
    res.sendFile(path.join(__dirname, "index.html"));
});

const chess = new Chess();

const players = {
    w: null,
    b: null
};

let started = false;
let lastMove = null;
let adminSocketId = null;

function getRole(socketId) {
    if (players.w === socketId) return "w";
    if (players.b === socketId) return "b";
    return null;
}

function getGameStatus() {
    if (!started) {
        return {
            state: "waiting",
            message: players.w
                ? "Waiting for Black player..."
                : "Waiting for players..."
        };
    }

    if (chess.isCheckmate()) {
        return {
            state: "checkmate",
            winner: chess.turn() === "w" ? "b" : "w",
            message:
                (chess.turn() === "w" ? "Black" : "White") +
                " wins by checkmate!"
        };
    }

    if (chess.isStalemate()) {
        return {
            state: "draw",
            message: "Draw by stalemate!"
        };
    }

    if (chess.isThreefoldRepetition()) {
        return {
            state: "draw",
            message: "Draw by threefold repetition!"
        };
    }

    if (chess.isInsufficientMaterial()) {
        return {
            state: "draw",
            message: "Draw: insufficient material!"
        };
    }

    if (chess.isDraw()) {
        return {
            state: "draw",
            message: "The game is a draw!"
        };
    }

    return {
        state: "playing",
        message: chess.isCheck()
            ? (chess.turn() === "w" ? "White" : "Black") +
              " king is in check!"
            : (chess.turn() === "w" ? "White" : "Black") +
              "'s turn"
    };
}

function getSnapshot() {
    return {
        started: started,
        board: chess.board(),
        turn: chess.turn(),
        fen: chess.fen(),
        check: chess.isCheck(),
        checkmate: chess.isCheckmate(),
        draw: chess.isDraw(),
        lastMove: lastMove,
        players: {
            white: !!players.w,
            black: !!players.b
        },
        status: getGameStatus()
    };
}

function sendState() {
    io.emit("gameState", getSnapshot());
}

function startIfReady() {
    if (players.w && players.b) {
        started = true;
    } else {
        started = false;
    }
}

const PIECE_VALUES = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 };
const MATE_SCORE = 100000;

function evaluatePosition(position, perspective, ply) {
    if (position.isCheckmate()) {
        // Prefer delivering mate sooner and delaying a forced mate against us.
        return position.turn() === perspective
            ? -MATE_SCORE + ply
            : MATE_SCORE - ply;
    }
    if (position.isDraw()) return 0;

    let score = 0;
    const board = position.board();
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = board[row][col];
            if (!piece) continue;
            let value = PIECE_VALUES[piece.type] || 0;
            if (piece.type === "p") {
                const advance = piece.color === "w" ? 6 - row : row - 1;
                value += Math.max(0, advance) * 8;
            }
            // Small central-square bonus for knights, bishops, and queens.
            if (piece.type === "n" || piece.type === "b" || piece.type === "q") {
                const center = 3.5 - (Math.abs(3.5 - row) + Math.abs(3.5 - col)) / 2;
                value += center * (piece.type === "n" ? 9 : 4);
            }
            score += piece.color === perspective ? value : -value;
        }
    }
    if (position.isCheck()) score += position.turn() === perspective ? -45 : 45;
    return score;
}

function orderMoves(moves) {
    return moves.sort(function (a, b) {
        function priority(m) {
            let score = 0;
            if (m.captured) score += 1000 + (PIECE_VALUES[m.captured] || 0) - (PIECE_VALUES[m.piece] || 0) / 10;
            if (m.promotion) score += 800 + (PIECE_VALUES[m.promotion] || 0);
            if (m.san && m.san.indexOf("#") !== -1) score += 100000;
            else if (m.san && m.san.indexOf("+") !== -1) score += 80;
            return score;
        }
        return priority(b) - priority(a);
    });
}

function findBestMove(fen, maxDepth) {
    const position = new Chess(fen);
    const perspective = position.turn();
    const rootMoves = orderMoves(position.moves({ verbose: true }));
    if (!rootMoves.length) return null;

    let bestMove = null;
    let bestScore = -Infinity;

    function search(depth, alpha, beta, ply) {
        if (position.isCheckmate() || position.isDraw()) {
            return evaluatePosition(position, perspective, ply);
        }
        if (depth === 0) {
            return evaluatePosition(position, perspective, ply);
        }

        const moves = orderMoves(position.moves({ verbose: true }));
        if (!moves.length) return evaluatePosition(position, perspective, ply);

        const maximizing = position.turn() === perspective;
        let best = maximizing ? -Infinity : Infinity;
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            position.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
            const score = search(depth - 1, alpha, beta, ply + 1);
            position.undo();

            if (maximizing) {
                if (score > best) best = score;
                if (best > alpha) alpha = best;
            } else {
                if (score < best) best = score;
                if (best < beta) beta = best;
            }
            if (beta <= alpha) break;
        }
        return best;
    }

    // Search deeper than the old 2-ply version, using alpha-beta pruning and
    // tactical move ordering so forced mates and checks are considered first.
    for (let i = 0; i < rootMoves.length; i++) {
        const m = rootMoves[i];
        position.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
        const score = search(maxDepth - 1, -Infinity, Infinity, 1);
        position.undo();
        if (score > bestScore) {
            bestScore = score;
            bestMove = {
                from: m.from,
                to: m.to,
                san: m.san,
                promotion: m.promotion || null,
                score: score,
                forcedMate: score > MATE_SCORE - 20,
                avoidsMate: score < -MATE_SCORE + 20
            };
        }
    }
    return bestMove;
}

io.on("connection", function (socket) {
    console.log("Connected:", socket.id);

    socket.on("joinGame", function (joinData) {
        let role = getRole(socket.id);

        if (role) {
            socket.emit("joined", {
                role: role,
                accepted: true
            });

            sendState();
            return;
        }

        if (!players.w) {
            players.w = socket.id;
            role = "w";
        } else if (!players.b) {
            players.b = socket.id;
            role = "b";
        } else {
            socket.emit("joinRejected", {
                message: "This chess room is full. Only two players can play."
            });
            return;
        }

        if (joinData && joinData.admin === true && !adminSocketId) {
            adminSocketId = socket.id;
        }

        socket.emit("joined", {
            role: role,
            accepted: true,
            isAdmin: socket.id === adminSocketId
        });

        startIfReady();

        console.log("Player joined as:", role);

        sendState();
    });

    socket.on("getLegalMoves", function (data) {
        const role = getRole(socket.id);

        if (!role || !started || !data) {
            socket.emit("legalMoves", {
                square: data ? data.square : null,
                moves: []
            });
            return;
        }

        if (chess.turn() !== role) {
            socket.emit("legalMoves", {
                square: data.square,
                moves: []
            });
            return;
        }

        try {
            const piece = chess.get(data.square);

            if (!piece || piece.color !== role) {
                socket.emit("legalMoves", {
                    square: data.square,
                    moves: []
                });
                return;
            }

            const moves = chess.moves({
                square: data.square,
                verbose: true
            }).map(function (move) {
                return {
                    from: move.from,
                    to: move.to,
                    san: move.san,
                    flags: move.flags,
                    promotion: move.promotion || null,
                    captured: move.captured || null
                };
            });

            socket.emit("legalMoves", {
                square: data.square,
                moves: moves
            });

        } catch (error) {
            socket.emit("legalMoves", {
                square: data.square,
                moves: []
            });
        }
    });

    socket.on("makeMove", function (data) {
        const role = getRole(socket.id);

        if (!role || !started || !data) {
            socket.emit("moveError", "Game is not ready.");
            return;
        }

        if (chess.isGameOver()) {
            socket.emit("moveError", "The game is already over.");
            return;
        }

        if (chess.turn() !== role) {
            socket.emit("moveError", "It is not your turn.");
            return;
        }

        try {
            const move = chess.move({
                from: data.from,
                to: data.to,
                promotion: data.promotion || "q"
            });

            if (!move) {
                socket.emit("moveError", "Invalid chess move.");
                return;
            }

            lastMove = {
                from: move.from,
                to: move.to,
                san: move.san,
                color: move.color
            };

            console.log(
                role === "w" ? "White:" : "Black:",
                move.san
            );

            sendState();

        } catch (error) {
            socket.emit("moveError", "Invalid chess move.");
        }
    });

    socket.on("suggestBestMove", function () {
        const role = getRole(socket.id);
        if (socket.id !== adminSocketId) {
            socket.emit("bestMoveResult", {
                error: "Best-move suggestions are available only from Admin.html."
            });
            return;
        }
        if (!role || !started || chess.isGameOver()) {
            socket.emit("bestMoveResult", {
                error: "The game must be active and you must be one of its players."
            });
            return;
        }
        // Only analyse the Admin page player's own colour, and only on that turn.
        if (chess.turn() !== role) {
            socket.emit("bestMoveResult", {
                error: "Suggestion is available only on your own turn. You are " +
                    (role === "w" ? "White" : "Black") + "."
            });
            return;
        }

        try {
            const currentFen = chess.fen();
            const suggestion = findBestMove(currentFen, 4);
            if (!suggestion) {
                socket.emit("bestMoveResult", { error: "No legal move is available." });
                return;
            }
            socket.emit("bestMoveResult", {
                move: suggestion,
                role: role,
                turn: chess.turn(),
                fen: currentFen
            });
        } catch (error) {
            console.error("Best-move analysis failed:", error);
            socket.emit("bestMoveResult", { error: "Could not analyse this position." });
        }
    });

    socket.on("newGame", function () {
        const role = getRole(socket.id);

        if (!role || !started || !chess.isGameOver()) {
            return;
        }

        chess.reset();
        lastMove = null;

        sendState();
    });

    socket.on("disconnect", function () {
        const role = getRole(socket.id);
        if (socket.id === adminSocketId) adminSocketId = null;

        if (role) {
            players[role] = null;
            started = false;

            console.log("Player disconnected:", role);

            sendState();
        }
    });
});

server.listen(PORT, "0.0.0.0", function () {
    console.log("Chess server running on port " + PORT);
});