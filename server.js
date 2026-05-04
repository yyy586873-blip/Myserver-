const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const FILE = path.join(__dirname, "codes.json");
const SITE_USER = "DXXX";
const SITE_PASS = "111";
const CODE_VALID_MS = 60 * 60 * 1000; // 1 hour

// ===== MUSIC SETUP =====
const PUBLIC_DIR = path.join(__dirname, "public");
const MUSIC_DIR = path.join(PUBLIC_DIR, "music");
const FILE_DIR = path.join(MUSIC_DIR, "file");
const SONGS_JSON = path.join(MUSIC_DIR, "songs.json");

// Ensure folders exist
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR);
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR);

// Ensure songs.json exists
if (!fs.existsSync(SONGS_JSON)) {
  fs.writeFileSync(SONGS_JSON, "[]");
}

if (!fs.existsSync(FILE)) {
  fs.writeFileSync(FILE, "[]");
}

function readCodes() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveCodes(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function generateCode(len) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var out = "";
  var i = 0;
  for (i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

app.post("/site-login", function(req, res) {
  var username = (req.body.username || "").trim();
  var password = (req.body.password || "").trim();

  if (username === SITE_USER && password === SITE_PASS) {
    return res.json({ status: "success" });
  }

  return res.json({ status: "fail" });
});

app.post("/register", function(req, res) {
  var username = (req.body.username || "").trim();
  var password = (req.body.password || "").trim();

  if (username !== SITE_USER || password !== SITE_PASS) {
    return res.json({ status: "fail", message: "Wrong username or password" });
  }

  var data = readCodes();
  var code = generateCode(25);

  data.push({
    username: username,
    code: code,
    created: Date.now(),
    used: false
  });

  saveCodes(data);

  return res.json({
    status: "success",
    code: code,
    expiresIn: 3600
  });
});

app.post("/login-code", function(req, res) {
  var username = (req.body.username || "").trim();
  var code = (req.body.code || "").trim();

  if (!username || !code) {
    return res.json({ status: "invalid" });
  }

  var data = readCodes();
  var item = null;
  var i = 0;

  for (i = 0; i < data.length; i++) {
    if (data[i].code === code) {
      item = data[i];
      break;
    }
  }

  if (!item) {
    return res.json({ status: "invalid" });
  }

  if (item.username !== username) {
    return res.json({ status: "invalid" });
  }

  if (Date.now() - item.created > CODE_VALID_MS) {
    return res.json({ status: "expired" });
  }

  if (item.used) {
    return res.json({ status: "used" });
  }

  item.used = true;
  saveCodes(data);

  return res.json({ status: "success" });
});

// ===== MUSIC API =====

// direct JSON for app
app.get("/api/songs.json", function(req, res) {
  res.sendFile(SONGS_JSON);
});

// optional: serve public folder explicitly
app.use("/public", express.static(PUBLIC_DIR));

// root page
app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Server Started on port " + PORT);
});
