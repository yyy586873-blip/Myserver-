"use strict";

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

// ============================================================
// MULTIPLAYER GAME
// ============================================================

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
        const winner = chess.turn() === "w" ? "b" : "w";

        return {
            state: "checkmate",
            winner: winner,
            message:
                (winner === "w" ? "White" : "Black") +
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
    started = !!(players.w && players.b);
}

// ============================================================
// CHESS ENGINE
// Iterative deepening + alpha-beta + move ordering +
// quiescence search + transposition table
// ============================================================

const PIECE_VALUES = {
    p: 100,
    n: 320,
    b: 335,
    r: 500,
    q: 900,
    k: 20000
};

const MATE_SCORE = 1000000;
const MAX_PLY = 64;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIME_MS = 1200;
const MAX_TIME_MS = 2500;
const MAX_TT_SIZE = 150000;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

let transpositionTable = new Map();

function pieceSquareBonus(piece, row, col) {
    const center =
        7 - (Math.abs(3.5 - row) + Math.abs(3.5 - col));

    const advance =
        piece.color === "w" ? 6 - row : row - 1;

    switch (piece.type) {
        case "p":
            return Math.max(0, advance) * 8 +
                Math.max(0, center) * 2;

        case "n":
            return Math.round(center * 7);

        case "b":
            return Math.round(center * 4);

        case "r":
            return Math.max(0, advance) * 1;

        case "q":
            return Math.round(center * 2);

        case "k":
            return 0;

        default:
            return 0;
    }
}

function evaluatePosition(position) {
    if (position.isCheckmate()) {
        return -MATE_SCORE;
    }

    if (position.isDraw()) {
        return 0;
    }

    const board = position.board();

    let score = 0;
    let whiteBishops = 0;
    let blackBishops = 0;

    let whiteMaterial = 0;
    let blackMaterial = 0;

    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = board[row][col];

            if (!piece) continue;

            const sign = piece.color === "w" ? 1 : -1;
            const value = PIECE_VALUES[piece.type] || 0;

            score += sign * value;
            score += sign * pieceSquareBonus(piece, row, col);

            if (piece.color === "w") {
                whiteMaterial += value;

                if (piece.type === "b") {
                    whiteBishops++;
                }
            } else {
                blackMaterial += value;

                if (piece.type === "b") {
                    blackBishops++;
                }
            }
        }
    }

    // Bishop pair bonus.
    if (whiteBishops >= 2) score += 25;
    if (blackBishops >= 2) score -= 25;

    // Encourage king safety while significant material remains.
    const materialRemaining =
        whiteMaterial + blackMaterial;

    if (materialRemaining > 2200) {
        const whiteKing = position.board().flat().find(
            p => p && p.type === "k" && p.color === "w"
        );

        const blackKing = position.board().flat().find(
            p => p && p.type === "k" && p.color === "b"
        );

        if (whiteKing) {
            const kingMoves = position.moves({
                verbose: true
            });

            // Avoid applying a king-safety bonus based on the
            // wrong side's legal moves. Actual king safety is
            // primarily addressed by tactical search.
            void kingMoves;
        }
    }

    // Return score from the side-to-move perspective.
    return position.turn() === "w" ? score : -score;
}

function getPositionKey(position) {
    // FEN contains side to move, castling rights and en-passant
    // information. Halfmove/fullmove counters are omitted from
    // the search key to improve cache reuse.
    const fields = position.fen().split(" ");

    return fields.slice(0, 4).join(" ");
}

function isCapture(move) {
    return move.isCapture();
}

function moveOrderingScore(move, ttMove) {
    let score = 0;

    if (
        ttMove &&
        move.from === ttMove.from &&
        move.to === ttMove.to &&
        (move.promotion || null) ===
            (ttMove.promotion || null)
    ) {
        return 2000000;
    }

    if (move.promotion) {
        score += 100000 + (PIECE_VALUES[move.promotion] || 0);
    }

    if (isCapture(move)) {
        const victim = PIECE_VALUES[move.captured] || 0;
        const attacker = PIECE_VALUES[move.piece] || 0;

        score += 100000 + victim * 10 - attacker;
    }

    if (move.san && move.san.includes("+")) {
        score += 500;
    }

    if (move.san && move.san.includes("#")) {
        score += 1000000;
    }

    return score;
}

function orderMoves(moves, ttMove) {
    return moves
        .map(function (move) {
            return {
                move: move,
                score: moveOrderingScore(move, ttMove)
            };
        })
        .sort(function (a, b) {
            return b.score - a.score;
        })
        .map(function (item) {
            return item.move;
        });
}

