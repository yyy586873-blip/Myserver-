const express = require("express");

const app = express();

let latestFrame = null;
let lastUpdate = 0;

app.use(express.raw({
type: "image/jpeg",
limit: "25mb"
}));

app.use(express.static("public"));

app.get("/health", function (req, res) {

res.json({
    status: "online",
    hasFrame: latestFrame !== null,
    lastUpdate: lastUpdate
});

});

app.post("/upload", function (req, res) {

if (!req.body || req.body.length === 0) {

    console.log("Empty upload received");

    res.status(400).json({
        success: false,
        error: "Empty image"
    });

    return;
}

latestFrame = Buffer.from(req.body);

lastUpdate = Date.now();

console.log(
    "Frame received: " +
    latestFrame.length +
    " bytes"
);

res.status(200).json({
    success: true,
    size: latestFrame.length
});

});

app.get("/latest.jpg", function (req, res) {

if (latestFrame === null) {

    res.status(404).send("No screen frame received yet");

    return;
}

res.setHeader("Content-Type", "image/jpeg");

res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
);

res.setHeader(
    "Pragma",
    "no-cache"
);

res.setHeader(
    "Expires",
    "0"
);

res.end(latestFrame);

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", function () {

console.log(
    "Screen server running on port " + PORT
);

});