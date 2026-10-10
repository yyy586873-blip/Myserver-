const express = require('express');
const path = require('path');
const app = express();
const http = require('http').Server(app);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Global Game State
let game = {
    board: getInitialBoard(),
    turn: 'white', // 'white' or 'black'
    whitePlayer: null,
    blackPlayer: null,
    status: 'waiting', // waiting, playing, finished
    winner: null,
    timerWhite: 300, // 5 mins in seconds
    timerBlack: 300,
    lastMoveTime: Date.now()
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

// API: Get current state
app.get('/api/state', (req, res) => {
    res.json(game);
});

// API: Join Game
app.post('/api/join', (req, res) => {
    const id = req.body.id || Math.random().toString(36).substr(2, 9);
    
    if (!game.whitePlayer) {
        game.whitePlayer = id;
        res.json({ role: 'white', joined: true });
    } else if (!game.blackPlayer && game.whitePlayer !== id) {
        game.blackPlayer = id;
        game.status = 'playing';
        game.timerWhite = 300;
        game.timerBlack = 300;
        res.json({ role: 'black', joined: true, startGame: true });
    } else {
        // Rejoin logic or error
        const role = (game.whitePlayer === id) ? 'white' : 'black';
        res.json({ role: role, joined: true });
    }
});

// API: Make a Move
app.post('/api/move', (req, res) => {
    if (game.status !== 'playing') return res.status(400).json({error: "Game not started"});
    
    const { from, to, playerId } = req.body;
    
    // Validate Turn
    const isWhiteTurn = game.turn === 'white';
    const isMyTurn = (isWhiteTurn && game.whitePlayer === playerId) || 
                     (!isWhiteTurn && game.blackPlayer === playerId);
                     
    if (!isMyTurn) return res.status(400).json({error: "Not your turn"});
    
    // Execute Move Logic
    const piece = game.board[from.r][from.c];
    game.board[to.r][to.c] = piece;
    game.board[from.r][from.c] = '';
    
    // Auto Promote to Queen
    if (piece === 'P' && to.r === 0) game.board[to.r][to.c] = 'Q';
    if (piece === 'p' && to.r === 7) game.board[to.r][to.c] = 'q';
    
    // Switch Turn & Reset Timer
    game.turn = game.turn === 'white' ? 'black' : 'white';
    
    res.json({ success: true });
});

// API: Timer Tick (Called by polling)
app.post('/api/tick', (req, res) => {
    if (game.status !== 'playing') return res.json({status: game.status});
    
    const now = Date.now();
    // Simple decrement logic based on server time difference could be added here
    // For simplicity, we handle timer display in client but track turn here
    
    res.json({ status: game.status, turn: game.turn });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Chess Server running on port ${PORT}`));