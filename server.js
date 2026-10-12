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

// Stockfish 19 Lite (single-threaded) provides strong analysis without requiring
// special cross-origin isolation headers. The engine is loaded once and reused.
const Stockfish = require("stockfish");
let stockfishEngine = null;
let stockfishReady = false;
let stockfishInitError = null;
let activeAnalysis = null;
let resolveStockfishReady;
let rejectStockfishReady;
const stockfishReadyPromise = new Promise(function (resolve, reject) {
    resolveStockfishReady = resolve;
    rejectStockfishReady = reject;
});

function parseInfoLine(line, analysis) {
    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);
    if (depthMatch) analysis.depth = parseInt(depthMatch[1], 10);
    if (scoreMatch) {
        analysis.scoreType = scoreMatch[1];
        analysis.score = parseInt(scoreMatch[2], 10);
    }
    if (pvMatch) analysis.pv = pvMatch[1].trim().split(/\s+/);
}

function uciLineToSan(fen, tokens) {
    const position = new Chess(fen);
    const sanMoves = [];
    for (let i = 0; i < tokens.length && i < 12; i++) {
        const match = tokens[i].match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
        if (!match) break;
        try {
            const move = position.move({
                from: match[1],
                to: match[2],
                promotion: match[3] || "q"
            });
            if (!move) break;
            sanMoves.push(move.san);
        } catch (error) {
            break;
        }
    }
    return sanMoves;
}

function finishStockfishAnalysis(bestMoveToken) {
    if (!activeAnalysis) return;
    const analysis = activeAnalysis;
    activeAnalysis = null;
    clearTimeout(analysis.timeout);

    if (!bestMoveToken || bestMoveToken === "(none)" || bestMoveToken === "0000") {
        analysis.reject(new Error("Stockfish did not return a legal move."));
        return;
    }

    const match = bestMoveToken.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
    if (!match) {
        analysis.reject(new Error("Stockfish returned an unreadable move."));
        return;
    }

    try {
        const position = new Chess(analysis.fen);
        const played = position.move({
            from: match[1],
            to: match[2],
            promotion: match[3] || "q"
        });
        if (!played) throw new Error("The suggested move is not legal in this position.");

        const forcedMate = analysis.scoreType === "mate" && analysis.score > 0;
        const avoidsMate = analysis.scoreType === "mate" && analysis.score < 0;
        const mateIn = analysis.scoreType === "mate" ? Math.abs(analysis.score) : null;
        const pvSan = uciLineToSan(analysis.fen, analysis.pv || [bestMoveToken]);
        let reason = "Stockfish's strongest move in the analysed position.";
        if (played.san.indexOf("#") !== -1) {
            reason = "This move delivers checkmate immediately.";
        } else if (forcedMate) {
            reason = "Stockfish found a forced checkmate line in its principal variation.";
        } else if (played.captured) {
            reason = "This move captures an opponent's piece; check the full line before playing.";
        } else if (played.san.indexOf("+") !== -1) {
            reason = "This move gives check and forces the opponent to respond.";
        }

        analysis.resolve({
            from: played.from,
            to: played.to,
            san: played.san,
            promotion: played.promotion || null,
            forcedMate: forcedMate,
            avoidsMate: avoidsMate,
            mateIn: mateIn,
            score: analysis.score,
            scoreType: analysis.scoreType || "cp",
            depth: analysis.depth || 0,
            elapsedMs: Date.now() - analysis.startedAt,
            pvSan: pvSan,
            reason: reason,
            message: forcedMate
                ? "Stockfish found a mate in the analysed line."
                : "No forced mate was confirmed in this search; this is Stockfish's best move from the completed analysis."
        });
    } catch (error) {
        analysis.reject(error);
    }
}

function initializeStockfish() {
    try {
        stockfishEngine = Stockfish("lite-single", function (rawLine) {
            const line = String(rawLine || "").trim();
            if (!line) return;
            if (line === "uciok") {
                stockfishEngine.processCommand("isready");
                return;
            }
            if (line === "readyok") {
                if (!stockfishReady) {
                    stockfishReady = true;
                    console.log("Stockfish Lite engine is ready.");
                    resolveStockfishReady();
                }
                return;
            }
            if (!activeAnalysis) return;
            if (line.indexOf("info ") === 0) {
                parseInfoLine(line, activeAnalysis);
            } else if (line.indexOf("bestmove ") === 0) {
                finishStockfishAnalysis(line.split(/\s+/)[1]);
            }
        });
        stockfishEngine.processCommand("uci");
    } catch (error) {
        stockfishInitError = error;
        rejectStockfishReady(error);
        console.error("Could not start Stockfish:", error);
    }
}

async function runStockfishAnalysis(fen) {
    if (stockfishInitError) throw stockfishInitError;
    await stockfishReadyPromise;
    if (!stockfishEngine || !stockfishReady) throw new Error("Stockfish engine is not ready yet.");
    if (activeAnalysis) throw new Error("Stockfish is already analysing another position. Please try again in a moment.");

    return new Promise(function (resolve, reject) {
        const analysis = {
            fen: fen,
            startedAt: Date.now(),
            depth: 0,
            score: 0,
            scoreType: "cp",
            pv: [],
            resolve: resolve,
            reject: reject,
            timeout: null
        };
        activeAnalysis = analysis;
        analysis.timeout = setTimeout(function () {
            if (activeAnalysis !== analysis) return;
            activeAnalysis = null;
            try { stockfishEngine.processCommand("stop"); } catch (ignore) {}
            reject(new Error("Stockfish analysis timed out. Please try again."));
        }, 8000);
        try {
            stockfishEngine.processCommand("position fen " + fen);
            stockfishEngine.processCommand("go movetime 1400");
        } catch (error) {
            clearTimeout(analysis.timeout);
            activeAnalysis = null;
            reject(error);
        }
    });
}

initializeStockfish();

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

    socket.on("suggestBestMove", async function () {
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

        const currentFen = chess.fen();
        try {
            const suggestion = await runStockfishAnalysis(currentFen);
            // Reject stale results if the board changed while Stockfish was thinking.
            if (chess.fen() !== currentFen || chess.turn() !== role) {
                socket.emit("bestMoveResult", { error: "The board changed during analysis. Please request a fresh suggestion." });
                return;
            }
            socket.emit("bestMoveResult", {
                move: suggestion,
                role: role,
                turn: chess.turn(),
                fen: currentFen
            });
        } catch (error) {
            console.error("Stockfish analysis failed:", error);
            socket.emit("bestMoveResult", {
                error: error && error.message ? error.message : "Could not analyse this position with Stockfish."
            });
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