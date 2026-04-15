const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

const PASS_FILE = "password.txt";

if (!fs.existsSync(PASS_FILE)) {
    fs.writeFileSync(PASS_FILE, "1234");
}

app.get("/", (req, res) => {
    res.send("🔥 Permanent Server Running");
});

app.post("/login", (req, res) => {
    const { password } = req.body;
    const real = fs.readFileSync(PASS_FILE, "utf8").trim();

    if (password === real) {
        res.json({ status: "success" });
    } else {
        res.json({ status: "fail" });
    }
});

app.listen(3000, () => {
    console.log("Server Started");
});
