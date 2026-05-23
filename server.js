const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, "chat.json");

app.use(express.json());

function load() {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function save(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// get messages
app.get("/api/messages", (req, res) => {
    res.json(load());
});

// send message (android or web both)
app.post("/api/send", (req, res) => {
    let msgs = load();

    let msg = {
        id: Date.now(),
        from: req.body.from,
        text: req.body.text,
        time: new Date().toLocaleString()
    };

    msgs.push(msg);
    save(msgs);

    res.json({ ok: true, msg });
});

app.listen(PORT, () => {
    console.log("Server running " + PORT);
});
