var http = require("http");
var fs = require("fs");
var path = require("path");

var PORT = parseInt(process.env.PORT || "10000", 10);
var HOST = "0.0.0.0";

// WebSocket dependency (npm install ws karna zaroori hai)
var WebSocketServer = require('ws').Server;

var INDEX_FILE = path.join(__dirname, "index.html");

// WebSocket Server for real-time streaming
var wss = new WebSocketServer({ port: 8080 });

// Store connected browser clients
var webClients = [];

wss.on('connection', function (ws) {
    console.log('Browser Connected');
    webClients.push(ws);
    
    ws.on('close', function() {
        console.log('Browser Disconnected');
        // Remove closed client
        var index = webClients.indexOf(ws);
        if (index > -1) webClients.splice(index, 1);
    });
});

var server = http.createServer(function (req, res) {
  
  // New Endpoint: /upload for Android App
  if (req.method === 'POST' && req.url === '/upload') {
    var body = [];
    
    req.on('data', function (chunk) {
      body.push(chunk);
    });
    
    req.on('end', function () {
      var data = Buffer.concat(body);
      
      // Broadcast this raw frame to all connected browsers
      for (var i = 0; i < webClients.length; i++) {
        if (webClients[i].readyState === WebSocket.OPEN) {
            webClients[i].send(data);
        }
      }
      
      res.writeHead(200);
      res.end("OK");
    });
    return; // Exit early so we don't serve HTML
  }

  // Default: Serve index.html
  fs.readFile(INDEX_FILE, function (err, data) {
    if (err) {
      res.writeHead(500);
      res.end("Error");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

server.listen(PORT, HOST, function () {
  console.log("Server running at http://" + HOST + ":" + PORT + "/");
  console.log("WebSocket ready on port 8080");
});