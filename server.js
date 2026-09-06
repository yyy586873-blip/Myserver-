
var http = require("http");
var fs = require("fs");
var path = require("path");

var PORT = parseInt(process.env.PORT || "10000", 10);
var HOST = "0.0.0.0";

var INDEX_FILE = path.join(__dirname, "index.html");

var server = http.createServer(function (req, res) {
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
});
