const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

const FILE = "codes.json";

// file create
if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify([]));
}

// random code generator
function generateCode(len = 25) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    for (let i = 0; i < len; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// REGISTER API
app.get("/register", (req, res) => {
    let data = JSON.parse(fs.readFileSync(FILE));

    const code = generateCode();

    data.push({
        code: code,
        created: Date.now(),
        used: false
    });

    fs.writeFileSync(FILE, JSON.stringify(data));

    res.json({ code: code });
});

// LOGIN API (app use करेगा)
app.post("/login-code", (req, res) => {
    const { code } = req.body;

    let data = JSON.parse(fs.readFileSync(FILE));

    let item = data.find(x => x.code === code);

    if (!item) {
        return res.json({ status: "invalid" });
    }

    // 1 hour = 3600000 ms
    if (Date.now() - item.created > 3600000) {
        return res.json({ status: "expired" });
    }

    if (item.used) {
        return res.json({ status: "used" });
    }

    // mark used
    item.used = true;
    fs.writeFileSync(FILE, JSON.stringify(data));

    res.json({ status: "success" });
});

// basic pages
app.use(express.static(__dirname));

app.listen(3000, () => console.log("Server Running"));
