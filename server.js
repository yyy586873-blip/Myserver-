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