const express = require("express");

const app = express();

let latestFrame = null;

app.use(express.raw({
    type: "image/jpeg",
    limit: "20mb"
}));

app.use(express.static("public"));

app.post("/upload", function (req, res) {

    if (!req.body || req.body.length === 0) {
        return res.status(400).send("No image received");
    }

    latestFrame = Buffer.from(req.body);

    console.log("Frame received: " + latestFrame.length + " bytes");

    res.status(200).send("OK");
});

app.get("/latest.jpg", function (req, res) {

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    if (latestFrame === null) {
        return res.status(404).send("No screen available");
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.send(latestFrame);
});

const port = process.env.PORT || 3000;

app.listen(port, function () {
    console.log("Server running on port " + port);
});