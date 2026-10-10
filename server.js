const express = require("express");
const http = require("http");
const path = require("path');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname)));

// Global State - Only ONE game exists
let gameState = {
    board: getInitialBoard(),
    turn: 'white',
    whitePlayer: null, // Stores IP/ID
    blackPlayer: null,
    started: false,
    lastUpdate: Date.now()
};

function getInitialBoard() {
    return [
        ['r','n','b','q','k','b','n','r'],
        ['p','p','p','p','p','p','p','p'],
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['P','P','P','P','P','P','P','P'],
        ['R','N','B','Q','K','B','N','R']
    ];
}

// Helper to generate a simple ID for players
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

app.get('/api/state', (req, res) => {
    // Return current game state
    res.json({
        board: gameState.board,
        turn: gameState.turn,
        white: gameState.whitePlayer,
        black: gameState.blackPlayer,
        started: gameState.started,
        myId: req.query.id || null
    });
});

app.post('/api/join', (req, res) => {
    let playerId = req.body.playerId;
    if (!playerId) {
        playerId = generateId();
    }

    // Logic: First person gets White, Second gets Black
    if (!gameState.whitePlayer) {
        gameState.whitePlayer = playerId;
        gameState.roleForNewUser = 'white';
    } else if (!gameState.blackPlayer && gameState.whitePlayer !== playerId) {
        gameState.blackPlayer = playerId;
        gameState.roleForNewUser = 'black';
        gameState.started = true; // Game auto-starts when 2nd player joins
    } else {
        // If both are full, maybe return existing or wait? 
        // For this simple version, we just say they joined their assigned role
        // or re-join if they disconnected.
        if(gameState.whitePlayer === playerId) gameState.roleForNewUser = 'white';
        else gameState.roleForNewUser = 'black';
    }

    res.json({
        success: true,
        playerId: playerId,
        role: gameState.roleForNewUser,
        started: gameState.started
    });
});

app.post('/api/move', (req, res) => {
    const { from, to, playerId } = req.body;
    
    // Basic validation: Is it this player's turn?
    const isWhiteTurn = gameState.turn === 'white';
    const currentPlayerIsWhite = gameState.whitePlayer === playerId;
    
    if ((isWhiteTurn && !currentPlayerIsWhite) || (!isWhiteTurn && currentPlayerIsWhite)) {
        return res.status(400).json({ error: "Not your turn" });
    }

    // Apply move
    const piece = gameState.board[from.r][from.c];
    gameState.board[to.r][to.c] = piece;
    gameState.board[from.r][from.c] = '';

    // Auto-promote to Queen
    if (piece === 'P' && to.r === 0) gameState.board[to.r][to.c] = 'Q';
    if (piece === 'p' && to.r === 7) gameState.board[to.r][to.c] = 'q';

    // Switch turn
    gameState.turn = gameState.turn === 'white' ? 'black' : 'white';
    gameState.lastUpdate = Date.now();

    res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
    gameState.board = getInitialBoard();
    gameState.turn = 'white';
    gameState.started = false;
    gameState.whitePlayer = null;
    gameState.blackPlayer = null;
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Chess Polling Server running on port ${PORT}`);
}); 