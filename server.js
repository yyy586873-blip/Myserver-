/*
 * World Chat relay server
 * No npm packages required.
 *
 * Render:
 *   Build Command: (empty)
 *   Start Command: node server.js
 */

var http = require("http");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var os = require("os");

var PORT = parseInt(process.env.PORT || "10000", 10);
var HOST = "0.0.0.0";

var ROOT = __dirname;
var INDEX_FILE = path.join(ROOT, "index.html");
var TEMP_DIR = path.join(os.tmpdir(), "worldchat-files");

var MAX_FILE_BYTES = 100 * 1024 * 1024;
var FILE_TTL_MS = 30 * 60 * 1000;

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

var clients = [];
var files = Object.create(null);

function json(res, status, data) {
    var body = JSON.stringify(data);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
    });

    res.end(body);
}

function safeName(value) {
    value = String(value || "file.bin");
    value = value.replace(/[^a-zA-Z0-9._-]/g, "_");

    if (value.length > 120) {
        value = value.substring(0, 120);
    }

    return value || "file.bin";
}

function removeClient(client) {
    var index = clients.indexOf(client);

    if (index !== -1) {
        clients.splice(index, 1);
    }
}

function sendText(socket, text) {
    if (!socket || socket.destroyed) {
        return;
    }

    var payload = Buffer.from(String(text), "utf8");
    var length = payload.length;
    var header;

    if (length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;

        var high = Math.floor(length / 4294967296);
        var low = length >>> 0;

        header.writeUInt32BE(high >>> 0, 2);
        header.writeUInt32BE(low, 6);
    }

    socket.write(Buffer.concat([header, payload]));
}

function sendPong(socket, payload) {
    payload = payload || Buffer.alloc(0);

    if (payload.length > 125) {
        payload = payload.slice(0, 125);
    }

    var header = Buffer.from([0x8A, payload.length]);
    socket.write(Buffer.concat([header, payload]));
}

function sendClose(socket) {
    try {
        socket.write(Buffer.from([0x88, 0x00]));
    } catch (e) {
    }

    try {
        socket.end();
    } catch (e2) {
    }
}

function broadcast(message) {
    var text = JSON.stringify(message);

    for (var i = clients.length - 1; i >= 0; i--) {
        if (!clients[i].socket.destroyed) {
            sendText(clients[i].socket, text);
        } else {
            clients.splice(i, 1);
        }
    }
}

function parseFrames(client) {
    var buffer = client.buffer;

    while (buffer.length >= 2) {
        var first = buffer[0];
        var second = buffer[1];

        var fin = (first & 0x80) !== 0;
        var opcode = first & 0x0F;
        var masked = (second & 0x80) !== 0;
        var length = second & 0x7F;

        var offset = 2;

        if (length === 126) {
            if (buffer.length < offset + 2) {
                break;
            }

            length = buffer.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (buffer.length < offset + 8) {
                break;
            }

            var high = buffer.readUInt32BE(offset);
            var low = buffer.readUInt32BE(offset + 4);

            if (high !== 0) {
                sendClose(client.socket);
                return;
            }

            length = low;
            offset += 8;
        }

        var maskKey = null;

        if (masked) {
            if (buffer.length < offset + 4) {
                break;
            }

            maskKey = buffer.slice(offset, offset + 4);
            offset += 4;
        }

        if (length > 1024 * 1024) {
            sendClose(client.socket);
            return;
        }

        if (buffer.length < offset + length) {
            break;
        }

        var payload = buffer.slice(offset, offset + length);
        buffer = buffer.slice(offset + length);

        if (masked) {
            var unmasked = Buffer.alloc(length);
            var j;

            for (j = 0; j < length; j++) {
                unmasked[j] = payload[j] ^
                    maskKey[j % 4];
            }

            payload = unmasked;
        }

        if (!fin) {
            continue;
        }

        if (opcode === 0x8) {
            sendClose(client.socket);
            return;
        }

        if (opcode === 0x9) {
            sendPong(client.socket, payload);
            continue;
        }

        if (opcode === 0xA) {
            continue;
        }

        if (opcode !== 0x1) {
            continue;
        }

        var text;

        try {
            text = payload.toString("utf8");
        } catch (e) {
            continue;
        }

        handleMessage(client, text);
    }

    client.buffer = buffer;
}