function createSearchContext(maxTimeMs) {
    return {
        deadline: Date.now() + maxTimeMs,
        nodes: 0,
        stopped: false,
        tt: transpositionTable
    };
}

function checkSearchTime(context) {
    context.nodes++;

    if (
        (context.nodes & 1023) === 0 &&
        Date.now() >= context.deadline
    ) {
        context.stopped = true;
        return true;
    }

    return context.stopped;
}

function quiescence(position, alpha, beta, ply, context) {
    if (checkSearchTime(context)) {
        return evaluatePosition(position);
    }

    if (ply >= MAX_PLY) {
        return evaluatePosition(position);
    }

    if (position.isCheckmate()) {
        return -MATE_SCORE + ply;
    }

    if (position.isDraw()) {
        return 0;
    }

    const inCheck = position.isCheck();

    // When in check, every legal evasion must be considered.
    // Stand-pat is not valid in this situation.
    if (!inCheck) {
        const standPat = evaluatePosition(position);

        if (standPat >= beta) return beta;
        if (standPat > alpha) alpha = standPat;
    }

    let moves = position.moves({
        verbose: true
    });

    if (!inCheck) {
        moves = moves.filter(function (move) {
            return isCapture(move) || !!move.promotion;
        });
    }

    moves = orderMoves(moves, null);

    for (const move of moves) {
        if (context.stopped) break;

        position.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion || "q"
        });

        const score = -quiescence(
            position,
            -beta,
            -alpha,
            ply + 1,
            context
        );

        position.undo();

        if (context.stopped) break;

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }

    return alpha;
}

function negamax(
    position,
    depth,
    alpha,
    beta,
    ply,
    context
) {
    if (checkSearchTime(context)) {
        return evaluatePosition(position);
    }

    if (ply >= MAX_PLY) {
        return evaluatePosition(position);
    }

    if (position.isCheckmate()) {
        return -MATE_SCORE + ply;
    }

    if (position.isDraw()) {
        return 0;
    }

    if (depth <= 0) {
        return quiescence(
            position,
            alpha,
            beta,
            ply,
            context
        );
    }

    const originalAlpha = alpha;
    const key = getPositionKey(position);
    const entry = context.tt.get(key);

    let ttMove = null;

    if (entry) {
        ttMove = entry.bestMove || null;

        if (entry.depth >= depth) {
            const ttScore =
                entry.score > MATE_SCORE - MAX_PLY
                    ? entry.score - ply
                    : entry.score < -MATE_SCORE + MAX_PLY
                        ? entry.score + ply
                        : entry.score;

            if (entry.flag === TT_EXACT) return ttScore;

            if (entry.flag === TT_LOWER) {
                alpha = Math.max(alpha, ttScore);
            } else if (entry.flag === TT_UPPER) {
                beta = Math.min(beta, ttScore);
            }

            if (alpha >= beta) return ttScore;
        }
    }

    const moves = orderMoves(
        position.moves({ verbose: true }),
        ttMove
    );

    if (!moves.length) {
        return position.isCheck() ? -MATE_SCORE + ply : 0;
    }

    let bestScore = -Infinity;
    let bestMove = null;

    for (const move of moves) {
        if (context.stopped) break;

        position.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion || "q"
        });

        const score = -negamax(
            position,
            depth - 1,
            -beta,
            -alpha,
            ply + 1,
            context
        );

        position.undo();

        if (context.stopped) break;

        if (score > bestScore) {
            bestScore = score;
            bestMove = {
                from: move.from,
                to: move.to,
                promotion: move.promotion || null
            };
        }

        if (score > alpha) {
            alpha = score;
        }

        if (alpha >= beta) {
            break;
        }
    }

    if (context.stopped) {
        return bestScore === -Infinity
            ? evaluatePosition(position)
            : bestScore;
    }

    let flag = TT_EXACT;

    if (bestScore <= originalAlpha) {
        flag = TT_UPPER;
    } else if (bestScore >= beta) {
        flag = TT_LOWER;
    }

    if (context.tt.size >= MAX_TT_SIZE) {
        // Bound memory usage. Clearing the table is simple and safe.
        context.tt.clear();
    }

    context.tt.set(key, {
        depth: depth,
        score: bestScore,
        flag: flag,
        bestMove: bestMove
    });

    return bestScore;
}

