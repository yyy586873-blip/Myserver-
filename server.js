const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname)));

// We only have ONE room with ID "123"
const ROOM_ID = "123";
let roomState = {
    white: null,
    black: null,
    board: getInitialBoard(),
    turn: 'white',
    started: false
};

wss.on("connection", (ws) => {
    console.log("Client connected:", ws.id);

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessages(ws, msg);
        } catch (e) {
            console.error("Error parsing message", e);
        }
    });

    ws.on("close", () => {
        // If client disconnects, remove them from the room
        if (roomState.white === ws) roomState.white = null;
        if (roomState.black === ws) roomState.black = null;
        
        // Notify the other player
        const opponent = roomState.white === ws ? roomState.black : roomState.white;
        if (opponent && opponent.readyState === 1) {
            opponent.send(JSON.stringify({ type: "opponent_left" }));
        }
    });
});

function handleMessages(ws, msg) {
    switch (msg.type) {
        case "join":
            // Assign role based on who is available
            if (!roomState.white) {
                roomState.white = ws;
                ws.role = "white";
                ws.send(JSON.stringify({ 
                    type: "joined", 
                    role: "white",
                    status: roomState.started ? "game_active" : "waiting_opponent"
                }));
                
                // If Black is already there, notify them that White joined
                if (roomState.black && roomState.black.readyState === 1) {
                    roomState.black.send(JSON.stringify({ 
                        type: "opponent_joined", 
                        opponentRole: "white" 
                    }));
                }

                // Start game if both are present
                if (roomState.white && roomState.black) {
                    roomState.started = true;
                    broadcastToAll({ type: "game_start" });
                } else {
                    broadcastToAll({ type: "update_status", text: "Waiting for players..." });
                }

            } else if (!roomState.black) {
                roomState.black = ws;
                ws.role = "black";
                ws.send(JSON.stringify({ 
                    type: "joined", 
                    role: "black",
                    status: roomState.started ? "game_active" : "waiting_opponent"
                }));
                
                // Notify White
                if (roomState.white && roomState.white.readyState === 1) {
                    roomState.white.send(JSON.stringify({ 
                        type: "opponent_joined", 
                        opponentRole: "black" 
                    }));
                }

                // Start game
                if (roomState.white && roomState.black) {
                    roomState.started = true;
                    broadcastToAll({ type: "game_start" });
                }
            } else {
                // Room full (shouldn't happen with 2 slots, but just in case)
                ws.send(JSON.stringify({ type: "error", message: "Room is full" }));
            }
            break;

        case "move":
            // Broadcast move to the OTHER player
            const senderRole = ws.role;
            const receiverRole = senderRole === "white" ? "black" : "white";
            const receiverWs = receiverRole === "white" ? roomState.white : roomState.black;
            
            if (receiverWs && receiverWs.readyState === 1) {
                receiverWs.send(JSON.stringify({
                    type: "opponent_move",
                    move: msg.move
                }));
            }
            break;
            
        case "reset":
            resetGameLogic();
            broadcastToAll({ type: "board_reset" });
            break;
    }
}

function broadcastToAll(data) {
    ["white", "black"].forEach(role => {
        const player = roomState[role];
        if (player && player.readyState === 1) {
            player.send(JSON.stringify(data));
        }
    });
}

function resetGameLogic() {
    roomState.board = getInitialBoard();
    roomState.turn = 'white';
    roomState.started = false;
    roomState.white = null;
    roomState.black = null;
}

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Chess Server running on port ${PORT}`);
});