function handleMessage(client, text) {
    var data;

    try {
        data = JSON.parse(text);
    } catch (e) {
        sendText(client.socket, JSON.stringify({
            type: "error",
            code: "BAD_JSON",
            message: "Invalid packet"
        }));
        return;
    }

    if (!data || !data.type) {
        return;
    }

    if (data.type === "hello") {
        client.userId = String(data.userId || "").substring(0, 80);
        client.name = String(data.name || "User").substring(0, 40);

        sendText(client.socket, JSON.stringify({
            type: "ready",
            serverTime: Date.now(),
            online: clients.length
        }));

        broadcast({
            type: "presence",
            online: clients.length
        });

        return;
    }

    if (data.type === "message") {
        var message = {
            type: "message",
            messageId: String(data.messageId || crypto.randomBytes(16).toString("hex")),
            senderId: String(data.senderId || client.userId || ""),
            senderName: String(data.senderName || client.name || "User")
                .substring(0, 40),
            messageType: String(data.messageType || "text"),
            text: String(data.text || "").substring(0, 4000),
            fileId: data.fileId ? String(data.fileId) : "",
            fileName: data.fileName ? String(data.fileName).substring(0, 120) : "",
            mime: data.mime ? String(data.mime).substring(0, 120) : "",
            size: Number(data.size || 0),
            timestamp: Date.now()
        };

        broadcast(message);
        return;
    }
}

function handleWebSocket(req, socket) {
    var key = req.headers["sec-websocket-key"];

    if (!key) {
        socket.end();
        return;
    }

    var accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

    var response =
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";

    socket.write(response);

    var client = {
        socket: socket,
        buffer: Buffer.alloc(0),
        userId: "",
        name: "User"
    };

    clients.push(client);

    socket.on("data", function (chunk) {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        parseFrames(client);
    });

    socket.on("close", function () {
        removeClient(client);

        broadcast({
            type: "presence",
            online: clients.length
        });
    });

    socket.on("error", function () {
        removeClient(client);
    });
}

function cleanupFiles() {
    var now = Date.now();
    var ids = Object.keys(files);

    ids.forEach(function (id) {
        var entry = files[id];

        if (!entry || entry.expiresAt <= now) {
            if (entry && entry.path) {
                try {
                    fs.unlinkSync(entry.path);
                } catch (e) {
                }
            }

            delete files[id];
        }
    });
}

setInterval(cleanupFiles, 60 * 1000);

var server = http.createServer(function (req, res) {
    var url = new URL(req.url, "http://localhost");

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });

        res.end();
        return;
    }

    if (req.method === "GET" &&
            (url.pathname === "/" || url.pathname === "/index.html")) {

        fs.readFile(INDEX_FILE, function (err, data) {
            if (err) {
                res.writeHead(500, {
                    "Content-Type": "text/plain; charset=utf-8"
                });

                res.end("index.html missing");
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
            });

            res.end(data);
        });

        return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
            ok: true,
            online: clients.length,
            time: Date.now()
        });

        return;
    }

    if (req.method === "POST" && url.pathname === "/upload") {
        var id = crypto.randomBytes(16).toString("hex");
        var name = safeName(url.searchParams.get("name"));
        var mime = String(
            url.searchParams.get("mime") ||
            "application/octet-stream"
        ).substring(0, 120);

        var filePath = path.join(TEMP_DIR, id + "_" + name);
        var output = fs.createWriteStream(filePath);
        var total = 0;
        var failed = false;

        req.on("data", function (chunk) {
            if (failed) {
                return;
            }

            total += chunk.length;

            if (total > MAX_FILE_BYTES) {
                failed = true;

                try {
                    req.destroy();
                } catch (e) {
                }

                try {
                    output.destroy();
                } catch (e2) {
                }

                try {
                    fs.unlinkSync(filePath);
                } catch (e3) {
                }

                json(res, 413, {
                    ok: false,
                    error: "FILE_TOO_LARGE"
                });

                return;
            }

            output.write(chunk);
        });

        req.on("end", function () {
            if (failed) {
                return;
            }

            output.end(function () {
                files[id] = {
                    path: filePath,
                    name: name,
                    mime: mime,
                    size: total,
                    expiresAt: Date.now() + FILE_TTL_MS
                };

                json(res, 200, {
                    ok: true,
                    fileId: id,
                    fileName: name,
                    mime: mime,
                    size: total
                });
            });
        });

        req.on("error", function () {
            failed = true;

            try {
                output.destroy();
            } catch (e) {
            }

            try {
                fs.unlinkSync(filePath);
            } catch (e2) {
            }
        });

        return;
    }

    if (req.method === "GET" &&
            url.pathname.indexOf("/file/") === 0) {

        var fileId = url.pathname.substring("/file/".length);
        var entry = files[fileId];

        if (!entry || entry.expiresAt <= Date.now() ||
                !fs.existsSync(entry.path)) {

            if (entry) {
                delete files[fileId];
            }

            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            });

            res.end("File expired or not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": entry.mime,
            "Content-Length": entry.size,
            "Content-Disposition":
                'inline; filename="' + entry.name.replace(/"/g, "") + '"',
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        });

        var input = fs.createReadStream(entry.path);

        input.on("error", function () {
            try {
                res.end();
            } catch (e) {
            }
        });

        input.pipe(res);
        return;
    }

    res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Not found");
});

server.on("upgrade", function (req, socket) {
    var url = new URL(req.url, "http://localhost");

    if (url.pathname !== "/ws") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
    }

    handleWebSocket(req, socket);
});

server.listen(PORT, HOST, function () {
    console.log("World Chat server listening on " + HOST + ":" + PORT);
});
