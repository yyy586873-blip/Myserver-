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

function evaluatePosition(position, perspective) {
    if (position.isCheckmate()) {
        return position.turn() === perspective ? -100000 : 100000;
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
                value += Math.max(0, advance) * 7;
            }
            score += piece.color === perspective ? value : -value;
        }
    }
    if (position.isCheck()) score += position.turn() === perspective ? -35 : 35;
    return score;
}

function findBestMove(fen, depth) {
    const position = new Chess(fen);
    const perspective = position.turn();
    const rootMoves = position.moves({ verbose: true });
    if (!rootMoves.length) return null;

    let bestMove = null;
    let bestScore = -Infinity;

    function search(currentDepth, alpha, beta) {
        if (currentDepth === 0 || currentDepth > 0 && position.isGameOver()) {
            return evaluatePosition(position, perspective);
        }
        const moves = position.moves({ verbose: true });
        if (!moves.length) return evaluatePosition(position, perspective);

        const maximizing = position.turn() === perspective;
        let best = maximizing ? -Infinity : Infinity;
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            position.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
            const score = search(currentDepth - 1, alpha, beta);
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

    for (let i = 0; i < rootMoves.length; i++) {
        const m = rootMoves[i];
        position.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
        const score = search(depth - 1, -Infinity, Infinity);
        position.undo();
        if (score > bestScore) {
            bestScore = score;
            bestMove = {
                from: m.from,
                to: m.to,
                san: m.san,
                promotion: m.promotion || null,
                score: score
            };
        }
    }
    return bestMove;
}

io.on("connection", function (socket) {
    console.log("Connected:", socket.id);

    socket.on("joinGame", function () {
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

        socket.emit("joined", {
            role: role,
            accepted: true
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
        if (!role || !started || chess.isGameOver()) {
            socket.emit("bestMoveResult", {
                error: "The game must be active and you must be one of its players."
            });
            return;
        }

        try {
            const suggestion = findBestMove(chess.fen(), 2);
            if (!suggestion) {
                socket.emit("bestMoveResult", { error: "No legal move is available." });
                return;
            }
            socket.emit("bestMoveResult", {
                move: suggestion,
                turn: chess.turn(),
                fen: chess.fen()
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