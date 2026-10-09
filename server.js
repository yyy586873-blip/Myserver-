const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname)));

// Store active rooms in memory
// Structure: { roomId: { white: ws, black: ws, board: [] } }
const rooms = {};

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
        // If client disconnects, leave their room
        for (let roomId in rooms) {
            const room = rooms[roomId];
            if (room.white === ws || room.black === ws) {
                const color = room.white === ws ? "white" : "black";
                room[color] = null;
                
                // If both left, delete room
                if (!room.white && !room.black) {
                    delete rooms[roomId];
                } else {
                    // Notify the other player they won by forfeit
                    const opponent = room.white === ws ? room.black : room.white;
                    if (opponent && opponent.readyState === 1) {
                        opponent.send(JSON.stringify({ type: "opponent_left" }));
                    }
                }
            }
        }
    });
});

function handleMessages(ws, msg) {
    switch (msg.type) {
        case "create_room":
            const roomId = Math.random().toString(36).substring(7);
            rooms[roomId] = { white: ws, black: null, board: getInitialBoard() };
            ws.roomId = roomId;
            ws.color = "white";
            ws.send(JSON.stringify({ 
                type: "room_created", 
                roomId: roomId,
                color: "white" 
            }));
            break;

        case "join_room":
            const joinRoomId = msg.roomId;
            if (rooms[joinRoomId]) {
                const room = rooms[joinRoomId];
                if (!room.black) {
                    room.black = ws;
                    ws.roomId = joinRoomId;
                    ws.color = "black";
                    
                    ws.send(JSON.stringify({ 
                        type: "joined", 
                        roomId: joinRoomId,
                        color: "black"
                    }));
                    
                    // Tell White someone joined
                    if (room.white.readyState === 1) {
                        room.white.send(JSON.stringify({ type: "opponent_joined", roomId: joinRoomId }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: "error", message: "Room is full" }));
                }
            } else {
                ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
            }
            break;

        case "move":
            // Broadcast move to the other player in the same room
            if (ws.roomId && rooms[ws.roomId]) {
                const room = rooms[ws.roomId];
                const opponent = room.white === ws ? room.black : room.white;
                if (opponent && opponent.readyState === 1) {
                    opponent.send(JSON.stringify({
                        type: "opponent_move",
                        move: msg.move
                    }));
                }
            }
            break;
            
        case "reset":
             if (ws.roomId && rooms[ws.roomId]) {
                const room = rooms[ws.roomId];
                room.board = getInitialBoard();
                broadcastToRoom(ws.roomId, { type: "board_reset" });
            }
            break;
    }
}

function broadcastToRoom(roomId, data) {
    if (rooms[roomId]) {
        ["white", "black"].forEach(key => {
            const player = rooms[roomId][key];
            if (player && player.readyState === 1) {
                player.send(JSON.stringify(data));
            }
        });
    }
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