function findBestMove(fen, maxDepth, maxTimeMs) {
    const position = new Chess(fen);
    const rootMoves = position.moves({ verbose: true });

    if (!rootMoves.length) return null;

    const context = createSearchContext(maxTimeMs);
    const perspective = position.turn();

    let bestMove = null;
    let bestScore = -Infinity;
    let completedDepth = 0;

    // A legal fallback is always available even if the search
    // reaches its time limit before completing depth 1.
    const fallback = rootMoves[0];

    bestMove = {
        from: fallback.from,
        to: fallback.to,
        san: fallback.san,
        promotion: fallback.promotion || null,
        score: 0
    };

    for (let depth = 1; depth <= maxDepth; depth++) {
        if (Date.now() >= context.deadline) break;

        let iterationBest = null;
        let iterationScore = -Infinity;

        const ttEntry = context.tt.get(
            getPositionKey(position)
        );

        const orderedRootMoves = orderMoves(
            rootMoves,
            ttEntry ? ttEntry.bestMove : null
        );

        for (const move of orderedRootMoves) {
            if (context.stopped) break;

            position.move({
                from: move.from,
                to: move.to,
                promotion: move.promotion || "q"
            });

            const score = -negamax(
                position,
                depth - 1,
                -Infinity,
                Infinity,
                1,
                context
            );

            position.undo();

            if (context.stopped) break;

            if (score > iterationScore) {
                iterationScore = score;
                iterationBest = {
                    from: move.from,
                    to: move.to,
                    san: move.san,
                    promotion: move.promotion || null,
                    score: score
                };
            }
        }

        // Keep only fully completed search iterations.
        if (context.stopped || !iterationBest) break;

        bestMove = iterationBest;
        bestScore = iterationScore;
        completedDepth = depth;

        if (Math.abs(bestScore) >= MATE_SCORE - MAX_PLY) {
            break;
        }
    }

    return {
        ...bestMove,
        depth: completedDepth,
        nodes: context.nodes,
        perspective: perspective
    };
}

// ============================================================
// SOCKET CONNECTIONS
// ============================================================

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
                message:
                    "This chess room is full. Only two players can play."
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

    // --------------------------------------------------------
    // LEGAL MOVES
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // MAKE MOVE
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // BEST MOVE ANALYSIS
    // --------------------------------------------------------

    let analysisRunning = false;

    socket.on("suggestBestMove", function () {
        const role = getRole(socket.id);

        if (!role || !started || chess.isGameOver()) {
            socket.emit("bestMoveResult", {
                error:
                    "The game must be active and you must be one of its players."
            });
            return;
        }

        if (chess.turn() !== role) {
            socket.emit("bestMoveResult", {
                error: "Wait for your turn before analysing a move."
            });
            return;
        }

        if (analysisRunning) {
            socket.emit("bestMoveResult", {
                error: "Analysis is already running. Please wait."
            });
            return;
        }

        analysisRunning = true;

        // Capture the position before starting analysis.
        const analysedFen = chess.fen();

        // Limit analysis time so it does not hold the server for
        // an unnecessarily long period.
        const maxDepth = DEFAULT_MAX_DEPTH;
        const maxTimeMs = DEFAULT_TIME_MS;

        setImmediate(function () {
            try {
                // Never use the live game object for search.
                // The analysis gets its own position from the FEN.
                const suggestion = findBestMove(
                    analysedFen,
                    maxDepth,
                    maxTimeMs
                );

                if (!suggestion) {
                    socket.emit("bestMoveResult", {
                        error: "No legal move is available."
                    });
                    return;
                }

                // Discard stale analysis if the game position changed.
                if (
                    !started ||
                    chess.isGameOver() ||
                    chess.fen() !== analysedFen ||
                    getRole(socket.id) !== role
                ) {
                    socket.emit("bestMoveResult", {
                        error:
                            "Position changed during analysis. Please try again."
                    });
                    return;
                }

                socket.emit("bestMoveResult", {
                    move: suggestion,
                    turn: role,
                    fen: analysedFen
                });

                console.log(
                    "Analysis:",
                    suggestion.san,
                    "| depth:",
                    suggestion.depth,
                    "| nodes:",
                    suggestion.nodes
                );
            } catch (error) {
                console.error("Best-move analysis failed:", error);

                socket.emit("bestMoveResult", {
                    error: "Could not analyse this position."
                });
            } finally {
                analysisRunning = false;
            }
        });
    });

    // --------------------------------------------------------
    // NEW GAME
    // --------------------------------------------------------

    socket.on("newGame", function () {
        const role = getRole(socket.id);

        if (!role || !started || !chess.isGameOver()) {
            return;
        }

        chess.reset();
        lastMove = null;
        transpositionTable.clear();

        sendState();
    });

    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------

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

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, "0.0.0.0", function () {
    console.log("Chess server running on port " + PORT);
});