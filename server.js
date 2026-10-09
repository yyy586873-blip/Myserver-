const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "20kb" }));

app.use(express.static(__dirname, {
    index: false
}));

// Latest accepted device statistics
let latestStats = null;

// Recent history, stored in memory
const messageHistory = [];

const MAX_HISTORY = 50;

// Dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Receive Android monitoring data
app.post("/api/stats", (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== "object" ||
            Array.isArray(body)) {
            return res.status(400).json({
                success: false,
                error: "Invalid JSON body"
            });
        }

        const timestamp = Number(body.timestamp) || Date.now();

        let stats;

        // Legacy Android payload format
        if (typeof body.text === "string") {
            stats = {
                id: String(body.id || "system_monitor"),
                text: body.text,
                timestamp: timestamp
            };
        } else {
            // Structured Android payload format
            stats = {
                id: String(body.id || "system_monitor"),
                model: String(body.model || "Unknown"),
                android_version: String(
                    body.android_version || "Unknown"
                ),
                battery: String(body.battery || "Unknown"),
                app_memory: String(
                    body.app_memory || "Unknown"
                ),
                max_app_memory: String(
                    body.max_app_memory || "Unknown"
                ),
                timestamp: timestamp
            };
        }

        latestStats = stats;

        messageHistory.push(stats);

        if (messageHistory.length > MAX_HISTORY) {
            messageHistory.shift();
        }

        return res.status(200).json({
            success: true,
            timestamp: timestamp
        });

    } catch (error) {
        console.error("POST /api/stats error:", error);

        return res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// Fetch latest statistics
app.get("/api/stats", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json(latestStats || {});
});

// Fetch recent history
app.get("/api/history", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json(messageHistory.slice().reverse());
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "system-monitor"
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
});