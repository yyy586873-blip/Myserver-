const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

const PASS_FILE = "password.txt";

if (!fs.existsSync(PASS_FILE)) {
    fs.writeFileSync(PASS_FILE, "1234");
}

app.use("/files", express.static(__dirname + "/files"));

app.get("/files-list", (req, res) => {
    fs.readdir(__dirname + "/files", (err, files) => {
        if (err) return res.json([]);

        const data = files.map(file => {
            const stats = fs.statSync(__dirname + "/files/" + file);
            return {
                name: file,
                size: (stats.size / 1024).toFixed(2) + " KB"
            };
        });

        res.json(data);
    });
});
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

app.get("/dashboard", (req, res) => {
    res.sendFile(__dirname + "/dashboard.html");
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
